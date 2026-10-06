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
import { createWriteStream, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'

export interface UpdateAsset {
  name: string
  url: string
  kind: 'installer' | 'portable'
  size?: number
  /** 提供时下载完成后必须校验 SHA-256，不一致就拒绝执行。 */
  sha256?: string
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

/** GitHub 请求的退避：500ms → 1500ms，首次之外最多再试 2 次。 */
const UPDATE_RETRY_DELAYS_MS = [500, 1500]

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * 4xx 是确定性错误（比如仓库还没有 Release 时的 404），重试只是白等；
 * 其余（超时、连接被重置、5xx、响应被截断）都按可恢复处理。
 */
function isRetryableUpdateError(message: string): boolean {
  const status = /更新源返回 (\d{3})/.exec(message)
  if (status) {
    const code = Number(status[1])
    return code === 429 || code >= 500
  }
  return true
}

/**
 * 带重试的更新清单请求：网络抖动（DNS/TLS、代理切换）不该让「检查更新」直接失败，
 * 退避 500ms → 1500ms 重试两次；仍失败就抛给调用方，由它决定怎么呈现。
 */
async function httpsJSONWithRetry<T>(url: string, timeoutMS: number): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= UPDATE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await httpsJSON<T>(url, timeoutMS)
    } catch (cause) {
      lastError = cause
      const reason = describeCause(cause)
      const delay = UPDATE_RETRY_DELAYS_MS[attempt]
      if (delay === undefined || !isRetryableUpdateError(reason)) break
      console.warn(`[update] 获取更新清单失败（${reason}），${delay}ms 后重试（第 ${attempt + 1}/${UPDATE_RETRY_DELAYS_MS.length} 次）`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError ?? new Error('更新源不可达')
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
      // 命名约定（本地文件为中文名；GitHub 资产为 ASCII 名，两者都识别）：
      // 便携版 / Portable → portable；安装版 / Setup → installer。
      kind: /便携版|portable/i.test(asset.name) ? 'portable' : 'installer'
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
    const raw = await httpsJSONWithRetry<GitHubRelease | UpdateManifest>(updateFeedURL(), 8000)
    // 两种来源：GitHub Release 原始 JSON，或直接给我们的清单格式（KUMONE_UPDATE_URL 用）。
    const manifest =
      'assets' in raw && Array.isArray(raw.assets) && !('tag_name' in raw)
        ? (raw as unknown as UpdateManifest)
        : await withGitHubHashes(raw as GitHubRelease)
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
  } catch (cause) {
    // 更新失败不影响听歌：界面照常显示「检查失败」，但日志里要留下真实原因。
    console.warn(`[update] 检查更新失败：${describeCause(cause)}`)
    return empty
  }
}

/**
 * GitHub Release 上没有逐资产哈希，但我们的发布流程会附带 sha256sums.txt：
 * 拉下来解析成「文件名 → SHA-256」并挂到对应资产上，下载后先验哈希再执行。
 */
export async function withGitHubHashes(release: GitHubRelease): Promise<UpdateManifest> {
  const manifest = releaseToManifest(release)
  const sums = (release.assets ?? []).find((asset) => /sha256sums/i.test(asset.name))
  if (!sums) return manifest
  try {
    const text = await fetchText(sums.browser_download_url, 8000)
    const table = new Map<string, string>()
    for (const line of text.split(/\r?\n/)) {
      const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim())
      if (match) table.set(match[2].trim(), match[1].toLowerCase())
    }
    for (const asset of manifest.assets) {
      const hash = table.get(asset.name)
      if (hash) asset.sha256 = hash
    }
  } catch {
    // 拿不到哈希清单只是退化为不校验，不阻断更新。
  }
  return manifest
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
  // 已有文件也必须过哈希（可能来自上次中断的下载）；不匹配就删掉重下。
  if (existsSync(target)) {
    if (!asset.sha256 || sha256File(target).toLowerCase() === asset.sha256.toLowerCase()) {
      onProgress?.(1)
      return Promise.resolve(target)
    }
    rmSync(target, { force: true })
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
      out.on('finish', () => out.close(() => resolve(tmp)))
      out.on('error', (cause) => reject(cause))
    })
    request.on('error', reject)
    request.setTimeout(15 * 60 * 1000, () => {
      request.destroy()
      reject(new Error('下载超时'))
    })
  }).then(() => {
    // 下载完先验哈希（有清单时），再落成最终文件名。
    if (asset.sha256) {
      const actual = sha256File(tmp).toLowerCase()
      if (actual !== asset.sha256.toLowerCase()) {
        rmSync(tmp, { force: true })
        throw new Error(`下载校验失败：${asset.name} 的 SHA-256 与发布清单不一致`)
      }
    }
    const { renameSync } = require('node:fs') as typeof import('node:fs')
    renameSync(tmp, target)
    return target
  })
}

