import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

function bindD1WithStats(database) {
  return {
    prepare(sql) {
      const bind = (...values) => {
        const execAll = () => {
          const stmt = database.prepare(sql)
          const isSelect = /^\s*SELECT\b/i.test(sql)
          if (isSelect) {
            const results = stmt.all(...values)
            return {
              results,
              meta: {
                changes: 0,
                rows_read: results.length,
                rows_written: 0
              }
            }
          }
          const info = stmt.run(...values)
          const changes = Number(info.changes) || 0
          return {
            results: [],
            meta: {
              changes,
              rows_read: 0,
              rows_written: changes
            }
          }
        }
        return {
          all: async () => execAll(),
          first: async () => {
            const r = execAll()
            return r.results[0] ?? null
          },
          run: async () => execAll()
        }
      }
      return { ...bind(), bind }
    },
    async batch(statements) {
      database.exec('BEGIN')
      try {
        const result = []
        for (const statement of statements) {
          result.push(await statement.all())
        }
        database.exec('COMMIT')
        return result
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    }
  }
}

function makeRequester(worker, env) {
  return async (userId, action, payload) => {
    const response = await worker.fetch(new Request('https://tracker.invalid/api/' + action, {
      method: payload !== undefined ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer test-token',
        'X-User-Id': userId,
        'Content-Type': 'application/json'
      },
      body: payload !== undefined ? JSON.stringify(payload) : undefined
    }), env)
    const data = await response.json()
    return { status: response.status, data }
  }
}

