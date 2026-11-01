import { SURFACE_INTERVAL_MS, SMALL_AQUA_INTERVAL_MS } from './constants'

export function pad(n) { return String(n).padStart(2, '0') }

export function formatDuration(ms) {
  if (ms <= 0) return '0'
  const totalSec = Math.floor(ms / 1000)
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  const secs = totalSec % 60
  if (days > 0) return days + '日 ' + pad(hours) + ':' + pad(mins) + ':' + pad(secs)
  return pad(hours) + ':' + pad(mins) + ':' + pad(secs)
}

export function formatClock(value) {
  const d = value instanceof Date ? value : new Date(value)
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

export function typeLabel(t) {
  if (t === 'dragon') return 'ドラゴン'
  if (t === 'fortress') return '砂漠の要塞'
  if (t === 'aqua') return '嵐の島(大アクア)'
  if (t === 'smallAqua') return '小アクア'
  if (t === 'wildFortress') return '野生の要塞'
  return t
}

export function typeClass(t) {
  if (t === 'dragon') return 'dragon'
  if (t === 'wildFortress') return 'wild'
  if (t === 'smallAqua') return 'smallAqua'
  if (t === 'aqua') return 'aqua'
  return 'fortress'
}

export function isAquaFamily(t) { return t === 'aqua' || t === 'smallAqua' }

export function intervalForType(t) {
  return t === 'aqua' ? SURFACE_INTERVAL_MS : (t === 'smallAqua' ? SMALL_AQUA_INTERVAL_MS : 0)
}

export function defaultRubyForType(type) {
  if (type === 'dragon') return 370
  if (type === 'fortress') return 280
  if (type === 'wildFortress') return 50
  return 0
}

export function getLocalDateKey(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}
export function getMonthKey(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1)
}
export function lastMonthKey(ms) {
  let d = new Date(ms)
  d = new Date(d.getFullYear(), d.getMonth() - 1, 1)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1)
}

export function aquaKey(o) { return o.type + '|' + Number(o.x) + '|' + Number(o.y) }

export function isBlank(v) { return v === '' || v === null || v === undefined }
/** 空欄・数値でない場合は null、それ以外は数値 */
export function toNum(v) {
  if (isBlank(v)) return null
  const n = Number(v)
  return Number.isNaN(n) ? null : n
}

export function newId(len = 7) {
  return Date.now() + '-' + Math.random().toString(36).slice(2, 2 + len)
}

export function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch (e) {
    return fallback
  }
}
export function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch (e) { /* 容量超過などは無視 */ }
}
export function asArray(v) { return Array.isArray(v) ? v : [] }
export function asObject(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {} }
