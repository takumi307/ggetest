import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { createServer } from 'vite'
import { nextTick } from 'vue'

function bindD1(database) {
  return {
    prepare(sql) {
      const bind = (...values) => ({
        all: () => {
          const results = database.prepare(sql).all(...values)
          return { results, meta: database.prepare('SELECT changes() AS changes').get() }
        },
        first: async () => database.prepare(sql).get(...values) ?? null,
        run: async () => database.prepare(sql).run(...values)
      })
      return { ...bind(), bind }
    },
    async batch(statements) {
      database.exec('BEGIN')
      try {
        const result = statements.map((statement) => statement.all())
        database.exec('COMMIT')
        return result
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    }
  }
}

test('small Aqua reminders follow each shared timer and respect shared lost status', async (t) => {
  const { default: worker } = await import('../gge-tracker-api/src/index.js')
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const emojiIds = {
    doragon: '123456789012345671', sabakunoyousai: '123456789012345672',
    yaseinoyousai: '123456789012345673', daiakua: '123456789012345674', syouakua: '123456789012345675'
  }
  const env = { DB: bindD1(db), TOKEN: 'test-token', ALLOWED_ORIGIN: 'https://tracker.invalid', DISCORD_EMOJI_IDS: emojiIds }
  const hour = 3_600_000
  const start = 1_800_000_000_000
  let now = start
  t.mock.method(Date, 'now', () => now)
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }
  async function request(path, userId = 'a', body) {
    return worker.fetch(new Request('https://tracker.invalid/api/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { ...headers, 'X-User-Id': userId },
      body: body ? JSON.stringify(body) : undefined
    }), env)
  }
  async function cron() {
    let work
    await worker.scheduled({}, env, { waitUntil: (promise) => { work = promise } })
    await work
  }
  const sent = []
  let fail = false
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (fail) return new Response(null, { status: 503 })
    sent.push(JSON.parse(options.body).content)
    return new Response(null, { status: 204 })
  })
  const aqua = (type, x, eventAt, updatedAt = now) => ({ type, x, y: 9, eventAt, updatedAt })
  const first = aqua('smallAqua', 1, start)
  const lost = aqua('smallAqua', 2, start)
  const future = aqua('smallAqua', 3, start + 32 * hour)
  const large = aqua('aqua', 4, start)
  await request('aqua/settings', 'a', { webhookUrl: 'https://discord.com/api/webhooks/123/test' })
  await request('aqua/sync', 'a', { items: [first, lost, future, large] })
  assert.equal((await request('aqua/lost', 'a', { ...lost, lost: true })).status, 200)
  assert.equal((await request('aqua/lost', 'a', { ...future, lost: true })).status, 200)
  const shared = (await (await request('aqua/sync', 'b', {})).json()).lost
  assert.deepEqual(shared.sort((a, b) => a.key.localeCompare(b.key)), [
    { key: 'smallAqua|2|9', eventAt: start }, { key: 'smallAqua|3|9', eventAt: future.eventAt }
  ])
  assert.deepEqual((await (await request('widget', 'b')).json()).upcoming, [])
  assert.equal((await request('aqua/lost', 'b', { ...future, lost: false })).status, 200)
  assert.equal((await (await request('widget', 'a')).json()).upcoming[0].x, 3)

  now = start + 5 * hour - 1
  await cron()
  assert.equal(sent.length, 0)
  now++
  fail = true
  await cron()
  fail = false
  await Promise.all([cron(), cron()])
  assert.equal(sent.length, 1)
  assert.match(sent[0], /小アクア \(1,9\).*5時間/)
  assert.ok(sent[0].includes(`<:syouakua:${emojiIds.syouakua}> 小アクア`))
  assert.ok(sent[0].includes('[対象を開く](https://tracker.invalid/#target=smallAqua%7C1%7C9)'))
  assert.doesNotMatch(sent[0], /\([234],9\)/)
  await cron()
  assert.equal(sent.length, 1)

  const updated = { ...lost, eventAt: now + 32 * hour, updatedAt: now }
  await request('aqua/sync', 'b', { items: [updated, { ...first, eventAt: updated.eventAt, updatedAt: now }] })
  assert.equal((await request('aqua/lost', 'a', { ...lost, lost: true })).status, 409)
  assert.deepEqual((await (await request('aqua/sync', 'a', { items: [lost] })).json()).lost, [])
  now = updated.eventAt + 5 * hour
  await cron()
  const reminders = sent.filter((message) => message.includes('5時間'))
  assert.equal(reminders.length, 2)
  assert.match(reminders[1], /\(1,9\)/)
  assert.match(reminders[1], /\(2,9\)/)

  const beforeRegular = sent.length
  const minute = 60_000
  await request('aqua/sync', 'a', { items: [
    aqua('smallAqua', 5, now + minute),
    aqua('aqua', 6, now - 20 * minute, now - hour),
    aqua('aqua', 8, now + 3 * minute),
    aqua('smallAqua', 9, now - 2 * minute, now - hour)
  ] })
  await request('fort/settings', 'a', { webhookUrl: 'https://discord.com/api/webhooks/123/test' })
  await request('fort/sync', 'a', { items: [
    { ...aqua('dragon', 7, now + minute), label: '自分用メモ' },
    aqua('fortress', 10, now + 2 * minute),
    aqua('wildFortress', 11, now + 3 * minute)
  ] })
  await cron()
  const regular = sent.slice(beforeRegular).join('\n')
  assert.match(regular, /小アクア \(5,9\) が約1分後に浮上します/)
  assert.match(regular, /大アクア \(8,9\) が約3分後に浮上します/)
  assert.match(regular, /小アクア \(9,9\) が浮上しました（[^）]*約2分前/)
  assert.match(regular, /通知停止中などに浮上[\s\S]*大アクア \(6,9\)（[^）]*約20分前/)
  assert.match(regular, /ドラゴン \(7,9\) 自分用メモ が約1分後に攻撃可能になります/)
  assert.match(regular, /砂漠の要塞 \(10,9\) が約2分後に攻撃可能になります/)
  for (const [name, id] of Object.entries(emojiIds)) assert.ok(regular.includes(`<:${name}:${id}>`), name)
  assert.doesNotMatch(regular, /対象を開く|#target=/)
})

