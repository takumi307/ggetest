import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import {
  STORAGE_KEY, LEGACY_MAIN_KEY, LEGACY_AQUA_KEY, TRACKER_SETTINGS_KEY, HISTORY_KEY, USER_ID_KEY,
  DISTANCE_TYPES, DISTANCE_TYPE_LIST, ALL_TYPES, FORT_TYPES, FORT_SHARED_COOLDOWN_MS, FORT_MEMBER_COOLDOWN_MS
} from '@/utils/constants'
import {
  pad, typeLabel, isAquaFamily, intervalForType, defaultRubyForType, getLocalDateKey, getMonthKey,
  lastMonthKey, aquaKey, isBlank, toNum, newId, loadJson, saveJson, asArray, asObject, formatClock
} from '@/utils/helpers'
import { useUiStore } from './uiStore'
import { useSyncStore } from './syncStore'
import { useEntryPreferencesStore } from './entryPreferencesStore'
import { fortAttackableAt } from '@/utils/fortTiming'

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

function validHome(home) {
  return home && !isBlank(home.x) && !isBlank(home.y) && Number.isFinite(Number(home.x)) && Number.isFinite(Number(home.y))
}

function legacyStormHome(homes) {
  return [homes?.aqua, homes?.smallAqua].find(validHome)
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
  s.homeCoords.storm ||= legacyStormHome(s.homeCoords) || { x: '', y: '' }
  DISTANCE_TYPES.forEach((t) => {
    if (!s.homeCoords[t]) s.homeCoords[t] = isAquaFamily(t) ? { x: '', y: '' } : { x: s.homeX ?? '', y: s.homeY ?? '' }
  })
  return s
}

