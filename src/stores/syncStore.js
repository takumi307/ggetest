import { defineStore } from 'pinia'
import { reactive, ref, watch } from 'vue'
import {
  SYNC_CHANNELS, CHANNEL_IDS, NOTIFY_TYPE_LIST, HIST_TOMB_KEY, SYNC_LOG_KEY,
  TOMB_KEEP_MS, HIST_TOMB_KEEP_MS, SYNC_RETRY_MS
} from '@/utils/constants'
import { aquaKey, getLocalDateKey, formatClock, loadJson, saveJson, asArray, asObject, newId } from '@/utils/helpers'
import { createApiClient } from '@/utils/api'
import { useUiStore } from './uiStore'
import { useTrackerStore } from './trackerStore'

function makeChannel(id) {
  const def = SYNC_CHANNELS[id]
  const ch = {
    // lastBuiltAt：直近に成功した同期の開始時刻（これより後に変わった分が「未送信」）
    settings: Object.assign({ lastBuiltAt: 0 }, def.defaults, asObject(loadJson(def.settingsKey, {}))),
    tombs: asArray(loadJson(def.tombKey, []))
  }
  if (id === 'fort') ch.histTombs = asArray(loadJson(HIST_TOMB_KEY, []))
  return ch
}

/* 通知設定の初期値・整形（保存先はサーバー。画面表示用に持つだけ） */
function defaultNotify(id) {
  const types = {}
  NOTIFY_TYPE_LIST[id].forEach(([t]) => { types[t] = true })
  return { leadMin: 10, quietOn: false, quietStart: 0, quietEnd: 7, digest: true, roleId: '', types }
}
function normalizeNotify(id, s) {
  const out = defaultNotify(id)
  s = s || {}
  if (Number.isFinite(Number(s.leadMin))) out.leadMin = Number(s.leadMin)
  out.quietOn = !!s.quietOn
  if (Number.isFinite(Number(s.quietStart))) out.quietStart = Number(s.quietStart)
  if (Number.isFinite(Number(s.quietEnd))) out.quietEnd = Number(s.quietEnd)
  out.digest = s.digest !== false
  out.roleId = String(s.roleId || '')
  Object.keys(out.types).forEach((t) => { out.types[t] = !(s.types && s.types[t] === false) })
  return out
}
function makeNotifyState(id) {
  return { loaded: false, loading: false, error: '', settings: defaultNotify(id), webhookSet: false, webhookHint: '' }
}