test('partial sync mode scopes items/cooldowns/history and matches full resolution', async (t) => {
  const { default: worker } = await import('../gge-tracker-api/src/index.js?partial-sync-1')
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const env = { DB: bindD1WithStats(db), TOKEN: 'test-token' }
  const req = makeRequester(worker, env)

  const hour = 3_600_000
  const minute = 60_000
  const base = 1_800_000_000_000
  let now = base
  t.mock.method(Date, 'now', () => now)

  // 100件の要塞を登録（他ユーザーのデータも混在させる）
  const items100 = []
  for (let i = 1; i <= 100; i++) {
    items100.push({ type: 'fortress', x: i, y: 10, label: `F${i}`, eventAt: base + i * minute, updatedAt: base })
  }
  assert.equal((await req('userA', 'fort/sync', { items: items100 })).status, 200)
  assert.equal((await req('userB', 'fort/sync', {
    items: [{ type: 'fortress', x: 1, y: 10, label: 'B-secret', eventAt: base + 5 * minute, updatedAt: base }]
  })).status, 200)

  // userB が座標 (1,10) で獲得履歴と winner cooldown、さらに訂正サイクルを作る
  const attackStart = base - 20 * hour
  const win1At = attackStart + 120 * hour
  const win2At = win1At - 2 * hour // 訂正（fort_winner_cycles 発火）
  await req('userB', 'fort/sync', {
    items: [{ type: 'fortress', x: 1, y: 10, eventAt: attackStart, updatedAt: attackStart }],
    history: [{ id: 'h-b1', type: 'fortress', x: 1, y: 10, at: attackStart, result: 'ruby', ruby: 280 }],
    cooldowns: [{ type: 'fortress', x: 1, y: 10, kind: 'winner', historyId: 'h-b1', eventAt: win1At, updatedAt: attackStart }]
  })
  await req('userB', 'fort/sync', {
    items: [],
    cooldowns: [{ type: 'fortress', x: 1, y: 10, kind: 'winner', historyId: 'h-b1', eventAt: win2At, updatedAt: attackStart + minute }]
  })

  // userA は (2,10) に自分の履歴 + クール、および共有観測クールを持つ
  await req('userA', 'fort/sync', {
    items: [{ type: 'fortress', x: 2, y: 10, eventAt: attackStart, updatedAt: attackStart }],
    history: [{ id: 'h-a2', type: 'fortress', x: 2, y: 10, at: attackStart, result: 'ruby', ruby: 300 }],
    cooldowns: [{ type: 'fortress', x: 2, y: 10, kind: 'winner', historyId: 'h-a2', eventAt: base + 50 * hour, updatedAt: attackStart }]
  })

  // 1) 空配列は「全件取得」にならず 0件を返す
  const emptyRes = await req('userA', 'fort/sync', {
    responseScope: 'submitted',
    items: [],
    cooldowns: []
  })
  assert.equal(emptyRes.status, 200)
  assert.equal(emptyRes.data.responseScope, 'submitted')
  assert.equal(emptyRes.data.partial, true)
  assert.deepEqual(emptyRes.data.items, [])
  assert.deepEqual(emptyRes.data.cooldowns, [])
  assert.equal(emptyRes.data.d1Usage.rowsRead, 0)

  // 2) 全件同期 vs 部分同期（1座標更新）の比較 & クール照合結果の一致確認
  const fullBefore = await req('userA', 'fort/sync', { items: [], cooldowns: [] })
  assert.equal(fullBefore.status, 200)
  assert.equal(fullBefore.data.partial, undefined)
  assert.equal(fullBefore.data.items.length, 100)

  // 部分同期で (1,10) に member 観測を更新（1件だけ）
  const partialRes = await req('userA', 'fort/sync', {
    responseScope: 'submitted',
    items: [{ type: 'fortress', x: 1, y: 10, label: 'F1-updated', eventAt: base + 10 * minute, updatedAt: base + minute }],
    cooldowns: [{ type: 'fortress', x: 1, y: 10, kind: 'member', eventAt: base + 10 * hour, updatedAt: base }]
  })
  assert.equal(partialRes.status, 200)
  assert.equal(partialRes.data.partial, true)
  assert.equal(partialRes.data.responseScope, 'submitted')
  assert.equal(partialRes.data.items.length, 1)
  assert.equal(partialRes.data.items[0].key, 'fortress|1|10')
  assert.equal(partialRes.data.items[0].label, 'F1-updated')
  assert.equal(partialRes.data.cooldowns.length, 1)
  assert.equal(partialRes.data.cooldownResults[0].status, 'ok')

  // 同じ条件で全件同期した結果の (1,10) と完全一致すること、および userB の秘密ラベルが漏れないこと
  const fullAfter = await req('userA', 'fort/sync', { items: [], cooldowns: [] })
  const fullFort1 = fullAfter.data.items.find((i) => i.key === 'fortress|1|10')
  const fullCd1 = fullAfter.data.cooldowns.find((c) => c.key === 'fortress|1|10')
  assert.deepEqual(partialRes.data.items[0], fullFort1)
  assert.deepEqual(partialRes.data.cooldowns[0], fullCd1)
  assert.equal(fullAfter.data.items.some((i) => i.label === 'B-secret'), false)

  // 3) 読み込み行数の比較：100件中1件更新で大幅削減されていること
  // 全件同期は items(100) + readFortCooldowns(100) = 200行読込、部分同期は items(1) + readFortCooldowns(1) = 2行読込
  const fullReadTest = await req('userA', 'fort/sync', {
    items: [{ type: 'fortress', x: 2, y: 10, label: 'F2-full', eventAt: base + 20 * minute, updatedAt: base + 2 * minute }],
    cooldowns: [{ type: 'fortress', x: 2, y: 10, kind: 'member', eventAt: base + 12 * hour, updatedAt: base }]
  })
  const partialReadTest = await req('userA', 'fort/sync', {
    responseScope: 'submitted',
    items: [{ type: 'fortress', x: 2, y: 10, label: 'F2-part', eventAt: base + 21 * minute, updatedAt: base + 3 * minute }],
    cooldowns: [{ type: 'fortress', x: 2, y: 10, kind: 'member', eventAt: base + 12 * hour, updatedAt: base }]
  })
  assert.equal(fullReadTest.data.items.length, 100)
  assert.equal(partialReadTest.data.items.length, 1)
  assert.ok(partialReadTest.data.d1Usage.rowsRead <= 4, `expected <=4 rowsRead, got ${partialReadTest.data.d1Usage.rowsRead}`)
})