export const useTrackerStore = defineStore('tracker', () => {
  const ui = useUiStore()
  const preferences = useEntryPreferencesStore()

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
  const readyNearestOnly = ref(false)
  const inlineEditId = ref(null)
  const statsPeriod = ref('month')
  const statsDate = ref(getLocalDateKey(Date.now()))
  const pendingTimerUpdate = ref(null)
  let timerCommit

  // localStorageへの保存（変更があれば自動で保存）
  watch(entries, (v) => saveJson(STORAGE_KEY, v), { deep: true })
  watch(attackHistory, (v) => saveJson(HISTORY_KEY, v), { deep: true })
  watch(settings, (v) => saveJson(TRACKER_SETTINGS_KEY, v), { deep: true })
  watch(userId, (v) => saveJson(USER_ID_KEY, v))

  function moveAquaLabel(entry) {
    if (!isAquaFamily(entry.type)) return
    preferences.seed(userId.value, entry, 'label', String(entry.label || '').trim().slice(0, 50))
    entry.label = ''
  }
  entries.value.forEach(moveAquaLabel)

  const entryLabel = (entry) => isAquaFamily(entry.type) ? preferences.get(userId.value, entry, 'label')?.value || '' : String(entry.label || '')
  const isFavorite = (entry) => preferences.get(userId.value, entry, 'favorite')?.value === '1'
  function toggleFavorite(entry) { preferences.set(userId.value, entry, 'favorite', isFavorite(entry) ? '' : '1') }

  function tick() { now.value = Date.now() }

  /* ================= 距離フィルター ================= */
  function stormHome() {
    const profile = useSyncStore().stormProfile()
    return profile?.enabled ? { x: profile.x, y: profile.y } : settings.value.homeCoords.storm
  }
  function homeOf(t) {
    const h = isAquaFamily(t) ? stormHome() : settings.value.homeCoords[t]
    return validHome(h) ? h : null
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

  function widgetDisplayRules() {
    const revision = settings.value.widgetDisplayRevision
    const updatedAt = revision?.userId === userId.value ? revision.updatedAt : 1
    const rules = Object.fromEntries(ALL_TYPES.map((type) => {
      const home = nearFilterActive(type) ? homeOf(type) : null
      return [type, {
        enabled: settings.value.enabled[type] !== false,
        ...(home ? { x: Number(home.x), y: Number(home.y), limit: limitOf(type) } : {})
      }]
    }))
    return { updatedAt, rules }
  }

  function touchWidgetDisplay() {
    const previous = settings.value.widgetDisplayRevision?.updatedAt || 0
    settings.value.widgetDisplayRevision = { userId: userId.value, updatedAt: Math.max(Date.now(), previous + 1) }
  }

  /* ================= 一覧・攻撃可能の絞り込み ================= */
  function matchesQuery(e) {
    const query = searchQuery.value.trim().toLowerCase()
    if (!query) return true
    // X座標とY座標のペア検索に対応（例: 662 715 / X:662 Y:715 / 662,715）
    const nums = query.match(/-?\d+(?:\.\d+)?/g)
    if (nums && nums.length >= 2 && String(e.x) === nums[0] && String(e.y) === nums[1]) return true
    const hay = String(e.x) + ' ' + String(e.y) + ' ' + entryLabel(e)
    return hay.toLowerCase().indexOf(query) !== -1
  }

  const rubyById = computed(() => new Map(attackHistory.value.filter(isCountedHistory).map((h) => [h.id, h])))
  const hasRubyHistory = (id) => rubyById.value.has(id)

  function attackableAt(e) {
    const update = pendingTimerUpdate.value
    if (update?.id === e.id && timerUpdateMatches(update, e)) e = update.preview
    if (!FORT_TYPES.includes(e.type)) return Number(e.eventAt)
    const timing = useSyncStore().fortCooldown(e)
    const ruby = rubyById.value.get(timing.historyId)
    if (!ruby || aquaKey(ruby) !== aquaKey(e)) timing.personalAt = null
    return fortAttackableAt(Number(e.eventAt), timing)
  }

  function pendingRubyFor(e) {
    const ruby = rubyById.value.get(e.pendingRubyId)
    return ruby && aquaKey(ruby) === aquaKey(e) ? ruby : null
  }

  function winnerHistoryId(e) {
    if (!FORT_TYPES.includes(e.type)) return undefined
    const pending = pendingRubyFor(e)
    if (pending) return pending.id
    const { personalAt, historyId } = useSyncStore().fortCooldown(e)
    const ruby = rubyById.value.get(historyId)
    return personalAt > now.value && ruby && aquaKey(ruby) === aquaKey(e) ? historyId : undefined
  }

  function sortEntries(list) {
    const mode = sortMode.value
    return list.slice().sort((a, b) => {
      const favorites = Number(isFavorite(b)) - Number(isFavorite(a))
      if (favorites) return favorites
      if (mode === 'timeDesc') return attackableAt(b) - attackableAt(a)
      if (mode === 'coordAsc') return Number(a.x) - Number(b.x) || Number(a.y) - Number(b.y)
      if (mode === 'coordDesc') return Number(b.x) - Number(a.x) || Number(b.y) - Number(a.y)
      if (mode === 'type') return typeLabel(a.type).localeCompare(typeLabel(b.type), 'ja') || attackableAt(a) - attackableAt(b)
      if (mode === 'label') return entryLabel(a).localeCompare(entryLabel(b), 'ja') || attackableAt(a) - attackableAt(b)
      return attackableAt(a) - attackableAt(b)
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
  const isLost = (entry) => useSyncStore().isAquaLost(entry)
  const lostList = computed(() => sortEntries(filteredMain.value.filter(isLost)))
  const waitingList = computed(() => sortEntries(filteredMain.value.filter((e) => !isLost(e) && attackableAt(e) > now.value)))
  const resultSummary = computed(() => `${filteredMain.value.length}件中 ${waitingList.value.length}件が攻撃待ち`)

  const readyList = computed(() => {
    const filtered = entries.value.filter((e) => {
      if (isLost(e)) return false
      if (settings.value.enabled[e.type] === false) return false
      if (readyTypeFilter.value !== 'all' && e.type !== readyTypeFilter.value) return false
      if (readyNearestOnly.value && (!isAquaFamily(e.type) || !useSyncStore().nearestFor(e)?.users.includes(userId.value))) return false
      if (!passesNear(e)) return false
      return matchesQuery(e)
    })
    return sortEntries(filtered.filter((e) => attackableAt(e) <= now.value))
  })

  const countSummary = computed(() => {
    const c = (t) => entries.value.filter((e) => e.type === t).length
    return `登録: ドラゴン${c('dragon')} / 要塞${c('fortress')} / 大アクア${c('aqua')} / 小アクア${c('smallAqua')} / 野生の要塞${c('wildFortress')}(計${entries.value.length}件)`
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
    if (draft.shareStorm && !validHome(draft.storm)) {
      ui.showAlert('最寄り比較に参加するには、嵐の島のX座標とY座標を入力してください。')
      return
    }
    const s = settings.value
    Object.keys(draft.enabled).forEach((t) => { s.enabled[t] = !!draft.enabled[t] })
    Object.keys(draft.near50).forEach((t) => { s.near50[t] = !!draft.near50[t] })
    Object.keys(draft.nearDistance).forEach((t) => {
      const raw = draft.nearDistance[t]
      const v = Number(raw)
      s.nearDistance[t] = (raw === '' || raw == null || !Number.isFinite(v) || v < 0) ? 50 : v
    })
    s.homeCoords = s.homeCoords || {}
    FORT_TYPES.forEach((t) => {
      const h = draft.home[t] || {}
      s.homeCoords[t] = { x: h.x == null ? '' : h.x, y: h.y == null ? '' : h.y }
    })
    if (draft.storm) {
      s.homeCoords.storm = { ...draft.storm }
      useSyncStore().updateStormProfile({ x: Number(draft.storm.x), y: Number(draft.storm.y) }, !!draft.shareStorm)
    }
    touchWidgetDisplay()
    ui.showToast('設定を保存しました')
  }

  function setUserId(v) {
    const next = String(v || '').trim()
    if (!userId.value && next) preferences.adoptGuest(next)
    userId.value = next
  }

  /* ================= 登録・編集・削除 ================= */
  function findCoordDuplicate(type, x, y, excludeId = null) {
    return entries.value.find((e) => e.type === type && e.x === x && e.y === y && e.id !== excludeId)
  }
  const num0 = (v) => (isBlank(v) ? 0 : Number(v))

  function enteredDuration(type, hv, mv, sv, historyId) {
    const h = num0(hv)
    const m = num0(mv)
    const aqua = isAquaFamily(type)
    const s = aqua ? num0(sv) : 0
    const ms = (h * 3600 + m * 60 + s) * 1000
    if (!Number.isInteger(h) || !Number.isInteger(m) || !Number.isInteger(s) || h < 0 ||
        m < 0 || m > 59 || s < 0 || s > 59 || !Number.isSafeInteger(ms)) {
      ui.showAlert(aqua ? '時間・分・秒を正しく入力してください（分と秒は0〜59）' : '時間・分を正しく入力してください（分は0〜59）')
      return null
    }
    const limit = historyId ? FORT_SHARED_COOLDOWN_MS : FORT_MEMBER_COOLDOWN_MS
    if (FORT_TYPES.includes(type) && ms > limit) {
      ui.showAlert(historyId ? '獲得した場合の残り時間は120時間以内で入力してください' : '取れなかった場合の残り時間は24時間以内です。獲得した場合は先にルビー獲得を記録してください。')
      return null
    }
    return ms
  }

  function setEnteredTime(entry, duration, historyId, enteredAt = Date.now()) {
    entry.eventAt = enteredAt + duration + intervalForType(entry.type)
    if (FORT_TYPES.includes(entry.type)) {
      useSyncStore().queueFortCooldown(entry, enteredAt, historyId)
    }
    entry.resultLogged = false
    delete entry.pendingRubyId
  }

  function timerUpdateMatches(update, entry) {
    return !!entry && update.userId === userId.value && update.key === aquaKey(entry) &&
      update.eventAt === entry.eventAt && update.pendingRubyId === entry.pendingRubyId &&
      (!update.historyId || hasRubyHistory(update.historyId)) &&
      (isAquaFamily(entry.type) || update.version === useSyncStore().timerVersion(entry))
  }

  function clearTimerUpdate() {
    clearTimeout(timerCommit)
    const update = pendingTimerUpdate.value
    pendingTimerUpdate.value = null
    return update
  }

  function reconcileTimerUpdate() {
    const update = pendingTimerUpdate.value
    if (update && !timerUpdateMatches(update, entries.value.find((entry) => entry.id === update.id))) {
      clearTimerUpdate()
      ui.showToast('最新のタイマー更新を反映しました')
    }
  }

  function commitTimerUpdate() {
    reconcileTimerUpdate()
    const update = clearTimerUpdate()
    if (!update) return
    const entry = entries.value.find((item) => item.id === update.id)
    setEnteredTime(entry, update.duration, update.historyId, update.enteredAt)
    useSyncStore().touchSync(entry, Math.max(update.enteredAt, (Number(entry.updatedAt) || 0) + 1))
    saveJson(STORAGE_KEY, entries.value)
  }

  function stageTimerUpdate(entry, duration, historyId) {
    const enteredAt = Date.now()
    const preview = { ...entry }
    setEnteredTime(preview, duration, historyId, enteredAt)
    pendingTimerUpdate.value = { id: entry.id, key: aquaKey(entry), userId: userId.value,
      eventAt: entry.eventAt, pendingRubyId: entry.pendingRubyId, version: useSyncStore().timerVersion(entry),
      duration, historyId, enteredAt, preview }
    timerCommit = setTimeout(commitTimerUpdate, 8000)
  }

  function undoTimerUpdate() {
    reconcileTimerUpdate()
    if (clearTimerUpdate()) ui.showToast('前のタイマーに戻しました')
  }

  /** 新規登録。成功したら true */
  async function submitNew(form) {
    const x = toNum(form.x)
    const y = toNum(form.y)
    if (x === null || y === null) { ui.showAlert('座標を入力してください'); return false }
    if (findCoordDuplicate(form.type, x, y)) {
      const ok = await ui.showConfirm(`同じ座標(X:${x} / Y:${y})に登録済みの${typeLabel(form.type)}があります。\n続けて登録しますか?`)
      if (!ok) return false
    }
    const entry = { id: newId(5), type: form.type, label: (form.label || '').trim(), x, y, eventAt: Date.now() }
    if (!isBlank(form.rh) || !isBlank(form.rm) || (isAquaFamily(form.type) && !isBlank(form.rs))) {
      const duration = enteredDuration(form.type, form.rh, form.rm, form.rs)
      if (duration === null) return false
      setEnteredTime(entry, duration)
    }
    if (isAquaFamily(entry.type)) {
      if (entry.label) preferences.set(userId.value, entry, 'label', entry.label.slice(0, 50))
      entry.label = ''
    }
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
    const hasTime = !isBlank(form.rh) || !isBlank(form.rm) || (isAquaFamily(form.type) && !isBlank(form.rs))
    const sameCoord = aquaKey(e) === aquaKey({ type: form.type, x, y })
    const historyId = sameCoord ? winnerHistoryId(e) : undefined
    const duration = hasTime ? enteredDuration(form.type, form.rh, form.rm, form.rs, historyId) : null
    if (hasTime && duration === null) return false
    if (findCoordDuplicate(form.type, x, y, id)) {
      const ok = await ui.showConfirm(`同じ座標(X:${x} / Y:${y})に登録済みの${typeLabel(form.type)}があります。\nこのまま保存しますか?`)
      if (!ok) return false
    }
    if (hasTime || !sameCoord) commitTimerUpdate()
    const sync = useSyncStore()
    const old = { type: e.type, x: e.x, y: e.y, label: e.label || '', eventAt: e.eventAt }
    e.type = form.type
    e.label = (form.label || '').trim()
    e.x = x
    e.y = y
    if (isAquaFamily(e.type)) {
      preferences.set(userId.value, e, 'label', e.label.slice(0, 50))
      e.label = ''
    }
    if (aquaKey(old) !== aquaKey(e)) {
      delete e.pendingCooldown
      delete e.pendingRubyId
    }
    if (hasTime && sameCoord) stageTimerUpdate(e, duration, historyId)
    else if (hasTime) setEnteredTime(e, duration, historyId)
    if (sync.chanIdOfType(old.type) && aquaKey(old) !== aquaKey(e)) sync.addTombstone(old)
    if (aquaKey(old) !== aquaKey(e) || old.label !== (e.label || '') || old.eventAt !== e.eventAt) sync.touchSync(e)
    inlineEditId.value = null
    if (!hasTime || !sameCoord) ui.showToast('更新しました')
    return true
  }

  /** 攻撃可能タブの「更新」。成功したら true */
  function updateReady(id, hv, mv, sv) {
    const e = entries.value.find((v) => String(v.id) === String(id))
    if (!e) return false
    if (FORT_TYPES.includes(e.type) && isBlank(hv) && isBlank(mv)) {
      ui.showAlert('ゲームに表示されているクールタイムの残りを入力してください')
      return false
    }
    const historyId = winnerHistoryId(e)
    const duration = enteredDuration(e.type, hv, mv, sv, historyId)
    if (duration === null) return false
    commitTimerUpdate()
    stageTimerUpdate(e, duration, historyId)
    return true
  }

  /** 「取れた！記録する」：座標は残したまま履歴だけ追加。記録したら true */
  async function recordAttackResult(id) {
    const e = entries.value.find((v) => v.id === id)
    if (!e || isAquaFamily(e.type)) return false
    if (winnerHistoryId(e)) {
      ui.showAlert('この座標のルビー獲得は記録済みです。時間を修正するには「編集」を開いてください。')
      return false
    }
    const ok = await ui.showConfirm('獲得できた記録を追加しますか？')
    if (!ok) return false
    if (pendingTimerUpdate.value?.id === id) clearTimerUpdate()
    const ruby = defaultRubyForType(e.type)
    const historyId = newId(6)
    attackHistory.value.push({
      id: historyId, entryId: e.id, type: e.type, label: e.label || '', x: e.x, y: e.y,
      result: 'ruby', ruby, at: Date.now()
    })
    e.resultLogged = true
    e.pendingRubyId = historyId
    ui.showToast('+' + ruby + 'ルビーを記録しました → 次回時間を入力')
    return true
  }

  async function deleteEntry(id) {
    const ok = await ui.showConfirm('この登録を削除しますか?')
    if (!ok) return
    if (pendingTimerUpdate.value?.id === id) clearTimerUpdate()
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
    if (pendingTimerUpdate.value && !entries.value.some((entry) => entry.id === pendingTimerUpdate.value.id)) clearTimerUpdate()
    ui.showToast('小アクア・大アクアの座標を削除しました')
  }

  /* ================= ルビー集計 ================= */
  const isCountedHistory = (x) => x.result !== 'taken' && (Number(x.ruby) || 0) > 0
  const rubySumOf = (list) => list.filter(isCountedHistory).reduce((sum, x) => sum + (Number(x.ruby) || 0), 0)

  const statsToday = computed(() => getLocalDateKey(now.value))
  const statsList = computed(() => {
    const today = statsToday.value
    const key = statsDate.value || today
    const hist = attackHistory.value
    let list
    if (statsPeriod.value === 'all') list = hist.slice()
    else if (statsPeriod.value === 'month') { const mk = today.slice(0, 7); list = hist.filter((x) => getMonthKey(x.at) === mk) }
    else if (statsPeriod.value === 'lastMonth') { const lk = lastMonthKey(today + 'T12:00:00'); list = hist.filter((x) => getMonthKey(x.at) === lk) }
    else if (statsPeriod.value === 'date') list = hist.filter((x) => getLocalDateKey(x.at) === key)
    else list = hist.filter((x) => getLocalDateKey(x.at) === today)
    return list.slice().sort((a, b) => b.at - a.at)
  })
  const rubyTotal = computed(() => rubySumOf(statsList.value))
  const rubyAverage = computed(() => {
    const t = statsToday.value + 'T12:00:00'
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
    const t = statsToday.value + 'T12:00:00'
    const thisKey = getMonthKey(t)
    const prevKey = lastMonthKey(t)
    const a = rubySumOf(attackHistory.value.filter((x) => getMonthKey(x.at) === thisKey))
    const b = rubySumOf(attackHistory.value.filter((x) => getMonthKey(x.at) === prevKey))
    return `今月 ${a.toLocaleString()} ／ 先月 ${b.toLocaleString()}（ルビー）`
  })
  function statsPeriodLabel() {
    return { today: '今日', month: '今月', lastMonth: '先月', all: '全期間', date: '指定日（' + statsDate.value + '）' }[statsPeriod.value] || ''
  }

  async function deleteHistory(id, undoAcquisition = false) {
    const ok = await ui.showConfirm(undoAcquisition ? 'このルビー獲得記録を取り消しますか？' : 'この記録を削除しますか?')
    if (!ok) return false
    const h = attackHistory.value.find((x) => x.id === id)
    if (!h) return false
    if (pendingTimerUpdate.value?.historyId === id) clearTimerUpdate()
    const sync = useSyncStore()
    tick()
    for (const entry of entries.value) {
      if (aquaKey(entry) !== aquaKey(h)) continue
      const { personalAt, historyId } = sync.fortCooldown(entry)
      if (historyId === id && Number(entry.eventAt) === personalAt) {
        entry.eventAt = now.value
        sync.touchSync(entry)
      }
      if (entry.pendingCooldown?.historyId === id) delete entry.pendingCooldown
      if (entry.pendingRubyId === id) delete entry.pendingRubyId
      if (!entry.pendingRubyId) entry.resultLogged = false
    }
    attackHistory.value = attackHistory.value.filter((x) => x.id !== id)
    sync.addHistTomb(h)
    ui.showToast(undoAcquisition ? 'ルビー獲得を取り消しました' : '記録を削除しました')
    return true
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
    const backupEntries = entries.value.map((entry) => ({ ...entry, label: entryLabel(entry), favorite: isFavorite(entry) }))
    const { widgetDisplayRevision, ...trackerSettings } = settings.value
    return JSON.stringify({ entries: backupEntries, attackHistory: attackHistory.value, trackerSettings })
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
      if (!inc.homeCoords?.storm) s.homeCoords.storm = legacyStormHome(inc.homeCoords) || s.homeCoords.storm
      DISTANCE_TYPES.forEach((t) => {
        const h = s.homeCoords[t] || {}
        s.homeCoords[t] = { x: h.x == null ? '' : h.x, y: h.y == null ? '' : h.y }
      })
      if (inc.homeX !== undefined) s.homeX = inc.homeX
      if (inc.homeY !== undefined) s.homeY = inc.homeY
      touchWidgetDisplay()
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
      moveAquaLabel(item)
      if (item.favorite === true) preferences.seed(userId.value, item, 'favorite', '1')
      delete item.favorite
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
    entries, attackHistory, settings, userId, now, attackableAt, winnerHistoryId, hasRubyHistory,
    entryLabel, isFavorite, toggleFavorite,
    searchQuery, typeFilter, sortMode, readyTypeFilter, readyNearestOnly, inlineEditId, statsPeriod, statsDate,
    pendingTimerUpdate, undoTimerUpdate, commitTimerUpdate, reconcileTimerUpdate,
    // getters
    waitingList, readyList, lostList, resultSummary, countSummary, nearWarning, nearCounts,
    statsList, rubyTotal, rubyAverage, rubyMonthSummary,
    // actions
    tick, resetFilters, coordDistance, hasHome, stormHome, shouldNotifyEntry, widgetDisplayRules, saveSettings, setUserId,
    findCoordDuplicate, submitNew, submitBulk, startEdit, cancelEdit, submitEdit, updateReady,
    recordAttackResult, deleteEntry, clearAquaCoordinates,
    isCountedHistory, statsPeriodLabel, deleteHistory, resetHistory,
    exportJson, backupFileName, importRaw
  }
})
