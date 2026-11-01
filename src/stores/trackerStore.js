import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import {
  STORAGE_KEY, LEGACY_MAIN_KEY, LEGACY_AQUA_KEY, TRACKER_SETTINGS_KEY, HISTORY_KEY, USER_ID_KEY,
  DISTANCE_TYPES, DISTANCE_TYPE_LIST, ALL_TYPES
} from '@/utils/constants'
import {
  pad, typeLabel, isAquaFamily, intervalForType, defaultRubyForType, getLocalDateKey, getMonthKey,
  lastMonthKey, aquaKey, isBlank, toNum, newId, loadJson, saveJson, asArray, asObject, formatClock
} from '@/utils/helpers'
import { useUiStore } from './uiStore'
import { useSyncStore } from './syncStore'

/* ---------- 初期読み込み ---------- */
function migrateLegacy() {
  if (localStorage.getItem(STORAGE_KEY) !== null) return
  const migrated = []
  asArray(loadJson(LEGACY_MAIN_KEY, [])).forEach((e) => {
    migrated.push({ id: e.id, type: e.type, label: e.label || '', x: e.x, y: e.y, eventAt: e.attackableAt })
  })
  asArray(loadJson(LEGACY_AQUA_KEY, [])).forEach((e) => {
    migrated.push({ id: e.id, type: 'aqua', label: '', x: e.x, y: e.y, eventAt: e.surfaceAt })
  })
  saveJson(STORAGE_KEY, migrated)
}

function loadSettings() {
  const base = {
    enabled: { dragon: true, fortress: true, aqua: true, smallAqua: true, wildFortress: true },
    near50: { dragon: false, fortress: false, wildFortress: false },
    nearDistance: { dragon: 50, fortress: 50, wildFortress: 50 },
    homeX: '', homeY: '', homeCoords: {}
  }
  const s = Object.assign(base, asObject(loadJson(TRACKER_SETTINGS_KEY, {})))
  s.enabled = Object.assign({ dragon: true, fortress: true, aqua: true, smallAqua: true, wildFortress: true }, s.enabled || {})
  s.near50 = Object.assign({ dragon: false, fortress: false, wildFortress: false }, s.near50 || {})
  s.nearDistance = Object.assign({ dragon: 50, fortress: 50, wildFortress: 50 }, s.nearDistance || {})
  s.homeCoords = Object.assign({}, s.homeCoords || {})
  DISTANCE_TYPES.forEach((t) => {
    if (!s.homeCoords[t]) s.homeCoords[t] = { x: s.homeX || '', y: s.homeY || '' }
  })
  return s
}

