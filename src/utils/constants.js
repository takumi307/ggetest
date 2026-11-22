/* localStorageのキー（元のHTMLと同じ名前。バックアップ互換のため変更しない） */
export const STORAGE_KEY = 'ggeUnifiedEntries'
export const LEGACY_MAIN_KEY = 'ggeTrackerEntries'
export const LEGACY_AQUA_KEY = 'ggeAquaEntries'
export const TRACKER_SETTINGS_KEY = 'ggeTrackerSettings'
export const HISTORY_KEY = 'ggeAttackHistory'
export const USER_ID_KEY = 'ggeUserId'
export const SYNC_LOG_KEY = 'ggeAquaSyncLog'
export const HIST_TOMB_KEY = 'ggeFortHistTombs'

export const SURFACE_INTERVAL_MS = 72 * 3600 * 1000
export const SMALL_AQUA_INTERVAL_MS = 32 * 3600 * 1000
export const TOMB_KEEP_MS = 60 * 24 * 3600 * 1000
export const HIST_TOMB_KEEP_MS = 180 * 24 * 3600 * 1000
export const SHARED_SYNC_INTERVAL_MS = 5 * 60 * 1000
export const FORT_SHARED_COOLDOWN_MS = 120 * 3600 * 1000
export const FORT_MEMBER_COOLDOWN_MS = 24 * 3600 * 1000
export const FORT_COOLDOWN_OFFSET_MS = FORT_SHARED_COOLDOWN_MS - FORT_MEMBER_COOLDOWN_MS
export const FORT_CYCLE_TOLERANCE_MS = 5 * 60 * 1000

export const ALL_TYPES = ['wildFortress', 'fortress', 'dragon', 'aqua', 'smallAqua']
export const FORT_TYPES = ['dragon', 'fortress', 'wildFortress']
export const DISTANCE_TYPES = [...FORT_TYPES, 'aqua', 'smallAqua']

export const TYPE_OPTIONS = [
  { value: 'wildFortress', label: '野生の要塞' },
  { value: 'fortress', label: '砂漠の要塞' },
  { value: 'dragon', label: 'ドラゴン' },
  { value: 'aqua', label: '大アクア' },
  { value: 'smallAqua', label: '小アクア' }
]

export const DISPLAY_TYPE_LIST = [
  ['dragon', 'ドラゴン'],
  ['fortress', '砂漠の要塞'],
  ['wildFortress', '野生の要塞'],
  ['aqua', '大アクア'],
  ['smallAqua', '小アクア']
]

export const DISTANCE_TYPE_LIST = DISPLAY_TYPE_LIST

export const SORT_OPTIONS = [
  { value: 'timeAsc', label: '攻撃可能になる順' },
  { value: 'timeDesc', label: '攻撃可能になる遅い順' },
  { value: 'coordAsc', label: '座標順(X→Y)' },
  { value: 'coordDesc', label: '座標順(X→Y)逆順' },
  { value: 'type', label: '種類順' },
  { value: 'label', label: 'ラベル順' }
]

export const CHANNEL_IDS = ['aqua', 'fort']

/* アクアは全員で共有。要塞・ドラゴンは120時間タイマーを共有し、座標と履歴はユーザーIDごと。 */
export const SYNC_CHANNELS = {
  aqua: {
    id: 'aqua',
    name: 'アクア',
    types: ['aqua', 'smallAqua'],
    settingsKey: 'ggeAquaSyncSettings',
    tombKey: 'ggeAquaTombstones',
    defaults: { url: '', token: '', lastSyncDate: '', lastSyncAt: 0 }
  },
  fort: {
    id: 'fort',
    name: '要塞・ドラゴン',
    types: ['dragon', 'fortress', 'wildFortress'],
    settingsKey: 'ggeFortSyncSettings',
    tombKey: 'ggeFortTombstones',
    defaults: { url: '', token: '', lastSyncDate: '', lastSyncAt: 0, histCursor: 0, histUnsupported: false }
  }
}

/* Discord通知の対象にできる種類（通知設定の画面で使う） */
export const NOTIFY_TYPE_LIST = {
  aqua: [['aqua', '大アクア'], ['smallAqua', '小アクア']],
  fort: [['dragon', 'ドラゴン'], ['fortress', '砂漠の要塞'], ['wildFortress', '野生の要塞']]
}

export const LEAD_OPTIONS = [0, 5, 10, 15, 20, 30, 45, 60]
