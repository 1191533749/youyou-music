/**
 * 日志收集链路端到端验证（本地隔离实例 → 生产 /logs 端点 → 服务器落盘）。
 *
 * 流程：
 *  1. 隔离 userData 预置 diagnostics/pending.jsonl（一条测试异常）；
 *  2. 启动 dev 实例（--remote-debugging-port）；
 *  3. CDP 调 window.youyou.invoke('settings:update', { collectLogs: true })
 *     —— 主进程 setLogCollectorEnabled(true) 会立即 flush 本地积压；
 *  4. 轮询 pending.jsonl：上传成功会被删掉（证明服务器返回 {ok:true}）；
 *  5. 结束杀 youyou-log-upload-test 实例。
 *
 * 用法：node scripts/test-log-upload.mjs
 */
import { spawn, execSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9367
const userData = path.join(os.tmpdir(), 'youyou-log-upload-test')
const pendingFile = path.join(userData, 'diagnostics', 'pending.jsonl')

function log(message) {
  console.log(`[log-e2e] ${message}`)
}

function waitFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function cdpEvaluate(expression, awaitPromise = false) {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  const targets = await response.json()
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error('未找到页面 target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  const evaluate = (expr) =>
    new Promise((resolve) => {
      const id = Math.floor(Math.random() * 1e9)
      const onMessage = (event) => {
        const message = JSON.parse(event.data)
        if (message.id === id) {
          ws.removeEventListener('message', onMessage)
          resolve(message.result)
        }
      }
      ws.addEventListener('message', onMessage)
      ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression: expr, returnByValue: true, awaitPromise }
        })
      )
    })
  const result = await evaluate(expression)
  ws.close()
  return result?.result?.value
}

async function toggleCollectLogs(next) {
  const result = await cdpEvaluate(
    `window.youyou.invoke('settings:update', { collectLogs: ${next} })`,
    true
  )
  log(`settings:update collectLogs=${next} -> ok=${result?.ok} collectLogs=${result?.data?.collectLogs}`)
  return result
}

async function waitPendingGone(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!fs.existsSync(pendingFile)) return true
    await waitFor(1000)
  }
  return !fs.existsSync(pendingFile)
}

function killInstance() {
  try {
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*youyou-log-upload-test*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore' }
    )
  } catch {
    /* ignore */
  }
}

async function main() {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(pendingFile), { recursive: true })
  fs.writeFileSync(
    pendingFile,
    `${JSON.stringify({
      at: new Date().toISOString(),
      category: 'other',
      message: 'e2e log upload test',
      appVersion: '0.4.2',
      platform: 'win32',
      osVersion: 'Windows',
      arch: 'x64',
      hostname: 'e2e-log-test'
    })}\n`,
    'utf8'
  )
  log(`预置积压队列: ${pendingFile}`)

  const env = { ...process.env, YOYOU_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    stdio: 'ignore',
    env,
    cwd: root,
    detached: true
  })
  child.unref()
  log(`dev 实例启动 PID=${child.pid}`)

  let ready = false
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await waitFor(1000)
    try {
      const hasBridge = await cdpEvaluate(`Boolean(window.youyou && window.youyou.invoke)`)
      if (hasBridge) {
        ready = true
        log('window.youyou 就绪')
        break
      }
    } catch {
      /* retry */
    }
  }
  if (!ready) {
    killInstance()
    throw new Error('页面始终未就绪')
  }

  await toggleCollectLogs(true)

  let uploaded = await waitPendingGone(20000)
  if (!uploaded) {
    // 首次 flush 可能撞上瞬态连接超时（8s 超时），关→开再触发一次 flush
    log('20s 内未上传，关→开重触发 flush')
    await toggleCollectLogs(false)
    await waitFor(1000)
    await toggleCollectLogs(true)
    uploaded = await waitPendingGone(20000)
  }

  log(uploaded ? 'PASS 本地积压已上传（pending.jsonl 被清空）' : 'FAIL 本地积压仍在')
  killInstance()
  process.exit(uploaded ? 0 : 1)
}

main().catch((cause) => {
  console.error(`[log-e2e] 失败: ${cause}`)
  killInstance()
  process.exit(1)
})
