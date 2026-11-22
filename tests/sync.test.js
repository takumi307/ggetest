import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createServer } from 'vite'
import { createPinia, setActivePinia } from 'pinia'

test('both channels start automatic sync five minutes after the last attempt', async (t) => {
  const vite = await createServer({ server: { middlewareMode: true, ws: false }, appType: 'custom' })
  t.after(() => vite.close())
  const { useSyncStore } = await vite.ssrLoadModule('/src/stores/syncStore.js')

  const connection = JSON.stringify({ url: 'https://tracker.invalid', token: 'test-token' })
  const storage = new Map([
    ['ggeUserId', '"test-user"'],
    ['ggeAquaSyncSettings', connection],
    ['ggeFortSyncSettings', connection]
  ])
  const page = { visibilityState: 'visible', querySelector: () => null }
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: page })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value)
  } })
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else delete globalThis.document
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete globalThis.localStorage
    setActivePinia(undefined)
  })

  const start = 1_800_000_000_000
  const interval = 5 * 60 * 1000
  let now = start
  t.mock.method(Date, 'now', () => now)
  const requests = []
  t.mock.method(globalThis, 'fetch', (url) => new Promise((resolve) => requests.push({ url, resolve })))

  setActivePinia(createPinia())
  const sync = useSyncStore()
  sync.autoSyncIfNeeded()
  assert.deepEqual(requests.map(({ url }) => new URL(url).pathname), ['/api/aqua/sync', '/api/fort/sync'])
  sync.autoSyncIfNeeded()
  assert.equal(requests.length, 2)

  now = start + 8_000
  requests[0].resolve(new Response('{"items":[]}'))
  requests[1].resolve(new Response('{"error":"test failure"}', { status: 500 }))
  await setImmediate()
  assert.equal(sync.channels.aqua.settings.lastSyncAt, now)
  assert.equal(sync.runtime.fort.failStreak, 1)

  now = start + interval - 1
  sync.autoSyncIfNeeded()
  assert.equal(requests.length, 2)

  now++
  page.visibilityState = 'hidden'
  sync.autoSyncIfNeeded()
  assert.equal(requests.length, 2)
  page.visibilityState = 'visible'
  sync.autoSyncIfNeeded()
  assert.deepEqual(requests.slice(2).map(({ url }) => new URL(url).pathname), ['/api/aqua/sync', '/api/fort/sync'])
  requests[2].resolve(new Response('{"items":[]}'))
  requests[3].resolve(new Response('{"items":[],"history":[]}'))
  await setImmediate()
  assert.equal(sync.runtime.fort.failStreak, 0)
})
