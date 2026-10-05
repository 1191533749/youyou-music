import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import {
  checkForUpdates,
  compareVersions,
  downloadAsset,
  releaseToManifest,
  type UpdateManifest
} from '../src/main/update/service.js'

describe('compareVersions', () => {
  it('比较三段式版本号', () => {
    expect(compareVersions('0.3.0', '0.2.9')).toBe(1)
    expect(compareVersions('0.2.9', '0.3.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0', '0.9.99')).toBe(1)
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
  })

  it('容忍 v 前缀与后缀', () => {
    expect(compareVersions('v0.3.0', '0.2.0')).toBe(1)
    expect(compareVersions('0.3.0-beta', '0.3.0')).toBe(0)
  })
})

describe('releaseToManifest', () => {
  it('把 GitHub Release 转成清单并按命名识别形态', () => {
    const manifest = releaseToManifest({
      tag_name: 'v0.3.0',
      body: '说明',
      assets: [
        { name: '悠悠音乐便携版0.3.0.exe', browser_download_url: 'https://x/portable.exe', size: 1 },
        { name: '悠悠音乐安装版0.3.0.exe', browser_download_url: 'https://x/installer.exe', size: 2 },
        { name: 'latest.yml', browser_download_url: 'https://x/latest.yml', size: 3 }
      ]
    })
    expect(manifest.version).toBe('0.3.0')
    expect(manifest.assets).toHaveLength(2)
    expect(manifest.assets[0].kind).toBe('portable')
    expect(manifest.assets[1].kind).toBe('installer')
  })
})

describe('update service 对本地清单源', () => {
  let server: Server
  let baseURL = ''

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('检测到更高版本并给出形态；下载资产成功', async () => {
    const payload = Buffer.from('悠悠音乐便携版0.9.0 假内容')
    server = createServer((request, response) => {
      if (request.url === '/manifest.json') {
        const manifest: UpdateManifest = {
          version: '9.9.9',
          notes: '测试更新',
          assets: [
            { name: '悠悠音乐便携版9.9.9.exe', url: `${baseURL}/portable.exe`, kind: 'portable' },
            { name: '悠悠音乐安装版9.9.9.exe', url: `${baseURL}/installer.exe`, kind: 'installer' }
          ]
        }
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(manifest))
        return
      }
      if (request.url === '/portable.exe' || request.url === '/installer.exe') {
        response.end(payload)
        return
      }
      response.statusCode = 404
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('测试服务器未就绪')
    baseURL = `http://127.0.0.1:${address.port}`

    process.env.KUMONE_UPDATE_URL = `${baseURL}/manifest.json`
    const result = await checkForUpdates('0.3.0')
    expect(result.current).toBe('0.3.0')
    expect(result.latest?.version).toBe('9.9.9')
    expect(result.updateType).toBe('installer')

    const local = await downloadAsset(result.assets[0])
    expect(local).toContain('悠悠音乐便携版9.9.9.exe')
    delete process.env.KUMONE_UPDATE_URL
  })

  it('版本不高于当前时不报更新', async () => {
    server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ version: '0.0.1', assets: [] } as UpdateManifest))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('测试服务器未就绪')
    process.env.KUMONE_UPDATE_URL = `http://127.0.0.1:${address.port}/m.json`
    const result = await checkForUpdates('0.0.1')
    expect(result.assets).toHaveLength(0)
    delete process.env.KUMONE_UPDATE_URL
  })
})
