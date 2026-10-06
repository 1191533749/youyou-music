/**
 * Transport layer for NetEase Cloud Music: cookie jar plus weapi / eapi
 * encrypted requests.
 *
 * Ported from `Sources/Kumone/Core/API/NeteaseClient.swift` of missuo/kumone
 * (LGPL-3.0). The Swift original serialises access to the cookie jar with two
 * locks and tags every request with an authentication epoch so a reply that
 * arrives after a re-login is discarded instead of writing stale cookies back.
 * That concurrency discipline is preserved here: Node is single-threaded, so
 * the "locks" collapse into synchronous sections, but the epoch/binding check
 * is still required because awaits interleave.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { eapi as encryptEapi, eapiHeader, encodeForm, weapi as encryptWeapi } from './crypto.js'

export type NeteaseErrorKind = 'http' | 'business' | 'needLogin' | 'decoding' | 'network'

export class NeteaseAPIError extends Error {
  readonly kind: NeteaseErrorKind
  readonly code: number
  readonly status: number

  constructor(kind: NeteaseErrorKind, options: { code?: number; status?: number; message?: string } = {}) {
    super(options.message ?? NeteaseAPIError.defaultMessage(kind, options))
    this.name = 'NeteaseAPIError'
    this.kind = kind
    this.code = options.code ?? 0
    this.status = options.status ?? 0
  }

  private static defaultMessage(
    kind: NeteaseErrorKind,
    options: { code?: number; status?: number }
  ): string {
    switch (kind) {
      case 'http':
        return `网络错误 (${options.status ?? -1})`
      case 'business':
        return `接口错误 (${options.code ?? -1})`
      case 'needLogin':
        return '需要登录'
      case 'decoding':
        return '数据加载失败，请稍后重试'
      case 'network':
        return '网络连接失败，请检查网络'
    }
  }
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

const SESSION_BINDING_KEY = '__kumone_session_binding'
const REQUEST_TIMEOUT_MS = 15_000

/**
 * 网络抖动重试：首次之外最多再试 2 次，退避 300ms → 900ms（带 ±20% 抖动，
 * 避免多个请求同一时刻一起重试）。单个请求自身仍有 15s 超时，所以再加一条
 * 总预算：已耗时 + 退避超过 10s 就不再试，免得把界面卡上半分钟。
 */
const NETWORK_RETRY_DELAYS_MS = [300, 900]
const NETWORK_RETRY_BUDGET_MS = 10_000

/** 可重试的 HTTP 状态：限流与网关/服务端临时故障；4xx 里只有 429 属于「等会儿再来」。 */
const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504])

/** 可重试的底层错误码：DNS 抖动、连接被重置、链路暂时不可达。 */
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT'
])

export interface NeteaseClientOptions {
  /** Directory that holds `cookies.json`. Defaults to app userData. */
  cookieDirectory: string
  /** Overrides the desktop cookie (`os=pc; appver=3.1.17`). */
  cookieExtra?: Record<string, string>
  onCookieChange?: (cookies: Record<string, string>) => void
  /** 网络重试与故障的日志出口（主进程的 log）。不传时退到 console.warn。 */
  log?: (message: string) => void
}

export class NeteaseClient {
  private cookies: Record<string, string> = {}
  private sessionBinding?: string
  private authEpoch = 0
  private readonly cookieFile: string
  private readonly options: NeteaseClientOptions
  private loaded = false

  constructor(options: NeteaseClientOptions) {
    this.options = options
    this.cookieFile = path.join(options.cookieDirectory, 'cookies.json')
  }

  // MARK: - Lifecycle

