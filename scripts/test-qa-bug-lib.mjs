/**
 * bug 猎手共享库：启停隔离实例、CDP 探针、登录态/离线音源种植。
 * 只读复制真实 profile 的 cookies.json，绝不修改真实 profile。
 * 杀进程按「命令行包含本测试 userData」过滤，绝不误杀用户的真实实例。
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'

/**
 * 沙箱铁律：本进程 spawn 任何程序都不能用 pipe 捕获输出（EPERM），
 * 所以杀进程一律 spawnSync(stdio:'ignore')。要读结果的先让 PowerShell 落文件。
 */
const runQuiet = (file, args) => spawnSync(file, args, { stdio: 'ignore', windowsHide: true })

// 以本文件位置推导仓库根目录（不依赖 process.cwd()）
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
export const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'offline.m4a')
export const CACHED_TRACK_ID = 999000001
export const CACHED_TRACK_NAME = '同步测试曲'
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const log = (message) => console.log(`[bug] ${message}`)

/** 离线缓存音源：不需要网络也能真的播放（mpv 读本地文件）。
 *  app 真实布局：`<cacheDirectory>/audio/<trackID>-<level>.m4a`，
 *  cacheDirectory 默认 `<userData>/audio-cache`（旧版才是 cache/audio，已迁移）。 */
export function plantCachedAudio(userData, id = CACHED_TRACK_ID, level = 'exhigh') {
  if (!existsSync(FIXTURE)) return false
  const directory = path.join(userData, 'audio-cache', 'audio')
  mkdirSync(directory, { recursive: true })
  copyFileSync(FIXTURE, path.join(directory, `${id}-${level}.m4a`))
  return true
}

/** 复制真实登录态（按已知可用目录顺序尝试），返回来源路径或 null。 */
export function plantCookies(userData) {
  const candidates = [
    process.env.YOYOU_COOKIE_PROFILE,
    path.join(process.env.APPDATA ?? '', 'youyou-music', 'cookies.json'),
    path.join(process.env.APPDATA ?? '', 'kumone-windows', 'cookies.json'),
    path.join(process.env.APPDATA ?? '', 'YouyouMusic', 'cookies.json')
  ].filter(Boolean)
  const source = candidates.find((candidate) => existsSync(candidate))
  if (!source) return null
  mkdirSync(userData, { recursive: true })
  copyFileSync(source, path.join(userData, 'cookies.json'))
  const jar = JSON.parse(readFileSync(path.join(userData, 'cookies.json'), 'utf8'))
  if (typeof jar.MUSIC_U !== 'string' || jar.MUSIC_U.length === 0) {
    log(`登录凭证存在但无 MUSIC_U：${source}`)
  }
  return source
}

/** 清理并重建 userData 目录（taskkill 后子进程释放句柄有延迟，重试）。 */
export function freshUserData(userData) {
  let lastError = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(userData, { recursive: true, force: true })
      mkdirSync(userData, { recursive: true })
      return
    } catch (cause) {
      lastError = cause
      // 纯 Node 等待（不能 spawn powershell sleep：沙箱 pipe 限制 + 没必要）
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    }
  }
  throw lastError
}

export async function launchBugInstance({ port, userData, extraEnv = {}, extraArgs = [], cookie = true, fixture = true }) {
  if (cookie) plantCookies(userData)
  if (fixture) plantCachedAudio(userData)
  const env = { ...process.env, YOYOU_USER_DATA: userData, ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`, ...extraArgs], {
    stdio: 'ignore',
    env,
    cwd: ROOT,
    detached: true
  })
  child.on('error', (cause) => {
    log(`spawn 失败: ${cause.message}`)
    child.__spawnError = cause
  })
  child.unref()
  log(`启动实例 PID=${child.pid} port=${port} userData=${userData}`)
  return child
}

/**
 * CDP Runtime.evaluate。返回 { ok, value, error }。
 * awaitPromise: true —— async 表达式会等真正落定。
 */
export async function cdp(port, expression) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error('未找到页面 target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', reject)
  })
  const value = await new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e9)
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      ws.removeEventListener('message', onMessage)
      const result = message.result
      if (result?.exceptionDetails) {
        resolve({
          ok: false,
          error: `${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`.trim()
        })
        return
      }
      resolve({ ok: true, value: result?.result?.value })
    }
    ws.addEventListener('message', onMessage)
    ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true }
      })
    )
  })
  ws.close()
  return value
}

/** 轮询直到表达式返回 true。返回 { ok, last }。 */
export async function waitFor(port, expression, timeoutMs = 20_000, label = expression) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    const reply = await cdp(port, expression)
    if (reply.ok && reply.value === true) return { ok: true, last: reply.value }
    last = reply.ok ? reply.value : reply.error
    await wait(500)
  }
  log(`等待超时: ${label} 最后取值=${JSON.stringify(last)?.slice(0, 200)}`)
  return { ok: false, last }
}

/** 取播放器状态。 */
export const playerState = (port) =>
  cdp(port, `(async () => (await window.youyou.invoke('player:state')).data)()`)

/** 等待播放器出声（position 增长）。 */
export async function waitPlaying(port, timeoutMs = 30_000) {
  const before = await playerState(port)
  const startPos = before.ok ? (before.value?.position ?? 0) : 0
  const deadline = Date.now() + timeoutMs
  let last = before
  while (Date.now() < deadline) {
    last = await playerState(port)
    if (last.ok && last.value?.playing && (last.value.position ?? 0) > startPos + 0.3) {
      return { ok: true, state: last.value }
    }
    await wait(600)
  }
  return { ok: false, state: last.ok ? last.value : null }
}

/** 按命令行包含 userData 杀实例（含 mpv 子进程树）。 */
export function killInstance(userData, mainPid = 0) {
  // 1) 主进程树（taskkill /T 带子进程，含 mpv）
  if (mainPid > 0) {
    try {
      runQuiet('taskkill', ['/F', '/T', '/PID', String(mainPid)])
    } catch {
      /* 已死 */
    }
  }
  // 2) 兜底清扫：主进程已死但子进程遗留时，按命令行里的 userData 路径匹配
  //    （PowerShell -like 通配符按字面单反斜杠匹配）
  const escaped = userData.replace(/'/g, "''")
  try {
    runQuiet('powershell', [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escaped}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    ])
  } catch {
    /* ignore */
  }
  // 3) mpv 进程按 IPC 管道名（youyou-mpv-<主PID>-）匹配：mpv 命令行里没有 userData
  if (mainPid > 0) {
    try {
      runQuiet('powershell', [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*youyou-mpv-${mainPid}-*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      ])
    } catch {
      /* ignore */
    }
  }
}

/** 按 mpv IPC 管道名杀某实例的 mpv（模拟 mpv 崩溃/被 OOM 杀）。 */
export function killMpvOf(mainPid) {
  runQuiet('powershell', [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*youyou-mpv-${mainPid}-*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  ])
}

/** 数某实例名下存活的 mpv 进程（PS 结果落文件再读，避免沙箱里 pipe stdio）。 */
export function mpvCountOf(mainPid) {
  const outFile = path.join(os.tmpdir(), `youyou-qa-mpvcount-${process.pid}.txt`)
  try {
    runQuiet('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*youyou-mpv-${mainPid}-*' }).Count | Out-File -FilePath '${outFile.replace(/'/g, "''")}' -Encoding ascii`
    ])
    return Number.parseInt(readFileSync(outFile, 'utf8').trim(), 10) || 0
  } catch {
    return 0
  }
}

