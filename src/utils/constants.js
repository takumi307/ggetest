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
export const SYNC_RETRY_MS = 5 * 60 * 1000

export const ALL_TYPES = ['wildFortress', 'fortress', 'dragon', 'aqua', 'smallAqua']
export const DISTANCE_TYPES = ['dragon', 'fortress', 'wildFortress']

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
  ['aqua', '嵐の島（大アクア）'],
  ['smallAqua', '小アクア']
]

export const DISTANCE_TYPE_LIST = [
  ['dragon', 'ドラゴン'],
  ['fortress', '砂漠の要塞'],
  ['wildFortress', '野生の要塞']
]

export const SORT_OPTIONS = [
  { value: 'timeAsc', label: '攻撃可能になる順' },
  { value: 'timeDesc', label: '攻撃可能になる遅い順' },
  { value: 'coordAsc', label: '座標順(X→Y)' },
  { value: 'coordDesc', label: '座標順(X→Y)逆順' },
  { value: 'type', label: '種類順' },
  { value: 'label', label: 'ラベル順' }
]

export const CHANNEL_IDS = ['aqua', 'fort']

/* 同期チャンネル：①アクア（大・小・全員で共通） ②要塞・ドラゴン（ユーザーごと） */
export const SYNC_CHANNELS = {
  aqua: {
    id: 'aqua',
    name: 'アクア',
    types: ['aqua', 'smallAqua'],
    settingsKey: 'ggeAquaSyncSettings',
    tombKey: 'ggeAquaTombstones',
    intervalMs: 0, // 0 = 1日1回（日付が変わって最初に開いた時）
    defaults: { url: '', token: '', lastSyncDate: '', lastSyncAt: 0 }
  },
  fort: {
    id: 'fort',
    name: '要塞・ドラゴン',
    types: ['dragon', 'fortress', 'wildFortress'],
    settingsKey: 'ggeFortSyncSettings',
    tombKey: 'ggeFortTombstones',
    intervalMs: 5 * 60 * 1000, // 5分おき（ページを開いている間）
    defaults: { url: '', token: '', lastSyncDate: '', lastSyncAt: 0, histCursor: 0, histUnsupported: false }
  }
}

/* Discord通知の対象にできる種類（通知設定の画面で使う） */
export const NOTIFY_TYPE_LIST = {
  aqua: [['aqua', '大アクア'], ['smallAqua', '小アクア']],
  fort: [['dragon', 'ドラゴン'], ['fortress', '砂漠の要塞'], ['wildFortress', '野生の要塞']]
}

export const LEAD_OPTIONS = [0, 5, 10, 15, 20, 30, 45, 60]