  /** Reads the persisted jar. Safe to call repeatedly. */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      await fs.mkdir(this.options.cookieDirectory, { recursive: true })
      const raw = await fs.readFile(this.cookieFile, 'utf8')
      const stored = JSON.parse(raw) as Record<string, string>
      if (stored && typeof stored === 'object') {
        const copy = { ...stored }
        const savedBinding = copy[SESSION_BINDING_KEY]
        delete copy[SESSION_BINDING_KEY]
        this.cookies = copy
        this.sessionBinding = copy.MUSIC_U ? (savedBinding ?? fingerprint(copy.MUSIC_U)) : undefined
        this.options.onCookieChange?.({ ...this.cookies })
      }
    } catch {
      // No jar yet, or an unreadable one: start logged out.
    }
  }

  private async persist(): Promise<void> {
    const snapshot: Record<string, string> = { ...this.cookies }
    if (this.sessionBinding) snapshot[SESSION_BINDING_KEY] = this.sessionBinding
    try {
      await fs.writeFile(this.cookieFile, JSON.stringify(snapshot), 'utf8')
    } catch {
      // Losing the jar only costs a re-login; never fail the request over it.
    }
    this.options.onCookieChange?.({ ...this.cookies })
  }

  // MARK: - Cookies

  get isLoggedIn(): boolean {
    return this.cookies.MUSIC_U !== undefined
  }

  /** Identifies the login across token renewals; a new sign-in gets a new binding. */
  get authenticationFingerprint(): string | undefined {
    return this.sessionBinding
  }

  cookie(name: string): string | undefined {
    return this.cookies[name]
  }

  allCookies(): Record<string, string> {
    return { ...this.cookies }
  }

  authenticationCookies(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const key of ['MUSIC_U', '__csrf']) {
      if (this.cookies[key]) out[key] = this.cookies[key]
    }
    return out
  }

  /**
   * Merges cookies into the jar. `expectedEpoch` rejects a write that raced a
   * re-login; `preservingSession` keeps the current binding across a token
   * refresh, which is what `/login/token/refresh` needs.
   */
  setCookies(
    incoming: Record<string, string>,
    expectedEpoch?: number,
    preservingSession = false
  ): boolean {
    if (expectedEpoch !== undefined && expectedEpoch !== this.authEpoch) return false
    const token = incoming.MUSIC_U
    if (token !== undefined && token !== this.cookies.MUSIC_U) {
      this.authEpoch += 1
      if (!preservingSession || this.sessionBinding === undefined) {
        this.sessionBinding = fingerprint(token)
      }
    }
    for (const [key, value] of Object.entries(incoming)) {
      if (key === SESSION_BINDING_KEY) continue
      this.cookies[key] = value
    }
    void this.persist()
    return true
  }

  /** Ingests a `;;`-joined raw cookie string as returned by the QR login check. */
  ingestCookieString(raw: string): void {
    const parsed: Record<string, string> = {}
    for (const cookie of raw.split(';;')) {
      const pair = cookie.split(';')[0]
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (!name || !value) continue
      parsed[name] = value
    }
    this.setCookies(parsed)
  }

  clearAuthCookies(): void {
    this.authEpoch += 1
    this.sessionBinding = undefined
    delete this.cookies.MUSIC_U
    delete this.cookies.__csrf
    void this.persist()
  }

  // MARK: - Requests

  private cookieHeader(extra: Record<string, string>, overrides: Record<string, string> = {}): string {
    const all: Record<string, string> = { ...this.cookies }
    for (const [k, v] of Object.entries(extra)) if (all[k] === undefined) all[k] = v
    for (const [k, v] of Object.entries(overrides)) all[k] = v
    return Object.entries(all)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
  }

  private authState(): { epoch: number; binding?: string } {
    return { epoch: this.authEpoch, binding: this.sessionBinding }
  }

  private isCurrent(auth: { epoch: number; binding?: string }): boolean {
    return auth.epoch === this.authEpoch || (auth.binding !== undefined && auth.binding === this.sessionBinding)
  }

  private absorbSetCookies(
    response: Response,
    auth: { epoch: number; binding?: string },
    preservingSession: boolean
  ): boolean {
    const header = response.headers.getSetCookie?.() ?? []
    if (header.length === 0) return true
    const incoming: Record<string, string> = {}
    for (const raw of header) {
      const pair = raw.split(';')[0]
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      const name = pair.slice(0, eq).trim()
      let value = pair.slice(eq + 1).trim()
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
      if (!name || !value) continue
      incoming[name] = value
    }
    if (Object.keys(incoming).length === 0) return true
    return this.setCookies(incoming, auth.epoch, preservingSession)
  }

  /**
   * The request, returning the body verbatim. NetEase answers some endpoints
   * with an empty 200 body when the request cannot be served (the weapi lyric
   * endpoints do this for anonymous callers), and callers that have an
   * alternative transport need to tell "empty" from "an error".
   *
   * 偶发的 `fetch failed`（DNS/TLS 抖动、代理切换）不该直接甩给用户，所以这里
   * 做一层自动重试：可恢复错误（连接类异常、429/5xx、空响应体）最多试 3 次。
   * 重试是安全的 —— 每个请求都是同一份加密表单原样重发，服务端按请求处理，
   * 接口自身的副作用（点赞/删除等）由业务层保证幂等，这里只是重放一次请求；
   * 业务错误（301 需要登录、参数错误）不在重试范围内，直接抛出。
   */
  private async performRaw(
    url: string,
    body: string,
    auth: { epoch: number; binding?: string },
    cookieHeader: string,
    absorbResponseCookies = true
  ): Promise<string> {
    // A request sent without a login carries no account's data, so a login
    // finishing while it is in flight does not make its answer stale.
    const anonymous = auth.binding === undefined
    if (!anonymous && !this.isCurrent(auth)) throw new NeteaseAPIError('network', { message: '登录状态已变化' })

    const startedAt = Date.now()
    let last: AttemptOutcome | undefined

    for (let attempt = 0; attempt <= NETWORK_RETRY_DELAYS_MS.length; attempt += 1) {
      last = await this.performOnce(url, body, auth, cookieHeader, absorbResponseCookies, anonymous)
      if (last.kind === 'ok') return last.text

      const delay = NETWORK_RETRY_DELAYS_MS[attempt]
      const affordable = delay !== undefined && Date.now() - startedAt + delay <= NETWORK_RETRY_BUDGET_MS
      if (!affordable) break

      const reason = last.kind === 'empty' ? '响应体为空' : last.reason
      this.logNetwork(
        `${url} ${reason}，${delay}ms 后重试（第 ${attempt + 1}/${NETWORK_RETRY_DELAYS_MS.length} 次）`
      )
      await sleep(jitter(delay))
    }

    if (last?.kind === 'failed') {
      // 到这里说明重试预算用完或次数耗尽了；原始底层信息已经写进日志。
      this.logNetwork(`${url} 重试结束仍失败：${last.reason}`)
      throw last.error
    }
    // 空响应体保持原有语义：把原样文本交回调用方（weapiJSON / eapi 会转成 undefined）。
    return last?.text ?? ''
  }

  /**
   * 一次尝试：网络异常与可重试状态码作为「可重试结果」返回，其余错误直接抛出。
   */
  private async performOnce(
    url: string,
    body: string,
    auth: { epoch: number; binding?: string },
    cookieHeader: string,
    absorbResponseCookies: boolean,
    anonymous: boolean
  ): Promise<AttemptOutcome> {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          Referer: 'https://music.163.com',
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookieHeader
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (error) {
      const reason = describeError(error)
      if (!isRecoverableNetworkError(error)) {
        // 不是网络抖动（例如代码问题导致的 TypeError）：没有重试的意义。
        this.logNetwork(`${url} 请求异常：${reason}`)
        throw new NeteaseAPIError('network', { message: `网络请求失败: ${reason}` })
      }
      return {
        kind: 'failed',
        reason,
        error: new NeteaseAPIError('network', {
          message: '网络请求失败：无法连接网易云，请检查网络后重试'
        })
      }
    }

    if (!anonymous && !this.isCurrent(auth)) throw new NeteaseAPIError('network', { message: '登录状态已变化' })

    const refreshSucceeded =
      new URL(url).pathname === '/weapi/login/token/refresh' &&
      response.status >= 200 &&
      response.status < 300 &&
      (await peekCode(response.clone())) === 200

    if (absorbResponseCookies) {
      if (!this.absorbSetCookies(response, auth, refreshSucceeded)) {
        // A reply from before a token renewal still belongs to this login, but
        // its older Set-Cookie must not roll back the renewed credentials.
        if (!this.isCurrent(auth)) throw new NeteaseAPIError('network', { message: '登录状态已变化' })
      }
    }

    if (!(response.status >= 200 && response.status < 300)) {
      const error = new NeteaseAPIError('http', { status: response.status })
      if (!RETRYABLE_HTTP_STATUS.has(response.status)) throw error
      // 重试前把响应体消费掉，别让这条连接悬着。
      await response.text().catch(() => undefined)
      return { kind: 'failed', error, reason: `HTTP ${response.status}` }
    }

    const text = await response.text()
    // 空响应体在网易云这里通常意味着「这次请求没被受理」（限流等），值得重发。
    if (text.trim() === '') return { kind: 'empty', text }
    return { kind: 'ok', text }
  }

  /** 重试与网络故障的日志出口；没接线时退到 console.warn，开发期也能看到。 */
  private logNetwork(message: string): void {
    if (this.options.log) this.options.log(message)
    else console.warn(`[netease] ${message}`)
  }

  /** POST to `https://music.163.com/weapi<path>` with weapi encryption. */
  async weapi(
    path: string,
    payload: Record<string, unknown> = {},
    options: { cookieOverrides?: Record<string, string>; absorbResponseCookies?: boolean } = {}
  ): Promise<any> {
    const json = await this.weapiJSON(path, payload, options)
    if (json === undefined) {
      throw new NeteaseAPIError('decoding', { message: `${path} 返回了空响应` })
    }
    return json
  }

  /**
   * weapi request that resolves `undefined` for an empty 200 body instead of
   * throwing, so callers with a fallback transport can try it.
   */
  async weapiJSON(
    path: string,
    payload: Record<string, unknown> = {},
    options: { cookieOverrides?: Record<string, string>; absorbResponseCookies?: boolean } = {}
  ): Promise<any> {
    const auth = this.authState()
    const csrf = options.cookieOverrides?.__csrf ?? this.cookies.__csrf
    const body = { ...payload, csrf_token: csrf ?? '' }
    const form = encryptWeapi(JSON.stringify(body))

    let fullPath = path
    if (csrf) fullPath += `${fullPath.includes('?') ? '&' : '?'}csrf_token=${csrf}`

    const cookieHeader = this.cookieHeader({ os: 'pc', appver: '3.1.17' }, options.cookieOverrides ?? {})
    const text = await this.performRaw(
      `https://music.163.com/weapi${fullPath}`,
      encodeForm(form),
      auth,
      cookieHeader,
      options.absorbResponseCookies ?? true
    )
    if (text.trim() === '') return undefined
    return parseJSON(text, path)
  }

  /** POST to `https://interface.music.163.com/eapi<path>` with eapi encryption. */
  async eapi(
    path: string,
    payload: Record<string, unknown> = {},
    options: { cookieOverrides?: Record<string, string> } = {}
  ): Promise<any> {
    const auth = this.authState()
    const apiPath = `/api${path}`
    const header = eapiHeader()
    if (this.cookies.MUSIC_U) header.MUSIC_U = this.cookies.MUSIC_U
    if (this.cookies.__csrf) header.__csrf = this.cookies.__csrf
    const body = { ...payload, header }
    const form = encryptEapi(apiPath, JSON.stringify(body))

    const cookieHeader = this.cookieHeader({ os: 'pc', appver: '3.1.17' }, options.cookieOverrides ?? {})
    const text = await this.performRaw(
      `https://interface.music.163.com/eapi${path}`,
      encodeForm(form),
      auth,
      cookieHeader,
      true
    )
    if (text.trim() === '') return undefined
    return parseJSON(text, path)
  }

  /**
   * Surfaces business-level errors the way the Swift `decoded(_:from:)` does:
   * a non-200 `code` in an otherwise successful reply becomes an error.
   */
  static unwrap(json: any, context: string): any {
    if (json && typeof json === 'object' && typeof json.code === 'number' && json.code !== 200) {
      if (json.code === 301) throw new NeteaseAPIError('needLogin')
      const message =
        typeof json.message === 'string' ? json.message : typeof json.msg === 'string' ? json.msg : undefined
      throw new NeteaseAPIError('business', { code: json.code, message: message ?? `${context} 失败 (${json.code})` })
    }
    return json
  }
}

