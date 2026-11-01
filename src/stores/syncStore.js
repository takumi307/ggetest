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
    settings: Object.assign({}, def.defaults, asObject(loadJson(def.settingsKey, {}))),
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
  const runtime = reactive({
    aqua: { syncing: false, lastTryAt: 0, failStreak: 0, lastError: '' },
    fort: { syncing: false, lastTryAt: 0, failStreak: 0, lastError: '' }
  })
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

  function touchSync(e) { if (e && chanIdOfType(e.type)) e.updatedAt = Date.now() }

  /* 削除は「墓標」として記録し、同期で相手側にも伝える */
  function addTombstone(e) {
    if (!e) return
    const id = chanIdOfType(e.type)
    if (!id || e.x == null || e.y == null) return
    const ch = channels[id]
    const k = aquaKey(e)
    ch.tombs = ch.tombs.filter((t) => aquaKey(t) !== k)
    ch.tombs.push({ type: e.type, x: Number(e.x), y: Number(e.y), updatedAt: Date.now() })
  }

  /* ルビー記録を削除したら「削除の記録」を残し、他の端末にも伝える */
  function addHistTomb(h) {
    const ch = channels.fort
    if (!h || !h.id || !SYNC_CHANNELS.fort.types.includes(h.type) || !ch.settings.url) return
    if (ch.histTombs.some((t) => t.id === h.id)) return
    ch.histTombs.push({ id: h.id, at: Date.now() })
  }

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
        changes.push({ kind: 'update', type: r.type, x: Number(r.x), y: Number(r.y), from: fromAt, to: newAt })
        if (newAt !== fromAt) l.resultLogged = false // 新しい周期。攻撃結果の記録は再び可能にする
        l.eventAt = newAt
        l.updatedAt = ru
        if (r.label != null) l.label = String(r.label)
        changed++
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

  /* ================= 同期本体 =================
   * mode: 'manual'（手動・結果をメッセージ表示）／'auto'（自動）／'silent'（呼び出し側がまとめて表示）
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
    if (rt.syncing) return { ok: false, changed: 0, error: '同期中です' }
    rt.syncing = true
    rt.lastTryAt = Date.now()
    try {
      const now = Date.now()
      ch.tombs = ch.tombs.filter((t) => now - (Number(t.updatedAt) || 0) < TOMB_KEEP_MS)

      const items = []
      tracker.entries.forEach((e) => {
        if (!def.types.includes(e.type) || !Number.isFinite(Number(e.x)) || !Number.isFinite(Number(e.y)) || !Number.isFinite(Number(e.eventAt))) return
        const it = { type: e.type, x: Number(e.x), y: Number(e.y), label: e.label || '', eventAt: Number(e.eventAt), updatedAt: Number(e.updatedAt) || 0, deleted: false }
        if (id === 'fort') it.notify = tracker.shouldNotifyEntry(e) // 距離フィルター外・非表示は通知しない
        items.push(it)
      })
      ch.tombs.forEach((t) => {
        const newer = tracker.entries.some((e) => def.types.includes(e.type) && aquaKey(e) === aquaKey(t) && (Number(e.updatedAt) || 0) > (Number(t.updatedAt) || 0))
        if (!newer) items.push({ type: t.type, x: t.x, y: t.y, updatedAt: Number(t.updatedAt) || 0, deleted: true })
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
        const hp = pendingH.map((h) => ({
          id: h.id, entryId: h.entryId || '', type: h.type, label: h.label || '', x: Number(h.x), y: Number(h.y),
          result: h.result === 'taken' ? 'taken' : 'ruby', ruby: Number(h.ruby) || 0, at: Number(h.at)
        }))
        ch.histTombs.slice(0, 2000).forEach((t) => { sentTombIds[t.id] = true; hp.push({ id: t.id, deleted: true }) })
        payload.history = hp
        payload.historySince = Number(ch.settings.histCursor) || 0
      }

      const data = await client(id).sync(payload)
      const changes = []
      const changed = applyRemoteItems(id, Array.isArray(data.items) ? data.items : [], changes)
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
      rt.failStreak = 0
      rt.lastError = ''
      if (mode === 'manual') ui.showToast('🔄 ' + def.name + 'を同期しました（相手の更新 ' + total + '件を反映）')
      else if (auto && !def.intervalMs) ui.showToast('🔄 本日の' + def.name + 'データを同期しました' + (total ? '（相手の更新 ' + total + '件）' : ''))
      else if (auto && total) ui.showToast('🔄 ' + def.name + '：他の端末の更新 ' + total + '件を反映しました')
      return { ok: true, changed: total, error: '' }
    } catch (err) {
      const emsg = err && err.message ? err.message : String(err)
      rt.lastError = emsg
      if (auto) {
        if (rt.failStreak === 0) ui.showToast(def.name + 'の自動同期に失敗しました')
        rt.failStreak++
      } else if (mode === 'manual') {
        ui.showAlert('同期できませんでした。\n' + emsg)
      }
      return { ok: false, changed: 0, error: emsg }
    } finally {
      rt.syncing = false
    }
  }

  /* アクア＋要塞・ドラゴンをまとめて同期して、結果を1回だけ表示 */
  async function syncAll() {
    const ids = CHANNEL_IDS.filter(isConfigured)
    if (!ids.length) { ui.showAlert('先に「設定」タブで接続（URL・合言葉・ユーザーID）を保存してください'); return false }
    const results = await Promise.all(ids.map((id) => syncNow(id, 'silent')))
    const fail = results.find((r) => !r.ok)
    if (fail) { ui.showAlert('同期できませんでした。\n' + fail.error); return false }
    const total = results.reduce((s, r) => s + r.changed, 0)
    ui.showToast('🔄 同期しました（相手の更新 ' + total + '件を反映）')
    return true
  }

  /* 入力中・編集中・パネル表示中は自動同期を見送る（画面が書き換わって入力が消えるのを防ぐ） */
  function userBusy() {
    if (T().inlineEditId != null) return true
    const a = document.activeElement
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')) return true
    if (document.querySelector('.panel.open, .modalOverlay.show')) return true
    return false
  }
  function syncDue(id) {
    const def = SYNC_CHANNELS[id]
    const rt = runtime[id]
    const s = channels[id].settings
    const now = Date.now()
    if (rt.lastTryAt && now - rt.lastTryAt < SYNC_RETRY_MS) return false
    if (def.intervalMs) return now - (Number(s.lastSyncAt) || 0) >= def.intervalMs - 5000
    return s.lastSyncDate !== getLocalDateKey(now)
  }
  function autoSyncIfNeeded() {
    if (document.visibilityState !== 'visible') return
    CHANNEL_IDS.forEach((id) => {
      if (!isConfigured(id) || runtime[id].syncing || !syncDue(id)) return
      if (userBusy()) return
      syncNow(id, 'auto')
    })
  }

  /* ================= 接続設定（アクア・要塞で共通のURL・合言葉・ユーザーID） ================= */
  async function saveConnection({ url, token, userId }) {
    url = String(url || '').trim().replace(/\/+$/, '')
    token = String(token || '').trim()
    userId = String(userId || '').trim()
    if (!url && !token) {
      CHANNEL_IDS.forEach((id) => {
        const s = channels[id].settings
        s.url = ''; s.token = ''; s.lastSyncDate = ''; s.lastSyncAt = 0
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
      if (changed) { s.lastSyncDate = ''; s.lastSyncAt = 0 }
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
    if (rt.lastError) return '失敗：' + rt.lastError
    const auto = def.intervalMs ? '5分おきに自動同期' : '日付が変わって最初に開いた時に自動同期'
    const last = ch.settings.lastSyncAt ? '最終同期 ' + formatClock(ch.settings.lastSyncAt) : 'まだ同期していません'
    const extra = id === 'fort' && ch.settings.histUnsupported ? '（ルビー記録はサーバー未対応）' : ''
    return last + '／' + auto + extra
  }

  /* ヘッダーの同期チップ用 */
  function summary() {
    const ids = CHANNEL_IDS.filter(isConfigured)
    if (!ids.length) return { state: 'unset', text: '未接続' }
    if (ids.some((id) => runtime[id].syncing)) return { state: 'syncing', text: '同期中…' }
    if (ids.some((id) => runtime[id].lastError)) return { state: 'error', text: '同期エラー' }
    const last = Math.max.apply(null, ids.map((id) => Number(channels[id].settings.lastSyncAt) || 0))
    return last ? { state: 'ok', text: formatClock(last) + ' 同期' } : { state: 'idle', text: '未同期' }
  }

  return {
    channels, runtime, syncLog, notify,
    chanIdOfType, isConfigured, anyConfigured, statusText, summary,
    touchSync, addTombstone, addHistTomb, clearSyncLog,
    syncNow, syncAll, autoSyncIfNeeded, saveConnection,
    loadNotify, loadAllNotify, saveNotify, testNotify
  }
})
