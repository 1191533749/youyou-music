/**
 * 网易云传输层的自动重试验证（离线用例：把全局 fetch 换成假实现，不碰网络）。
 *
 * 覆盖三件事：
 *   1. 可恢复错误重试后成功；
 *   2. 重试耗尽后抛出的是中文可读提示，原始底层信息写进日志；
 *   3. 不该重试的（4xx）只打一次请求，5xx / 空响应体会重试。
 */
import * as os from 'node:os'
import * as path from 'node:path'
import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NeteaseAPIError, NeteaseClient } from '../src/main/netease/client'
import { checkForUpdates, type UpdateManifest } from '../src/main/update/service.js'

const originalFetch = globalThis.fetch
const COOKIE_DIR = path.join(os.tmpdir(), 'youyou-retry-test')

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

/** undici 的真实形状：TypeError('fetch failed') 包着带错误码的 cause。 */
function networkError(code = 'ECONNRESET'): TypeError {
  const cause = Object.assign(new Error(`connect ${code} music.163.com:443`), { code })
  return new TypeError('fetch failed', { cause })
}

/** 装上假 fetch：按脚本依次返回/抛出，并记录调用次数。 */
function stubFetch(script: Array<Response | Error>): { calls: number } {
  const state = { calls: 0 }
  globalThis.fetch = (async () => {
    const step = script[state.calls] ?? script[script.length - 1]
    state.calls += 1
    if (step instanceof Error) throw step
    return step
  }) as typeof fetch
  return state
}

function makeClient(logs: string[]): NeteaseClient {
  return new NeteaseClient({
    cookieDirectory: COOKIE_DIR,
    log: (message) => logs.push(message)
  })
}

beforeEach(() => {
  globalThis.fetch = originalFetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('NeteaseClient 网络重试', () => {
  it('fetch failed 两次后成功：自动重试并返回解析结果', { timeout: 10_000 }, async () => {
    const logs: string[] = []
    const calls = stubFetch([networkError(), networkError('ETIMEDOUT'), jsonResponse({ code: 200, ok: true })])

    const result = await makeClient(logs).weapi('/test/retry')

    expect(result).toEqual({ code: 200, ok: true })
    expect(calls.calls).toBe(3)
    // 两次重试都要有日志，且带上真实错误码
    expect(logs.filter((line) => line.includes('后重试')).length).toBe(2)
    expect(logs.some((line) => line.includes('ECONNRESET'))).toBe(true)
  })

  it('HTTP 429/5xx 会重试：503 两次后 200 正常返回', { timeout: 10_000 }, async () => {
    const calls = stubFetch([jsonResponse({}, 503), jsonResponse({}, 502), jsonResponse({ code: 200 })])

    const result = await makeClient([]).weapi('/test/retry-status')

    expect(result).toEqual({ code: 200 })
    expect(calls.calls).toBe(3)
  })

  it('空响应体会重试：第二次拿到内容就正常返回', { timeout: 10_000 }, async () => {
    const calls = stubFetch([new Response('', { status: 200 }), jsonResponse({ code: 200, filled: true })])

    const result = await makeClient([]).weapi('/test/retry-empty')

    expect(result).toEqual({ code: 200, filled: true })
    expect(calls.calls).toBe(2)
  })

  it('重试耗尽后抛出友好中文错误，原始信息写进日志', { timeout: 10_000 }, async () => {
    const logs: string[] = []
    const calls = stubFetch([networkError('ENOTFOUND'), networkError('ENOTFOUND'), networkError('ENOTFOUND')])

    const failure = await makeClient(logs).weapi('/test/retry-exhausted').catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(NeteaseAPIError)
    expect((failure as NeteaseAPIError).kind).toBe('network')
    expect((failure as Error).message).toBe('网络请求失败：无法连接网易云，请检查网络后重试')
    expect(calls.calls).toBe(3)
    expect(logs.some((line) => line.includes('ENOTFOUND'))).toBe(true)
    expect(logs.some((line) => line.includes('重试结束仍失败'))).toBe(true)
  })

  it('4xx 属于确定性错误：不重试，只打一次请求', { timeout: 10_000 }, async () => {
    const calls = stubFetch([jsonResponse({}, 400), jsonResponse({ code: 200 })])

    const failure = await makeClient([]).weapi('/test/no-retry').catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(NeteaseAPIError)
    expect((failure as NeteaseAPIError).kind).toBe('http')
    expect((failure as NeteaseAPIError).status).toBe(400)
    expect(calls.calls).toBe(1)
  })
})

describe('更新检查的 GitHub 请求重试', () => {
  /** 本机 http 服务器充当更新源：验证 5xx 会重试、4xx 立即失败。 */
  async function withManifestServer(
    handler: (requests: number, response: import('node:http').ServerResponse) => void,
    run: (baseURL: string, requests: () => number) => Promise<void>
  ): Promise<void> {
    let requests = 0
    const server = createServer((_request, response) => handler(++requests, response))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('测试服务器未就绪')
    const baseURL = `http://127.0.0.1:${address.port}`
    process.env.YOYOU_UPDATE_URL = `${baseURL}/manifest.json`
    try {
      await run(baseURL, () => requests)
    } finally {
      delete process.env.YOYOU_UPDATE_URL
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  it('更新源 503 两次后返回清单：重试生效', { timeout: 15_000 }, async () => {
    const manifest: UpdateManifest = { version: '9.9.9', notes: '重试测试', assets: [] }

    await withManifestServer(
      (requests, response) => {
        if (requests < 3) {
          response.statusCode = 503
          response.end('busy')
          return
        }
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(manifest))
      },
      async (_baseURL, requests) => {
        const result = await checkForUpdates('0.3.0')
        expect(result.latest?.version).toBe('9.9.9')
        expect(requests()).toBe(3)
      }
    )
  })

  it('更新源 404 不重试：立即失败并返回「检查失败」结果', { timeout: 15_000 }, async () => {
    await withManifestServer(
      (_requests, response) => {
        response.statusCode = 404
        response.end('not found')
      },
      async (_baseURL, requests) => {
        const result = await checkForUpdates('0.3.0')
        expect(result.assets).toHaveLength(0)
        expect(result.latest).toBeUndefined()
        expect(requests()).toBe(1)
      }
    )
  })
})
