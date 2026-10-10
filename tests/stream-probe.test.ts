/**
 * 起播音源探测（离线用例：本地 http server，不碰外网）。
 *
 * 覆盖：
 *   1. `looksLikeNoticeBySize` 的体积判定（提示音 / 真歌 / 短歌 / 未知大小）；
 *   2. `probeStream` 在 206 + content-range、200 + content-length、
 *      分块无长度、403、首包为空、连上不响应（超时）六种响应下的结论；
 *   3. HTTP 层面的拒绝只请求一次（不带 Range 不再重试）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { looksLikeNoticeBySize, probeStream } from '../src/main/player/streamProbe'

const SAMPLE_BYTES = 96 * 1024
/** 4 分钟的歌：体积远大于 240s × 8KB/s（1.92MB）→ 判定为真歌。 */
const FOUR_MIN_SONG_BYTES = 4 * 1024 * 1024
/** 提示音占位文件通常几百 KB（十几秒），远小于上面那条下限。 */
const NOTICE_BYTES = 300 * 1024

let server: Server
let base = ''
const sockets = new Set<Socket>()
let requestCounts = new Map<string, number>()

function count(pathname: string): void {
  requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1)
}

function writeChunks(response: ServerResponse, totalBytes: number): void {
  const chunk = Buffer.alloc(16 * 1024, 0x41)
  let written = 0
  const pump = (): void => {
    while (written < totalBytes) {
      const size = Math.min(chunk.byteLength, totalBytes - written)
      written += size
      if (!response.write(chunk.subarray(0, size))) {
        response.once('drain', pump)
        return
      }
    }
    response.end()
  }
  pump()
}

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    count(url.pathname)
    const range = request.headers.range

    if (url.pathname === '/range-ok') {
      // 支持 Range：206 + content-range 带完整大小。
      response.writeHead(206, {
        'Content-Type': 'audio/mpeg',
        'Content-Range': `bytes 0-${SAMPLE_BYTES - 1}/${FOUR_MIN_SONG_BYTES}`
      })
      response.end(Buffer.alloc(SAMPLE_BYTES, 0x41))
      return
    }

    if (url.pathname === '/notice') {
      // 提示音：同样支持 Range，但总大小只有几百 KB。
      response.writeHead(206, {
        'Content-Type': 'audio/mpeg',
        'Content-Range': `bytes 0-${SAMPLE_BYTES - 1}/${NOTICE_BYTES}`
      })
      response.end(Buffer.alloc(Math.min(SAMPLE_BYTES, NOTICE_BYTES), 0x41))
      return
    }

    if (url.pathname === '/length-only') {
      // 忽略 Range，回 200 带 content-length：content-length 即完整大小。
      response.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(FOUR_MIN_SONG_BYTES)
      })
      writeChunks(response, 64 * 1024)
      return
    }

    if (url.pathname === '/chunked-unknown') {
      // 分块传输、既无 content-length 也无 content-range：体积未知但数据是真的。
      response.writeHead(200, { 'Content-Type': 'audio/mpeg' })
      writeChunks(response, 64 * 1024)
      return
    }

    if (url.pathname === '/empty') {
      response.writeHead(200, { 'Content-Type': 'audio/mpeg' })
      response.end()
      return
    }

    if (url.pathname === '/forbidden') {
      response.writeHead(403, { 'Content-Type': 'text/plain' })
      response.end('no')
      return
    }

    if (url.pathname === '/hang') {
      // 连上了但一个字节都不回：应被超时打断。
      return
    }

    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  const address = server.address() as AddressInfo
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  // /hang 的响应永远不会结束，先掐掉这些连接，close 才不会一直等。
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeAll(() => {
  requestCounts = new Map()
})

describe('looksLikeNoticeBySize', () => {
  it('体积未知时不作判断', () => {
    expect(looksLikeNoticeBySize(undefined, 240)).toBe(false)
    expect(looksLikeNoticeBySize(0, 240)).toBe(false)
    expect(looksLikeNoticeBySize(Number.NaN, 240)).toBe(false)
  })

  it('短歌不参与体积判定，避免误伤', () => {
    expect(looksLikeNoticeBySize(100 * 1024, 90)).toBe(false)
  })

  it('正常体积的真歌不算提示音', () => {
    expect(looksLikeNoticeBySize(FOUR_MIN_SONG_BYTES, 240)).toBe(false)
  })

  it('明显偏小的流判定为提示音', () => {
    expect(looksLikeNoticeBySize(NOTICE_BYTES, 240)).toBe(true)
  })
})

describe('probeStream', () => {
  it('206 + content-range：拿到完整大小', async () => {
    const result = await probeStream(`${base}/range-ok`, 3_000)
    expect(result.ok).toBe(true)
    expect(result.status).toBe(206)
    expect(result.totalBytes).toBe(FOUR_MIN_SONG_BYTES)
    expect(looksLikeNoticeBySize(result.totalBytes, 240)).toBe(false)
  })

  it('提示音体积能被提前识破', async () => {
    const result = await probeStream(`${base}/notice`, 3_000)
    expect(result.ok).toBe(true)
    expect(result.totalBytes).toBe(NOTICE_BYTES)
    expect(looksLikeNoticeBySize(result.totalBytes, 240)).toBe(true)
  })

  it('源忽略 Range 时用 200 的 content-length', async () => {
    const result = await probeStream(`${base}/length-only`, 3_000)
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.totalBytes).toBe(FOUR_MIN_SONG_BYTES)
  })

  it('分块传输拿不到大小时仍然算可用', async () => {
    const result = await probeStream(`${base}/chunked-unknown`, 3_000)
    expect(result.ok).toBe(true)
    expect(result.totalBytes).toBeUndefined()
  })

  it('首包为空算失败', async () => {
    const result = await probeStream(`${base}/empty`, 3_000)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('首包为空')
  })

  it('HTTP 拒绝只请求一次，不带 Range 不再重试', async () => {
    requestCounts.delete('/forbidden')
    const result = await probeStream(`${base}/forbidden`, 3_000)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
    expect(result.error).toBe('HTTP 403')
    expect(requestCounts.get('/forbidden')).toBe(1)
  })

  it('连上不响应会被超时打断，并且不带 Range 再试一次', async () => {
    requestCounts.delete('/hang')
    const result = await probeStream(`${base}/hang`, 300)
    expect(result.ok).toBe(false)
    expect(result.status).toBeUndefined()
    expect(result.error).toBeTruthy()
    expect(requestCounts.get('/hang')).toBe(2)
  }, 10_000)
})