function sha256File(file: string): string {
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 当前程序是不是便携版形态（electron-builder portable 会注入这两个环境变量）。 */
export function isPortableBuild(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR) || /Portable/i.test(process.execPath)
}

/**
 * 生成「退出 → 替换/安装 → 重开」的 PowerShell 脚本（不执行）。
 * 独立导出便于单测断言脚本形状与转义。
 *
 * 便携版有两个实测要点：
 *  1. 内层应用退出后，便携版外壳进程还会短暂存活并占用 exe——
 *     必须连外壳（父进程 + 任何指向目标路径的进程）一起等；
 *  2. 覆盖用带重试的复制循环（10 秒内最多 40 次），
 *     兜住杀毒扫描/句柄释放等任何瞬时占用。
 */
export function buildApplyScript(options: {
  pid: number
  parentPid: number
  portable: boolean
  currentExe: string
  newFile: string
}): string {
  const { pid, parentPid, portable, currentExe, newFile } = options
  // 替换脚本自带的落盘日志：应用退出后 PowerShell 没有控制台，
  // 出错时只有这个文件能说明卡在哪一步（排障与支持都靠它）。
  // 注意写在 TEMP 根，不写 youyou-update 子目录——那个目录可能被新实例启动时的
  // cleanUpdateCache 删掉，日志放里面会一起消失。
  const logLine = `$log = Join-Path $env:TEMP 'youyou-apply.log'; function L($m) { try { Add-Content -Path $log -Value ("$(Get-Date -Format o) " + $m) -Encoding utf8 } catch {} }; L 'apply script started'`
  // 用换行拼接成完整多行脚本：try/catch、for 这类块结构绝不能用分号拼接
  // （`}; catch` 在 PowerShell 里是语法错误，PS 会启动即挂且退出码 0）。
  const lines: string[] = [
    logLine,
    `$pidToWait = ${pid}`,
    '$waits = 0',
    'while (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500; $waits++; if ($waits % 20 -eq 0) { L ("still waiting for app pid, polls=" + $waits) } }',
    'L "old app exited"'
  ]
  if (portable) {
    lines.push(
      `$target = '${escapePS(currentExe)}'`,
      `$newFile = '${escapePS(newFile)}'`,
      `$parentToWait = ${parentPid}`,
      'while (($parentToWait -gt 0) -and (Get-Process -Id $parentToWait -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 300 }',
      'while (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $target }) { Start-Sleep -Milliseconds 300 }',
      'L "holder processes exited"',
      '$copied = $false',
      'for ($i = 0; $i -lt 40 -and -not $copied; $i++) {',
      '  try {',
      '    Copy-Item -Path $newFile -Destination $target -Force -ErrorAction Stop',
      '    $copied = $true',
      '  } catch {',
      '    L ("copy attempt " + $i + " failed: " + $_.Exception.Message)',
      '    Start-Sleep -Milliseconds 250',
      '  }',
      '}',
      'L ("copied=" + $copied)',
      'if ($copied) { Start-Process -FilePath $target; L "relaunched" }',
      'L "apply script done"'
    )
  } else {
    lines.push(
      `$installer = '${escapePS(newFile)}'`,
      "Start-Process -FilePath $installer -ArgumentList '/S' -Wait",
      'L "installer finished"',
      `Start-Process -FilePath '${escapePS(currentExe)}'`,
      'L "relaunched"',
      'L "apply script done"'
    )
  }
  return lines.join('\n')
}

/**
 * 排定「退出 → 替换/安装 → 重开」流程并退出应用。
 * 用 PowerShell 做脱离进程：它等我们的 PID 消失后再动手，避免覆盖被占用/被自己杀掉的局面。
 */
