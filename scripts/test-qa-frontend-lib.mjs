/**
 * qa-frontend 共享探针库 —— 只读探针 + 启动/关闭辅助，不改任何 src 代码。
 *
 * 用法：每个页面测试脚本 import 本库，独立起一个隔离实例（YOYOU_USER_DATA 指向
 * 临时目录，绝不触碰用户真实数据），测完立即杀进程。
 *
 * 关键约定：
 *  - CDP 评估一律 returnByValue + awaitPromise，异常包装成 { __exception } 返回。
 *  - killOnPort 先按监听端口找 PID，再核对进程名是 electron.exe 才杀
 *    （不按 CommandLine 过滤，避免误杀 pwsh）。
 *  - 截图落在 <项目根>/shots-qa/。
 *  - startConsoleMonitor 用一条常驻 WebSocket 收集 Runtime.exceptionThrown /
 *    consoleAPICalled(error) / Log.entryAdded(error)。
 */
import { spawn, execSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const root = path.resolve(__dirname, '..')
export const electronPath = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
export const shotsDir = path.join(root, 'shots-qa')

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const log = (message) => console.log(`[qa] ${message}`)

export const recordTo = (results) => (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 按端口杀旧实例：先确认监听进程是 electron.exe 再杀。 */
export function killOnPort(port) {
  let pid
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', windowsHide: true })
    const re = new RegExp(`:${port}\\s+\\S+\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i')
    const match = out.match(re)
    if (match) pid = Number(match[1])
  } catch {
    /* ignore */
  }
  if (!pid) return
  try {
    const tl = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
      encoding: 'utf8',
      windowsHide: true
    })
    if (!/electron\.exe/i.test(tl)) {
      log(`端口 ${port} 上监听的进程不是 electron.exe（${tl.trim()}），不杀。`)
      return
    }
  } catch {
    return
  }
  try {
    execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', windowsHide: true })
    log(`已结束端口 ${port} 上的旧 electron 实例 (PID ${pid})。`)
  } catch {
    /* 进程可能已退出 */
  }
}

/** 一次性 CDP 调用超时（避免目标死亡时永久挂起）。
 *  40s：网易云风控重试风暴会让渲染层偶发忙 20s+，20s 太容易误杀。 */
const CDP_TIMEOUT_MS = 40_000
const withTimeout = (promise, ms, label) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`CDP 超时: ${label}`)), ms))])

/** 一次性的 CDP 评估。 */
export async function cdpEval(port, expression, awaitPromise = true) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error('未找到页面 target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await withTimeout(
    new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', reject)
    }),
    CDP_TIMEOUT_MS,
    'ws open'
  )
  const value = await withTimeout(
    new Promise((resolve) => {
      const id = Math.floor(Math.random() * 1e9)
      const onMessage = (event) => {
        const message = JSON.parse(event.data)
        if (message.id !== id) return
        ws.removeEventListener('message', onMessage)
        const result = message.result
        if (result?.exceptionDetails) {
          resolve({
            __exception: `${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`
          })
          return
        }
        resolve(result?.result?.value)
      }
      ws.addEventListener('message', onMessage)
      ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise }
        })
      )
    }),
    CDP_TIMEOUT_MS,
    'Runtime.evaluate'
  )
  ws.close()
  return value
}

/** 轮询表达式直到为 true。 */
export async function waitFor(port, expression, timeoutMs = 20_000, label = expression) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await cdpEval(port, expression)
    } catch {
      last = undefined
    }
    if (last && typeof last === 'object' && '__exception' in last) last = undefined
    if (last) return true
    await wait(400)
  }
  log(`等待超时: ${label} 最后取值=${JSON.stringify(last)?.slice(0, 300)}`)
  return false
}

/** 截图到 shots-qa/<name>，返回文件路径；失败重试 2 次后仅告警不抛出（截图不应中断测试）。 */
export async function screenshot(port, name) {
  let lastError = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = targets.find((target) => target.type === 'page')
      if (!page) throw new Error('未找到页面 target')
      const ws = new WebSocket(page.webSocketDebuggerUrl)
      await withTimeout(
        new Promise((resolve, reject) => {
          ws.addEventListener('open', () => resolve())
          ws.addEventListener('error', reject)
        }),
        CDP_TIMEOUT_MS,
        'ws open (screenshot)'
      )
      const data = await withTimeout(
        new Promise((resolve) => {
          const id = Math.floor(Math.random() * 1e9)
          const onMessage = (event) => {
            const message = JSON.parse(event.data)
            if (message.id !== id) return
            ws.removeEventListener('message', onMessage)
            resolve(message.result?.data)
          }
          ws.addEventListener('message', onMessage)
          ws.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } }))
        }),
        CDP_TIMEOUT_MS,
        'captureScreenshot'
      )
      ws.close()
      fs.mkdirSync(shotsDir, { recursive: true })
      const file = path.join(shotsDir, name)
      fs.writeFileSync(file, Buffer.from(data ?? '', 'base64'))
      log(`截图 ${path.relative(root, file)} (${data ? Math.round(data.length * 0.75) : 0} bytes)`)
      return file
    } catch (error) {
      lastError = error
      log(`截图 ${name} 第 ${attempt}/2 次失败: ${error?.message}`, 'warn')
      await wait(2000)
    }
  }
  log(`截图 ${name} 放弃: ${lastError?.message}`, 'warn')
  return null
}

/** 把真实账号状态复制进独立 userData（只读复制，不动真实目录）。 */
export function copyRealState(userData) {
  const real = path.join(process.env.APPDATA ?? '', 'youyou-music')
  const copied = []
  for (const name of ['cookies.json', 'accounts.json', 'settings.json']) {
    const from = path.join(real, name)
    const to = path.join(userData, name)
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, to)
      copied.push(name)
    }
  }
  const dailyFrom = path.join(real, 'daily-history')
  const dailyTo = path.join(userData, 'daily-history')
  if (fs.existsSync(dailyFrom)) {
    fs.cpSync(dailyFrom, dailyTo, { recursive: true })
    copied.push('daily-history')
  }
  return copied
}

/**
 * 启动隔离实例。extraEnv 支持测试钩子（YOYOU_FAIL_SEARCH 等）。
 * 返回 { child, ready }。
 */
export async function boot({ port, userData, withRealState = true, extraEnv = {}, waitReady = 24 }) {
  killOnPort(port)
  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  const copied = withRealState ? copyRealState(userData) : []
  if (copied.length > 0) log(`已从真实用户目录复制状态文件: ${copied.join(', ')}`)

  const env = { ...process.env, YOYOU_USER_DATA: userData, ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  const logFd = fs.openSync(path.join(userData, 'main-stdout.log'), 'a')
  const child = spawn(
    electronPath,
    [path.join(root, 'out', 'main', 'index.js'), `--remote-debugging-port=${port}`],
    { stdio: ['ignore', logFd, logFd], env, cwd: root, detached: true, windowsHide: true }
  )
  child.unref()

  let ready = false
  for (let attempt = 0; attempt < waitReady; attempt += 1) {
    await wait(1500)
    try {
      if (await cdpEval(port, `Boolean(window.youyou && document.querySelector('.sidebar__link'))`, false)) {
        ready = true
        break
      }
    } catch {
      /* 还没起来 */
    }
  }
  if (!ready) log(`实例启动超时（端口 ${port}）。main-stdout.log: ${path.join(userData, 'main-stdout.log')}`)
  return { child, ready, userData }
}

/** 关窗口 + 杀进程 + 清端口。 */
export async function shutdown({ port, child }) {
  try {
    await cdpEval(port, `window.close()`, false)
  } catch {
    /* 已关 */
  }
  await wait(900)
  if (child?.pid) {
    try {
      execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore', windowsHide: true })
    } catch {
      /* 已退出 */
    }
  }
  killOnPort(port)
  log('实例已关闭。')
}

/** 常驻 WebSocket 收集页面报错（console.error / 未捕获异常 / Log.error）。 */
export async function startConsoleMonitor(port) {
  const errors = []
  let ws
  let closed = false
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = targets.find((target) => target.type === 'page')
      if (!page) throw new Error('无页面')
      ws = new WebSocket(page.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', () => resolve())
        ws.addEventListener('error', reject)
      })
      await new Promise((resolve) => {
        let done = 0
        const onClose = () => {
          if (!closed) errors.push({ type: 'target-closed', text: 'CDP target 连接断开（页面可能崩溃/被关闭）' })
        }
        ws.addEventListener('close', onClose)
        const onMessage = (event) => {
          const message = JSON.parse(event.data)
          if (message.id === 9001 || message.id === 9002) {
            done += 1
            if (done === 2) {
              ws.removeEventListener('message', onMessage)
              resolve()
            }
            return
          }
          if (message.method === 'Runtime.exceptionThrown') {
            const d = message.params?.exceptionDetails
            errors.push({ type: 'exception', text: `${d?.text ?? ''} ${d?.exception?.description ?? ''}`.trim() })
          } else if (message.method === 'Runtime.consoleAPICalled') {
            const type = message.params?.type
            if (type === 'error' || type === 'assert') {
              const args = (message.params?.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
              errors.push({ type: `console.${type}`, text: args })
            }
          } else if (message.method === 'Log.entryAdded') {
            const entry = message.params?.entry
            if (entry?.level === 'error') errors.push({ type: 'log', text: entry.text ?? '' })
          }
        }
        ws.addEventListener('message', onMessage)
        ws.send(JSON.stringify({ id: 9001, method: 'Runtime.enable' }))
        ws.send(JSON.stringify({ id: 9002, method: 'Log.enable' }))
        setTimeout(() => resolve(), 3000)
      })
      break
    } catch {
      ws = undefined
      await wait(800)
    }
  }
  return {
    getErrors: () => [...errors],
    stop: () => {
      if (ws && !closed) {
        closed = true
        try {
          ws.close()
        } catch {
          /* ignore */
        }
      }
    }
  }
}

export const clickSidebar = (port, label) =>
  cdpEval(
    port,
    `(() => {
      const b = [...document.querySelectorAll('.sidebar__link')].find((n) => (n.textContent ?? '').includes(${JSON.stringify(label)}))
      if (!b) return false
      b.click()
      return true
    })()`,
    false
  )

export const playerState = (port) =>
  cdpEval(
    port,
    `(async () => {
      try {
        const r = await window.youyou.invoke('player:state')
        return r?.data ?? { ok: r?.ok, kind: r?.kind }
      } catch (e) {
        return { __err: String(e) }
      }
    })()`
  )

/** 汇总退出码。 */
export function finish(results, failedMessage = '有 FAIL') {
  const failed = results.filter((item) => !item.ok)
  log(failed.length === 0 ? `全部通过 (${results.length}/${results.length})` : `${failedMessage}：${failed.length}/${results.length} 项失败`)
  process.exit(failed.length === 0 ? 0 : 1)
}