test('cooldown boundaries and arrival order agree across sync and widget', async (t) => {
  const { default: worker } = await import('../gge-tracker-api/src/index.js?timing-matrix')
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const env = { DB: bindD1(db), TOKEN: 'test-token' }
  const minute = 60_000
  const hour = 60 * minute
  const base = 1_800_000_000_000
  let now = base
  t.mock.method(Date, 'now', () => now)

  async function request(userId, action, payload) {
    const response = await worker.fetch(new Request('https://tracker.invalid/api/' + action, {
      method: payload ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer test-token', 'X-User-Id': userId, 'Content-Type': 'application/json' },
      body: payload && JSON.stringify(payload)
    }), env)
    assert.equal(response.status, 200)
    return response.json()
  }

  const scenarios = [
    { title: '67h winner, 22h member', a: 67 * hour, b: 22 * hour, expected: 22 * hour },
    { title: '3h winner, 18h member', a: 3 * hour, b: 18 * hour, expected: 18 * hour },
    { title: '100h winner, 24h member', a: 100 * hour, b: 24 * hour, expected: 24 * hour },
    { title: '120h winner, 24h member', a: 120 * hour, b: 24 * hour, expected: 24 * hour },
    { title: '23h59m winner remains on the 120h side', a: 24 * hour - minute, b: 12 * hour, expected: 12 * hour },
    { title: 'equal remaining times', a: 24 * hour, b: 24 * hour, expected: 24 * hour },
    { title: 'exactly 5m newer inferred start is the same cycle', a: 100 * hour, b: 4 * hour + 5 * minute, expected: 4 * hour },
    { title: '6m newer inferred start is a new cycle', a: 100 * hour, b: 4 * hour + 6 * minute, expected: 4 * hour + 6 * minute },
    { title: '24h minus 1m', a: 95 * hour, b: 24 * hour - minute, expected: 24 * hour - minute },
    { title: '1m member cooldown', a: 3 * hour, b: minute, expected: minute },
    { title: 'member input above 24h is rejected', a: 100 * hour, b: 24 * hour + minute, expected: 4 * hour },
    { title: 'zero stays a private ready check', a: 100 * hour, b: 0, expected: 0 },
    { title: 'zero winner cooldown has expired', a: 0, b: 22 * hour, expected: 22 * hour }
  ]
  for (const [typeIndex, type] of ['dragon', 'fortress', 'wildFortress'].entries()) {
    for (const [i, { title, a, b, expected }] of scenarios.entries()) {
      for (const [orderIndex, order] of ['winner first', 'member first', 'concurrent'].entries()) {
        const id = `${typeIndex}-${i}-${orderIndex}`
        const x = (typeIndex * scenarios.length + i) * 3 + orderIndex + 1
        const spot = { type, x, y: 15 }
        const winnerId = 'winner-' + id
        const memberId = 'member-' + id
        const attackStart = base + a - 120 * hour
        const item = { ...spot, eventAt: attackStart, updatedAt: attackStart }
        const winner = { ...spot, kind: 'winner', historyId: 'ruby', eventAt: base + a, updatedAt: attackStart }
        const member = { ...spot, kind: 'member', eventAt: base + b, updatedAt: base }
        const sendWinner = () => request(winnerId, 'fort/sync', {
          items: [item], cooldowns: [winner],
          history: [{ ...spot, id: 'ruby', at: attackStart, result: 'ruby', ruby: 280 }]
        })
        const sendMember = () => request(memberId, 'fort/sync', { items: [item], cooldowns: [member] })
        if (order === 'concurrent') await Promise.all([sendWinner(), sendMember()])
        else for (const send of order === 'winner first' ? [sendWinner, sendMember] : [sendMember, sendWinner]) await send()
        await sendMember()
        await sendWinner()

        const message = `${type}: ${title}, ${order}`
        const winnerSync = (await request(winnerId, 'fort/sync', { cooldowns: [] })).cooldowns[0]
        const memberSync = (await request(memberId, 'fort/sync', { cooldowns: [] })).cooldowns[0]
        assert.equal(winnerSync.personalAt, base + a, message)
        assert.equal(memberSync.personalAt, null, message)
        assert.equal(b === 0 ? memberSync.readyAt : memberSync.sharedMemberAt, base + expected, message)
        const winnerExpected = Math.max(a, b === 0 ? Math.max(a - 96 * hour, 0) : expected)
        for (const [userId, remaining] of [[winnerId, winnerExpected], [memberId, expected]]) {
          const { upcoming } = await request(userId, 'widget')
          assert.equal(upcoming[0]?.at, remaining ? base + remaining : undefined, message)
        }
        now = base + 121 * hour
        await sendMember()
        await sendWinner()
        assert.deepEqual((await request(winnerId, 'widget')).upcoming, [], message)
        assert.deepEqual((await request(memberId, 'widget')).upcoming, [], message)
        now = base
      }
    }
  }
})