async function peekCode(response: Response): Promise<number | undefined> {
  try {
    const json = JSON.parse(await response.text())
    return typeof json?.code === 'number' ? json.code : undefined
  } catch {
    return undefined
  }
}

function parseJSON(text: string, context: string): any {
  try {
    return JSON.parse(text)
  } catch {
    throw new NeteaseAPIError('decoding', { message: `${context} 响应不是合法 JSON` })
  }
}

function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** 一次尝试的结果：成功 / 空响应体（可重试）/ 可重试失败（带最终要抛的错误）。 */
type AttemptOutcome =
  | { kind: 'ok'; text: string }
  | { kind: 'empty'; text: string }
  | { kind: 'failed'; error: NeteaseAPIError; reason: string }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** ±20% 抖动：多个请求同时失败时错开重试时刻，别一起再撞上去。 */
function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4))
}

/**
 * 判断一次 fetch 异常是不是「网络抖动」。
 *
 * undici 会把真实原因塞进 `TypeError: fetch failed` 的 `cause` 里（可能不止一层），
 * 所以这里沿着 cause 链找错误码；超时（AbortSignal.timeout 触发的 AbortError /
 * TimeoutError）同样按可恢复处理。
 */
function isRecoverableNetworkError(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const node = current as { name?: string; code?: unknown; message?: unknown; cause?: unknown }
    if (typeof node.code === 'string' && RETRYABLE_ERROR_CODES.has(node.code)) return true
    const name = String(node.name ?? '')
    if (name === 'AbortError' || name === 'TimeoutError' || name === 'ConnectTimeoutError') return true
    const message = String(node.message ?? '')
    if (/fetch failed|socket hang up|other side closed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_/i.test(message)) {
      return true
    }
    current = node.cause
  }
  return false
}

/** 展开错误链，把 `fetch failed` 背后真正的 ECONNRESET 之类带进日志。 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as { cause?: unknown }).cause
  if (!cause) return `${error.name}: ${error.message}`
  const causeText = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
  return `${error.name}: ${error.message} → ${causeText}`
}