export function applyUpdate(asset: UpdateAsset, localPath: string): void {
  const portable = isPortableBuild()
  const currentExe = portable
    ? (process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath)
    : process.execPath
  const script = buildApplyScript({
    pid: process.pid,
    parentPid: process.ppid,
    portable,
    currentExe,
    newFile: localPath
  })

  // 排障落盘：applyUpdate 被调用、spawn 成功/失败、子进程退出码，全部记到 TEMP。
  // 应用退出后没有控制台，这是唯一能回答「替换为什么没发生」的证据。
  try {
    writeFileSync(
      path.join(os.tmpdir(), 'youyou-apply-start.log'),
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, parentPid: process.ppid, portable, currentExe, localPath }, null, 2)
    )
  } catch {
    /* ignore */
  }

  // 把脚本落成 .ps1 再用 -File 启动：比 -Command 传一大串内嵌引号可靠得多。
  const ps1Path = path.join(os.tmpdir(), 'youyou-apply.ps1')
  try {
    writeFileSync(ps1Path, script, 'utf8')
  } catch {
    /* ignore */
  }

  // stdout/stderr 接文件而不是 ignore：PowerShell 的解析/运行错误只走这两个流，
  // 接住才能排障（对正常流程零影响，-WindowStyle Hidden 本身就没有控制台）。
  // 注意必须用 openSync 拿真实 fd：直接把 WriteStream 传给 spawn 会因 fd 尚未打开
  // 同步抛 "The argument 'stdio' is invalid"。
  const outFd = openSync(path.join(os.tmpdir(), 'youyou-apply-out.log'), 'a')
  const errFd = openSync(path.join(os.tmpdir(), 'youyou-apply-err.log'), 'a')

  // 关键：必须经 `cmd /c start` 启动 PowerShell。
  // 实测本环境下「父进程退出会连带杀掉子进程」（作业对象 kill-on-close），
  // 直接 spawn 的 PS 会随应用退出一起死掉，替换永远不执行；而 cmd 的 `start`
  // 通过 ShellExecute 把 PS 挂到独立会话，是唯一实测能活过应用退出的通道。
  // 注意用独立 argv 元素（与验证时的形式一致）；拼成单串给 /c 会被 cmd 的引号
  // 解析坑掉。
  const child = spawn('cmd.exe', [
    '/c',
    'start',
    '',
    'powershell.exe',
    '-NoProfile',
    '-WindowStyle',
    'Hidden',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    ps1Path
  ], {
    stdio: ['ignore', outFd, errFd],
    windowsHide: true
  })
  try {
    writeFileSync(
      path.join(os.tmpdir(), 'youyou-apply-pid.log'),
      `child.pid=${child.pid} at=${new Date().toISOString()}`
    )
  } catch {
    /* ignore */
  }
  child.on('spawn', () => {
    try {
      writeFileSync(path.join(os.tmpdir(), 'youyou-apply-spawned.log'), `spawned at=${new Date().toISOString()}`)
    } catch {
      /* ignore */
    }
  })
  child.on('error', (cause) => {
    try {
      writeFileSync(path.join(os.tmpdir(), 'youyou-apply-spawn-error.log'), String(cause))
    } catch {
      /* ignore */
    }
  })
  child.on('exit', (code) => {
    try {
      writeFileSync(path.join(os.tmpdir(), 'youyou-apply-exit.log'), `exit code=${code} at=${new Date().toISOString()}`)
    } catch {
      /* ignore */
    }
  })
  child.unref()

  // 给脱离进程一点启动时间，再退出本进程。
  // 必须用 app.exit 而不是 app.quit：托盘开启时 window-all-closed 会把 quit 拦下来
  // （"关闭时最小化到托盘"语义），那样旧进程永远不退、替换永远不执行。
  setTimeout(() => {
    try {
      writeFileSync(path.join(os.tmpdir(), 'youyou-exit-firing.log'), `firing at=${new Date().toISOString()}`)
    } catch {
      /* ignore */
    }
    app.exit(0)
  }, 1500)
  // 兜底：万一 app.exit 因为任何原因没有终止进程（本环境实测过它失效的场景），
  // 5 秒后用 process.exit 硬杀——更新流程绝不能卡在「旧进程不退出」。
  setTimeout(() => {
    try {
      writeFileSync(path.join(os.tmpdir(), 'youyou-exit-fallback.log'), `fallback at=${new Date().toISOString()}`)
    } catch {
      /* ignore */
    }
    process.exit(0)
  }, 5000)
}

/** 把路径转义成 PowerShell 单引号字面量。 */
function escapePS(value: string): string {
  return value.replace(/'/g, "''")
}

/** 清理上次更新留下的下载缓存（.part 与已完成文件）。 */
export async function cleanUpdateCache(): Promise<void> {
  await rm(path.join(os.tmpdir(), 'youyou-update'), { recursive: true, force: true }).catch(() => undefined)
}
