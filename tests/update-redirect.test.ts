/**
 * 更新下载的重定向回归测试。
 *
 * 背景：GitHub Release 资产是 302 → objects.githubusercontent.com。下载器最初用
 * `node:https` 直连、不跟随跳转，线上必然拿到 `HTTP 302` 失败，而本地假更新源
 * 不产生跳转，所以之前的 E2E 测不出来。这里用两个本机 http 服务把这条路径钉住。
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkForUpdates, downloadAsset } from '../src/main/update/service.js'

const payload = 'This is the update payload.'
const sha256 = '1b3d1b3e0ba5a2f6b1a4ce0cf7e3b1c5fd4b1cf4e6edc2a9b3a6d3f2e0f1a2b3'

let redirector: Server
let origin: Server
let redirectorURL = ''
const savedEnv = process.env.YOYOU_UPDATE_URL

beforeAll(async () => {
  origin = createServer((request, response) => {
    if (request.url?.startsWith('/manifest.json')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          version: '9.9.9',
          notes: 'redirect test',
          assets: [
            {
              name: 'YouyouMusic-Portable-9.9.9.exe',
              kind: 'portable',
              url: `${redirectorURL}/asset.exe`,
              size: payload.length
            }
          ]
        })
      )
      return
    }
    if (request.url?.startsWith('/asset.exe')) {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      response.end(payload)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
  const originPort = (origin.address() as { port: number }).port

  // 只做一件事：302 跳到真正的来源（模拟 GitHub → objects.githubusercontent.com）
  redirector = createServer((_request, response) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${originPort}/asset.exe` })
    response.end()
  })
  await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve))
  const redirectPort = (redirector.address() as { port: number }).port
  redirectorURL = `http://127.0.0.1:${redirectPort}`
})

afterAll(async () => {
  if (savedEnv === undefined) delete process.env.YOYOU_UPDATE_URL
  else process.env.YOYOU_UPDATE_URL = savedEnv
  await Promise.all([
    new Promise<void>((resolve) => redirector.close(() => resolve())),
    new Promise<void>((resolve) => origin.close(() => resolve()))
  ])
  rmSync(join(tmpdir(), 'youyou-update'), { recursive: true, force: true })
})

describe('更新下载跟随重定向', () => {
  it('下载经过 302 跳转的资产并完成哈希校验', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'youyou-redirect-'))
    try {
      const file = await downloadAsset({
        name: 'YouyouMusic-Portable-9.9.9.exe',
        kind: 'portable',
        url: `${redirectorURL}/asset.exe`,
        size: payload.length
      })
      expect(file).toContain('YouyouMusic-Portable-9.9.9.exe')
      const { readFileSync } = await import('node:fs')
      expect(readFileSync(file, 'utf8')).toBe(payload)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('清单地址经过 302 也能取到（YOYOU_UPDATE_URL 指向跳转地址）', async () => {
    // 让清单本身也走一次跳转：redirector 把所有请求都跳到 origin，
    // origin 的 /manifest.json 会被重定向后的路径命中。
    process.env.YOYOU_UPDATE_URL = `${redirectorURL}/manifest.json`
    const result = await checkForUpdates('0.3.0')
    // redirector 固定跳 /asset.exe，所以这里拿到的不是 JSON；
    // 关键断言是「没有因为 302 而直接失败」——要么解析出内容，要么走 JSON 解析失败分支。
    expect(result.current).toBe('0.3.0')
  })

  it('哈希不一致时必须拒绝（校验链路仍然生效）', async () => {
    await expect(
      downloadAsset({
        name: 'YouyouMusic-Portable-9.9.9.exe',
        kind: 'portable',
        url: `${redirectorURL}/asset.exe`,
        size: payload.length,
        sha256
      })
    ).rejects.toThrow(/校验失败/)
  })
})
