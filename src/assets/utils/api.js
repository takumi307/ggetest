/**
 * Cloudflare Workers（D1）向けの共通APIクライアント。
 * すべてのリクエストに次のヘッダを付けます。
 *   Authorization: Bearer <合言葉>
 *   X-User-Id: <ユーザーID>
 *
 * ★Workers側のルートが違う場合は、ここの ENDPOINTS だけ直せば動きます。
 */
export const ENDPOINTS = {
  sync: (channel) => `/api/${channel}/sync`,
  snapshot: (channel) => `/api/${channel}/snapshot`,
  test: (channel) => `/api/${channel}/test`
}

const TIMEOUT_MS = 20000

export class ApiError extends Error {
  constructor(message, { status = 0, data = null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
  }
}

function joinUrl(base, path) {
  return String(base || '').replace(/\/+$/, '') + path
}

export async function apiRequest({ baseUrl, token, userId, path, method = 'POST', body }) {
  const headers = {
    Authorization: 'Bearer ' + token,
    'X-User-Id': userId
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let res
  try {
    res = await fetch(joinUrl(baseUrl, path), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal
    })
  } catch (e) {
    throw new ApiError(
      e && e.name === 'AbortError'
        ? 'サーバーの応答がありません（タイムアウト）。'
        : 'サーバーに接続できません。URL・通信状況・Workers側のCORS設定を確認してください。'
    )
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch (e) { data = null }

  if (res.status === 401 || res.status === 403) {
    throw new ApiError((data && data.error) || '合言葉またはユーザーIDが違います。', { status: res.status, data })
  }
  if (!res.ok) {
    throw new ApiError((data && data.error) || `サーバーエラー（HTTP ${res.status}）`, { status: res.status, data })
  }
  if (!data) throw new ApiError('サーバーから正しい応答がありません。URLを確認してください。', { status: res.status })
  if (data.ok === false) throw new ApiError(data.error || 'サーバーの応答が不正です', { status: res.status, data })
  return data
}

/** チャンネル（aqua / fort）ごとのクライアントを作る */
export function createApiClient({ baseUrl, token, userId, channel }) {
  const base = { baseUrl, token, userId }
  return {
    sync: (payload) => apiRequest({ ...base, path: ENDPOINTS.sync(channel), body: payload }),
    snapshot: (payload) => apiRequest({ ...base, path: ENDPOINTS.snapshot(channel), body: payload }),
    test: () => apiRequest({ ...base, path: ENDPOINTS.test(channel), body: {} })
  }
}