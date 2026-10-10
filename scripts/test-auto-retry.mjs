/**
 * 验证「首个接口报错不再直接弹错误卡片」：渲染层 useAsync 的静默自动重试。
 *
 * 两个场景（各自起一个隔离实例，用主进程测试钩子 YOYOU_FAIL_LIBRARY=<N>
 * 让 library:overview 前 N 次直接失败）：
 *   A. N=2 —— 前两次失败、第三次成功：页面全程不该出现错误卡片，最终要出内容，
 *      且耗时必须 > 2s（证明它确实在后台重试，而不是一次就成）。
 *   B. N=99 —— 一直失败：前 5 秒不该出现错误卡片（保持加载态），
 *      三次重试耗尽后（约 5.5s）才把错误卡片呈现出来。
 *
 * 用法：npx electron-vite build 之后 node scripts/test-auto-retry.mjs
 */
import { spawn, execSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const shotsDir = path.join(os.tmpdir(), 'shots-auto-retry')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[auto-retry] ${message}`)

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const SNAPSHOT = `(() => ({
  hasError: Boolean(document.querySelector('.page__error')),
  errorText: (document.querySelector('.page__error')?.textContent ?? '').trim(),
  hasRetryButton: [...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').trim() === '重试'),
  placeholder: (document.querySelector('.placeholder')?.textContent ?? '').trim(),
  library: Boolean(document.querySelector('.page.library')),
  hero: Boolean(document.querySelector('.library__hero'))
}))()`

function cdpEval(port, expression, awaitPromise = false) {
  return (async () => {
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
          resolve({ __exception: `${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}` })
          return
        }
        resolve(result?.result?.value)
      }
      ws.addEventListener('message', onMessage)
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }))
    })
    ws.close()
    return value
  })()
}

async function screenshot(port, name) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = targets.find((target) => target.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', reject)
  })
  const data = await new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e9)
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      ws.removeEventListener('message', onMessage)
      resolve(message.result?.data)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } }))
  })
  ws.close()
  fs.writeFileSync(path.join(shotsDir, name), Buffer.from(data, 'base64'))
  log(`截图 ${name}`)
}

function killOnPort(port) {
  try {
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--remote-debugging-port=${port}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore' }
    )
  } catch {
    /* ignore */
  }
}

async function boot(port, tag, failBudget) {
  const userData = path.join(os.tmpdir(), `youyou-auto-retry-${tag}`)
  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  const real = path.join(process.env.APPDATA, 'youyou-music')
  for (const name of ['cookies.json', 'settings.json']) {
    const from = path.join(real, name)
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(userData, name))
  }
  const env = { ...process.env, YOYOU_USER_DATA: userData, YOYOU_FAIL_LIBRARY: String(failBudget) }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, ['.', `--remote-debugging-port=${port}`], { stdio: 'ignore', env, cwd: root, detached: true })
  child.unref()
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await wait(1500)
    try {
      if (await cdpEval(port, `Boolean(window.youyou && document.querySelector('.sidebar__link'))`)) return true
    } catch {
      /* 还没起来 */
    }
  }
  return false
}

async function openLibrary(port) {
  return cdpEval(
    port,
    `(() => {
      const link = [...document.querySelectorAll('.sidebar__link')].find((b) => (b.textContent ?? '').includes('我的音乐'))
      if (!link) return false
      link.click()
      return true
    })()`
  )
}

/** 点击「我的音乐」后按 200ms 采样，直到 stopAt 毫秒为止。 */
async function sampleUntil(port, stopAt, stopWhen) {
  const start = Date.now()
  const timeline = []
  let errorFirstSeen = undefined
  let contentFirstSeen = undefined
  let placeholderSeen = false
  let errorSeen = false
  while (Date.now() - start < stopAt) {
    const snap = await cdpEval(port, SNAPSHOT)
    const elapsed = Date.now() - start
    if (snap?.hasError) {
      errorSeen = true
      if (errorFirstSeen === undefined) {
        errorFirstSeen = elapsed
        timeline.push({ at: elapsed, event: 'ERROR_CARD', text: snap.errorText })
      }
    }
    if (snap?.placeholder) placeholderSeen = true
    if (snap?.library || snap?.hero) {
      if (contentFirstSeen === undefined) {
        contentFirstSeen = elapsed
        timeline.push({ at: elapsed, event: 'CONTENT' })
      }
      if (stopWhen === 'content') break
    }
    await wait(200)
  }
  return { timeline, errorFirstSeen, contentFirstSeen, placeholderSeen, errorSeen }
}

async function main() {
  if (!fs.existsSync(electron)) {
    console.error(`找不到 electron: ${electron}`)
    process.exit(1)
  }
  fs.rmSync(shotsDir, { recursive: true, force: true })
  fs.mkdirSync(shotsDir, { recursive: true })

  // ---- 场景 A：前两次失败，第三次成功 ----
  const PORT_A = 9362
  log('场景 A：library:overview 前 2 次失败、第 3 次成功')
  try {
    if (!(await boot(PORT_A, 'a', 2))) {
      record('场景 A 实例启动', false, '轮询超时')
    } else {
      if (!(await openLibrary(PORT_A))) record('场景 A 打开我的音乐', false, '未找到侧栏入口')
      else {
        const observed = await sampleUntil(PORT_A, 12000, 'content')
        log(`场景 A 时间线: ${JSON.stringify(observed.timeline)}`)
        record('场景 A 最终出内容（重试后恢复正常）', observed.contentFirstSeen !== undefined, `${observed.contentFirstSeen ?? '-'}ms`)
        record('场景 A 全程未出现错误卡片', !observed.errorSeen, `errorFirstSeen=${observed.errorFirstSeen ?? '-'}`)
        record('场景 A 先显示加载占位', observed.placeholderSeen)
        record(
          '场景 A 耗时 > 2s（证明真的重试了）',
          (observed.contentFirstSeen ?? 0) > 2000,
          `${observed.contentFirstSeen ?? '-'}ms（两次退避 700+1600=2300ms）`
        )
        await screenshot(PORT_A, '01-recovered.png')
      }
    }
  } finally {
    killOnPort(PORT_A)
  }

  // ---- 场景 B：一直失败 ----
  const PORT_B = 9363
  log('场景 B：library:overview 一直失败')
  try {
    if (!(await boot(PORT_B, 'b', 99))) {
      record('场景 B 实例启动', false, '轮询超时')
    } else {
      if (!(await openLibrary(PORT_B))) record('场景 B 打开我的音乐', false, '未找到侧栏入口')
      else {
        const observed = await sampleUntil(PORT_B, 9000, 'never')
        log(`场景 B 时间线: ${JSON.stringify(observed.timeline)}`)
        log(`场景 B 错误卡片首现 = ${observed.errorFirstSeen ?? '-'}ms`)
        record('场景 B 前 5s 不显示错误卡片（保持加载态）', (observed.errorFirstSeen ?? 0) > 5000, `errorFirstSeen=${observed.errorFirstSeen ?? '-'}`)
        record('场景 B 重试耗尽后呈现错误卡片', observed.errorSeen, `${observed.errorFirstSeen ?? '-'}ms`)
        record('场景 B 首屏先显示加载占位', observed.placeholderSeen)
        const text = await cdpEval(PORT_B, `(document.querySelector('.page__error')?.textContent ?? '').trim()`)
        record('场景 B 错误文案正确', String(text).includes('服务器连接失败'), String(text))
        await screenshot(PORT_B, '02-exhausted.png')
      }
    }
  } finally {
    killOnPort(PORT_B)
  }

  const failed = results.filter((item) => !item.ok)
  log(failed.length === 0 ? 'AUTO-RETRY OK' : `AUTO-RETRY FAILED (${failed.length}/${results.length})`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((cause) => {
  console.error(`[auto-retry] 失败: ${cause}`)
  try {
    killOnPort(9362)
    killOnPort(9363)
  } catch {
    /* ignore */
  }
  process.exit(1)
})
