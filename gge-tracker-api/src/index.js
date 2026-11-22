/**
 * GGE Tracker API（Cloudflare Workers + D1）v2
 *
 * 認証   : Authorization: Bearer <TOKEN>（Secret）／ X-User-Id: <ユーザーID>
 * ルート : POST /api/aqua/sync | settings | test
 *          POST /api/fort/sync | settings | test
 * データ : 要塞・ドラゴンの座標・履歴 = ユーザーIDごと／120時間タイマー・アクア = 全員で共通
 * 通知   : Cronトリガー（5分おき）。Webhook・通知設定はアプリから登録（D1に保存）
 *
 * Secrets: TOKEN
 * Vars   : ALLOWED_ORIGIN（カンマ区切りで複数可）
 */

import { resolveFortTiming, fortAttackableAt } from '../../src/utils/fortTiming.js'
import {
  FORT_SHARED_COOLDOWN_MS, FORT_MEMBER_COOLDOWN_MS, FORT_COOLDOWN_OFFSET_MS, FORT_CYCLE_TOLERANCE_MS
} from '../../src/utils/constants.js'

const FORT_TYPES = ['dragon', 'fortress', 'wildFortress']
const AQUA_TYPES = ['aqua', 'smallAqua']
const CHANNEL_TYPES = { aqua: AQUA_TYPES, fort: FORT_TYPES }
const SHARED_USER = 'shared' // アクアの共通データの保存先

const TYPE_INFO = {
  dragon: { name: 'ドラゴン', icon: '🐉', emoji: 'doragon' },
  fortress: { name: '砂漠の要塞', icon: '🏰', emoji: 'sabakunoyousai' },
  wildFortress: { name: '野生の要塞', icon: '🌲', emoji: 'yaseinoyousai' },
  aqua: { name: '大アクア', icon: '🌊', emoji: 'daiakua' },
  smallAqua: { name: '小アクア', icon: '💧', emoji: 'syouakua' }
}

function notificationIcon(env, info) {
  const id = env.DISCORD_EMOJI_IDS?.[info.emoji]
  return typeof id === 'string' && /^\d{17,20}$/.test(id) ? '<:' + info.emoji + ':' + id + '>' : info.icon
}

