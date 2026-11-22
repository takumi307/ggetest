import assert from 'node:assert/strict'
import test from 'node:test'
import { calendarMonth, rubyTrend, summarizeRubyHistory } from '../src/utils/rubyAnalytics.js'

const isCounted = (entry) => entry.result !== 'taken' && Number(entry.ruby) > 0
const record = (year, month, day, hour, type, ruby, result = 'success') =>
  ({ at: new Date(year, month - 1, day, hour).getTime(), type, ruby, result })

test('calendar and trends count the same successes and include empty calendar days', () => {
  const history = [
    record(2024, 2, 29, 10, 'dragon', 370),
    record(2024, 2, 29, 10, 'fortress', '280'),
    record(2024, 2, 29, 12, 'dragon', 370, 'taken'),
    record(2024, 2, 1, 13, 'wildFortress', 50)
  ]
  const summary = summarizeRubyHistory(history, isCounted)
  assert.equal(summary.total, 700)
  assert.equal(summary.count, 3)
  assert.equal(summary.days.size, 2)
  assert.deepEqual(summary.types.map(({ type, ruby }) => [type, ruby]), [['dragon', 370], ['fortress', 280], ['wildFortress', 50]])

  const calendar = calendarMonth('2024-02', summary.days)
  assert.equal(calendar.offset, 4)
  assert.equal(calendar.days.length, 29)
  assert.equal(calendar.days[1].ruby, 0)
  assert.deepEqual(calendar.days.at(-1), { key: '2024-02-29', day: 29, ruby: 650, count: 2 })
  assert.equal(rubyTrend('lastMonth', '2024-03-01', history, isCounted).bins.at(-1).ruby, 650)
  assert.equal(rubyTrend('date', '2024-02-29', history.slice(0, 3), isCounted).bins[10].ruby, 650)
})

test('all-period trends include empty months and summarize long histories by year', () => {
  const history = [record(2024, 12, 1, 12, 'dragon', 370), record(2025, 2, 1, 12, 'fortress', 280)]
  const monthly = rubyTrend('all', '2025-02-01', history, isCounted)
  assert.equal(monthly.unit, 'month')
  assert.deepEqual(monthly.bins.map(({ key, ruby }) => [key, ruby]), [['2024-12', 370], ['2025-01', 0], ['2025-02', 280]])
  const yearly = rubyTrend('all', '2025-02-01', [record(2022, 11, 1, 10, 'dragon', 370), ...history], isCounted)
  assert.equal(yearly.unit, 'year')
  assert.deepEqual(yearly.bins.map(({ key }) => key), ['2022', '2024', '2025'])
})
