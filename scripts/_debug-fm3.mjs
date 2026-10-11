/** 临时调试：反复点私人漫游，观察页面 target 与主进程生死。 */
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9379
const userData = path.join(os.tmpdir(), 'youyou-fm-debug3')

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
const tail = (chunk) => {
  out += chunk.toString()
}
child.stdout.on('data', tail)
child.stderr.on('data', tail)
let mainExit = null
child.on('exit', (code) => {
  mainExit = code
})

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function cdpEval(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error('NO_PAGE')
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
  console.log('ready, mainExit=', mainExit)
  for (let round = 0; round < 60; round += 1) {
    if (mainExit !== null) {
      console.log(`### 主进程退出 code=${mainExit}（第 ${round} 轮）`)
      console.log('--- 日志尾部 ---')
      console.log(out.slice(-5000))
      break
    }
    try {
      const snap = await cdpEval(
        `(() => {
          const link = [...document.querySelectorAll('.sidebar__link')].find((node) => (node.textContent ?? '').trim() === '私人漫游')
          if (!link) return { noLink: true }
          const active = link.classList.contains('is-active')
          if (!active) link.click()
          return {
            active,
            fmTitle: document.querySelector('.fm__title')?.textContent ?? null,
            fmFail: document.querySelector('.placeholder__title')?.textContent ?? null,
            route: document.querySelector('.page')?.className ?? null,
            body: document.body.innerText.slice(0, 90).replace(/\\n/g, '|')
          }
        })()`
      )
      console.log(`r${round}`, JSON.stringify(snap))
      if (snap.fmTitle || snap.fmFail) {
        console.log('FM 页面出内容了')
      }
    } catch (cause) {
      console.log(`r${round} CDP 错误: ${String(cause)}（页面 target 消失？mainExit=${mainExit}）`)
      if (String(cause).includes('NO_PAGE')) {
        await wait(3000)
        const still = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json().catch(() => [])
        console.log('targets now:', JSON.stringify(still.map((t) => ({ type: t.type, title: t.title }))))
      }
    }
    await wait(2000)
  }
  if (mainExit === null) console.log('### 2 分钟观察结束，主进程仍存活')
  console.log('--- 日志尾部 ---')
  console.log(out.slice(-5000))
} finally {
  try {
    spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
  } catch { /* 忽略 */ }
  setTimeout(() => process.exit(0), 2000)
}
