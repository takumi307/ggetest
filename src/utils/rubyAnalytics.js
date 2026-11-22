import { getLocalDateKey, getMonthKey, pad } from './helpers.js'

export function summarizeRubyHistory(history, isCounted) {
  const days = new Map()
  const types = new Map()
  let total = 0
  let count = 0
  for (const entry of history) {
    const date = new Date(entry.at)
    if (!Number.isFinite(date.getTime()) || !isCounted(entry)) continue
    const ruby = Number(entry.ruby)
    const day = getLocalDateKey(date)
    const daily = days.get(day) || { ruby: 0, count: 0 }
    const type = types.get(entry.type) || { ruby: 0, count: 0, type: entry.type }
    daily.ruby += ruby
    daily.count++
    type.ruby += ruby
    type.count++
    days.set(day, daily)
    types.set(entry.type, type)
    total += ruby
    count++
  }
  return { total, count, days, types: [...types.values()].sort((a, b) => b.ruby - a.ruby) }
}

export function monthDate(month, offset = 0) {
  const [year, number] = month.split('-').map(Number)
  return new Date(year, number - 1 + offset, 1)
}

export function calendarMonth(month, daily) {
  const first = monthDate(month)
  const next = monthDate(month, 1)
  next.setDate(0)
  const days = Array.from({ length: next.getDate() }, (_, index) => {
    const day = index + 1
    const key = `${month}-${pad(day)}`
    return { key, day, ruby: 0, count: 0, ...daily.get(key) }
  })
  return { offset: first.getDay(), days }
}

export function trendBucketKey(at, unit) {
  if (unit === 'hour') return pad(new Date(at).getHours())
  if (unit === 'day') return getLocalDateKey(at)
  if (unit === 'month') return getMonthKey(at)
  return String(new Date(at).getFullYear())
}

export function rubyTrend(period, date, history, isCounted) {
  let unit
  let keys
  if (period === 'today' || period === 'date') {
    unit = 'hour'
    keys = Array.from({ length: 24 }, (_, hour) => pad(hour))
  } else if (period === 'all') {
    const months = [...new Set(history.filter((entry) => isCounted(entry) && Number.isFinite(new Date(entry.at).getTime()))
      .map((entry) => getMonthKey(entry.at)))].sort()
    const first = months[0]
    const last = months.at(-1)
    const monthIndex = (month) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5))
    const span = first ? monthIndex(last) - monthIndex(first) + 1 : 0
    unit = span > 24 ? 'year' : 'month'
    keys = unit === 'year' ? [...new Set(months.map((month) => month.slice(0, 4)))] :
      Array.from({ length: span }, (_, index) => getMonthKey(monthDate(first, index)))
  } else {
    unit = 'day'
    const month = getMonthKey(monthDate(date.slice(0, 7), period === 'lastMonth' ? -1 : 0))
    keys = calendarMonth(month, new Map()).days.map((day) => day.key)
  }
  const bins = new Map(keys.map((key) => [key, { key, ruby: 0, count: 0 }]))
  for (const entry of history) {
    if (!isCounted(entry)) continue
    const bin = bins.get(trendBucketKey(entry.at, unit))
    if (!bin) continue
    bin.ruby += Number(entry.ruby)
    bin.count++
  }
  return { unit, bins: [...bins.values()] }
}

export function trendLabel(key, unit) {
  if (unit === 'hour') return `${Number(key)}時台`
  if (unit === 'day') return `${Number(key.slice(5, 7))}月${Number(key.slice(8))}日`
  if (unit === 'month') return `${key.slice(0, 4)}年${Number(key.slice(5))}月`
  return `${key}年`
}