const TOMB_KEEP_MS = 60 * 24 * 3600 * 1000       // 削除の記録は60日で破棄
const HIST_TOMB_KEEP_MS = 180 * 24 * 3600 * 1000 // ルビー記録の削除の記録は180日で破棄
const MAX_ITEMS = 1000
const MAX_HIST = 3000
const TARGET_DURATION_MS = 15 * 60 * 1000
const GRACE_MIN = 10          // 時刻から何分以内なら「通常の通知」にするか
const DIGEST_MAX_AGE_H = 12   // まとめ通知に含める最大の遅れ（時間）
const MAX_MESSAGES_PER_RUN = 5 // 1グループが1回の実行で送るDiscordメッセージの上限
const MESSAGE_GAP_MS = 1200    // メッセージの間隔（Discordの送信制限対策）
const SMALL_AQUA_REMINDER_MS = 5 * 3600000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ================= スキーマ（初回アクセス時に自動作成） ================= */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS items (
    user_id TEXT NOT NULL, channel TEXT NOT NULL, item_key TEXT NOT NULL, type TEXT NOT NULL,
    x REAL NOT NULL, y REAL NOT NULL, label TEXT NOT NULL DEFAULT '',
    event_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0, notify INTEGER NOT NULL DEFAULT 1, notified INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel, item_key))`,
  `CREATE INDEX IF NOT EXISTS idx_items_notify ON items (deleted, notify, event_at)`,
  `CREATE INDEX IF NOT EXISTS idx_items_small_aqua ON items (user_id, event_at)
    WHERE channel='aqua' AND type='smallAqua' AND deleted=0`,
  `CREATE TABLE IF NOT EXISTS aqua_lost (item_key TEXT PRIMARY KEY, event_at INTEGER NOT NULL)`,
  `CREATE TRIGGER IF NOT EXISTS clear_aqua_lost AFTER UPDATE OF event_at, deleted ON items
    WHEN NEW.channel='aqua' AND (NEW.deleted=1 OR NEW.event_at<>OLD.event_at)
    BEGIN DELETE FROM aqua_lost WHERE item_key=NEW.item_key; END`,
  `CREATE TABLE IF NOT EXISTS aqua_reminders (
    item_key TEXT NOT NULL, event_at INTEGER NOT NULL, claimed_at INTEGER NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (item_key, event_at))`,
  `CREATE INDEX IF NOT EXISTS idx_aqua_reminders_event ON aqua_reminders (event_at)`,
  `CREATE TABLE IF NOT EXISTS history (
    user_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL DEFAULT '', entry_id TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '', x REAL NOT NULL DEFAULT 0, y REAL NOT NULL DEFAULT 0,
    result TEXT NOT NULL DEFAULT 'ruby', ruby INTEGER NOT NULL DEFAULT 0, at_ms INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0, touched_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id))`,
  `CREATE INDEX IF NOT EXISTS idx_history_touched ON history (user_id, touched_at)`,
  `CREATE INDEX IF NOT EXISTS idx_history_tomb ON history (user_id, touched_at) WHERE deleted=1`,
  `CREATE TABLE IF NOT EXISTS fort_cooldowns (
    user_id TEXT NOT NULL, item_key TEXT NOT NULL, event_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, history_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, item_key))`,
  `CREATE INDEX IF NOT EXISTS idx_fort_cooldowns_item ON fort_cooldowns (item_key, event_at)`,
  `CREATE TABLE IF NOT EXISTS fort_winner_cycles (
    user_id TEXT NOT NULL, item_key TEXT NOT NULL, history_id TEXT NOT NULL,
    first_at INTEGER NOT NULL, member_cap INTEGER,
    PRIMARY KEY (user_id, item_key))`,
  `CREATE TRIGGER IF NOT EXISTS track_fort_winner_correction AFTER UPDATE OF event_at ON fort_cooldowns
    WHEN NEW.history_id<>'' AND NEW.history_id=OLD.history_id AND NEW.event_at<>OLD.event_at
    BEGIN
      INSERT INTO fort_winner_cycles (user_id, item_key, history_id, first_at, member_cap)
      VALUES (NEW.user_id, NEW.item_key, NEW.history_id, OLD.event_at,
        CASE WHEN OLD.event_at-${FORT_COOLDOWN_OFFSET_MS}<=NEW.updated_at THEN OLD.event_at-${FORT_COOLDOWN_OFFSET_MS} END)
      ON CONFLICT(user_id,item_key) DO UPDATE SET history_id=excluded.history_id,
        first_at=CASE WHEN fort_winner_cycles.history_id=excluded.history_id THEN fort_winner_cycles.first_at ELSE excluded.first_at END,
        member_cap=CASE WHEN fort_winner_cycles.history_id=excluded.history_id
          THEN COALESCE(fort_winner_cycles.member_cap, excluded.member_cap) ELSE excluded.member_cap END;
    END`,
  `CREATE TABLE IF NOT EXISTS fort_member_observations (
    user_id TEXT NOT NULL, item_key TEXT NOT NULL, event_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, item_key))`,
  `CREATE TABLE IF NOT EXISTS entry_preferences (
    user_id TEXT NOT NULL, channel TEXT NOT NULL, item_key TEXT NOT NULL, field TEXT NOT NULL,
    value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, channel, item_key, field))`,
  `CREATE TABLE IF NOT EXISTS target_intents (
    channel TEXT NOT NULL, item_key TEXT NOT NULL, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY (channel, item_key))`,
  `CREATE INDEX IF NOT EXISTS idx_target_intents_expiry ON target_intents (expires_at)`,
  `CREATE TABLE IF NOT EXISTS storm_homes (
    user_id TEXT PRIMARY KEY, x REAL, y REAL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS widget_display (
    user_id TEXT PRIMARY KEY, rules TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (
    user_id TEXT NOT NULL, channel TEXT NOT NULL, json TEXT NOT NULL,
    PRIMARY KEY (user_id, channel))`
]

let schemaReady = null
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => {
      schemaReady = null
      throw e
    })
  }
  return schemaReady
}

/* D1のバッチは100件ずつに分けて実行し、消費量と各ステートメントの結果を返す */
async function runBatch(env, stmts, metrics) {
  const results = []
  for (let i = 0; i < stmts.length; i += 100) {
    const chunk = await env.DB.batch(stmts.slice(i, i + 100))
    for (const r of chunk) {
      recordMeta(metrics, r?.meta)
      results.push(r)
    }
  }
  return results
}

function createMetrics(op, mode) {
  return {
    op,
    mode,
    startedAt: Date.now(),
    queries: 0,
    rowsRead: 0,
    rowsWritten: 0,
    targetItems: 0,
    targetCooldowns: 0,
    targetHistory: 0,
    counts: { ok: 0, conflict: 0, rejected: 0 }
  }
}

function recordMeta(metrics, meta) {
  if (!metrics || !meta) return
  metrics.queries += 1
  metrics.rowsRead += Number(meta.rows_read) || 0
  metrics.rowsWritten += Number(meta.rows_written) || 0
}

async function dbAll(stmt, metrics) {
  const res = await stmt.all()
  recordMeta(metrics, res?.meta)
  return res
}

/* ================= 共通 ================= */
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(cors || {}) }
  })
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || ''
  const allowed = String(env.ALLOWED_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean)
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, X-User-Id, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  }
  if (allowed.includes('*')) h['Access-Control-Allow-Origin'] = '*'
  else if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin
  return h
}

async function safeEqual(a, b) {
  const enc = new TextEncoder()
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b)))
  ])
  const x = new Uint8Array(ha)
  const y = new Uint8Array(hb)
  let d = 0
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]
  return d === 0
}

const asArr = (v) => (Array.isArray(v) ? v : [])
const pad = (n) => String(n).padStart(2, '0')
const jstHour = (ms) => new Date(ms + 9 * 3600000).getUTCHours()
function jstHM(ms) {
  const d = new Date(ms + 9 * 3600000)
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes())
}

/* ================= リクエスト処理 ================= */
export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    try {
      return await route(request, env, cors)
    } catch (err) {
      console.error(err)
      return json({ ok: false, error: 'サーバーエラー: ' + ((err && err.message) || err) }, 500, cors)
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(notifyCheck(env).catch((e) => console.error('notifyCheck error', e)))
  }
}

async function route(request, env, cors) {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (request.method === 'GET' && (path === '/' || path === '/api')) {
    return json({ ok: true, message: 'GGE Tracker API is running' }, 200, cors)
  }

  const widget = path === '/api/widget' && request.method === 'GET'
  const m = path.match(/^\/api\/(aqua|fort)\/(sync|settings|test|target)$/)
  const aquaLost = path === '/api/aqua/lost' && request.method === 'POST'
  if (!widget && !aquaLost && (!m || request.method !== 'POST')) return json({ ok: false, error: '不明な操作です' }, 404, cors)

  if (!env.TOKEN) return json({ ok: false, error: 'サーバーにTOKENが設定されていません' }, 500, cors)
  const auth = request.headers.get('Authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!(await safeEqual(token, env.TOKEN))) return json({ ok: false, error: '合言葉が違います' }, 401, cors)

  const userId = (request.headers.get('X-User-Id') || '').trim()
  if (!/^[\x21-\x7E]{1,64}$/.test(userId)) {
    return json({ ok: false, error: 'ユーザーIDが正しくありません（半角英数字・記号、64文字以内）' }, 400, cors)
  }
  await ensureSchema(env)
  if (widget) return json(await widgetSnapshot(env, userId), 200, { ...cors, 'Cache-Control': 'no-store' })
  let body = {}
  try { body = await request.json() } catch (e) { body = {} }
  if (!body || typeof body !== 'object') body = {}

  if (aquaLost) {
    const r = await handleAquaLost(env, body)
    return json(r, r.ok ? 200 : 409, cors)
  }

  const [, channel, action] = m
  // アクアは全員で共通のデータ。要塞・ドラゴンはユーザーごと
  const dataUser = channel === 'aqua' ? SHARED_USER : userId

  if (action === 'settings') {
    const r = await handleSettings(env, dataUser, channel, body)
    return json(r, r.ok ? 200 : 400, cors)
  }
  if (action === 'test') {
    const r = await handleTest(env, dataUser, channel, userId, body)
    return json(r, r.ok ? 200 : 400, cors)
  }
  if (action === 'target') {
    const result = await handleTarget(env, channel, userId, body)
    return json(result, result.ok ? 200 : 400, cors)
  }
  const r = await handleSync(env, dataUser, channel, body, userId)
  return json(r, r.ok ? 200 : (r.status || 400), cors)
}

async function listAquaLost(env) {
  const { results } = await env.DB.prepare('SELECT item_key, event_at FROM aqua_lost').all()
  return results.map((r) => ({ key: r.item_key, eventAt: r.event_at }))
}

async function handleAquaLost(env, body) {
  const item = normalizeItem(body, AQUA_TYPES)
  if (!item || typeof body.lost !== 'boolean') return { ok: false, error: '対象が正しくありません' }
  const current = env.DB.prepare(`SELECT item_key FROM items
    WHERE user_id=? AND channel='aqua' AND item_key=? AND event_at=? AND deleted=0`)
    .bind(SHARED_USER, item.key, item.eventAt)
  const write = body.lost
    ? env.DB.prepare(`INSERT OR IGNORE INTO aqua_lost (item_key, event_at)
        SELECT item_key, event_at FROM items WHERE user_id=? AND channel='aqua'
          AND item_key=? AND event_at=? AND deleted=0`).bind(SHARED_USER, item.key, item.eventAt)
    : env.DB.prepare('DELETE FROM aqua_lost WHERE item_key=? AND event_at=?').bind(item.key, item.eventAt)
  const [match] = await env.DB.batch([current, write])
  if (!match.results.length) return { ok: false, error: '対象の時刻が変わりました。同期してからもう一度操作してください。' }
  return { ok: true, lost: await listAquaLost(env) }
}

/* ================= 端末同期（sync） ================= */
function normalizeItem(it, types) {
  if (!it || types.indexOf(it.type) === -1) return null
  const x = Number(it.x)
  const y = Number(it.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const deleted = it.deleted === true
  const eventAt = Number(it.eventAt)
  if (!deleted && !Number.isFinite(eventAt)) return null
  return {
    key: it.type + '|' + x + '|' + y,
    type: it.type,
    x, y,
    label: String(it.label || '').slice(0, 50),
    eventAt: Number.isFinite(eventAt) ? eventAt : 0,
    updatedAt: Number(it.updatedAt) || 0,
    deleted,
    notify: it.notify !== false, // 省略時は通知する
    notified: 0
  }
}

/* incoming(a) が current(b) に勝つか（「最後に編集した方が勝ち」） */
function wins(a, b) {
  if (a.deleted && b.deleted) return a.updatedAt > b.updatedAt
  if (a.deleted) return a.updatedAt >= b.updatedAt
  if (b.deleted) return a.updatedAt > b.updatedAt
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt
  return a.eventAt > b.eventAt
}

function rowToRec(r) {
  return {
    key: r.item_key, type: r.type, x: r.x, y: r.y, label: r.label || '',
    eventAt: r.event_at, updatedAt: r.updated_at, deleted: !!r.deleted,
    notify: !!r.notify, notified: r.notified || 0
  }
}
function publicRec(r) {
  return {
    key: r.key, type: r.type, x: r.x, y: r.y, label: r.label,
    eventAt: r.eventAt, updatedAt: r.updatedAt, deleted: r.deleted, notify: r.notify
  }
}

function upsertStmt(env, dataUser, channel, r) {
  return env.DB.prepare(
    `INSERT INTO items (user_id, channel, item_key, type, x, y, label, event_at, updated_at, deleted, notify, notified)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id, channel, item_key) DO UPDATE SET
       type=excluded.type, x=excluded.x, y=excluded.y, label=excluded.label,
       event_at=excluded.event_at, updated_at=excluded.updated_at,
       deleted=excluded.deleted, notify=excluded.notify,
       notified=CASE WHEN excluded.deleted=0 AND excluded.event_at=items.event_at
         THEN items.notified ELSE excluded.notified END
     ${channel === 'aqua' ? `WHERE excluded.updated_at>items.updated_at
       OR (excluded.updated_at=items.updated_at AND (excluded.deleted>items.deleted
         OR (excluded.deleted=0 AND items.deleted=0 AND excluded.event_at>items.event_at)))` : ''}`
  ).bind(dataUser, channel, r.key, r.type, r.x, r.y, r.label, r.eventAt, r.updatedAt, r.deleted ? 1 : 0, r.notify ? 1 : 0, r.notified || 0)
}

function rawFortKey(it) {
  if (!it || FORT_TYPES.indexOf(it.type) === -1) return null
  const x = Number(it.x)
  const y = Number(it.y)
  return Number.isFinite(x) && Number.isFinite(y) ? `${it.type}|${x}|${y}` : null
}

async function loadScopedItems(env, dataUser, channel, keys, metrics) {
  const map = new Map()
  if (!keys.length) return map
  const stmts = []
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90)
    stmts.push(
      env.DB.prepare(
        `SELECT item_key, type, x, y, label, event_at, updated_at, deleted, notify, notified
         FROM items WHERE user_id=? AND channel=? AND item_key IN (${chunk.map(() => '?').join(',')})`
      ).bind(dataUser, channel, ...chunk)
    )
  }
  const rs = await runBatch(env, stmts, metrics)
  rs.forEach((r) => (r.results || []).forEach((row) => map.set(row.item_key, rowToRec(row))))
  return map
}

async function handleSync(env, dataUser, channel, req, userId) {
  const scopeRaw = req.responseScope
  if (scopeRaw !== undefined && scopeRaw !== null && scopeRaw !== 'full' && scopeRaw !== 'submitted') {
    return { ok: false, status: 400, error: 'responseScope の指定が正しくありません' }
  }
  const isPartial = scopeRaw === 'submitted'
  if (isPartial && channel !== 'fort') {
    return { ok: false, status: 400, error: '部分同期モードは fort チャンネルのみ対応しています' }
  }
  if (isPartial) {
    if (Array.isArray(req.items) && req.items.length > MAX_ITEMS) {
      return { ok: false, status: 400, error: 'items の件数が上限を超えています' }
    }
    if (Array.isArray(req.cooldowns) && req.cooldowns.length > MAX_ITEMS) {
      return { ok: false, status: 400, error: 'cooldowns の件数が上限を超えています' }
    }
    if (Array.isArray(req.history) && req.history.length > MAX_HIST) {
      return { ok: false, status: 400, error: 'history の件数が上限を超えています' }
    }
  }

  const types = CHANNEL_TYPES[channel]
  const now = Date.now()
  const metrics = createMetrics(`${channel}.sync`, isPartial ? 'submitted' : 'full')

  let map
  const dirty = new Set()
  let out = []
  const itemResults = []

  if (isPartial) {
    const submittedItems = new Map()
    for (const it of asArr(req.items)) {
      const rec = normalizeItem(it, types)
      if (!rec) {
        itemResults.push({ key: rawFortKey(it), status: 'rejected', reason: 'invalid_item' })
        metrics.counts.rejected += 1
        continue
      }
      const prev = submittedItems.get(rec.key)
      if (!prev || wins(rec, prev)) submittedItems.set(rec.key, rec)
    }
    const targetKeys = Array.from(submittedItems.keys())
    metrics.targetItems = targetKeys.length
    map = await loadScopedItems(env, dataUser, channel, targetKeys, metrics)

    for (const rec of submittedItems.values()) {
      const cur = map.get(rec.key)
      if (!cur) {
        if (!rec.deleted && rec.eventAt <= rec.updatedAt) rec.notified = rec.eventAt
        map.set(rec.key, rec)
        dirty.add(rec.key)
        itemResults.push({ key: rec.key, status: rec.deleted ? 'deleted' : 'inserted' })
        metrics.counts.ok += 1
        continue
      }
      if (wins(rec, cur)) {
        const sameTime = !rec.deleted && cur.eventAt === rec.eventAt
        rec.notified = sameTime ? cur.notified : 0
        if (!sameTime && !rec.deleted && rec.eventAt <= rec.updatedAt) rec.notified = rec.eventAt
        map.set(rec.key, rec)
        dirty.add(rec.key)
        itemResults.push({ key: rec.key, status: rec.deleted ? 'deleted' : 'updated' })
        metrics.counts.ok += 1
      } else if (!rec.deleted && !cur.deleted && rec.updatedAt === cur.updatedAt && rec.eventAt === cur.eventAt && cur.notify !== rec.notify) {
        cur.notify = rec.notify
        dirty.add(rec.key)
        itemResults.push({ key: rec.key, status: 'updated' })
        metrics.counts.ok += 1
      } else if (!rec.deleted && !cur.deleted && rec.updatedAt === cur.updatedAt && rec.eventAt === cur.eventAt && rec.label === cur.label) {
        itemResults.push({ key: rec.key, status: 'unchanged' })
        metrics.counts.ok += 1
      } else {
        itemResults.push({ key: rec.key, status: 'conflict', reason: 'stale_update' })
        metrics.counts.conflict += 1
      }
    }

    const stmts = []
    for (const k of targetKeys) {
      const r = map.get(k)
      if (!r) continue
      out.push(r)
      if (dirty.has(k)) stmts.push(upsertStmt(env, dataUser, channel, r))
    }
    if (stmts.length) await runBatch(env, stmts, metrics)
  } else {
    const rawItems = asArr(req.items).slice(0, MAX_ITEMS)
    metrics.targetItems = rawItems.length
    const { results } = await dbAll(
      env.DB.prepare(
        'SELECT item_key, type, x, y, label, event_at, updated_at, deleted, notify, notified FROM items WHERE user_id=? AND channel=?'
      ).bind(dataUser, channel),
      metrics
    )
    map = new Map()
    results.forEach((r) => map.set(r.item_key, rowToRec(r)))

    rawItems.forEach((it) => {
      const rec = normalizeItem(it, types)
      if (!rec) return
      const cur = map.get(rec.key)
      if (channel === 'aqua') {
        rec.notify = true
        rec.label = cur?.label || '' // 共有に残っている旧ラベルは保存のみ。新しいラベルはユーザーID別。
      }
      if (!cur) {
        // 登録した時点ですでに攻撃可能だったもの（時刻が更新日時以前）は、通知の対象にしない
        if (!rec.deleted && rec.eventAt <= rec.updatedAt) rec.notified = rec.eventAt
        map.set(rec.key, rec)
        dirty.add(rec.key)
        return
      }
      if (wins(rec, cur)) {
        // 同じ時刻なら「通知済み」を引き継ぐ（時刻が変わったら、また通知する）
        const sameTime = !rec.deleted && cur.eventAt === rec.eventAt
        rec.notified = sameTime ? cur.notified : 0
        if (!sameTime && !rec.deleted && rec.eventAt <= rec.updatedAt) rec.notified = rec.eventAt
        map.set(rec.key, rec)
        dirty.add(rec.key)
      } else if (!rec.deleted && !cur.deleted && rec.updatedAt === cur.updatedAt && rec.eventAt === cur.eventAt && cur.notify !== rec.notify) {
        cur.notify = rec.notify // 内容が同じなら、通知する／しないの設定だけ最新の送信を反映
        dirty.add(rec.key)
      }
    })

    const stmts = []
    for (const [k, r] of Array.from(map.entries())) {
      if (r.deleted && now - r.updatedAt > TOMB_KEEP_MS) {
        stmts.push(env.DB.prepare('DELETE FROM items WHERE user_id=? AND channel=? AND item_key=? AND deleted=1 AND updated_at=?')
          .bind(dataUser, channel, k, r.updatedAt))
        continue
      }
      out.push(channel === 'aqua' ? { ...r, label: '' } : r)
      if (dirty.has(k)) stmts.push(upsertStmt(env, dataUser, channel, r))
    }
    if (stmts.length) await runBatch(env, stmts, metrics)
  }

  const res = { ok: true, items: out.map(publicRec) }
  if (isPartial) {
    res.responseScope = 'submitted'
    res.partial = true
    res.itemResults = itemResults
  }
  if (channel === 'aqua') res.lost = await listAquaLost(env)
  if (channel === 'fort' && Array.isArray(req.history)) {
    await addHistory(env, dataUser, req, res, now, metrics, isPartial)
  }
  if (channel === 'fort' && (Array.isArray(req.cooldowns) || isPartial)) {
    const cdRes = await syncFortCooldowns(env, dataUser, asArr(req.cooldowns), {
      scope: isPartial ? 'submitted' : 'full',
      metrics
    })
    if (isPartial) {
      res.cooldowns = cdRes.cooldowns
      res.cooldownResults = cdRes.results
    } else {
      res.cooldowns = cdRes
    }
  }
  if (Array.isArray(req.preferences)) res.preferences = await syncPreferences(env, channel, userId, req.preferences)
  if (req.includeTargets === true) res.targets = await listTargets(env, channel, userId, now)
  if (channel === 'aqua' && (req.includeNearest === true || req.stormHome)) {
    await syncStormHomes(env, userId, req, res, out)
  }
  if (req.widgetDisplay) res.widgetDisplaySaved = await saveWidgetDisplay(env, userId, req.widgetDisplay)

  const durationMs = Math.max(0, Date.now() - metrics.startedAt)
  if (isPartial) {
    res.d1Usage = {
      queries: metrics.queries,
      rowsRead: metrics.rowsRead,
      rowsWritten: metrics.rowsWritten,
      durationMs
    }
  }
  console.log(JSON.stringify({
    type: 'd1_sync_metrics',
    op: metrics.op,
    mode: metrics.mode,
    targetItems: metrics.targetItems,
    targetCooldowns: metrics.targetCooldowns,
    targetHistory: metrics.targetHistory,
    queries: metrics.queries,
    rowsRead: metrics.rowsRead,
    rowsWritten: metrics.rowsWritten,
    durationMs,
    counts: metrics.counts
  }))
  return res
}

async function syncStormHomes(env, userId, req, response, entries) {
  const update = req.stormHome
  if (update && Number.isSafeInteger(update.updatedAt) && update.updatedAt > 0 &&
      (update.enabled === false || (update.enabled === true && Number.isFinite(update.x) && Number.isFinite(update.y)))) {
    await env.DB.prepare(`INSERT INTO storm_homes (user_id,x,y,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET x=excluded.x,y=excluded.y,updated_at=excluded.updated_at
      WHERE excluded.updated_at>storm_homes.updated_at`)
      .bind(userId, update.enabled ? update.x : null, update.enabled ? update.y : null, update.updatedAt).run()
  }
  if (req.includeNearest !== true) return
  const { results } = await env.DB.prepare(`SELECT user_id,x,y,updated_at FROM storm_homes
    WHERE x IS NOT NULL OR user_id=? ORDER BY user_id`).bind(userId).all()
  const own = results.find((home) => home.user_id === userId)
  response.stormHome = own ? { enabled: own.x !== null, x: own.x, y: own.y, updatedAt: own.updated_at } : null
  const participants = results.filter((home) => home.x !== null)
  response.nearest = []
  if (!participants.length) return
  for (const entry of entries) {
    if (entry.deleted) continue
    let distance = Infinity
    let users = []
    for (const home of participants) {
      const candidate = Math.hypot(entry.x - home.x, entry.y - home.y)
      if (!Number.isFinite(candidate) || candidate > distance) continue
      if (candidate < distance) { distance = candidate; users = [] }
      users.push(home.user_id)
    }
    if (users.length) response.nearest.push({ key: entry.key, distance, users })
  }
}

function entryKey(channel, type, x, y) {
  if (!CHANNEL_TYPES[channel].includes(type) || typeof x !== 'number' || typeof y !== 'number' ||
      !Number.isFinite(x) || !Number.isFinite(y)) return null
  return `${type}|${x}|${y}`
}

async function syncPreferences(env, channel, userId, changes) {
  const sql = `INSERT INTO entry_preferences (user_id,channel,item_key,field,value,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(user_id,channel,item_key,field) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    WHERE excluded.updated_at>entry_preferences.updated_at OR
      (excluded.updated_at=entry_preferences.updated_at AND excluded.value>entry_preferences.value)`
  const stmts = []
  for (const change of changes.slice(0, 100)) {
    if (!change) continue
    const { type, x, y, field, value, updatedAt } = change
    const key = entryKey(channel, type, x, y)
    if (!key || !Number.isSafeInteger(updatedAt) || updatedAt <= 0) continue
    const valid = field === 'favorite' ? value === '1' || value === '' :
      field === 'label' && channel === 'aqua' && typeof value === 'string' && value.length <= 50
    if (valid) stmts.push(env.DB.prepare(sql).bind(userId, channel, key, field, value, updatedAt))
  }
  await runBatch(env, stmts)
  const { results } = await env.DB.prepare(`SELECT item_key AS key, field, value, updated_at AS updatedAt
    FROM entry_preferences WHERE user_id=? AND channel=?`).bind(userId, channel).all()
  return results
}

async function listTargets(env, channel, userId, now) {
  const { results } = await env.DB.prepare(`SELECT item_key AS key, expires_at AS expiresAt, user_id=? AS mine
    FROM target_intents WHERE channel=? AND expires_at>?`).bind(userId, channel, now).all()
  return results
}

async function handleTarget(env, channel, userId, body) {
  const key = entryKey(channel, body.type, body.x, body.y)
  if (!key || !['claim', 'release'].includes(body.action)) return { ok: false, error: '対象または操作が正しくありません' }
  const now = Date.now()
  if (body.action === 'claim') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM target_intents WHERE expires_at<=?').bind(now),
      env.DB.prepare(`INSERT INTO target_intents (channel,item_key,user_id,expires_at) VALUES (?,?,?,?)
        ON CONFLICT(channel,item_key) DO NOTHING`).bind(channel, key, userId, now + TARGET_DURATION_MS)
    ])
  } else {
    await env.DB.prepare('DELETE FROM target_intents WHERE channel=? AND item_key=? AND user_id=? AND expires_at=?')
      .bind(channel, key, userId, Number(body.expiresAt) || 0).run()
  }
  return { ok: true, targets: await listTargets(env, channel, userId, now) }
}

function formatFortCooldownRows(rows) {
  return rows.flatMap((row) => {
    const timing = resolveFortTiming(row)
    if (timing.sharedAt == null && row.readyAt == null) return []
    const sharedUpdatedAt = timing.useObservation ? row.observedUpdatedAt : timing.sharedStartedAt ?? row.legacyUpdatedAt
    return [{ ...row, ...timing, sharedUpdatedAt }]
  })
}

const FORT_COOLDOWN_SELECT = `
    SELECT i.item_key AS key, s.event_at AS legacyAt, s.updated_at AS legacyUpdatedAt,
      m.event_at AS observedAt, m.updated_at AS observedUpdatedAt,
      CASE WHEN own.event_at=own.updated_at THEN own.event_at END AS readyAt, own.updated_at AS memberUpdatedAt,
      other.event_at AS otherConfirmedAt, oc.first_at AS otherFirstAt, oc.member_cap AS otherMemberCap,
      CASE WHEN h.id IS NOT NULL THEN p.event_at END AS personalAt,
      CASE WHEN h.id IS NOT NULL THEN p.updated_at END AS personalUpdatedAt, h.id AS historyId,
      CASE WHEN h.id IS NOT NULL THEN pc.first_at END AS personalFirstAt,
      CASE WHEN h.id IS NOT NULL THEN pc.member_cap END AS personalMemberCap
    FROM items i
    LEFT JOIN fort_cooldowns s ON s.user_id='' AND s.item_key=i.item_key
    LEFT JOIN fort_member_observations m ON m.user_id='' AND m.item_key=i.item_key
    LEFT JOIN fort_member_observations own ON own.user_id=i.user_id AND own.item_key=i.item_key
    LEFT JOIN fort_cooldowns p ON p.user_id=i.user_id AND p.item_key=i.item_key
    LEFT JOIN history h ON h.user_id=i.user_id AND h.id=p.history_id AND h.deleted=0
      AND h.type=i.type AND h.x=i.x AND h.y=i.y AND h.result='ruby' AND h.ruby>0
    LEFT JOIN fort_winner_cycles pc ON pc.user_id=p.user_id AND pc.item_key=p.item_key AND pc.history_id=p.history_id
    LEFT JOIN fort_cooldowns other ON other.item_key=i.item_key AND other.user_id=(
      SELECT w.user_id FROM fort_cooldowns w
      JOIN history wh ON wh.user_id=w.user_id AND wh.id=w.history_id AND wh.deleted=0
        AND wh.type=i.type AND wh.x=i.x AND wh.y=i.y AND wh.result='ruby' AND wh.ruby>0
      LEFT JOIN fort_winner_cycles wc ON wc.user_id=w.user_id AND wc.item_key=w.item_key AND wc.history_id=w.history_id
      WHERE w.item_key=i.item_key AND w.user_id<>i.user_id
      ORDER BY w.event_at DESC, wc.member_cap IS NULL, wc.member_cap, w.user_id LIMIT 1)
    LEFT JOIN fort_winner_cycles oc ON oc.user_id=other.user_id AND oc.item_key=other.item_key AND oc.history_id=other.history_id`

async function syncFortCooldowns(env, userId, updates, options = {}) {
  const isPartial = options.scope === 'submitted'
  const metrics = options.metrics
  const winnerUpsert = `INSERT INTO fort_cooldowns (user_id, item_key, event_at, updated_at, history_id)
    SELECT h.user_id, ?, ?, ?, h.id FROM history h
    WHERE h.user_id=? AND h.id=? AND h.deleted=0 AND h.result='ruby' AND h.ruby>0
      AND h.type=? AND h.x=? AND h.y=? AND h.at_ms<=?
      AND (h.at_ms>=? OR EXISTS (
        SELECT 1 FROM fort_cooldowns known WHERE known.user_id=h.user_id AND known.item_key=? AND known.history_id=h.id))
    ON CONFLICT(user_id, item_key) DO UPDATE SET
      event_at=excluded.event_at, updated_at=excluded.updated_at, history_id=excluded.history_id
    WHERE (excluded.history_id=fort_cooldowns.history_id AND excluded.updated_at<fort_cooldowns.event_at AND
      (excluded.updated_at>fort_cooldowns.updated_at OR
        (excluded.updated_at=fort_cooldowns.updated_at AND excluded.event_at>fort_cooldowns.event_at)))
      OR (excluded.history_id<>fort_cooldowns.history_id AND ((
        excluded.event_at>fort_cooldowns.event_at AND excluded.updated_at>fort_cooldowns.updated_at) OR NOT EXISTS (
        SELECT 1 FROM history existing
        WHERE existing.user_id=fort_cooldowns.user_id AND existing.id=fort_cooldowns.history_id AND existing.deleted=0)))`
  const memberUpsert = `INSERT INTO fort_member_observations (user_id, item_key, event_at, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id, item_key) DO UPDATE SET event_at=excluded.event_at, updated_at=excluded.updated_at
    WHERE (excluded.user_id='' AND excluded.event_at>fort_member_observations.event_at)
      OR (excluded.user_id<>'' AND (excluded.updated_at>fort_member_observations.updated_at OR
        (excluded.updated_at=fort_member_observations.updated_at AND excluded.event_at>fort_member_observations.event_at)))`
  const stmts = []
  const submittedKeys = new Set()
  const rejectedResults = []
  const trackedEntries = []

  for (const item of updates.slice(0, MAX_ITEMS)) {
    const rec = normalizeItem(item, FORT_TYPES)
    const fallbackKey = rawFortKey(item)
    if (!rec || rec.deleted || !Number.isSafeInteger(rec.updatedAt) || rec.updatedAt <= 0 ||
        !Number.isSafeInteger(rec.eventAt) || rec.eventAt < rec.updatedAt ||
        rec.eventAt - rec.updatedAt > FORT_SHARED_COOLDOWN_MS) {
      if (isPartial) {
        rejectedResults.push({ key: rec?.key || fallbackKey, status: 'rejected', reason: 'invalid_cooldown' })
        if (metrics) metrics.counts.rejected += 1
      }
      continue
    }
    const remaining = rec.eventAt - rec.updatedAt
    const historyId = typeof item.historyId === 'string' ? item.historyId.slice(0, 64) : ''
    if (historyId && item.kind !== 'member') {
      const earliestRecord = rec.updatedAt - FORT_SHARED_COOLDOWN_MS - FORT_CYCLE_TOLERANCE_MS
      const idx = stmts.length
      stmts.push(env.DB.prepare(winnerUpsert).bind(rec.key, rec.eventAt, rec.updatedAt, userId,
        historyId, rec.type, rec.x, rec.y, rec.updatedAt, earliestRecord, rec.key))
      submittedKeys.add(rec.key)
      trackedEntries.push({ key: rec.key, kind: 'winner', stmtIndices: [idx] })
    } else if (item.kind === 'member' && remaining <= FORT_MEMBER_COOLDOWN_MS) {
      const idx1 = stmts.length
      stmts.push(env.DB.prepare(memberUpsert).bind(userId, rec.key, rec.eventAt, rec.updatedAt))
      const indices = [idx1]
      // 0では24時間以上のどの時点か判別できない。
      if (remaining > 0) {
        indices.push(stmts.length)
        stmts.push(env.DB.prepare(memberUpsert).bind('', rec.key, rec.eventAt + FORT_COOLDOWN_OFFSET_MS, rec.updatedAt))
      }
      submittedKeys.add(rec.key)
      trackedEntries.push({ key: rec.key, kind: 'member', stmtIndices: indices })
    } else if (isPartial) {
      rejectedResults.push({ key: rec.key, status: 'rejected', reason: 'invalid_cooldown_kind_or_range' })
      if (metrics) metrics.counts.rejected += 1
    }
  }

  const batchResults = stmts.length ? await runBatch(env, stmts, metrics) : []
  if (!isPartial) return readFortCooldowns(env, userId, undefined, metrics)

  const targetKeys = Array.from(submittedKeys)
  if (metrics) metrics.targetCooldowns = targetKeys.length
  const cooldowns = await readFortCooldowns(env, userId, targetKeys, metrics)
  const resolvedMap = new Map(cooldowns.map((c) => [c.key, c]))

  const keyWriteState = new Map()
  for (const entry of trackedEntries) {
    const changed = entry.stmtIndices.some((idx) => (batchResults[idx]?.meta?.changes || 0) > 0)
    const prev = keyWriteState.get(entry.key)
    keyWriteState.set(entry.key, prev || changed)
  }

  const results = [...rejectedResults]
  for (const key of targetKeys) {
    const resolved = resolvedMap.get(key)
    const wrote = keyWriteState.get(key) === true
    if (!resolved) {
      results.push({ key, status: 'unregistered', wrote, reason: wrote ? 'item_not_registered' : 'conflict_or_missing_history' })
      if (metrics) {
        if (wrote) metrics.counts.ok += 1
        else metrics.counts.conflict += 1
      }
    } else if (!wrote) {
      results.push({ key, status: 'conflict', wrote: false, reason: 'stale_or_missing_history' })
      if (metrics) metrics.counts.conflict += 1
    } else {
      results.push({ key, status: 'ok', wrote: true })
      if (metrics) metrics.counts.ok += 1
    }
  }
  return { cooldowns, results }
}

async function readFortCooldowns(env, userId, keys, metrics) {
  // 共有タイマーは、本人が登録している座標に限って返す。
  if (Array.isArray(keys)) {
    const uniqueKeys = Array.from(new Set(keys.filter((k) => typeof k === 'string' && k.length > 0)))
    if (!uniqueKeys.length) return []
    const stmts = []
    for (let i = 0; i < uniqueKeys.length; i += 90) {
      const chunk = uniqueKeys.slice(i, i + 90)
      stmts.push(
        env.DB.prepare(
          `${FORT_COOLDOWN_SELECT} WHERE i.user_id=? AND i.channel='fort' AND i.deleted=0 AND i.item_key IN (${chunk.map(() => '?').join(',')})`
        ).bind(userId, ...chunk)
      )
    }
    const rs = await runBatch(env, stmts, metrics)
    const rows = rs.flatMap((r) => r.results || [])
    return formatFortCooldownRows(rows)
  }
  const { results } = await dbAll(
    env.DB.prepare(`${FORT_COOLDOWN_SELECT} WHERE i.user_id=? AND i.channel='fort' AND i.deleted=0`).bind(userId),
    metrics
  )
  return formatFortCooldownRows(results)
}

async function saveWidgetDisplay(env, userId, display) {
  if (!Number.isSafeInteger(display.updatedAt) || display.updatedAt < 1 || !display.rules) return false
  const rules = Object.fromEntries([...FORT_TYPES, ...AQUA_TYPES].map((type) => {
    const { enabled, x, y, limit } = display.rules[type] ?? {}
    const near = [x, y, limit].every(Number.isFinite) && limit >= 0
    return [type, { enabled: enabled !== false, ...(near ? { x, y, limit } : {}) }]
  }))
  await env.DB.prepare(`INSERT INTO widget_display (user_id, rules, updated_at) VALUES (?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET rules=excluded.rules, updated_at=excluded.updated_at
    WHERE excluded.updated_at>widget_display.updated_at`).bind(userId, JSON.stringify(rules), display.updatedAt).run()
  return true
}

async function widgetSnapshot(env, userId) {
  const [{ results }, cooldowns, display] = await Promise.all([
    env.DB.prepare(`SELECT i.item_key, i.type, i.x, i.y, i.event_at, COALESCE(p.value, '') AS label
      FROM items i LEFT JOIN entry_preferences p
        ON p.user_id=? AND p.channel='aqua' AND p.item_key=i.item_key AND p.field='label'
      WHERE i.user_id=? AND i.channel='aqua' AND i.deleted=0
        AND NOT EXISTS (SELECT 1 FROM aqua_lost l WHERE l.item_key=i.item_key AND l.event_at=i.event_at)
      UNION ALL
      SELECT item_key, type, x, y, event_at, label FROM items
      WHERE user_id=? AND channel='fort' AND deleted=0`).bind(userId, SHARED_USER, userId).all(),
    readFortCooldowns(env, userId),
    env.DB.prepare('SELECT rules FROM widget_display WHERE user_id=?').bind(userId).first()
  ])
  const timers = new Map(cooldowns.map((timer) => [timer.key, timer]))
  const rules = display ? JSON.parse(display.rules) : {}
  const now = Date.now()
  const upcoming = results.flatMap((entry) => {
    const rule = rules[entry.type]
    if (rule?.enabled === false || (rule?.limit != null && Math.hypot(entry.x - rule.x, entry.y - rule.y) > rule.limit)) return []
    const timer = timers.get(entry.item_key)
    const at = timer ? fortAttackableAt(entry.event_at, timer) : entry.event_at
    return at > now ? [{ type: entry.type, x: entry.x, y: entry.y, label: entry.label, at }] : []
  }).sort((a, b) => a.at - b.at).slice(0, 15)
  return { ok: true, upcoming }
}

/* ================= ルビー獲得記録の同期（追加と削除だけ・差分のみ） ================= */
function normalizeHist(h) {
  if (!h) return null
  const id = String(h.id || '').slice(0, 64)
  if (!id) return null
  if (h.deleted === true) return { id, deleted: true }
  const x = Number(h.x)
  const y = Number(h.y)
  const at = Number(h.at)
  if (FORT_TYPES.indexOf(h.type) === -1 || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(at)) return null
  return {
    id, type: h.type,
    entryId: String(h.entryId || '').slice(0, 64),
    label: String(h.label || '').slice(0, 50),
    x, y,
    result: h.result === 'taken' ? 'taken' : 'ruby',
    ruby: Number(h.ruby) || 0,
    at, deleted: false
  }
}

async function addHistory(env, userId, req, out, now, metrics, isPartial) {
  const sinceRaw = Number(req.historySince)
  const hasCursor = req.historySince !== undefined && req.historySince !== null && Number.isFinite(sinceRaw) && sinceRaw > 0
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0
  const recs = []
  asArr(req.history).slice(0, MAX_HIST).forEach((h) => {
    const rec = normalizeHist(h)
    if (rec) recs.push(rec)
  })
  if (metrics) metrics.targetHistory = recs.length

  // 送られてきたIDの現状だけを読む（履歴の全件は読まない）。
  // IDは90件ずつの照会にして、複数をまとめて1回のバッチで実行する
  const cur = new Map()
  const ids = Array.from(new Set(recs.map((r) => r.id)))
  const lookups = []
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90)
    lookups.push(
      env.DB.prepare(
        `SELECT id, deleted FROM history WHERE user_id=? AND id IN (${chunk.map(() => '?').join(',')})`
      ).bind(userId, ...chunk)
    )
  }
  for (let i = 0; i < lookups.length; i += 40) {
    const rs = await env.DB.batch(lookups.slice(i, i + 40))
    rs.forEach((r) => {
      recordMeta(metrics, r?.meta)
      ;(r.results || []).forEach((row) => cur.set(row.id, !!row.deleted))
    })
  }

  const stmts = []
  const rejected = []
  recs.forEach((rec) => {
    const exists = cur.has(rec.id)
    if (rec.deleted) {
      if (!exists) {
        stmts.push(env.DB.prepare('INSERT OR IGNORE INTO history (user_id, id, deleted, touched_at) VALUES (?,?,1,?)').bind(userId, rec.id, now))
        cur.set(rec.id, true)
      } else if (!cur.get(rec.id)) {
        stmts.push(env.DB.prepare('UPDATE history SET deleted=1, touched_at=? WHERE user_id=? AND id=?').bind(now, userId, rec.id))
        cur.set(rec.id, true)
      }
    } else if (!exists) {
      stmts.push(env.DB.prepare(
        'INSERT OR IGNORE INTO history (user_id, id, type, entry_id, label, x, y, result, ruby, at_ms, deleted, touched_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?)'
      ).bind(userId, rec.id, rec.type, rec.entryId, rec.label, rec.x, rec.y, rec.result, rec.ruby, rec.at, now))
      cur.set(rec.id, false)
    } else if (cur.get(rec.id)) {
      rejected.push(rec.id) // すでに他の端末で削除済み → 送った側にも削除させる
    }
  })
  if (!isPartial || recs.length > 0) {
    stmts.push(env.DB.prepare('DELETE FROM history WHERE user_id=? AND deleted=1 AND touched_at<?').bind(userId, now - HIST_TOMB_KEEP_MS))
  }
  if (stmts.length) await runBatch(env, stmts, metrics)

  if (isPartial && !hasCursor) {
    out.history = []
    out.historyDeleted = rejected
    return
  }

  // 前回の同期以降に変わった行だけを返す
  const rows = await dbAll(
    env.DB.prepare(
      'SELECT id, type, entry_id, label, x, y, result, ruby, at_ms, deleted FROM history WHERE user_id=? AND touched_at>=?'
    ).bind(userId, since),
    metrics
  )
  out.history = rows.results.map((r) => ({
    id: r.id, type: r.type, entryId: r.entry_id, label: r.label, x: r.x, y: r.y,
    result: r.result, ruby: r.ruby, at: r.at_ms, deleted: !!r.deleted
  }))
  out.historyDeleted = rejected
  out.historyNow = now
}

/* ================= 通知設定（要塞＝ユーザーごと／アクア＝共通） ================= */
const WEBHOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?(?:discord|discordapp)\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/
const isWebhook = (u) => typeof u === 'string' && WEBHOOK_RE.test(u)

function sanitizeSettings(channel, s) {
  s = s || {}
  const lead = Number(s.leadMin)
  const qs = Number(s.quietStart)
  const qe = Number(s.quietEnd)
  const types = {}
  CHANNEL_TYPES[channel].forEach((t) => { types[t] = !(s.types && s.types[t] === false) })
  const roleId = String(s.roleId || '').trim()
  return {
    leadMin: Number.isFinite(lead) ? Math.min(60, Math.max(0, Math.round(lead))) : 10,
    quietOn: s.quietOn === true,
    quietStart: Number.isFinite(qs) ? Math.min(23, Math.max(0, Math.round(qs))) : 0,
    quietEnd: Number.isFinite(qe) ? Math.min(23, Math.max(0, Math.round(qe))) : 7,
    digest: s.digest !== false,
    roleId: /^\d{5,25}$/.test(roleId) ? roleId : '',
    types
  }
}

async function loadSettings(env, dataUser, channel) {
  const row = await env.DB.prepare('SELECT json FROM settings WHERE user_id=? AND channel=?').bind(dataUser, channel).first()
  let s = {}
  if (row) { try { s = JSON.parse(row.json) } catch (e) { s = {} } }
  const st = sanitizeSettings(channel, s)
  st.webhookUrl = isWebhook(s.webhookUrl) ? s.webhookUrl : ''
  return st
}

async function saveSettings(env, dataUser, channel, st) {
  await env.DB.prepare(
    'INSERT INTO settings (user_id, channel, json) VALUES (?,?,?) ON CONFLICT(user_id, channel) DO UPDATE SET json=excluded.json'
  ).bind(dataUser, channel, JSON.stringify(st)).run()
}

/* Webhook URLは外に返さない（登録済みかどうかと、末尾6文字だけ返す） */
function settingsResponse(st) {
  const pub = { ...st }
  delete pub.webhookUrl
  return { ok: true, settings: pub, webhook: { set: !!st.webhookUrl, hint: st.webhookUrl ? '…' + st.webhookUrl.slice(-6) : '' } }
}

/* body.settings：通知設定（送られたときだけ更新）／ body.webhookUrl：''で解除・URLで登録（送られたときだけ更新） */
async function handleSettings(env, dataUser, channel, body) {
  const cur = await loadSettings(env, dataUser, channel)
  let next = cur
  let changed = false
  if (body.settings && typeof body.settings === 'object') {
    next = sanitizeSettings(channel, body.settings)
    next.webhookUrl = cur.webhookUrl
    changed = true
  }
  if (typeof body.webhookUrl === 'string') {
    const u = body.webhookUrl.trim()
    if (u === '') {
      next.webhookUrl = ''
    } else if (isWebhook(u)) {
      next.webhookUrl = u
    } else {
      return { ok: false, error: 'DiscordのWebhook URLの形式が正しくありません（https://discord.com/api/webhooks/… で始まるURLを入力してください）' }
    }
    changed = true
  }
  if (changed) await saveSettings(env, dataUser, channel, next)
  return settingsResponse(next)
}

/* ================= Discord ================= */
async function postDiscord(url, text, roleId) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, allowed_mentions: { parse: [], roles: roleId ? [String(roleId)] : [] } })
    })
    if (!res.ok) {
      console.error('Discord HTTP ' + res.status + ': ' + (await res.text()))
      return { ok: false, status: res.status }
    }
    return { ok: true, status: res.status }
  } catch (e) {
    console.error('Discord通信エラー', e)
    return { ok: false, status: 0 }
  }
}

async function sendDiscord(url, text, roleId) {
  return (await postDiscord(url, text, roleId)).ok
}

/* テスト送信：body.webhookUrl があればそのURLへ（未保存のURLも試せる）、なければ登録済みのURLへ */
async function handleTest(env, dataUser, channel, userId, body) {
  const st = await loadSettings(env, dataUser, channel)
  let url = st.webhookUrl
  if (typeof body.webhookUrl === 'string' && body.webhookUrl.trim()) {
    if (!isWebhook(body.webhookUrl.trim())) {
      return { ok: false, error: 'DiscordのWebhook URLの形式が正しくありません（https://discord.com/api/webhooks/… で始まるURL）' }
    }
    url = body.webhookUrl.trim()
  }
  if (!url) return { ok: false, error: 'Webhook URLが未登録です。URLを入力してからテストしてください' }
  const label = channel === 'aqua' ? 'アクア用（共有）' : '要塞・ドラゴン用（ユーザー: ' + userId + '）'
  const ok = await sendDiscord(url, '✅ GGE Tracker の通知テストです — ' + label, '')
  return ok ? { ok: true } : { ok: false, error: 'Discordへの送信に失敗しました。Webhook URLが有効か確認してください' }
}

/* 通知しない時間帯か（開始＞終了なら日付をまたぐ。開始＝終了は「停止なし」） */
function isQuiet(st, hour) {
  if (!st.quietOn || st.quietStart === st.quietEnd) return false
  if (st.quietStart < st.quietEnd) return hour >= st.quietStart && hour < st.quietEnd
  return hour >= st.quietStart || hour < st.quietEnd
}

/* 通知の行を、Discordの文字数制限（1800字）に収まるメッセージにまとめる。
 * 各メッセージが、どの行（どの対象）を含むかも記録する */
function packMessages(dueItems, lateItems, roleId, lateHeader) {
  const msgs = []
  let cur = null
  const start = () => {
    cur = { text: roleId ? '<@&' + roleId + '>\n' : '', rows: [], lateStarted: false }
    msgs.push(cur)
  }
  const add = (text, row, isLate) => {
    if (!cur) start()
    let chunk = text + '\n'
    if (isLate && !cur.lateStarted) chunk = (cur.rows.length ? '\n' : '') + lateHeader + '\n' + chunk
    if (cur.text.length + chunk.length > 1800 && cur.rows.length) {
      start()
      chunk = (isLate ? lateHeader + '\n' : '') + text + '\n'
    }
    cur.text += chunk
    cur.rows.push(row)
    if (isLate) cur.lateStarted = true
  }
  dueItems.forEach((i) => add(i.text, i.row, false))
  lateItems.forEach((i) => add(i.text, i.row, true))
  return msgs
}

function smallAquaTargetLink(env, row) {
  const origin = String(env.ALLOWED_ORIGIN || '').split(',').map((value) => value.trim())
    .find((value) => /^https:\/\/[a-z0-9.-]+(?::\d+)?\/?$/i.test(value))
  if (!origin) return ''
  const key = encodeURIComponent('smallAqua|' + row.x + '|' + row.y)
  return ' · [対象を開く](' + origin.replace(/\/$/, '') + '/#target=' + key + ')'
}

/* ================= 5分おきの通知チェック（Cron） ================= */
async function notifyCheck(env) {
  await ensureSchema(env)
  const now = Date.now()
  const horizon = now + 60 * 60000 // 「何分前」は最大60分

  const [itemsR, setR] = await Promise.all([
    env.DB.prepare(
      `SELECT user_id, channel, item_key, type, x, y, label, event_at FROM items i
       WHERE deleted=0 AND notify=1 AND notified<>event_at AND event_at<=?
         AND (channel<>'aqua' OR NOT EXISTS (SELECT 1 FROM aqua_lost l
           WHERE l.item_key=i.item_key AND l.event_at=i.event_at))`
    ).bind(horizon).all(),
    env.DB.prepare('SELECT user_id, channel, json FROM settings').all()
  ])
  const settingsMap = new Map()
  setR.results.forEach((r) => {
    let s = {}
    try { s = JSON.parse(r.json) } catch (e) { s = {} }
    const st = sanitizeSettings(r.channel, s)
    st.webhookUrl = isWebhook(s.webhookUrl) ? s.webhookUrl : ''
    settingsMap.set(r.user_id + '|' + r.channel, st)
  })

  // ユーザー × チャンネルごとにまとめる（アクアは共通データなので全員で1グループ）
  const groups = new Map()
  itemsR.results.forEach((r) => {
    const k = r.user_id + '|' + r.channel
    if (!groups.has(k)) groups.set(k, { userId: r.user_id, channel: r.channel, rows: [] })
    groups.get(k).rows.push(r)
  })

  const hour = jstHour(now)

  for (const g of groups.values()) {
    const st = settingsMap.get(g.userId + '|' + g.channel)
    if (!st || !st.webhookUrl) continue // Webhook未登録なら通知しない
    if (isQuiet(st, hour)) continue // 通知停止中は保留（停止が明けてから判断する）
    const lead = st.leadMin * 60000
    const isAqua = g.channel === 'aqua'
    const verbSoon = isAqua ? '浮上します' : '攻撃可能になります'
    const verbNow = isAqua ? '浮上しました' : '攻撃可能になりました'
    const lateHeader = '🌙 通知停止中などに' + (isAqua ? '浮上' : '攻撃可能') + 'になっていた対象'

    g.rows.sort((a, b) => a.event_at - b.event_at)
    const dueItems = []
    const lateItems = []
    const silent = [] // 通知せずに「処理済み」にする対象

    g.rows.forEach((r) => {
      const left = r.event_at - now
      if (left > lead) return // まだ早い
      if (st.types[r.type] === false) { silent.push(r); return } // 通知オフの種類

      const info = TYPE_INFO[r.type] || { name: r.type, icon: '📍' }
      const name = notificationIcon(env, info) + ' ' + info.name + ' (' + r.x + ',' + r.y + ')' + (!isAqua && r.label ? ' ' + r.label : '')
      const when = jstHM(r.event_at)
      const late = -left // 時刻から何ms過ぎたか（未到達なら負）
      const elapsed = isAqua && late >= 60000 ? '・約' + Math.floor(late / 60000) + '分前' : ''

      if (late <= GRACE_MIN * 60000) {
        dueItems.push({
          row: r,
          text: left > 0
            ? '⏰ ' + name + ' が約' + Math.ceil(left / 60000) + '分後に' + verbSoon + '（' + when + '）'
            : '🔔 ' + name + ' が' + verbNow + '（' + when + elapsed + '）'
        })
      } else if (st.digest && late <= DIGEST_MAX_AGE_H * 3600000) {
        lateItems.push({ row: r, text: '・' + name + '（' + when + (elapsed || '〜') + '）' })
      } else {
        silent.push(r) // 遅れすぎ、またはまとめ通知がオフ
      }
    })

    // 1通ずつ送り、届いた分だけを「通知済み」にする。失敗した時点で止めて、残りは次回に回す
    const msgs = packMessages(dueItems, lateItems, st.roleId, lateHeader)
    const done = silent.slice()
    let sentCount = 0
    for (let i = 0; i < msgs.length; i++) {
      if (sentCount >= MAX_MESSAGES_PER_RUN) break // 残りは5分後の実行で送る
      if (sentCount > 0) await sleep(MESSAGE_GAP_MS)
      const res = await postDiscord(st.webhookUrl, msgs[i].text, st.roleId)
      sentCount++
      if (!res.ok) {
        console.error('Discord送信に失敗しました（HTTP ' + res.status + '）。残りは次回の実行で再試行します。')
        break
      }
      msgs[i].rows.forEach((r) => done.push(r))
    }

    if (!done.length) continue
    const stmts = done.map((r) =>
      env.DB.prepare('UPDATE items SET notified=event_at WHERE user_id=? AND channel=? AND item_key=? AND event_at=?')
        .bind(g.userId, g.channel, r.item_key, r.event_at)
    )
    await runBatch(env, stmts)
  }
  await remindSmallAqua(env, settingsMap.get(SHARED_USER + '|aqua'), now, hour)
}

async function remindSmallAqua(env, st, now, hour) {
  if (!st?.webhookUrl || st.types.smallAqua === false || isQuiet(st, hour)) return
  const due = now - SMALL_AQUA_REMINDER_MS
  const oldest = due - DIGEST_MAX_AGE_H * 3600000
  const leaseCutoff = now - 10 * 60000
  await env.DB.prepare('DELETE FROM aqua_reminders WHERE event_at<?').bind(oldest).run()
  const { results } = await env.DB.prepare(`
    SELECT i.item_key, i.x, i.y, i.event_at FROM items i
    LEFT JOIN aqua_lost l ON l.item_key=i.item_key AND l.event_at=i.event_at
    LEFT JOIN aqua_reminders r ON r.item_key=i.item_key AND r.event_at=i.event_at
    WHERE i.user_id=? AND i.channel='aqua' AND i.type='smallAqua'
      AND i.deleted=0 AND i.event_at>0 AND i.event_at BETWEEN ? AND ? AND l.item_key IS NULL
      AND (r.item_key IS NULL OR (r.sent=0 AND r.claimed_at<=?))
    ORDER BY i.event_at LIMIT 40`).bind(SHARED_USER, oldest, due, leaseCutoff).all()
  if (!results.length) return
  const claims = await env.DB.batch(results.map((r) => env.DB.prepare(`
    INSERT INTO aqua_reminders (item_key, event_at, claimed_at)
    SELECT i.item_key, i.event_at, ? FROM items i
    WHERE i.user_id=? AND i.channel='aqua' AND i.item_key=? AND i.event_at=? AND i.deleted=0
      AND NOT EXISTS (SELECT 1 FROM aqua_lost l WHERE l.item_key=i.item_key AND l.event_at=i.event_at)
    ON CONFLICT(item_key, event_at) DO UPDATE SET claimed_at=excluded.claimed_at
      WHERE aqua_reminders.sent=0 AND aqua_reminders.claimed_at<=?`
  ).bind(now, SHARED_USER, r.item_key, r.event_at, leaseCutoff)))
  const reminders = results.filter((r, i) => claims[i].meta.changes > 0).map((r) => ({
    row: r,
    text: notificationIcon(env, TYPE_INFO.smallAqua) + ' 小アクア (' + r.x + ',' + r.y + ') の浮上（' + jstHM(r.event_at) + '）から5時間が経過しました。時間を確認して更新してください。見失った場合は「ロスト」にしてください。' +
      smallAquaTargetLink(env, r)
  }))
  const messages = packMessages(reminders, [], st.roleId, '')
  for (let i = 0; i < messages.length; i++) {
    if (i) await sleep(MESSAGE_GAP_MS)
    const message = messages[i]
    const result = await postDiscord(st.webhookUrl, message.text, st.roleId)
    if (!result.ok) {
      await runBatch(env, messages.slice(i).flatMap((pending) => pending.rows.map((r) => env.DB.prepare(
        'DELETE FROM aqua_reminders WHERE item_key=? AND event_at=? AND claimed_at=? AND sent=0'
      ).bind(r.item_key, r.event_at, now))))
      break
    }
    await runBatch(env, message.rows.map((r) => env.DB.prepare(
      'UPDATE aqua_reminders SET sent=1 WHERE item_key=? AND event_at=? AND claimed_at=?'
    ).bind(r.item_key, r.event_at, now)))
  }
}
