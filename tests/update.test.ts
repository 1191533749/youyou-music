import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import {
  buildApplyScript,
  checkForUpdates,
  compareVersions,
  downloadAsset,
  releaseToManifest,
  withGitHubHashes,
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

  it('ASCII 发布资产名同样识别形态（GitHub 上传对非 ASCII 名会截断，故发布用 ASCII）', () => {
    const manifest = releaseToManifest({
      tag_name: 'v0.3.0',
      assets: [
        { name: 'YouyouMusic-Portable-0.3.0.exe', browser_download_url: 'https://x/p.exe' },
        { name: 'YouyouMusic-Setup-0.3.0.exe', browser_download_url: 'https://x/i.exe' }
      ]
    })
    expect(manifest.assets[0].kind).toBe('portable')
    expect(manifest.assets[1].kind).toBe('installer')
  })
})

describe('buildApplyScript', () => {
  it('便携版脚本：先等应用与外壳退出、带重试复制、成功后才重启', () => {
    const script = buildApplyScript({
      pid: 4242,
      parentPid: 4000,
      portable: true,
      currentExe: "C:\\用户\\悠悠 音乐\\YouyouMusic-Portable.exe",
      newFile: "C:\\Temp\\youyou-update\\悠悠音乐便携版9.9.9.exe"
    })
    expect(script).toContain('$pidToWait = 4242')
    expect(script).toContain('$parentToWait = 4000')
    expect(script).toContain('ExecutablePath -eq $target')
    expect(script).toContain('for ($i = 0; $i -lt 40')
    expect(script).toContain('Copy-Item -Path $newFile -Destination $target -Force -ErrorAction Stop')
    expect(script).toContain('Start-Process -FilePath $target')
    // 单引号转义：路径里的单引号要翻倍
    expect(script).toContain("'C:\\用户\\悠悠 音乐\\YouyouMusic-Portable.exe'")
    const escaped = buildApplyScript({
      pid: 1,
      parentPid: 0,
      portable: true,
      currentExe: "C:\\a'b.exe",
      newFile: "C:\\n.exe"
    })
    expect(escaped).toContain("'C:\\a''b.exe'")
  })

  it('生成的脚本必须能被 PowerShell 解析器干净接受（防 try/catch 拼接回归）', async () => {
    const script = buildApplyScript({
      pid: 4242,
      parentPid: 4000,
      portable: true,
      currentExe: "C:\\用户\\悠悠 音乐\\YouyouMusic-Portable.exe",
      newFile: "C:\\Temp\\youyou-update\\悠悠音乐便携版9.9.9.exe"
    })
    const { writeFileSync, rmSync } = await import('node:fs')
    const { execFileSync } = await import('node:child_process')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const file = join(tmpdir(), `youyou-parse-test-${Date.now()}.ps1`)
    writeFileSync(file, script, 'utf8')
    try {
      // scriptblock::Create 只解析不执行；解析失败会抛异常且退出码非 0。
      const check = `$errors = $null; [void][scriptblock]::Create((Get-Content -Raw -LiteralPath '${file}')); if ($Error.Count -gt 0) { Write-Output $Error[0]; exit 1 }; exit 0`
      execFileSync('powershell.exe', ['-NoProfile', '-Command', check], { stdio: 'pipe', windowsHide: true })
    } finally {
      rmSync(file, { force: true })
    }
  })

  it('安装版脚本：静默安装后启动原路径主程序', () => {
    const script = buildApplyScript({
      pid: 4242,
      parentPid: 0,
      portable: false,
      currentExe: 'C:\\Programs\\YouyouMusic\\YouyouMusic.exe',
      newFile: 'C:\\Temp\\youyou-update\\悠悠音乐安装版9.9.9.exe'
    })
    expect(script).toContain("Start-Process -FilePath $installer -ArgumentList '/S' -Wait")
    expect(script).toContain("Start-Process -FilePath 'C:\\Programs\\YouyouMusic\\YouyouMusic.exe'")
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

  it('下载后按 SHA-256 校验：一致通过、不一致拒绝', async () => {
    const { createHash } = await import('node:crypto')
    const payload = Buffer.from('校验用内容')
    const good = createHash('sha256').update(payload).digest('hex')
    const bad = '0'.repeat(64)
    server = createServer((_request, response) => response.end(payload))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('测试服务器未就绪')
    const url = `http://127.0.0.1:${address.port}/a.exe`

    const ok = await downloadAsset({ name: `好-${Date.now()}.exe`, url, kind: 'portable', sha256: good })
    expect(ok).toContain('.exe')
    await expect(
      downloadAsset({ name: `坏-${Date.now()}.exe`, url, kind: 'portable', sha256: bad })
    ).rejects.toThrow(/校验失败/)
  })

  it('从 GitHub Release 的 sha256sums.txt 解析并挂到对应资产', async () => {
    const hashA = 'a'.repeat(64)
    const hashB = 'b'.repeat(64)
    const sumsText = `${hashA}  悠悠音乐便携版9.9.9.exe\n${hashB}  悠悠音乐安装版9.9.9.exe\n`
    server = createServer((request, response) => {
      if (request.url === '/sums.txt') {
        response.end(sumsText)
        return
      }
      response.statusCode = 404
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('测试服务器未就绪')
    const base = `http://127.0.0.1:${address.port}`

    const manifest = await withGitHubHashes({
      tag_name: 'v9.9.9',
      assets: [
        { name: '悠悠音乐便携版9.9.9.exe', browser_download_url: `${base}/p.exe` },
        { name: '悠悠音乐安装版9.9.9.exe', browser_download_url: `${base}/i.exe` },
        { name: 'sha256sums.txt', browser_download_url: `${base}/sums.txt` }
      ]
    })
    expect(manifest.assets[0].sha256).toBe(hashA)
    expect(manifest.assets[1].sha256).toBe(hashB)
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