export const useSyncStore = defineStore('sync', () => {
  const ui = useUiStore()
  const T = () => useTrackerStore() // 循環参照を避けるため、使う時に取得する

  /* ================= state ================= */
  const channels = reactive({ aqua: makeChannel('aqua'), fort: makeChannel('fort') })
  const online = ref(navigator.onLine !== false)
  const runtime = reactive(Object.fromEntries(CHANNEL_IDS.map((id) => [id, {
    syncing: false, saving: false, manual: false, lastTryAt: 0, lastError: '',
    reconnectPending: !online.value
  }])))
  const updateNotice = ref('')
  let updateTimer
  const RECONNECT_RETRY_MS = 30000

  function showRemoteUpdate() {
    updateNotice.value = '最新データに更新しました'
    clearTimeout(updateTimer)
    updateTimer = setTimeout(() => { updateNotice.value = '' }, 3000)
  }
  const syncLog = ref(asArray(loadJson(SYNC_LOG_KEY, [])))
  const notify = reactive({ aqua: makeNotifyState('aqua'), fort: makeNotifyState('fort') })

  CHANNEL_IDS.forEach((id) => {
    const def = SYNC_CHANNELS[id]
    watch(() => channels[id].settings, (v) => saveJson(def.settingsKey, v), { deep: true })
    watch(() => channels[id].tombs, (v) => saveJson(def.tombKey, v), { deep: true })
  })
  watch(() => channels.fort.histTombs, (v) => saveJson(HIST_TOMB_KEY, v), { deep: true })
  watch(syncLog, (v) => saveJson(SYNC_LOG_KEY, v), { deep: true })

  /* ================= 基本ヘルパー ================= */
  const chanIdOfType = (t) => CHANNEL_IDS.find((id) => SYNC_CHANNELS[id].types.includes(t)) || null
  const isConfigured = (id) => !!(channels[id].settings.url && channels[id].settings.token && T().userId)
  const anyConfigured = () => CHANNEL_IDS.some(isConfigured)

  function client(id) {
    const s = channels[id].settings
    return createApiClient({ baseUrl: s.url, token: s.token, userId: T().userId, channel: id })
  }

  function touchSync(e) {
    if (!e) return
    const id = chanIdOfType(e.type)
    if (!id) return
    e.updatedAt = Date.now()
    scheduleSync(id) // PUSH_ENABLED が false の間は何もしない
  }

  /* 削除は「墓標」として記録し、同期で相手側にも伝える */
  function addTombstone(e) {
    if (!e) return
    const id = chanIdOfType(e.type)
    if (!id || e.x == null || e.y == null) return
    const ch = channels[id]
    const k = aquaKey(e)
    ch.tombs = ch.tombs.filter((t) => aquaKey(t) !== k)
    ch.tombs.push({ type: e.type, x: Number(e.x), y: Number(e.y), updatedAt: Date.now() })
    scheduleSync(id)
  }

  /* ルビー記録を削除したら「削除の記録」を残し、他の端末にも伝える */
  function addHistTomb(h) {
    const ch = channels.fort
    if (!h || !h.id || !SYNC_CHANNELS.fort.types.includes(h.type) || !ch.settings.url) return
    if (ch.histTombs.some((t) => t.id === h.id)) return
    ch.histTombs.push({ id: h.id, at: Date.now() })
    scheduleSync('fort')
  }

  /* ================= 送信データの組み立て ================= */
  const validEntry = (def, e) =>
    def.types.includes(e.type) && Number.isFinite(Number(e.x)) && Number.isFinite(Number(e.y)) && Number.isFinite(Number(e.eventAt))

  function itemPayload(id, e) {
    const it = {
      type: e.type, x: Number(e.x), y: Number(e.y), label: e.label || '',
      eventAt: Number(e.eventAt), updatedAt: Number(e.updatedAt) || 0, deleted: false
    }
    if (id === 'fort') it.notify = T().shouldNotifyEntry(e) // 距離フィルター外・非表示は通知しない
    return it
  }
  const tombPayload = (t) => ({ type: t.type, x: t.x, y: t.y, updatedAt: Number(t.updatedAt) || 0, deleted: true })
  const histPayload = (h) => ({
    id: h.id, entryId: h.entryId || '', type: h.type, label: h.label || '', x: Number(h.x), y: Number(h.y),
    result: h.result === 'taken' ? 'taken' : 'ruby', ruby: Number(h.ruby) || 0, at: Number(h.at)
  })
  const tombIsNewest = (def, t) =>
    !T().entries.some((e) => def.types.includes(e.type) && aquaKey(e) === aquaKey(t) && (Number(e.updatedAt) || 0) > (Number(t.updatedAt) || 0))

  /* ================= 受信データの反映 ================= */
  function remoteWins(local, remote) {
    const lu = Number(local.updatedAt) || 0
    const ru = Number(remote.updatedAt) || 0
    if (ru !== lu) return ru > lu
    return (Number(remote.eventAt) || 0) > (Number(local.eventAt) || 0)
  }

  function applyRemoteItems(id, items, changes) {
    const tracker = T()
    const types = SYNC_CHANNELS[id].types
    const ch = channels[id]
    let changed = 0
    items.forEach((r) => {
      if (!r || !types.includes(r.type) || !Number.isFinite(Number(r.x)) || !Number.isFinite(Number(r.y))) return
      const k = aquaKey(r)
      const ru = Number(r.updatedAt) || 0
      const locals = tracker.entries.filter((e) => types.includes(e.type) && aquaKey(e) === k)
      if (r.deleted) {
        const newest = locals.reduce((m, l) => Math.max(m, Number(l.updatedAt) || 0), 0)
        if (locals.length && newest > ru) return // こちらの登録の方が新しい → 削除は無視
        if (locals.length) {
          tracker.entries = tracker.entries.filter((e) => locals.indexOf(e) === -1)
          changed++
          changes.push({ kind: 'delete', type: r.type, x: Number(r.x), y: Number(r.y) })
        }
        ch.tombs = ch.tombs.filter((t) => aquaKey(t) !== k)
        ch.tombs.push({ type: r.type, x: Number(r.x), y: Number(r.y), updatedAt: ru })
        return
      }
      if (!Number.isFinite(Number(r.eventAt))) return
      const tomb = ch.tombs.find((t) => aquaKey(t) === k)
      if (!locals.length) {
        if (tomb && (Number(tomb.updatedAt) || 0) >= ru) return // こちらで削除済み
        tracker.entries.push({
          id: 'sync-' + newId(5), type: r.type, label: r.label || '',
          x: Number(r.x), y: Number(r.y), eventAt: Number(r.eventAt), updatedAt: ru
        })
        ch.tombs = ch.tombs.filter((t) => aquaKey(t) !== k)
        changed++
        changes.push({ kind: 'add', type: r.type, x: Number(r.x), y: Number(r.y), to: Number(r.eventAt) })
        return
      }
      const l = locals[0]
      if (remoteWins(l, r)) {
        const fromAt = Number(l.eventAt)
        const newAt = Number(r.eventAt)
        const newLabel = r.label == null ? l.label : String(r.label)
        if (newAt !== fromAt || (newLabel || '') !== (l.label || '')) {
          changes.push({ kind: 'update', type: r.type, x: Number(r.x), y: Number(r.y), from: fromAt, to: newAt })
          changed++
        }
        if (newAt !== fromAt) l.resultLogged = false // 新しい周期。攻撃結果の記録は再び可能にする
        l.eventAt = newAt
        l.updatedAt = ru
        l.label = newLabel
      }
    })
    return changed
  }

  function applyRemoteHistory(list, rejected) {
    const tracker = T()
    const ch = channels.fort
    const types = SYNC_CHANNELS.fort.types
    let add = 0, del = 0
    const tombIds = {}
    ch.histTombs.forEach((t) => { tombIds[t.id] = true })
    const byId = {}
    tracker.attackHistory.forEach((h) => { byId[h.id] = h })
    const removeIds = {}
    ;(rejected || []).forEach((id) => { if (byId[id]) removeIds[id] = true })
    ;(list || []).forEach((r) => {
      if (!r || !r.id) return
      if (r.deleted) { if (byId[r.id]) removeIds[r.id] = true; return }
      if (!types.includes(r.type) || !Number.isFinite(Number(r.at))) return
      if (byId[r.id]) { byId[r.id].synced = true; return }
      if (tombIds[r.id]) return
      tracker.attackHistory.push({
        id: String(r.id), entryId: r.entryId || '', type: r.type, label: r.label || '',
        x: Number(r.x), y: Number(r.y), result: r.result === 'taken' ? 'taken' : 'ruby',
        ruby: Number(r.ruby) || 0, at: Number(r.at), synced: true
      })
      byId[String(r.id)] = true
      add++
    })
    const ids = Object.keys(removeIds)
    if (ids.length) {
      tracker.attackHistory = tracker.attackHistory.filter((h) => !removeIds[h.id])
      del = ids.length
    }
    return { add, del }
  }

  /* ================= 同期ログ ================= */
  function addSyncLog(rec) {
    syncLog.value.push(rec)
    if (syncLog.value.length > 60) syncLog.value = syncLog.value.slice(-60)
  }
  function clearSyncLog() { syncLog.value = [] }

  /* ================= 操作の数秒後に、その種類の同期を自動で行う =================
   * 現在は無効（PUSH_ENABLED = false）。true にすると、登録・編集・削除・記録の
   * 最後の操作から3秒後（連続操作でも最初の操作から30秒以内）に自動で同期する。 */
  const PUSH_ENABLED = false
  const pushTimers = { aqua: null, fort: null }
  const pushSince = { aqua: 0, fort: 0 }
  const PUSH_DELAY_MS = 3000
  const PUSH_MAX_WAIT_MS = 30000

  function scheduleSync(id) {
    if (!PUSH_ENABLED || !id || !isConfigured(id)) return
    const now = Date.now()
    if (!pushTimers[id]) pushSince[id] = now
    clearTimeout(pushTimers[id])
    const wait = Math.max(0, Math.min(PUSH_DELAY_MS, pushSince[id] + PUSH_MAX_WAIT_MS - now))
    pushTimers[id] = setTimeout(() => runPush(id), wait)
  }

  async function runPush(id) {
    pushTimers[id] = null
    if (runtime[id].syncing) { scheduleSync(id); return } // 同期中なら、終わってからもう一度
    await syncNow(id, 'auto')
  }

  /* ================= 同期本体 =================
   * mode: 'manual'（手動）／'auto'（自動）
   * 戻り値: { ok, changed, error } */
  async function syncNow(id, mode = 'manual') {
    const auto = mode === 'auto'
    const def = SYNC_CHANNELS[id]
    const ch = channels[id]
    const rt = runtime[id]
    const tracker = T()
    if (!isConfigured(id)) {
      if (mode === 'manual') ui.showAlert('先に「設定」タブで接続（URL・合言葉・ユーザーID）を保存してください')
      return { ok: false, changed: 0, error: '未接続' }
    }
    if (!online.value) return { ok: false, changed: 0, error: 'オフライン' }
    if (rt.syncing) return { ok: false, changed: 0, error: '同期中です' }
    rt.syncing = true
    rt.manual = !auto
    rt.reconnectPending = false
    rt.lastTryAt = Date.now()
    try {
      const now = Date.now()
      ch.tombs = ch.tombs.filter((t) => now - (Number(t.updatedAt) || 0) < TOMB_KEEP_MS)

      const items = []
      tracker.entries.forEach((e) => {
        if (validEntry(def, e)) items.push(itemPayload(id, e))
      })
      ch.tombs.forEach((t) => {
        if (tombIsNewest(def, t)) items.push(tombPayload(t))
      })
      const payload = { items }
      let pendingH = []
      const sentTombIds = {}
      if (id === 'fort') {
        // ルビー記録：まだ送っていない記録＋削除の記録だけを送り、前回以降の変化だけを受け取る
        ch.histTombs = ch.histTombs.filter((t) => now - (Number(t.at) || 0) < HIST_TOMB_KEEP_MS)
        pendingH = tracker.attackHistory
          .filter((h) => !h.synced && h.id && def.types.includes(h.type) && Number.isFinite(Number(h.at)))
          .slice(0, 2000)
        const hp = pendingH.map(histPayload)
        ch.histTombs.slice(0, 2000).forEach((t) => { sentTombIds[t.id] = true; hp.push({ id: t.id, deleted: true }) })
        payload.history = hp
        payload.historySince = Number(ch.settings.histCursor) || 0
      }

      const lastBuiltAt = Number(ch.settings.lastBuiltAt) || Number(ch.settings.lastSyncAt) || 0
      rt.saving = items.some((item) => item.updatedAt > lastBuiltAt) || !!payload.history?.length
      const data = await client(id).sync(payload)
      if (!Array.isArray(data.items)) throw new Error('同期データの形式が正しくありません')
      const changes = []
      const changed = applyRemoteItems(id, data.items, changes)
      let rubyAdd = 0, rubyDel = 0
      if (id === 'fort') {
        if (Array.isArray(data.history)) {
          const rr = applyRemoteHistory(data.history, data.historyDeleted)
          rubyAdd = rr.add
          rubyDel = rr.del
          pendingH.forEach((h) => { h.synced = true })
          ch.histTombs = ch.histTombs.filter((t) => !sentTombIds[t.id])
          if (Number(data.historyNow)) ch.settings.histCursor = Number(data.historyNow)
          ch.settings.histUnsupported = false
        } else {
          ch.settings.histUnsupported = true // サーバーがルビー記録の同期に未対応
        }
      }
      const total = changed + rubyAdd + rubyDel
      // 5分おきの自動同期は「相手の更新なし」を履歴に残さない
      if (!auto || changes.length || rubyAdd || rubyDel || !def.intervalMs) {
        addSyncLog({ ch: id, at: Date.now(), auto, sent: items.filter((i) => !i.deleted).length, changes, ruby: { add: rubyAdd, del: rubyDel } })
      }
      ch.settings.lastSyncDate = getLocalDateKey(Date.now())
      ch.settings.lastSyncAt = Date.now()
      ch.settings.lastBuiltAt = now // この時刻より後に変わった分が「未送信」
      rt.lastError = ''
      if (total && online.value) showRemoteUpdate()
      return { ok: true, changed: total, error: '' }
    } catch (err) {
      const emsg = err && err.message ? err.message : String(err)
      rt.lastError = emsg
      return { ok: false, changed: 0, error: emsg }
    } finally {
      rt.syncing = false
      rt.saving = false
      rt.manual = false
    }
  }

  const canSyncNow = () => online.value && anyConfigured() && !CHANNEL_IDS.some((id) => runtime[id].syncing)

  async function syncAll() {
    if (!canSyncNow()) return false
    const results = await Promise.all(CHANNEL_IDS.filter(isConfigured).map((id) => syncNow(id)))
    return results.every((r) => r.ok)
  }

  /* 確認ダイアログが開いている間だけ、自動同期を見送る */
  function userBusy() {
    return !!document.querySelector('.modalOverlay.show')
  }
  function syncDue(id) {
    const def = SYNC_CHANNELS[id]
    const rt = runtime[id]
    const s = channels[id].settings
    const now = Date.now()
    const retryDelay = rt.reconnectPending ? RECONNECT_RETRY_MS : SYNC_RETRY_MS
    if (rt.lastTryAt && now - rt.lastTryAt < retryDelay) return false
    if (rt.reconnectPending) return true
    if (def.intervalMs) return now - (Number(s.lastSyncAt) || 0) >= def.intervalMs
    return s.lastSyncDate !== getLocalDateKey(now)
  }
  function autoSyncIfNeeded() {
    if (!online.value || document.visibilityState !== 'visible' || userBusy()) return
    CHANNEL_IDS.forEach((id) => {
      if (isConfigured(id) && !runtime[id].syncing && syncDue(id)) syncNow(id, 'auto')
    })
  }

  function updateNetworkStatus() {
    const connected = navigator.onLine !== false
    if (connected === online.value) return
    online.value = connected
    if (connected) autoSyncIfNeeded()
    else {
      CHANNEL_IDS.forEach((id) => { runtime[id].reconnectPending = true })
      clearTimeout(updateTimer)
      updateNotice.value = ''
    }
  }

  /* ================= アプリを離れるときの送信 =================
   * 前回の同期の開始時刻より後に変わった分（未送信の変更）だけを、1回送る。
   * keepalive の送信なので、結果は待たない。届かなかった分は、次の同期で送られる。 */
  function buildPendingPayload(id) {
    const def = SYNC_CHANNELS[id]
    const ch = channels[id]
    const tracker = T()
    const since = Number(ch.settings.lastBuiltAt) || Number(ch.settings.lastSyncAt) || 0
    const items = []
    tracker.entries.forEach((e) => {
      if (!validEntry(def, e) || (Number(e.updatedAt) || 0) <= since) return
      items.push(itemPayload(id, e))
    })
    ch.tombs.forEach((t) => {
      if ((Number(t.updatedAt) || 0) <= since) return
      if (tombIsNewest(def, t)) items.push(tombPayload(t))
    })
    const payload = { items }
    let hasHistory = false
    if (id === 'fort') {
      const hp = []
      tracker.attackHistory
        .filter((h) => !h.synced && h.id && def.types.includes(h.type) && Number.isFinite(Number(h.at)))
        .slice(0, 200)
        .forEach((h) => hp.push(histPayload(h)))
      ch.histTombs.slice(0, 200).forEach((t) => hp.push({ id: t.id, deleted: true }))
      if (hp.length) {
        payload.history = hp
        payload.historySince = Date.now() // 返ってくる結果は使わないので、小さくする
        hasHistory = true
      }
    }
    return items.length || hasHistory ? payload : null
  }

  let lastLeaveAt = 0
  function flushOnLeave() {
    const now = Date.now()
    if (!online.value || now - lastLeaveAt < 2000) return // hidden と pagehide が続けて来たときの二重送信を防ぐ
    lastLeaveAt = now
    CHANNEL_IDS.forEach((id) => {
      if (!isConfigured(id) || runtime[id].syncing) return // 同期中なら、その同期に任せる
      const payload = buildPendingPayload(id)
      if (payload) client(id).pushKeepalive(payload)
    })
  }

  /* ================= 接続設定（アクア・要塞で共通のURL・合言葉・ユーザーID） ================= */
  async function saveConnection({ url, token, userId }) {
    if (CHANNEL_IDS.some((id) => runtime[id].syncing)) return false
    url = String(url || '').trim().replace(/\/+$/, '')
    token = String(token || '').trim()
    userId = String(userId || '').trim()
    if (!url && !token) {
      CHANNEL_IDS.forEach((id) => {
        const s = channels[id].settings
        s.url = ''; s.token = ''; s.lastSyncDate = ''; s.lastSyncAt = 0; s.lastBuiltAt = 0
        notify[id].loaded = false
        runtime[id].lastError = ''
      })
      ui.showToast('接続を解除しました')
      return false
    }
    if (!/^https:\/\//.test(url) || !token) {
      ui.showAlert('URL（https://〜）と合言葉の両方を入力してください')
      return false
    }
    const tracker = T()
    const changed = userId !== tracker.userId || CHANNEL_IDS.some((id) => channels[id].settings.url !== url || channels[id].settings.token !== token)
    tracker.setUserId(userId)
    CHANNEL_IDS.forEach((id) => {
      const s = channels[id].settings
      if (changed) { s.lastSyncDate = ''; s.lastSyncAt = 0; s.lastBuiltAt = 0 }
      s.url = url
      s.token = token
      runtime[id].lastTryAt = 0
      runtime[id].lastError = ''
    })
    if (changed) { // 接続先が変わったら、ルビー記録を新しい接続先へ最初から送り直す
      tracker.attackHistory.forEach((h) => { delete h.synced })
      channels.fort.settings.histCursor = 0
      channels.fort.settings.histUnsupported = false
      channels.fort.histTombs = []
    }
    const ok = await syncAll()
    await loadAllNotify()
    return ok
  }

  /* ================= 通知設定（保存先はサーバー） ================= */
  function applyNotifyResponse(id, data) {
    const n = notify[id]
    if (data.settings) n.settings = normalizeNotify(id, data.settings)
    n.webhookSet = !!(data.webhook && data.webhook.set)
    n.webhookHint = (data.webhook && data.webhook.hint) || ''
    n.loaded = true
    n.error = ''
  }

  async function loadNotify(id) {
    const n = notify[id]
    if (!isConfigured(id) || n.loading) return false
    n.loading = true
    try {
      applyNotifyResponse(id, await client(id).settings({}))
      return true
    } catch (err) {
      n.error = err && err.message ? err.message : String(err)
      return false
    } finally {
      n.loading = false
    }
  }
  async function loadAllNotify() {
    await Promise.all(CHANNEL_IDS.map((id) => loadNotify(id)))
  }

  /* settings: 通知設定（省略可）／ webhookUrl: undefinedで変更なし・''で解除・URLで登録 */
  async function saveNotify(id, settings, webhookUrl) {
    if (!isConfigured(id)) { ui.showAlert('先に「接続」を設定してください'); return false }
    try {
      const payload = {}
      if (settings) payload.settings = settings
      if (webhookUrl !== undefined) payload.webhookUrl = webhookUrl
      applyNotifyResponse(id, await client(id).settings(payload))
      ui.showToast('通知設定を保存しました')
      return true
    } catch (err) {
      ui.showAlert('通知設定を保存できませんでした。\n' + (err && err.message ? err.message : err))
      return false
    }
  }

  async function testNotify(id, webhookUrl) {
    if (!isConfigured(id)) { ui.showAlert('先に「接続」を設定してください'); return false }
    try {
      await client(id).test(webhookUrl ? { webhookUrl } : {})
      ui.showToast('✅ テスト通知を送信しました')
      return true
    } catch (err) {
      ui.showAlert('テスト通知に失敗しました。\n' + (err && err.message ? err.message : err))
      return false
    }
  }

  /* ================= 表示用 ================= */
  function statusText(id) {
    const ch = channels[id]
    const def = SYNC_CHANNELS[id]
    const rt = runtime[id]
    if (!isConfigured(id)) return '未接続'
    if (!online.value) return 'オフライン'
    if (rt.lastError) return '同期できませんでした（' + rt.lastError + '）'
    const auto = def.intervalMs ? '5分おきに自動同期' : '日付が変わって最初に開いた時に自動同期'
    const last = ch.settings.lastSyncAt ? '最終同期 ' + formatClock(ch.settings.lastSyncAt) : 'まだ同期していません'
    const extra = id === 'fort' && ch.settings.histUnsupported ? '（ルビー記録はサーバー未対応）' : ''
    return last + '／' + auto + extra
  }

  /* ヘッダーの同期チップ用 */
  function summary() {
    const ids = CHANNEL_IDS.filter(isConfigured)
    const last = Math.min(...ids.map((id) => Number(channels[id].settings.lastSyncAt) || 0))
    const lastSync = ids.length && last ? formatClock(last).slice(-5) : ''
    const status = (state, text) => ({ state, text, lastSync })
    if (!online.value) return status('offline', 'オフライン')
    if (!ids.length) return status('unset', '未接続')
    if (ids.some((id) => runtime[id].lastError)) return status('error', '同期できませんでした')
    if (ids.some((id) => runtime[id].saving)) return status('syncing', '保存中...')
    if (ids.some((id) => runtime[id].manual || (!lastSync && runtime[id].syncing))) return status('syncing', '同期中…')
    return lastSync ? status('ok', '同期済み') : status('idle', '未同期')
  }

  return {
    channels, runtime, syncLog, notify, updateNotice,
    chanIdOfType, isConfigured, anyConfigured, canSyncNow, statusText, summary,
    touchSync, addTombstone, addHistTomb, clearSyncLog,
    syncNow, syncAll, autoSyncIfNeeded, updateNetworkStatus, scheduleSync, flushOnLeave, saveConnection,
    loadNotify, loadAllNotify, saveNotify, testNotify
  }
})
