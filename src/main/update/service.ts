/**
 * 内置更新：启动检测 → 30 秒倒计时自动更新（可稍后） → 下载 → 替换 → 自动重开。
 *
 * 两类安装形态走两条路：
 *  - 便携版：下载新的便携版 exe，用脱离的 PowerShell 等本进程退出后覆盖当前 exe 再启动；
 *  - 安装版：下载新的安装包，用脱离的 PowerShell 等本进程退出后静默安装再启动。
 *
 * 更新源默认是 GitHub Releases（https://api.github.com/repos/<owner>/<repo>/releases/latest），
 * 资产命名约定：文件名含「便携版」→ portable，「安装版」→ installer。
 * 测试/内网场景可用环境变量 KUMONE_UPDATE_URL 指向一个 JSON 清单。
 */
import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { get } from 'node:https'
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'

export interface UpdateAsset {
  name: string
  url: string
  kind: 'installer' | 'portable'
  size?: number
}

export interface UpdateManifest {
  version: string
  notes?: string
  assets: UpdateAsset[]
}

export interface UpdateCheckResult {
  /** 当前版本与最新版本是否一致/更新来源是否不可达时为空。 */
  latest?: UpdateManifest
  current: string
  /** 只返回比当前版本新的条目；没有可用更新则为空数组。 */
  assets: UpdateAsset[]
  updateType: 'installer' | 'portable' | null
}

const GITHUB_OWNER = '1191533749'
const GITHUB_REPO = 'youyou-music'