test('shared fort timing stays separate from private D1 coordinates and ruby records', async (t) => {
  const vite = await createServer({ server: { middlewareMode: true, ws: false }, appType: 'custom' })
  t.after(() => vite.close())
  const { default: worker } = await vite.ssrLoadModule('/gge-tracker-api/src/index.js')
  const { useTrackerStore } = await vite.ssrLoadModule('/src/stores/trackerStore.js')
  const { useSyncStore } = await vite.ssrLoadModule('/src/stores/syncStore.js')
  const { useUiStore } = await vite.ssrLoadModule('/src/stores/uiStore.js')
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(`
    CREATE TABLE items (
      user_id TEXT NOT NULL, channel TEXT NOT NULL, item_key TEXT NOT NULL, type TEXT NOT NULL,
      x REAL NOT NULL, y REAL NOT NULL, label TEXT NOT NULL DEFAULT '', event_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, notify INTEGER NOT NULL DEFAULT 1,
      notified INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, channel, item_key));
    CREATE TABLE history (
      user_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL DEFAULT '', entry_id TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '', x REAL NOT NULL DEFAULT 0, y REAL NOT NULL DEFAULT 0,
      result TEXT NOT NULL DEFAULT 'ruby', ruby INTEGER NOT NULL DEFAULT 0, at_ms INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0, touched_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, id));
    INSERT INTO items (user_id, channel, item_key, type, x, y, label, event_at) VALUES
      ('winner', 'fort', 'fortress|7|8', 'fortress', 7, 8, 'private winner memo', 1234),
      ('member', 'fort', 'dragon|3|4', 'dragon', 3, 4, 'private member memo', 1800000000100);
    INSERT INTO history (user_id, id, type, x, y, ruby, at_ms) VALUES
      ('winner', 'old-ruby', 'fortress', 7, 8, 280, 123);
  `)
  const env = { DB: bindD1(db), TOKEN: 'test-token' }
  t.mock.method(globalThis, 'fetch', (url, options) => worker.fetch(new Request(url, options), env))
  const storage = new Map([['ggeUserId', '"winner"']])
  storage.set('ggeTrackerSettings', JSON.stringify({ homeCoords: { aqua: { x: 6, y: 6 }, smallAqua: { x: 1, y: 1 } } }))
  for (const key of ['ggeAquaSyncSettings', 'ggeFortSyncSettings']) {
    storage.set(key, JSON.stringify({ url: 'https://tracker.invalid', token: 'test-token' }))
  }
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value)
  } })
  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete globalThis.localStorage
    setActivePinia(undefined)
  })

  const start = 1_800_000_000_000
  const hour = 3_600_000
  const minute = 60_000
  let now = start
  t.mock.method(Date, 'now', () => now)
  setActivePinia(createPinia())
  const tracker = useTrackerStore()
  assert.deepEqual(tracker.stormHome(), { x: 6, y: 6 })
  const sync = useSyncStore()
  const ui = useUiStore()
  const fort = () => tracker.entries.find((entry) => entry.type === 'fortress')
  assert.equal((await sync.syncNow('fort', 'silent')).ok, true)
  assert.equal(tracker.attackableAt(fort()), 1234)
  assert.equal(tracker.attackHistory[0].id, 'old-ruby')

  const mistakenRecord = tracker.recordAttackResult(fort().id)
  ui.closeModal(true)
  assert.equal(await mistakenRecord, true)
  const mistakenId = tracker.winnerHistoryId(fort())
  assert.equal((await sync.syncNow('fort', 'silent')).ok, true)
  const dismissed = tracker.deleteHistory(mistakenId, true)
  ui.closeModal(false)
  assert.equal(await dismissed, false)
  assert.equal(tracker.winnerHistoryId(fort()), mistakenId)
  const undo = tracker.deleteHistory(mistakenId, true)
  ui.closeModal(true)
  assert.equal(await undo, true)
  assert.equal(tracker.winnerHistoryId(fort()), undefined)
  assert.equal(tracker.attackableAt(fort()), 1234)
  assert.deepEqual(tracker.attackHistory.map((entry) => entry.id), ['old-ruby'])
  assert.equal((await sync.syncNow('fort', 'silent')).ok, true)
  assert.equal(db.prepare('SELECT deleted FROM history WHERE id=?').get(mistakenId).deleted, 1)

  const connect = (userId) => sync.saveConnection({ userId, url: 'https://tracker.invalid', token: 'test-token' })
  now = start + hour
  tracker.tick()
  assert.equal(await connect('member'), true)
  assert.equal(fort(), undefined)
  assert.deepEqual(tracker.attackHistory, [])
  const dragon = tracker.entries.find((entry) => entry.type === 'dragon')
  assert.equal(tracker.attackableAt(dragon), 1_800_000_000_100)
  assert.equal(await tracker.submitEdit(dragon.id, { ...dragon, rh: 14, rm: 0 }), true)
  assert.equal(tracker.attackableAt(dragon) - now, 14 * hour)
  tracker.commitTimerUpdate()
  assert.equal(await tracker.submitNew({ type: 'aqua', x: 9, y: 10, rs: 17 }), true)
  const aqua = tracker.entries.find((entry) => entry.type === 'aqua')
  assert.equal(tracker.attackableAt(aqua) - now, 72 * hour + 17_000)
  assert.equal(await tracker.submitNew({ type: 'smallAqua', x: 9, y: 10 }), true)
  const small = tracker.entries.find((entry) => entry.type === 'smallAqua')
  assert.equal(tracker.updateReady(small.id, 0, 0, 60), false)
  ui.closeModal(false)
  assert.equal(tracker.updateReady(small.id, 0, 1, 25), true)
  assert.equal(tracker.attackableAt(small) - now, 32 * hour + minute + 25_000)
  assert.equal(await tracker.submitEdit(aqua.id, { ...aqua, rh: '', rm: '', rs: 9 }), true)
  assert.equal(tracker.attackableAt(aqua) - now, 72 * hour + 9_000)
  tracker.commitTimerUpdate()
  assert.equal((await sync.syncNow('aqua', 'silent')).ok, true)
  const sharedAqua = await (await worker.fetch(new Request('https://tracker.invalid/api/aqua/sync', {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'X-User-Id': 'another-user' }, body: '{"items":[]}'
  }), env)).json()
  assert.equal(sharedAqua.items.find((entry) => entry.type === 'aqua').eventAt, now + 72 * hour + 9_000)
  assert.equal(sharedAqua.items.find((entry) => entry.type === 'smallAqua').eventAt, now + 32 * hour + minute + 25_000)
  assert.equal(await tracker.submitNew({ type: 'fortress', x: 7, y: 8, label: 'member memo', rh: '', rm: '' }), true)
  assert.equal(tracker.updateReady(fort().id, 120, 0), false)
  ui.closeModal(false)
  assert.equal(tracker.updateReady(fort().id, 23, 2), true)
  tracker.commitTimerUpdate()
  assert.equal((await sync.syncNow('fort', 'silent')).ok, true)
  assert.equal(tracker.attackableAt(fort()), start + 24 * hour + 2 * minute)

  now = start + hour + 25 * minute
  tracker.tick()
  assert.equal(await connect('winner'), true)
  assert.equal(tracker.waitingList.includes(fort()), true)
  const record = tracker.recordAttackResult(fort().id)
  ui.closeModal(true)
  assert.equal(await record, true)
  const winnerEnd = start + 120 * hour
  assert.equal(tracker.updateReady(fort().id, 118, 35), true)
  assert.equal(tracker.attackableAt(fort()), winnerEnd)
  tracker.commitTimerUpdate()


  assert.equal((await sync.syncNow('fort', 'silent')).ok, true)
  assert.equal(tracker.attackableAt(fort()), winnerEnd)

  assert.equal(await connect('member'), true)
  assert.equal(fort().label, 'member memo')
  assert.equal(tracker.attackableAt(fort()) - now, 22 * hour + 35 * minute)
  assert.equal(tracker.waitingList.includes(fort()), true)

  now = start + 24 * hour
  tracker.tick()
  assert.equal(tracker.readyList.includes(fort()), true)
  assert.equal(await connect('winner'), true)
  assert.equal(fort().label, 'private winner memo')
  assert.equal(tracker.attackableAt(fort()), winnerEnd)
  assert.equal(tracker.waitingList.includes(fort()), true)
  assert.equal(tracker.attackHistory.length, 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history WHERE user_id=?').get('member').n, 0)

  const newerAt = now
  const api = (userId, payload) => worker.fetch(new Request('https://tracker.invalid/api/fort/sync', {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'X-User-Id': userId }, body: JSON.stringify(payload)
  }), env)
  const update = (updatedAt, eventAt) => ({ type: 'fortress', x: 7, y: 8, updatedAt, eventAt, kind: 'member' })
  // A new cycle can be reported by members without a ruby winner. A late old-cycle report cannot replace it.
  await api('member', { cooldowns: [update(newerAt, newerAt + 24 * hour)] })
  await api('observer', { cooldowns: [update(newerAt + minute, newerAt + minute + 24 * hour)] })
  await api('member', { cooldowns: [update(start + 4 * hour, start + 24 * hour)] })
  const winnerHistoryId = tracker.attackHistory.find((entry) => entry.id !== 'old-ruby').id
  await api('winner', { cooldowns: [{ ...update(start + 5 * hour, winnerEnd), kind: 'winner', historyId: winnerHistoryId }] })
  await api('member', { cooldowns: [{ ...update(newerAt, newerAt + 120 * hour), kind: undefined }] })
  await api('member', { cooldowns: [{ ...update(newerAt, newerAt + 120 * hour), kind: 'winner', historyId: 'forged' }] })
  const memberResult = await (await api('member', { cooldowns: [], history: [] })).json()
  const memberFort = memberResult.cooldowns.find((timer) => timer.key === 'fortress|7|8')
  assert.equal(memberFort.sharedAt, newerAt + minute + 120 * hour)
  assert.equal(memberFort.confirmedAt, winnerEnd)
  assert.equal(memberFort.personalAt, null)
  assert.deepEqual(memberResult.history, [])
  assert.equal((await sync.syncNow('fort', 'silent')).ok, true)
  assert.equal(tracker.attackableAt(fort()), winnerEnd)

  // Zero is private and cannot erase the other user's active cooldown.
  now = newerAt + 2 * minute
  await api('member', { cooldowns: [update(now, now)] })
  assert.equal(await connect('member'), true)
  assert.equal(tracker.attackableAt(fort()), now)
  assert.equal(await connect('winner'), true)
  assert.equal(tracker.attackableAt(fort()), winnerEnd)

  const legacyResponse = await (await api('winner', { items: [], history: [] })).json()
  assert.equal(legacyResponse.cooldowns, undefined)
  assert.equal(legacyResponse.items[0].label, 'private winner memo')
  assert.equal(legacyResponse.history.some((entry) => entry.id === 'old-ruby'), true)

  const ruby = tracker.attackHistory.find((entry) => entry.id !== 'old-ruby')
  const deletion = tracker.deleteHistory(ruby.id, true)
  ui.closeModal(true)
  await deletion
  assert.equal(fort().eventAt, now)
  assert.equal(tracker.attackableAt(fort()), newerAt + minute + 24 * hour)
  assert.equal((await sync.syncNow('fort', 'silent')).ok, true)
  assert.equal(tracker.attackableAt(fort()), newerAt + minute + 24 * hour)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history WHERE id=? AND deleted=0').get('old-ruby').n, 1)

  const correctedRecord = tracker.recordAttackResult(fort().id)
  ui.closeModal(true)
  assert.equal(await correctedRecord, true)
  assert.equal(tracker.updateReady(fort().id, 95, 58), true)
  tracker.commitTimerUpdate()
  assert.equal((await sync.syncNow('fort', 'silent')).ok, true)
  assert.equal(tracker.attackableAt(fort()), winnerEnd)

  const aquaEntry = tracker.entries.find((entry) => entry.type === 'aqua' && entry.x === 9)
  const smallEntry = tracker.entries.find((entry) => entry.type === 'smallAqua' && entry.x === 9)
  assert.equal(tracker.coordDistance(aquaEntry), 5)
  assert.equal(tracker.coordDistance(smallEntry), 5)
  assert.equal(await tracker.submitEdit(aquaEntry.id, { ...aquaEntry, label: '自分のアクア' }), true)
  tracker.toggleFavorite(aquaEntry)
  assert.equal(tracker.waitingList[0], aquaEntry)
  assert.equal((await sync.syncNow('aqua', 'silent')).ok, true)
  assert.equal(tracker.entryLabel(aquaEntry), '自分のアクア')
  assert.equal(db.prepare("SELECT label FROM items WHERE item_key='aqua|9|10'").get().label, '')

  await sync.toggleTarget(aquaEntry)
  const expiresAt = sync.targetFor(aquaEntry).expiresAt
  assert.equal(expiresAt, now + 15 * minute)
  assert.equal(sync.targetFor(aquaEntry).mine, 1)
  assert.equal(await connect('member'), true)
  assert.equal(tracker.entryLabel(aquaEntry), '')
  assert.equal(tracker.isFavorite(aquaEntry), false)
  assert.equal(sync.targetFor(aquaEntry).mine, 0)
  assert.equal(await tracker.submitEdit(aquaEntry.id, { ...aquaEntry, label: '相手のアクア' }), true)
  assert.equal((await sync.syncNow('aqua', 'silent')).ok, true)
  const targetApi = (userId, action, expiresAt) => worker.fetch(new Request('https://tracker.invalid/api/aqua/target', {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'X-User-Id': userId },
    body: JSON.stringify({ type: 'aqua', x: 9, y: 10, action, expiresAt })
  }), env)
  assert.equal((await (await targetApi('member', 'claim')).json()).targets[0].mine, 0)
  assert.equal((await (await targetApi('member', 'release', expiresAt)).json()).targets.length, 1)

  assert.equal(await connect('winner'), true)
  assert.equal(tracker.entryLabel(aquaEntry), '自分のアクア')
  assert.equal(tracker.isFavorite(aquaEntry), true)
  await sync.toggleTarget(aquaEntry)
  assert.equal(sync.targetFor(aquaEntry), null)
  await sync.toggleTarget(aquaEntry)
  assert.equal(sync.targetFor(aquaEntry).mine, 1)
  now += 15 * minute
  tracker.tick()
  assert.equal(sync.targetFor(aquaEntry), null)
  assert.equal((await (await targetApi('member', 'claim')).json()).targets[0].mine, 1)

  db.prepare(`INSERT INTO items (user_id, channel, item_key, type, x, y, label, event_at)
    VALUES ('shared', 'aqua', 'aqua|77|78', 'aqua', 77, 78, 'legacy shared label', 1234)`).run()
  const legacyAqua = await worker.fetch(new Request('https://tracker.invalid/api/aqua/sync', {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'X-User-Id': 'member' },
    body: JSON.stringify({ items: [{ type: 'aqua', x: 77, y: 78, label: 'legacy client write', eventAt: 2345, updatedAt: now }] })
  }), env)
  assert.equal((await legacyAqua.json()).items.find((entry) => entry.x === 77).label, '')
  assert.equal(db.prepare("SELECT label FROM items WHERE item_key='aqua|77|78'").get().label, 'legacy shared label')

  assert.equal(await connect('winner'), true)
  const setStorm = (x, y, shareStorm) => tracker.saveSettings({
    enabled: {}, near50: {}, nearDistance: {}, home: {}, storm: { x, y }, shareStorm
  })
  setStorm(6, 6, true)
  assert.equal(await tracker.submitNew({ type: 'smallAqua', x: 20, y: 10, rm: 1 }), true)
  const farSmall = tracker.entries.find((entry) => entry.type === 'smallAqua' && entry.x === 20)
  assert.equal((await sync.syncNow('aqua', 'silent')).ok, true)
  assert.equal(sync.stormProfile().dirty, false)
  assert.deepEqual(sync.nearestFor(aquaEntry).users, ['winner'])
  assert.equal(await connect('member'), true)
  setStorm(20, 10, true)
  assert.equal((await sync.syncNow('aqua', 'silent')).ok, true)
  assert.deepEqual(sync.nearestFor(aquaEntry).users, ['winner'])
  assert.equal(sync.nearestFor(aquaEntry).distance, 5)
  assert.deepEqual(sync.nearestFor(farSmall).users, ['member'])
  assert.equal(sync.nearestFor(farSmall).distance, 0)
  setStorm(12, 14, true)
  assert.equal((await sync.syncNow('aqua', 'silent')).ok, true)
  assert.deepEqual(sync.nearestFor(aquaEntry).users, ['member', 'winner'])
  tracker.now = aquaEntry.eventAt + 1
  tracker.readyNearestOnly = true
  assert(tracker.readyList.includes(aquaEntry))
  assert(tracker.readyList.every((entry) => ['aqua', 'smallAqua'].includes(entry.type)))
  tracker.readyNearestOnly = false
  tracker.tick()
  setStorm(12, 14, false)
  assert.equal((await sync.syncNow('aqua', 'silent')).ok, true)
  assert.deepEqual(sync.nearestFor(aquaEntry).users, ['winner'])
  assert.deepEqual(tracker.stormHome(), { x: 12, y: 14 })
  assert.equal(db.prepare("SELECT x FROM storm_homes WHERE user_id='member'").get().x, null)

  const widgetRequest = (userId) => worker.fetch(new Request('https://tracker.invalid/api/widget', {
    headers: userId ? { Authorization: 'Bearer test-token', 'X-User-Id': userId } : {}
  }), env)
  assert.equal((await widgetRequest(null)).status, 401)
  const widgetResponse = await widgetRequest('winner')
  assert.equal(widgetResponse.headers.get('cache-control'), 'no-store')
  const widget = (await widgetResponse.json()).upcoming
  assert.equal(widget.find((entry) => entry.type === 'fortress').at, winnerEnd)
  assert.equal(widget.find((entry) => entry.type === 'aqua' && entry.x === 9).label, '自分のアクア')
  const peerWidget = (await (await widgetRequest('member')).json()).upcoming
  assert.equal(peerWidget.find((entry) => entry.type === 'aqua' && entry.x === 9).label, '相手のアクア')
  assert(widget.every((entry, i) => entry.at > now && (i === 0 || widget[i - 1].at <= entry.at)))

  const savedAquaAt = aquaEntry.eventAt
  assert.equal(await tracker.submitEdit(aquaEntry.id, { ...aquaEntry, label: tracker.entryLabel(aquaEntry), rh: 3 }), true)
  assert.equal(tracker.attackableAt(aquaEntry), now + 75 * hour)
  assert.equal((await sync.syncNow('aqua', 'silent')).ok, true)
  assert.equal(db.prepare("SELECT event_at FROM items WHERE item_key='aqua|9|10'").get().event_at, savedAquaAt)
  tracker.undoTimerUpdate()
  assert.equal(tracker.attackableAt(aquaEntry), savedAquaAt)

  assert.equal(tracker.updateReady(aquaEntry.id, 2, 35), true)
  now += 1000
  const peerAquaAt = now + 76 * hour
  await worker.fetch(new Request('https://tracker.invalid/api/aqua/sync', {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'X-User-Id': 'winner' },
    body: JSON.stringify({ items: [{ type: 'aqua', x: 9, y: 10, eventAt: peerAquaAt, updatedAt: now }] })
  }), env)
  assert.equal((await sync.syncNow('aqua', 'silent')).ok, true)
  assert.equal(tracker.pendingTimerUpdate, null)
  tracker.undoTimerUpdate()
  assert.equal(tracker.attackableAt(aquaEntry), peerAquaAt)

  const memberFortEntry = fort()
  assert.equal(tracker.updateReady(memberFortEntry.id, 2, 35), true)
  assert(tracker.pendingTimerUpdate)
  now += hour
  await api('observer', { cooldowns: [update(now, now + 24 * hour)] })
  assert.equal((await sync.syncNow('fort', 'silent')).ok, true)
  assert.equal(tracker.pendingTimerUpdate, null)
  assert.equal(sync.fortCooldown(memberFortEntry).sharedAt, now + 120 * hour)

  const type = 'fortress'
  const spot = (x) => ({ type, x, y: 100 })
  const keyOf = (x) => `fortress|${x}|100`
  const target = (x) => tracker.entries.find((entry) => entry.type === type && entry.x === x && entry.y === 100)
  const startCase = now + 6 * 24 * hour
  now = startCase
  const winnerReport = (x, eventAt, updatedAt) => ({ ...spot(x), kind: 'winner', historyId: `case-${x}`, eventAt, updatedAt })
  const memberReport = (x, eventAt, updatedAt = startCase) => ({ ...spot(x), kind: 'member', eventAt, updatedAt })
  const seeds = [[31, 3 * hour], [32, 100 * hour], [33, 3 * hour], [34, 96 * hour - minute], [35, 100 * hour]]
  const initialReports = seeds.map(([x, remain]) => {
    const start = startCase + remain - 120 * hour
    return winnerReport(x, start + 120 * hour, start)
  })
  await api('winner', {
    items: initialReports.map((report) => ({ ...report, eventAt: report.updatedAt })),
    history: initialReports.map((report) => ({ ...report, id: report.historyId, at: report.updatedAt, result: 'ruby', ruby: 280 })),
    cooldowns: initialReports
  })
  await api('member', {
    items: initialReports.map((report) => ({ ...report, eventAt: report.updatedAt })),
    cooldowns: [
      memberReport(32, startCase + 24 * hour),
      memberReport(34, startCase + 2 * minute, startCase - hour),
      memberReport(35, startCase + 4 * hour + 7 * minute)
    ]
  })
  tracker.tick()
  assert.equal((await sync.syncNow('fort', 'silent')).ok, true)
  assert(tracker.readyList.includes(target(31)))
  assert.equal(tracker.updateReady(target(31).id, 18, 0), true)
  assert.equal(tracker.attackableAt(target(31)), startCase + 18 * hour)
  tracker.commitTimerUpdate()
  assert.equal((await sync.syncNow('fort', 'silent')).ok, true)
  assert.equal(tracker.attackableAt(target(31)), startCase + 18 * hour)
  assert.equal(tracker.attackableAt(target(32)), startCase + 24 * hour)
  assert.equal(tracker.attackableAt(target(35)), startCase + 4 * hour + 7 * minute)

  const widgetAt = async (id, x) => (await (await widgetRequest(id)).json()).upcoming.find((entry) => entry.x === x && entry.y === 100)?.at
  assert.equal(await widgetAt('winner', 31), startCase + 18 * hour)
  assert.equal(await widgetAt('member', 31), startCase + 18 * hour)
  assert.equal(await widgetAt('winner', 32), startCase + 100 * hour)
  assert.equal(await widgetAt('member', 32), startCase + 24 * hour)
  assert.equal(await connect('winner'), true)
  assert.equal(sync.fortCooldown(target(31)).personalAt, startCase + 3 * hour)
  assert.equal(tracker.attackableAt(target(31)), startCase + 18 * hour)
  assert.equal(tracker.attackableAt(target(32)), startCase + 100 * hour)
  const originalHistoryId = tracker.winnerHistoryId(target(33))
  assert.equal(originalHistoryId, 'case-33')
  assert.equal(await tracker.submitEdit(target(33).id, { ...target(33), rh: 5 }), true)
  assert.equal(tracker.attackableAt(target(33)), startCase + 5 * hour)
  tracker.commitTimerUpdate()
  assert.equal((await sync.syncNow('fort', 'silent')).ok, true)
  assert.equal(tracker.attackableAt(target(33)), startCase + 5 * hour)
  assert.equal(tracker.winnerHistoryId(target(33)), originalHistoryId)
  assert.equal(await widgetAt('winner', 33), startCase + 5 * hour)
  assert.equal(await widgetAt('member', 33), undefined)

  now += minute
  tracker.tick()
  await api('winner', { cooldowns: [
    winnerReport(34, startCase + 96 * hour + 5 * minute, now),
    winnerReport(35, startCase + 100 * hour + 4 * minute, now)
  ] })
  await api('member', { cooldowns: [
    memberReport(31, startCase - 80 * hour, startCase - 84 * hour),
    memberReport(34, startCase + 2 * minute, startCase - hour)
  ] })
  await api('winner', { cooldowns: [initialReports[2], initialReports[3]] })
  assert.equal(await widgetAt('member', 34), undefined)
  assert.equal(await widgetAt('member', 35), startCase + 4 * hour + 4 * minute)
  assert.equal(await widgetAt('winner', 31), startCase + 18 * hour)
  assert.equal(await widgetAt('winner', 33), startCase + 5 * hour)
  assert.equal(await connect('member'), true)
  assert(tracker.readyList.includes(target(33)))
  assert(tracker.readyList.includes(target(34)))
  assert.equal(tracker.attackableAt(target(35)), startCase + 4 * hour + 4 * minute)

  const postAqua = (items) => worker.fetch(new Request('https://tracker.invalid/api/aqua/sync', {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'X-User-Id': 'member' },
    body: JSON.stringify({ items })
  }), env)
  const soon = (type, x, y, minutes) => ({ type, x, y, eventAt: now + minutes * minute, updatedAt: now })
  await postAqua([
    ...Array.from({ length: 16 }, (_, i) => soon('smallAqua', 200 + i, 200, i + 1)),
    soon('smallAqua', 3, 4, 40), soon('aqua', 3, 4, 41)
  ])
  await api('member', { items: [soon('dragon', 4, 3, 39), soon('dragon', 200, 200, 1)] })
  const getWidget = async (id) => (await (await widgetRequest(id)).json()).upcoming
  assert(!(await getWidget('member')).some((entry) => entry.type === 'smallAqua' && entry.x === 3))
  const display = {
    enabled: { aqua: false }, near50: { smallAqua: true, dragon: true },
    nearDistance: { smallAqua: 5, dragon: 5 }, home: { dragon: { x: 0, y: 0 } }, storm: { x: 0, y: 0 }
  }
  tracker.saveSettings(display)
  assert.equal((await sync.syncNow('aqua', 'silent')).ok, true)
  const filtered = await getWidget('member')
  assert(filtered.some((entry) => entry.type === 'smallAqua' && entry.x === 3))
  assert(filtered.some((entry) => entry.type === 'dragon' && entry.x === 4))
  assert(filtered.every((entry) => entry.type !== 'aqua' && entry.x < 200))
  assert((await getWidget('winner')).some((entry) => entry.type === 'smallAqua' && entry.x >= 200))
  await api('member', { widgetDisplay: { updatedAt: 1, rules: {} } })
  assert.deepEqual(await getWidget('member'), filtered)

  await nextTick()
  setActivePinia(createPinia())
  const reloaded = useTrackerStore()
  const reloadedTarget = (x) => reloaded.entries.find((entry) => entry.type === type && entry.x === x && entry.y === 100)
  assert.equal(reloaded.attackableAt(reloadedTarget(31)), startCase + 18 * hour)
  assert(reloaded.readyList.includes(reloadedTarget(33)))
  assert(reloaded.readyList.includes(reloadedTarget(34)))
  assert.equal(reloaded.attackableAt(reloadedTarget(35)), startCase + 4 * hour + 4 * minute)

  const reloadedUi = useUiStore()
  for (const [hours, minutes] of [[0, 0], [0, 1], [23, 59], [24, 0]]) {
    assert.equal(reloaded.updateReady(reloadedTarget(33).id, hours, minutes), true)
    reloaded.undoTimerUpdate()
  }
  for (const [hours, minutes] of [[24, 1], [25, 0], [-1, 0], [1, 60], [0.5, 0], ['', '']]) {
    assert.equal(reloaded.updateReady(reloadedTarget(33).id, hours, minutes), false)
    assert.equal(reloaded.pendingTimerUpdate, null)
    reloadedUi.closeModal(false)
  }
  const reloadedSync = useSyncStore()
  assert.equal(await reloadedSync.saveConnection({ userId: 'winner', url: 'https://tracker.invalid', token: 'test-token' }), true)
  const correction = reloadedTarget(33)
  for (const [hours, minutes] of [[0, 0], [0, 1], [23, 59], [24, 0], [67, 0], [119, 59], [120, 0]]) {
    assert.equal(reloaded.updateReady(correction.id, hours, minutes), true)
    assert.equal(reloaded.attackableAt(correction), now + hours * hour + minutes * minute)
    reloaded.undoTimerUpdate()
  }
  for (const [hours, minutes] of [[120, 1], [121, 0]]) {
    assert.equal(reloaded.updateReady(correction.id, hours, minutes), false)
    assert.equal(reloaded.pendingTimerUpdate, null)
    reloadedUi.closeModal(false)
  }
})
