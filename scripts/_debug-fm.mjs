/** 临时调试：FM 实例崩溃原因（带主进程日志）。 */
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9379
const userData = path.join(os.tmpdir(), 'youyou-fm-debug')

fs.rmSync(userData, { recursive: true, force: true })
fs.mkdirSync(userData, { recursive: true })
const env = { ...process.env, YOYOU_USER_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, '--enable-logging'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env,
  cwd: root
})
let out = ''
child.stdout.on('data', (chunk) => {
  out += chunk.toString()
})
child.stderr.on('data', (chunk) => {
  out += chunk.toString()
})
child.on('exit', (code) => {
  console.log('=== MAIN EXITED code=', code)
  console.log(out.slice(-4000))
  process.exit(0)
})

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const cdpEval = async (expression) => {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error('no page')
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
      if (result?.exceptionDetails) return resolve({ __exception: result.exceptionDetails.text })
      resolve(result?.result?.value)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
  ws.close()
  return value
}

try {
  for (let i = 0; i < 30; i += 1) {
    await wait(1500)
    try {
      if (await cdpEval(`Boolean(window.youyou)`)) break
    } catch { /* 未就绪 */ }
  }
  console.log('ready')
  await cdpEval(`(() => {
    const link = [...document.querySelectorAll('.sidebar__link')].find((node) => (node.textContent ?? '').trim() === '私人漫游')
    if (link) link.click()
    return true
  })()`)
  console.log('clicked FM')
  // 等待漫游出曲或主进程退出
  for (let i = 0; i < 40; i += 1) {
    await wait(1500)
    try {
      const snap = await cdpEval(`(() => ({
        title: document.querySelector('.fm__title')?.textContent ?? null,
        body: document.body.innerText.slice(0, 120)
      }))()`)
      console.log('snap', JSON.stringify(snap))
      if (snap.title) {
        console.log('FM 出曲成功')
        break
      }
    } catch (cause) {
      console.log('cdp error', String(cause))
      break
    }
  }
} finally {
  try {
    spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
  } catch { /* 忽略 */ }
  setTimeout(() => process.exit(0), 3000)
}