export function updateFeedURL(): string {
  const override = process.env.KUMONE_UPDATE_URL
  if (override) return override
  return `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
}

/** 'x.y.z' 三段数字比较；a > b 返回 1，相等 0，a < b 返回 -1。无法解析时按 0 处理。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1
  }
  return 0
}

function parseVersion(version: string): [number, number, number] {
  const parts = version.split('.').map((part) => {
    const match = /^\d+/.exec(part.trim())
    return match ? Number(match[0]) : 0
  })
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

function fetchText(url: string, timeoutMS: number): Promise<string> {
  const lib = url.startsWith('https://') ? require('node:https') : require('node:http')
  return new Promise((resolve, reject) => {
    const request = lib.get(url, { headers: { 'User-Agent': 'YouyouMusic-Updater' } }, (response: {
      statusCode?: number
      setEncoding: (encoding: string) => void
      on: (event: string, cb: (chunk?: unknown) => void) => void
      resume: () => void
    }) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`更新源返回 ${response.statusCode}`))
        return
      }
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk as string
        if (body.length > 2 * 1024 * 1024) {
          request.destroy()
          reject(new Error('更新清单过大'))
        }
      })
      response.on('end', () => resolve(body))
    })
    request.on('error', reject)
    request.setTimeout(timeoutMS, () => {
      request.destroy()
      reject(new Error('更新源超时'))
    })
  })
}

async function httpsJSON<T>(url: string, timeoutMS: number): Promise<T> {
  const body = await fetchText(url, timeoutMS)
  try {
    return JSON.parse(body) as T
  } catch (cause) {
    throw new Error(`更新清单解析失败: ${String(cause)}`)
  }
}

interface GitHubRelease {
  tag_name?: string
  name?: string
  body?: string
  assets?: Array<{ name: string; browser_download_url: string; size?: number }>
}

/** 把 GitHub 最新 Release 转成统一清单；不匹配命名约定就跳过。 */
export function releaseToManifest(release: GitHubRelease): UpdateManifest {
  const version = (release.tag_name ?? release.name ?? '').replace(/^v/i, '')
  const assets: UpdateAsset[] = (release.assets ?? [])
    .filter((asset) => /\.exe$/i.test(asset.name))
    .map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      kind: /便携版/.test(asset.name) ? 'portable' : 'installer'
    }))
  return { version, notes: release.body, assets }
}

/**
 * 检查更新。只读、绝不落盘：
 * 返回比当前版本新的资产；网络失败返回空结果（更新失败不能影响听歌）。
 * `currentOverride` 供测试注入（vitest 里 electron 的 app 不可用）。
 */
export async function checkForUpdates(currentOverride?: string): Promise<UpdateCheckResult> {
  const current = currentOverride ?? safeAppVersion()
  const empty: UpdateCheckResult = { current, assets: [], updateType: null }
  try {
    const raw = await httpsJSON<GitHubRelease | UpdateManifest>(updateFeedURL(), 8000)
    // 两种来源：GitHub Release 原始 JSON，或直接给我们的清单格式（KUMONE_UPDATE_URL 用）。
    const manifest =
      'assets' in raw && Array.isArray(raw.assets) && !('tag_name' in raw)
        ? (raw as unknown as UpdateManifest)
        : releaseToManifest(raw as GitHubRelease)
    if (!manifest.version || compareVersions(manifest.version, current) <= 0) return empty
    return {
      current,
      latest: manifest,
      assets: manifest.assets,
      updateType: manifest.assets.some((asset) => asset.kind === 'installer')
        ? 'installer'
        : manifest.assets.some((asset) => asset.kind === 'portable')
          ? 'portable'
          : null
    }
  } catch {
    return empty
  }
}

/** 读取应用版本；在非 Electron 环境（单测）下退回 '0.0.0'。 */
function safeAppVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
}

/** 下载一个资产到临时目录，返回本地路径；带回进度回调（0–1）。 */
export function downloadAsset(asset: UpdateAsset, onProgress?: (fraction: number) => void): Promise<string> {
  const dir = path.join(os.tmpdir(), 'youyou-update')
  mkdirSync(dir, { recursive: true })
  const target = path.join(dir, asset.name)
  if (existsSync(target)) {
    onProgress?.(1)
    return Promise.resolve(target)
  }
  const tmp = `${target}.part`
  const lib = asset.url.startsWith('https://') ? require('node:https') : require('node:http')

  return new Promise((resolve, reject) => {
    const request = lib.get(asset.url, { headers: { 'User-Agent': 'YouyouMusic-Updater' } }, (response: {
      statusCode?: number
      headers: Record<string, string | string[] | undefined>
      on: (event: string, cb: (chunk?: unknown) => void) => void
      pipe: (out: NodeJS.WritableStream) => void
      resume: () => void
    }) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`下载失败：HTTP ${response.statusCode}`))
        return
      }
      const rawLength = response.headers['content-length']
      const total = Number(Array.isArray(rawLength) ? rawLength[0] : (rawLength ?? asset.size ?? 0))
      let received = 0
      const out = createWriteStream(tmp)
      response.on('data', (chunk) => {
        received += (chunk as Buffer).length
        if (total > 0) onProgress?.(Math.min(1, received / total))
      })
      response.pipe(out)
      out.on('finish', () => out.close(() => resolve(target)))
      out.on('error', (cause) => reject(cause))
    })
    request.on('error', reject)
    request.setTimeout(15 * 60 * 1000, () => {
      request.destroy()
      reject(new Error('下载超时'))
    })
  }).then((result) => {
    // .part 重命名为最终文件名
    if (result === target) return target
    const { renameSync } = require('node:fs') as typeof import('node:fs')
    renameSync(tmp, target)
    return target
  })
}

/** 当前程序是不是便携版形态（electron-builder portable 会注入这两个环境变量）。 */
export function isPortableBuild(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR) || /Portable/i.test(process.execPath)
}

/**
 * 排定「退出 → 替换/安装 → 重开」流程并退出应用。
 * 用 PowerShell 做脱离进程：它等我们的 PID 消失后再动手，避免覆盖被占用/被自己杀掉的局面。
 */
export function applyUpdate(asset: UpdateAsset, localPath: string): void {
  const pid = String(process.pid)
  const portable = isPortableBuild()

  let script: string
  if (portable) {
    // 便携版：覆盖当前正在运行的 exe（用 PORTABLE_EXECUTABLE_FILE 更准，拿不到就用 execPath），
    // 然后重新启动它。路径统一用单引号包裹并转义，避免中文路径/空格问题。
    const currentExe = process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath
    script = [
      `$pidToWait = ${pid}`,
      `$target = '${escapePS(currentExe)}'`,
      `$newFile = '${escapePS(localPath)}'`,
      'while (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500 }',
      'Copy-Item -Path $newFile -Destination $target -Force',
      'Start-Process -FilePath $target'
    ].join('; ')
  } else {
    // 安装版：静默运行新安装包（覆盖安装到原目录），完成后启动安装后的主程序。
    const installedExe = process.execPath
    script = [
      `$pidToWait = ${pid}`,
      `$installer = '${escapePS(localPath)}'`,
      'while (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500 }',
      "Start-Process -FilePath $installer -ArgumentList '/S' -Wait",
      `Start-Process -FilePath '${escapePS(installedExe)}'`
    ].join('; ')
  }

  spawn(
    'powershell.exe',
    ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { detached: true, stdio: 'ignore', windowsHide: true }
  ).unref()

  // 给脱离进程一点启动时间，再退出本进程，让锁定的文件被释放。
  setTimeout(() => app.quit(), 1500)
}

/** 把路径转义成 PowerShell 单引号字面量。 */
function escapePS(value: string): string {
  return value.replace(/'/g, "''")
}

/** 清理上次更新留下的下载缓存（.part 与已完成文件）。 */
export async function cleanUpdateCache(): Promise<void> {
  await rm(path.join(os.tmpdir(), 'youyou-update'), { recursive: true, force: true }).catch(() => undefined)
}