/** 等待 CDP 就绪：window.youyou 存在 + 侧栏已渲染 + 落定 2.5 秒（保证 React 事件挂上）。 */export async function waitReady(port, timeoutMs = 90_000, retryIfFail = true) {
  const deadline = Date.now() + timeoutMs
  let linked = false
  for (;;) {
    try {
      const reply = await cdp(port, `Boolean(window.youyou) && Boolean(document.querySelector('.sidebar__link'))`)
      if (reply.ok && reply.value === true) {
        linked = true
        break
      }
    } catch (cause) {
      if (!retryIfFail) throw cause
    }
    if (Date.now() > deadline) return false
    await wait(1200)
  }
  await wait(2500)
  return linked
}

/** 等端口彻底释放（旧实例死透，避免 Chromium 自动换端口导致探针连不上）。 */
export async function waitPortFree(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) })
    } catch {
      return true
    }
    if (Date.now() > deadline) return false
    await wait(500)
  }
}

/** 侧栏导航。 */
export const clickNav = (port, label) =>
  cdp(port, `(() => {
    const link = [...document.querySelectorAll('.sidebar__link')].find((item) => (item.textContent ?? '').includes(${JSON.stringify(label)}))
    if (!link) return false
    link.click()
    return true
  })()`)

/** 搜索框输入并回车（走 React 受控组件路径）。 */
export const typeSearch = (port, keyword) =>
  cdp(port, `(() => {
    const input = [...document.querySelectorAll('input')].find((el) => el.offsetParent !== null)
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(keyword)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)

/** 搜索结果行数（当前可见 page-slot 内）。 */
export const searchRows = (port) =>
  cdp(port, `document.querySelector('.page-slot:not([hidden])')?.querySelectorAll('.song-row').length ?? document.querySelectorAll('.song-row').length`)

/**
 * 切到「单曲」页签并等行渲染：综合页的单曲是卡片网格（.grid--albums 无 .song-row），
 * 只有单曲页签的 SongList / 站外结果用 .song-row。返回最终行数。
 */
export const goToSongsTab = (port, timeoutMs = 20_000) =>
  cdp(port, `(async () => {
    const start = Date.now()
    const clickTab = () => {
      const tab = [...document.querySelectorAll('.search__tabs .chip')].find((el) => (el.textContent ?? '').includes('单曲'))
      if (!tab) return false
      tab.click()
      return true
    }
    // 先等页签出现（loading 落定后 tabs 一定在），最多点 3 次（React 重渲染可能换节点）
    for (let i = 0; i < 40; i++) {
      if (clickTab()) break
      await new Promise((r) => setTimeout(r, 250))
    }
    while (Date.now() - start < ${timeoutMs}) {
      const rows = document.querySelectorAll('.song-row').length
      const loading = !!document.querySelector('.search__loading')
      if (rows > 0) return { rows, tabActive: true }
      if (!loading && document.querySelector('.placeholder')) return { rows: 0, tabActive: true, placeholder: true }
      clickTab()
      await new Promise((r) => setTimeout(r, 300))
    }
    return { rows: document.querySelectorAll('.song-row').length, tabActive: false }
  })()`)

/** 收集 app 日志证据（诊断队列）。 */
export function collectLogs(userData) {
  const file = path.join(userData, 'diagnostics', 'pending.jsonl')
  if (!existsSync(file)) return []
  try {
    return readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { raw: line }
      }
    })
  } catch {
    return []
  }
}