export const useTrackerStore = defineStore('tracker', () => {
  const ui = useUiStore()

  /* ================= state ================= */
  migrateLegacy()
  const entries = ref(asArray(loadJson(STORAGE_KEY, [])))
  const attackHistory = ref(asArray(loadJson(HISTORY_KEY, [])))
  const settings = ref(loadSettings())
  const userId = ref(String(loadJson(USER_ID_KEY, '') || ''))

  // 画面状態（検索・絞り込み・並び替え・編集中カード・集計期間）
  const now = ref(Date.now())
  const searchQuery = ref('')
  const typeFilter = ref('all')
  const sortMode = ref('timeAsc')
  const readyTypeFilter = ref('all')
  const inlineEditId = ref(null)
  const statsPeriod = ref('today')
  const statsDate = ref(getLocalDateKey(Date.now()))

  // localStorageへの保存（変更があれば自動で保存）
  watch(entries, (v) => saveJson(STORAGE_KEY, v), { deep: true })
  watch(attackHistory, (v) => saveJson(HISTORY_KEY, v), { deep: true })
  watch(settings, (v) => saveJson(TRACKER_SETTINGS_KEY, v), { deep: true })
  watch(userId, (v) => saveJson(USER_ID_KEY, v))

  function tick() { now.value = Date.now() }

  /* ================= 距離フィルター ================= */
  function homeOf(t) {
    const h = settings.value.homeCoords && settings.value.homeCoords[t]
    return h && h.x !== '' && h.y !== '' && h.x != null && h.y != null ? h : null
  }
  function hasHome(t) { return !!homeOf(t) }
  function limitOf(t) {
    const v = Number(settings.value.nearDistance && settings.value.nearDistance[t])
    return !Number.isFinite(v) || v < 0 ? 50 : v
  }
  function coordDistance(e) {
    if (!DISTANCE_TYPES.includes(e.type) || e.x == null || e.y == null) return null
    const home = homeOf(e.type)
    if (!home) return null
    const dx = Number(e.x) - Number(home.x)
    const dy = Number(e.y) - Number(home.y)
    return Math.sqrt(dx * dx + dy * dy)
  }
  /* 距離フィルターが有効なのは「ON」かつ「自分の座標が入力済み」のときだけ */
  function nearFilterActive(t) {
    return !!(settings.value.near50 && settings.value.near50[t]) && hasHome(t)
  }
  function passesNear(e) {
    if (!nearFilterActive(e.type)) return true
    const d = coordDistance(e)
    return !(d === null || d > limitOf(e.type))
  }
  /* Discord通知の対象にしてよいか（表示オフ・距離フィルター外は通知しない） */
  function shouldNotifyEntry(e) {
    if (settings.value.enabled && settings.value.enabled[e.type] === false) return false
    return passesNear(e)
  }

  /* ================= 一覧・攻撃可能の絞り込み ================= */
  function matchesQuery(e) {
    const query = searchQuery.value.trim().toLowerCase()
    if (!query) return true
    // X座標とY座標のペア検索に対応（例: 662 715 / X:662 Y:715 / 662,715）
    const nums = query.match(/-?\d+(?:\.\d+)?/g)
    if (nums && nums.length >= 2 && String(e.x) === nums[0] && String(e.y) === nums[1]) return true
    const hay = String(e.x) + ' ' + String(e.y) + ' ' + (e.label || '')
    return hay.toLowerCase().indexOf(query) !== -1
  }
  function sortEntries(list) {
    const mode = sortMode.value
    return list.slice().sort((a, b) => {
      if (mode === 'timeDesc') return b.eventAt - a.eventAt
      if (mode === 'coordAsc') return Number(a.x) - Number(b.x) || Number(a.y) - Number(b.y)
      if (mode === 'coordDesc') return Number(b.x) - Number(a.x) || Number(b.y) - Number(a.y)
      if (mode === 'type') return typeLabel(a.type).localeCompare(typeLabel(b.type), 'ja') || a.eventAt - b.eventAt
      if (mode === 'label') return String(a.label || '').localeCompare(String(b.label || ''), 'ja') || a.eventAt - b.eventAt
      return a.eventAt - b.eventAt
    })
  }

  const filteredMain = computed(() =>
    entries.value.filter((e) => {
      if (settings.value.enabled[e.type] === false) return false
      if (typeFilter.value !== 'all' && e.type !== typeFilter.value) return false
      if (!passesNear(e)) return false
      return matchesQuery(e)
    })
  )
  const waitingList = computed(() => sortEntries(filteredMain.value.filter((e) => e.eventAt - now.value > 0)))
  const resultSummary = computed(() => `${filteredMain.value.length}件中 ${waitingList.value.length}件が攻撃待ち`)

  const readyList = computed(() => {
    const filtered = entries.value.filter((e) => {
      if (settings.value.enabled[e.type] === false) return false
      if (readyTypeFilter.value !== 'all' && e.type !== readyTypeFilter.value) return false
      if (!passesNear(e)) return false
      return matchesQuery(e)
    })
    return sortEntries(filtered.filter((e) => e.eventAt - now.value <= 0))
  })

  const countSummary = computed(() => {
    const c = (t) => entries.value.filter((e) => e.type === t).length
    return `登録: ドラゴン${c('dragon')} / 要塞${c('fortress')} / 嵐の島${c('aqua')} / 小アクア${c('smallAqua')} / 野生の要塞${c('wildFortress')}(計${entries.value.length}件)`
  })

  const nearWarning = computed(() => {
    const names = DISTANCE_TYPE_LIST.filter(
      ([t]) => settings.value.enabled[t] !== false && settings.value.near50 && settings.value.near50[t] && !hasHome(t)
    ).map(([, name]) => name)
    return names.length
      ? '距離絞り込みを利用するには自分の座標を入力してください（' + names.join('・') + '）。入力するまでは距離で絞り込まず、すべて表示します。'
      : ''
  })

  const nearCounts = computed(() =>
    DISTANCE_TYPE_LIST.map(([t, name]) => {
      const limit = limitOf(t)
      const count = entries.value.filter((e) => {
        if (e.type !== t) return false
        const d = coordDistance(e)
        return d !== null && d <= limit
      }).length
      return { type: t, name, limit, count, hasHome: hasHome(t) }
    })
  )

  function resetFilters() {
    searchQuery.value = ''
    typeFilter.value = 'all'
    sortMode.value = 'timeAsc'
  }

  /* ================= 設定 ================= */
  function saveSettings(draft) {
    const s = settings.value
    Object.keys(draft.enabled).forEach((t) => { s.enabled[t] = !!draft.enabled[t] })
    Object.keys(draft.near50).forEach((t) => { s.near50[t] = !!draft.near50[t] })
    Object.keys(draft.nearDistance).forEach((t) => {
      const raw = draft.nearDistance[t]
      const v = Number(raw)
      s.nearDistance[t] = (raw === '' || raw == null || !Number.isFinite(v) || v < 0) ? 50 : v
    })
    s.homeCoords = s.homeCoords || {}
    DISTANCE_TYPES.forEach((t) => {
      const h = draft.home[t] || {}
      s.homeCoords[t] = { x: h.x == null ? '' : h.x, y: h.y == null ? '' : h.y }
    })
    ui.showToast('設定を保存しました')
  }

  function setUserId(v) { userId.value = String(v || '').trim() }

  /* ================= 登録・編集・削除 ================= */
  function findCoordDuplicate(type, x, y, excludeId = null) {
    return entries.value.find((e) => e.type === type && e.x === x && e.y === y && e.id !== excludeId)
  }
  function remainToEventAt(type, h, m) {
    const ms = (h * 3600 + m * 60) * 1000
    return Date.now() + ms + intervalForType(type)
  }
  const num0 = (v) => (isBlank(v) ? 0 : Number(v))

  /** 新規登録。成功したら true */
  async function submitNew(form) {
    const x = toNum(form.x)
    const y = toNum(form.y)
    if (x === null || y === null) { ui.showAlert('座標を入力してください'); return false }
    if (findCoordDuplicate(form.type, x, y)) {
      const ok = await ui.showConfirm(`同じ座標(X:${x} / Y:${y})に登録済みの${typeLabel(form.type)}があります。\n続けて登録しますか?`)
      if (!ok) return false
    }
    const eventAt = isBlank(form.rh) && isBlank(form.rm)
      ? Date.now()
      : remainToEventAt(form.type, num0(form.rh), num0(form.rm))
    const entry = { id: newId(5), type: form.type, label: (form.label || '').trim(), x, y, eventAt }
    useSyncStore().touchSync(entry)
    entries.value.push(entry)
    ui.showToast('追加しました')
    return true
  }

  /** 複数登録。キャンセル時は -1、それ以外は追加件数 */
  async function submitBulk(type, list) {
    if (!list.length) { ui.showAlert('登録する座標がありません'); return -1 }
    const dup = []
    list.forEach((c) => { if (findCoordDuplicate(type, c.x, c.y)) dup.push(`X:${c.x} / Y:${c.y}`) })
    if (dup.length) {
      const ok = await ui.showConfirm(
        `すでに登録済みの座標(${typeLabel(type)})があります。\n${dup.slice(0, 8).join('\n')}${dup.length > 8 ? `\n…ほか${dup.length - 8}件` : ''}\n\n重複を除いて登録しますか?`
      )
      if (!ok) return -1
    }
    const sync = useSyncStore()
    const seen = {}
    let added = 0
    const base = Date.now()
    list.forEach((c) => {
      const key = c.x + '|' + c.y
      if (seen[key] || findCoordDuplicate(type, c.x, c.y)) return
      seen[key] = true
      const entry = { id: newId(7), type, label: '', x: c.x, y: c.y, eventAt: base }
      sync.touchSync(entry)
      entries.value.push(entry)
      added++
    })
    ui.showToast(`${added}件を登録しました → 攻撃可能タブから時間を入力できます`)
    return added
  }

  function startEdit(id) { inlineEditId.value = id }
  function cancelEdit() { inlineEditId.value = null }

  /** インライン編集の保存。成功したら true */
  async function submitEdit(id, form) {
    const x = toNum(form.x)
    const y = toNum(form.y)
    if (x === null || y === null) { ui.showAlert('座標を入力してください'); return false }
    const e = entries.value.find((v) => v.id === id)
    if (!e) return false
    if (findCoordDuplicate(form.type, x, y, id)) {
      const ok = await ui.showConfirm(`同じ座標(X:${x} / Y:${y})に登録済みの${typeLabel(form.type)}があります。\nこのまま保存しますか?`)
      if (!ok) return false
    }
    const sync = useSyncStore()
    const old = { type: e.type, x: e.x, y: e.y, label: e.label || '', eventAt: e.eventAt }
    e.type = form.type
    e.label = (form.label || '').trim()
    e.x = x
    e.y = y
    if (!isBlank(form.rh) || !isBlank(form.rm)) {
      e.eventAt = remainToEventAt(form.type, num0(form.rh), num0(form.rm))
      e.resultLogged = false
    }
    if (sync.chanIdOfType(old.type) && aquaKey(old) !== aquaKey(e)) sync.addTombstone(old)
    if (aquaKey(old) !== aquaKey(e) || old.label !== (e.label || '') || old.eventAt !== e.eventAt) sync.touchSync(e)
    inlineEditId.value = null
    ui.showToast('更新しました')
    return true
  }

  /** 攻撃可能タブの「更新」。成功したら true */
  function updateReady(id, hv, mv) {
    const h = num0(hv)
    const m = num0(mv)
    if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || m < 0 || m > 59) {
      ui.showAlert('時間・分を正しく入力してください（分は0〜59）')
      return false
    }
    const e = entries.value.find((v) => String(v.id) === String(id))
    if (!e) return false
    e.eventAt = remainToEventAt(e.type, h, m)
    e.resultLogged = false
    useSyncStore().touchSync(e)
    ui.showToast('更新しました')
    return true
  }

  /** 「取れた！記録する」：座標は残したまま履歴だけ追加。記録したら true */
  async function recordAttackResult(id) {
    const e = entries.value.find((v) => v.id === id)
    if (!e || isAquaFamily(e.type)) return false
    if (e.resultLogged) {
      ui.showAlert('この周期はすでに記録済みです。残り時間を更新すると、次の周期でまた記録できます。')
      return false
    }
    const ok = await ui.showConfirm('獲得できた記録を追加しますか？')
    if (!ok) return false
    const ruby = defaultRubyForType(e.type)
    attackHistory.value.push({
      id: newId(6), entryId: e.id, type: e.type, label: e.label || '', x: e.x, y: e.y,
      result: 'ruby', ruby, at: Date.now()
    })
    e.resultLogged = true
    ui.showToast('+' + ruby + 'ルビーを記録しました → 次回時間を入力')
    return true
  }

  async function deleteEntry(id) {
    const ok = await ui.showConfirm('この登録を削除しますか?')
    if (!ok) return
    const sync = useSyncStore()
    entries.value.filter((e) => e.id === id).forEach((e) => sync.addTombstone(e))
    entries.value = entries.value.filter((e) => e.id !== id)
  }

  async function clearAquaCoordinates() {
    const targets = entries.value.filter((e) => isAquaFamily(e.type))
    if (!targets.length) { ui.showToast('削除する小アクア・大アクアの座標はありません'); return }
    const small = targets.filter((e) => e.type === 'smallAqua').length
    const big = targets.filter((e) => e.type === 'aqua').length
    const ok = await ui.showConfirm(`小アクア・大アクアの座標登録をすべて削除しますか？\n対象：小アクア ${small}件 / 大アクア ${big}件\n攻撃履歴・ルビー集計は削除されません。`)
    if (!ok) return
    const sync = useSyncStore()
    targets.forEach((e) => sync.addTombstone(e))
    entries.value = entries.value.filter((e) => !isAquaFamily(e.type))
    ui.showToast('小アクア・大アクアの座標を削除しました')
  }

  /* ================= ルビー集計 ================= */
  const isCountedHistory = (x) => x.result !== 'taken' && (Number(x.ruby) || 0) > 0
  const rubySumOf = (list) => list.filter(isCountedHistory).reduce((sum, x) => sum + (Number(x.ruby) || 0), 0)

  const statsList = computed(() => {
    const t = now.value
    const key = statsDate.value || getLocalDateKey(t)
    const hist = attackHistory.value
    let list
    if (statsPeriod.value === 'all') list = hist.slice()
    else if (statsPeriod.value === 'month') { const mk = getMonthKey(t); list = hist.filter((x) => getMonthKey(x.at) === mk) }
    else if (statsPeriod.value === 'lastMonth') { const lk = lastMonthKey(t); list = hist.filter((x) => getMonthKey(x.at) === lk) }
    else if (statsPeriod.value === 'date') list = hist.filter((x) => getLocalDateKey(x.at) === key)
    else { const tk = getLocalDateKey(t); list = hist.filter((x) => getLocalDateKey(x.at) === tk) }
    return list.slice().sort((a, b) => b.at - a.at)
  })
  const rubyTotal = computed(() => rubySumOf(statsList.value))
  const rubyAverage = computed(() => {
    const t = now.value
    const counted = statsList.value.filter(isCountedHistory)
    let days = 1
    if (statsPeriod.value === 'month') days = new Date(t).getDate()
    else if (statsPeriod.value === 'lastMonth') { const ld = new Date(t); days = new Date(ld.getFullYear(), ld.getMonth(), 0).getDate() }
    else if (statsPeriod.value === 'all' && counted.length) {
      const first = Math.min.apply(null, counted.map((x) => x.at))
      const fd = new Date(first)
      const td = new Date(t)
      const firstDay = Date.UTC(fd.getFullYear(), fd.getMonth(), fd.getDate())
      const todayDay = Date.UTC(td.getFullYear(), td.getMonth(), td.getDate())
      days = Math.max(1, Math.floor((todayDay - firstDay) / 86400000) + 1)
    }
    return Math.round(rubyTotal.value / days)
  })
  const rubyMonthSummary = computed(() => {
    const t = now.value
    const thisKey = getMonthKey(t)
    const prevKey = lastMonthKey(t)
    const a = rubySumOf(attackHistory.value.filter((x) => getMonthKey(x.at) === thisKey))
    const b = rubySumOf(attackHistory.value.filter((x) => getMonthKey(x.at) === prevKey))
    return `今月 ${a.toLocaleString()} ／ 先月 ${b.toLocaleString()}（ルビー）`
  })
  function statsPeriodLabel() {
    return { today: '今日', month: '今月', lastMonth: '先月', all: '全期間', date: '指定日（' + statsDate.value + '）' }[statsPeriod.value] || ''
  }

  async function deleteHistory(id) {
    const ok = await ui.showConfirm('この記録を削除しますか?')
    if (!ok) return
    const h = attackHistory.value.find((x) => x.id === id)
    attackHistory.value = attackHistory.value.filter((x) => x.id !== id)
    useSyncStore().addHistTomb(h)
    if (h) {
      const e = entries.value.find((x) => x.id === h.entryId) ||
        entries.value.find((x) => x.type === h.type && x.x === h.x && x.y === h.y)
      if (e && e.resultLogged) e.resultLogged = false
    }
    ui.showToast('記録を削除しました')
  }

  async function resetHistory(scope) {
    const sync = useSyncStore()
    const list = scope === 'all' ? attackHistory.value.slice() : statsList.value.slice()
    if (!list.length) { ui.showToast('削除する記録はありません'); return }
    const fort = sync.channels.fort.settings
    const syncNote = fort.url && fort.mode !== 'snapshot' ? '\n※端末同期の設定中は、他の端末の記録も削除されます。' : ''
    const ok = await ui.showConfirm(
      (scope === 'all' ? 'ルビーの記録をすべて' : '「' + statsPeriodLabel() + '」の記録を') +
      '削除しますか？\n対象：' + list.length + '件（合計 ' + rubySumOf(list).toLocaleString() + 'ルビー）\nこの操作は元に戻せません。' + syncNote
    )
    if (!ok) return
    const ids = {}
    list.forEach((h) => { ids[h.id] = true; sync.addHistTomb(h) })
    attackHistory.value = attackHistory.value.filter((h) => !ids[h.id])
    ui.showToast(list.length + '件の記録を削除しました')
  }

  /* ================= バックアップ ================= */
  function exportJson() {
    return JSON.stringify({ entries: entries.value, attackHistory: attackHistory.value, trackerSettings: settings.value })
  }
  function backupFileName() {
    const d = new Date()
    return 'gge_tracker_backup_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes()) + '.json'
  }

  /** 読み込み成功なら true */
  function importRaw(raw) {
    raw = (raw || '').trim()
    if (!raw) { ui.showAlert('読み込むデータがありません'); return false }
    let imported
    try { imported = JSON.parse(raw) } catch (e) {
      ui.showAlert('データの形式が正しくありません。書き出したファイル、またはコピーした内容をそのまま使ってください。')
      return false
    }
    const sync = useSyncStore()
    let list = []
    if (Array.isArray(imported)) {
      list = imported
    } else if (imported && Array.isArray(imported.entries)) {
      imported.entries.forEach((e) => {
        list.push(Object.assign({}, e, { id: e.id, type: e.type, label: e.label || '', x: e.x, y: e.y, eventAt: e.eventAt !== undefined ? e.eventAt : e.attackableAt }))
      })
      if (Array.isArray(imported.aquaEntries)) {
        imported.aquaEntries.forEach((e) => {
          list.push({ id: e.id || ('import-aqua-' + e.x + '-' + e.y), type: 'aqua', label: e.label || '', x: e.x, y: e.y, eventAt: e.eventAt !== undefined ? e.eventAt : e.surfaceAt })
        })
      }
      // 旧形式のバックアップで種類ごとに分かれている座標配列も読み込む
      const legacyDefs = [
        { keys: ['wildFortressEntries', 'wildFortresses', 'wildFortress'], type: 'wildFortress', timeKeys: ['eventAt', 'attackableAt', 'respawnAt', 'availableAt'] },
        { keys: ['fortressEntries', 'desertFortressEntries', 'fortresses', 'desertFortresses'], type: 'fortress', timeKeys: ['eventAt', 'attackableAt', 'respawnAt', 'availableAt'] },
        { keys: ['dragonEntries', 'dragons'], type: 'dragon', timeKeys: ['eventAt', 'attackableAt', 'respawnAt', 'availableAt'] },
        { keys: ['smallAquaEntries', 'smallAquas'], type: 'smallAqua', timeKeys: ['eventAt', 'surfaceAt', 'attackableAt', 'respawnAt'] }
      ]
      legacyDefs.forEach((def) => {
        def.keys.forEach((keyName) => {
          if (!Array.isArray(imported[keyName])) return
          imported[keyName].forEach((e, i) => {
            let tm
            for (let ti = 0; ti < def.timeKeys.length; ti++) {
              if (e[def.timeKeys[ti]] !== undefined) { tm = e[def.timeKeys[ti]]; break }
            }
            list.push({
              id: e.id || ('import-' + def.type + '-' + e.x + '-' + e.y + '-' + i),
              type: def.type, label: e.label || '', x: e.x, y: e.y,
              eventAt: tm !== undefined ? tm : Date.now()
            })
          })
        })
      })
    }
    if (imported && Array.isArray(imported.attackHistory)) {
      imported.attackHistory.forEach((h) => {
        if (!attackHistory.value.some((x) => x.id === h.id)) {
          const hh = Object.assign({}, h)
          delete hh.synced
          attackHistory.value.push(hh)
        }
      })
    }
    // 自分の城の座標・表示設定・距離フィルター設定もバックアップから復元
    if (imported && imported.trackerSettings && typeof imported.trackerSettings === 'object') {
      const inc = imported.trackerSettings
      const s = settings.value
      s.enabled = Object.assign({}, s.enabled || {}, inc.enabled || {})
      s.near50 = Object.assign({}, s.near50 || {}, inc.near50 || {})
      s.nearDistance = Object.assign({}, s.nearDistance || {}, inc.nearDistance || {})
      s.homeCoords = Object.assign({}, s.homeCoords || {}, inc.homeCoords || {})
      DISTANCE_TYPES.forEach((t) => {
        const h = s.homeCoords[t] || {}
        s.homeCoords[t] = { x: h.x == null ? '' : h.x, y: h.y == null ? '' : h.y }
      })
      if (inc.homeX !== undefined) s.homeX = inc.homeX
      if (inc.homeY !== undefined) s.homeY = inc.homeY
    }
    // 同じIDまたは種類＋座標の登録は、新しい時刻のときだけ更新する（重複追加しない）
    const existingIds = {}
    const existingCoords = {}
    const coordKey = (item) => {
      if (!item || item.type == null || item.x == null || item.y == null || item.x === '' || item.y === '') return null
      return String(item.type) + '|' + String(Number(item.x)) + '|' + String(Number(item.y))
    }
    entries.value.forEach((e, index) => {
      if (e.id != null) existingIds[e.id] = index
      const key = coordKey(e)
      if (key !== null && existingCoords[key] === undefined) existingCoords[key] = index
    })
    let added = 0, updated = 0, skipped = 0
    list.forEach((item) => {
      if (!item || !ALL_TYPES.includes(item.type) || item.x == null || item.y == null) return
      if (!item.id) item.id = 'import-' + item.type + '-' + item.x + '-' + item.y
      const noTime = item.eventAt == null || !Number.isFinite(Number(item.eventAt))
      item.eventAt = noTime ? Date.now() : Number(item.eventAt)
      const key = coordKey(item)
      let index = existingIds[item.id]
      if (index === undefined && key !== null) index = existingCoords[key]
      if (index !== undefined) {
        const oldEntry = entries.value[index]
        if (noTime || item.eventAt <= Number(oldEntry.eventAt)) { skipped++; return }
        const nextEntry = Object.assign({}, oldEntry, item)
        if (nextEntry.eventAt !== oldEntry.eventAt) nextEntry.resultLogged = false
        sync.touchSync(nextEntry)
        entries.value[index] = nextEntry
        if (nextEntry.id != null) existingIds[nextEntry.id] = index
        const nk = coordKey(nextEntry)
        if (nk !== null) existingCoords[nk] = index
        updated++
        return
      }
      if (item.updatedAt == null) sync.touchSync(item)
      entries.value.push(item)
      existingIds[item.id] = entries.value.length - 1
      if (key !== null) existingCoords[key] = entries.value.length - 1
      added++
    })
    ui.showAlert(`新規追加 ${added}件、既存データ更新 ${updated}件、更新なし ${skipped}件。` + (skipped ? '\n（更新なし＝現在のデータの方が新しい、または同じ時刻だったもの）' : ''))
    return true
  }

  return {
    // state
    entries, attackHistory, settings, userId, now,
    searchQuery, typeFilter, sortMode, readyTypeFilter, inlineEditId, statsPeriod, statsDate,
    // getters
    waitingList, readyList, resultSummary, countSummary, nearWarning, nearCounts,
    statsList, rubyTotal, rubyAverage, rubyMonthSummary,
    // actions
    tick, resetFilters, coordDistance, hasHome, shouldNotifyEntry, saveSettings, setUserId,
    findCoordDuplicate, submitNew, submitBulk, startEdit, cancelEdit, submitEdit, updateReady,
    recordAttackResult, deleteEntry, clearAquaCoordinates,
    isCountedHistory, statsPeriodLabel, deleteHistory, resetHistory,
    exportJson, backupFileName, importRaw
  }
})