test('partial sync rejects stale updates, invalid inputs, unregistered cooldowns, and duplicate history', async (t) => {
  const { default: worker } = await import('../gge-tracker-api/src/index.js?partial-sync-2')
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const env = { DB: bindD1WithStats(db), TOKEN: 'test-token' }
  const req = makeRequester(worker, env)

  const base = 1_800_000_000_000
  let now = base
  t.mock.method(Date, 'now', () => now)

  // 不正な responseScope や件数超過は 400
  assert.equal((await req('u1', 'fort/sync', { responseScope: 'unknown' })).status, 400)
  assert.equal((await req('u1', 'aqua/sync', { responseScope: 'submitted', items: [] })).status, 400)
  const overItems = Array.from({ length: 1001 }, (_, i) => ({ type: 'dragon', x: i, y: 1, eventAt: base, updatedAt: base }))
  assert.equal((await req('u1', 'fort/sync', { responseScope: 'submitted', items: overItems })).status, 400)

  // 新規登録
  await req('u1', 'fort/sync', {
    responseScope: 'submitted',
    items: [{ type: 'dragon', x: 5, y: 5, label: 'new', eventAt: base + 1000, updatedAt: base + 500 }]
  })

  // 古い更新で上書きしない（conflict が返る）
  const staleRes = await req('u1', 'fort/sync', {
    responseScope: 'submitted',
    items: [{ type: 'dragon', x: 5, y: 5, label: 'old', eventAt: base + 9999, updatedAt: base + 100 }]
  })
  assert.equal(staleRes.data.items[0].label, 'new')
  assert.equal(staleRes.data.itemResults[0].status, 'conflict')

  // 未登録座標へのクール送信は cooldowns に含まれず、cooldownResults に unregistered として返る
  const unregCd = await req('u1', 'fort/sync', {
    responseScope: 'submitted',
    items: [],
    cooldowns: [{ type: 'dragon', x: 999, y: 999, kind: 'member', eventAt: base + 3_600_000, updatedAt: base }]
  })
  assert.deepEqual(unregCd.data.cooldowns, [])
  assert.equal(unregCd.data.cooldownResults[0].key, 'dragon|999|999')
  assert.equal(unregCd.data.cooldownResults[0].status, 'unregistered')

  // 不正なクール（24h超の member）は rejected が返る
  const invalidCd = await req('u1', 'fort/sync', {
    responseScope: 'submitted',
    cooldowns: [{ type: 'dragon', x: 5, y: 5, kind: 'member', eventAt: base + 25 * 3_600_000, updatedAt: base }]
  })
  assert.equal(invalidCd.data.cooldownResults[0].status, 'rejected')

  // 履歴送信：同一リクエスト再送で重複せず、時刻も作り直されない。historySince 未指定時は全件返さない
  const histAt = base - 10_000
  const histReq = {
    responseScope: 'submitted',
    items: [],
    history: [{ id: 'hist-1', type: 'dragon', x: 5, y: 5, at: histAt, result: 'ruby', ruby: 150 }]
  }
  const h1 = await req('u1', 'fort/sync', histReq)
  assert.deepEqual(h1.data.history, [])
  assert.equal(h1.data.historyNow, undefined)

  now = base + 5_000
  const h2 = await req('u1', 'fort/sync', { ...histReq, historySince: base })
  assert.equal(h2.data.history.length, 1)
  assert.equal(h2.data.history[0].at, histAt)
  assert.equal(db.prepare('SELECT COUNT(*) AS cnt FROM history WHERE user_id=?').get('u1').cnt, 1)

  // 削除を含む場合：対象座標の削除が反映され、items には deleted: true、cooldowns からは除外される
  const delRes = await req('u1', 'fort/sync', {
    responseScope: 'submitted',
    items: [{ type: 'dragon', x: 5, y: 5, deleted: true, updatedAt: now }],
    cooldowns: [{ type: 'dragon', x: 5, y: 5, kind: 'member', eventAt: now + 3_600_000, updatedAt: now }]
  })
  assert.equal(delRes.data.items.length, 1)
  assert.equal(delRes.data.items[0].deleted, true)
  assert.equal(delRes.data.itemResults[0].status, 'deleted')
  assert.deepEqual(delRes.data.cooldowns, [])
  assert.equal(delRes.data.cooldownResults[0].status, 'unregistered')
})

test('partial sync handles >90 items chunking cleanly', async (t) => {
  const { default: worker } = await import('../gge-tracker-api/src/index.js?partial-sync-3')
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const env = { DB: bindD1WithStats(db), TOKEN: 'test-token' }
  const req = makeRequester(worker, env)

  const base = 1_800_000_000_000
  const items120 = Array.from({ length: 120 }, (_, i) => ({
    type: 'wildFortress', x: i + 1, y: 20, eventAt: base + 60_000, updatedAt: base
  }))
  const cooldowns120 = Array.from({ length: 120 }, (_, i) => ({
    type: 'wildFortress', x: i + 1, y: 20, kind: 'member', eventAt: base + 3_600_000, updatedAt: base
  }))
  const res = await req('u-chunk', 'fort/sync', {
    responseScope: 'submitted',
    items: items120,
    cooldowns: cooldowns120
  })
  assert.equal(res.status, 200)
  assert.equal(res.data.items.length, 120)
  assert.equal(res.data.cooldowns.length, 120)
})
