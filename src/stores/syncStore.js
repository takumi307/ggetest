import { defineStore } from 'pinia'
import { reactive, ref, watch } from 'vue'
import { SYNC_CHANNELS, CHANNEL_IDS, HIST_TOMB_KEY, SYNC_LOG_KEY, TOMB_KEEP_MS, HIST_TOMB_KEEP_MS, SYNC_RETRY_MS } from '@/utils/constants'
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

function clampNum(v, def, min, max) {
  if (v === '' || v == null || !Number.isFinite(Number(v))) return def
  return Math.min(max, Math.max(min, Math.round(Number(v))))
}

export const useSyncStore = defineStore('sync', () => {
  const ui = useUiStore()
  const T = () => useTrackerStore() // 循環参照を避けるため、使う時に取得する

  /* ================= state ================= */
  const channels = reactive({ aqua: makeChannel('aqua'), fort: makeChannel('fort') })
  const runtime = reactive({
    aqua: { syncing: false, lastTryAt: 0, failStreak: 0 },
    fort: { syncing: false, lastTryAt: 0, failStreak: 0 }
  })
  const syncLog = ref(asArray(loadJson(SYNC_LOG_KEY, [])))

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
  const isSnapshot = (id) => id === 'fort' && channels.fort.settings.mode === 'snapshot'
  const btnLabel = (id) => (isSnapshot(id) ? '📤 要塞・ドラゴンを今すぐ送信（通知のみ）' : SYNC_CHANNELS[id].btnLabel)

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

  /* ================= 同期本体 ================= */
  function fortSettingsPayload() {
    const s = channels.fort.settings
    return { leadMin: s.leadMin, quietOn: !!s.quietOn, quietStart: s.quietStart, quietEnd: s.quietEnd, digest: s.digest !== false }
  }

  async function syncNow(id, auto = false) {
    const def = SYNC_CHANNELS[id]
    const ch = channels[id]
    const rt = runtime[id]
    const tracker = T()
    if (!isConfigured(id)) {
      if (!auto) ui.showAlert('先に「表示・記録設定」で' + def.name + 'の同期URL・合言葉・ユーザーIDを保存してください')
      return false
    }
    if (rt.syncing) return false
    rt.syncing = true
    rt.lastTryAt = Date.now()
    try {
      const now = Date.now()
      ch.tombs = ch.tombs.filter((t) => now - (Number(t.updatedAt) || 0) < TOMB_KEEP_MS)
      const api = client(id)

      /* ① 通知のみ（一方向）：通知してよい対象の「種類・座標・時刻・メモ」だけを丸ごと送る */
      if (isSnapshot(id)) {
        const hasAny = tracker.entries.some((e) => def.types.includes(e.type))
        if (auto && !hasAny) return false // 空の端末が自動で一覧を空にするのを防ぐ
        const snapItems = []
        tracker.entries.forEach((e) => {
          if (!def.types.includes(e.type) || !Number.isFinite(Number(e.x)) || !Number.isFinite(Number(e.y)) || !Number.isFinite(Number(e.eventAt))) return
          if (!tracker.shouldNotifyEntry(e)) return
          snapItems.push({ type: e.type, x: Number(e.x), y: Number(e.y), label: e.label || '', eventAt: Number(e.eventAt) })
        })
        await api.snapshot({ items: snapItems, settings: fortSettingsPayload() })
        if (!auto) addSyncLog({ ch: id, at: Date.now(), auto: false, sent: snapItems.length, changes: [], mode: 'snapshot' })
        ch.settings.lastSyncDate = getLocalDateKey(Date.now())
        ch.settings.lastSyncAt = Date.now()
        rt.failStreak = 0
        if (!auto) ui.showToast('📤 通知用の一覧を送信しました（' + snapItems.length + '件）')
        return true
      }

      /* ② 端末同期 */
      const items = []
      tracker.entries.forEach((e) => {
        if (!def.types.includes(e.type) || !Number.isFinite(Number(e.x)) || !Number.isFinite(Number(e.y)) || !Number.isFinite(Number(e.eventAt))) return
        const it = { type: e.type, x: Number(e.x), y: Number(e.y), label: e.label || '', eventAt: Number(e.eventAt), updatedAt: Number(e.updatedAt) || 0, deleted: false }
        if (id === 'fort') it.notify = tracker.shouldNotifyEntry(e)
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
        payload.settings = fortSettingsPayload()
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

      const data = await api.sync(payload)
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
      // 5分おきの自動同期は「相手の更新なし」を履歴に残さない
      if (!auto || changes.length || rubyAdd || rubyDel || !def.intervalMs) {
        addSyncLog({ ch: id, at: Date.now(), auto: !!auto, sent: items.filter((i) => !i.deleted).length, changes, ruby: { add: rubyAdd, del: rubyDel } })
      }
      ch.settings.lastSyncDate = getLocalDateKey(Date.now())
      ch.settings.lastSyncAt = Date.now()
      rt.failStreak = 0
      if (!auto) ui.showToast('🔄 ' + def.name + 'を同期しました（相手の更新 ' + changed + '件' + (id === 'fort' ? '・ルビー記録 ' + (rubyAdd + rubyDel) + '件' : '') + 'を反映）')
      else if (!def.intervalMs) ui.showToast('🔄 本日の' + def.name + 'データを同期しました' + (changed ? '（相手の更新 ' + changed + '件）' : ''))
      else if (changed || rubyAdd || rubyDel) ui.showToast('🔄 ' + def.name + '：他の端末の更新 ' + (changed + rubyAdd + rubyDel) + '件を反映しました')
      return true
    } catch (err) {
      if (auto) {
        if (rt.failStreak === 0) ui.showToast(def.name + 'の自動同期に失敗しました')
        rt.failStreak++
      } else {
        const emsg = err && err.message ? err.message : String(err)
        ui.showAlert((isSnapshot(id) ? '送信できませんでした。\n' : '同期できませんでした。\n') + emsg)
      }
      return false
    } finally {
      rt.syncing = false
    }
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
      syncNow(id, true)
    })
  }

  /* ================= 設定の保存・テスト ================= */
  /** 同期設定を保存して今すぐ同期。入力欄の値（input）を受け取る */
  function saveChannelSettings(id, input) {
    const def = SYNC_CHANNELS[id]
    const s = channels[id].settings
    const url = String(input.url || '').trim()
    const token = String(input.token || '').trim()
    if (id === 'fort') {
      s.leadMin = clampNum(input.leadMin, 10, 0, 60)
      s.quietOn = !!input.quietOn
      s.quietStart = clampNum(input.quietStart, 0, 0, 23)
      s.quietEnd = clampNum(input.quietEnd, 7, 0, 23)
      s.digest = !!input.digest
      const newMode = input.mode === 'snapshot' ? 'snapshot' : 'sync'
      if (newMode !== s.mode) { s.mode = newMode; s.lastSyncAt = 0 }
    }
    if (!url && !token) {
      s.url = ''; s.token = ''; s.lastSyncDate = ''; s.lastSyncAt = 0
      ui.showToast(def.name + 'の同期を解除しました')
      return false
    }
    if (!/^https:\/\//.test(url) || !token) {
      ui.showAlert('同期URL（https://〜）と合言葉の両方を入力してください')
      return false
    }
    if (url !== s.url || token !== s.token) {
      s.lastSyncDate = ''
      s.lastSyncAt = 0
      if (id === 'fort') { // 接続先が変わったら、ルビー記録を新しい接続先へ最初から送り直す
        T().attackHistory.forEach((h) => { delete h.synced })
        s.histCursor = 0
        s.histUnsupported = false
        channels.fort.histTombs = []
      }
    }
    s.url = url
    s.token = token
    runtime[id].lastTryAt = 0
    syncNow(id, false)
    return true
  }

  async function testNotify() {
    if (!isConfigured('fort')) { ui.showAlert('先に同期URL・合言葉・ユーザーIDを保存してください'); return }
    try {
      await client('fort').test()
      ui.showToast('✅ テスト通知を送信しました')
    } catch (err) {
      ui.showAlert('テスト通知に失敗しました。\n' + (err && err.message ? err.message : err))
    }
  }

  /* ================= 表示用 ================= */
  function statusText(id) {
    const ch = channels[id]
    const def = SYNC_CHANNELS[id]
    if (!isConfigured(id)) return '同期：未設定（URL・合言葉・ユーザーIDが必要です）'
    if (isSnapshot(id)) {
      return ch.settings.lastSyncAt
        ? '通知のみ：設定済み／最終送信 ' + formatClock(ch.settings.lastSyncAt) + '／5分おきに自動送信（他の端末へは反映されません）'
        : '通知のみ：設定済み（まだ送信していません）'
    }
    let auto = def.intervalMs ? '／5分おきに自動同期' : '／日付が変わって最初に開いた時に自動同期'
    if (id === 'fort' && ch.settings.histUnsupported) auto += '（ルビー記録は未同期：サーバー側が未対応です）'
    if (!ch.settings.lastSyncAt) return '同期：設定済み（まだ同期していません）' + auto
    return '同期：設定済み／最終同期 ' + formatClock(ch.settings.lastSyncAt) + auto
  }

  return {
    channels, runtime, syncLog,
    chanIdOfType, isConfigured, anyConfigured, isSnapshot, btnLabel, statusText,
    touchSync, addTombstone, addHistTomb, clearSyncLog,
    syncNow, autoSyncIfNeeded, saveChannelSettings, testNotify
  }
})