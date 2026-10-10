/**
 * 端到端验证多平台登录页：平台图标、默认网易云二维码、切到 QQ 后拿到真二维码图片。
 *
 * 用法：npx electron-vite build 之后 node scripts/test-platforms.mjs
 * 用独立的 userData（全新的、没登录过），所以进去就是登录页。
 */
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9372
const userData = path.join(os.tmpdir(), 'youyou-platforms-test')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[platforms] ${message}`)

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function cdpEval(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
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
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
  ws.close()
  return value
}

/** 轮询一段表达式直到它为真。 */
async function waitFor(expression, timeoutMs = 20_000, label = expression) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await cdpEval(expression)
    if (last === true) return true
    await wait(400)
  }
  log(`等待超时: ${label} 最后取值=${JSON.stringify(last)?.slice(0, 200)}`)
  return false
}

const snapshot = () =>
  cdpEval(
    `(() => {
      const chips = [...document.querySelectorAll('.login__platform')]
      const image = document.querySelector('.login__qr-image')
      const matrix = document.querySelector('.qr-grid')
      return {
        chips: chips.length,
        active: chips.findIndex((node) => node.classList.contains('login__platform--active')),
        labels: chips.map((node) => node.getAttribute('aria-label')),
        loggedInDots: document.querySelectorAll('.login__platform-dot').length,
        hasImage: Boolean(image),
        imageOk: image ? image.complete && image.naturalWidth > 0 : false,
        imageSrc: image ? image.getAttribute('src').slice(0, 30) : null,
        hasMatrix: Boolean(matrix),
        status: document.querySelector('.login__status')?.textContent ?? null,
        placeholder: document.querySelector('.login__qr-placeholder')?.textContent ?? null
      }
    })()`
  )

const clickChip = (index) => cdpEval(`(() => { document.querySelectorAll('.login__platform')[${index}].click(); return true })()`)

async function main() {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  const env = { ...process.env, YOYOU_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`], { stdio: 'ignore', env, cwd: root, detached: true })
  child.unref()

  try {
    let ready = false
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await wait(1500)
      try {
        if (await cdpEval(`Boolean(window.youyou)`)) {
          ready = true
          break
        }
      } catch {
        /* 还没起来 */
      }
    }
    if (!ready) {
      record('实例启动', false, '轮询超时')
      return
    }
    record('实例启动并连上 CDP', true)

    const platforms = await cdpEval(`(async () => (await window.youyou.invoke('auth:platforms')).data)()`)
    record(
      'auth:platforms 返回两个平台',
      Array.isArray(platforms) && platforms.length === 2 && platforms.every((item) => item.loggedIn === false),
      JSON.stringify(platforms)
    )

    // 没登录时首页给的是「去登录」入口，登录页在它后面。
    const opened = await cdpEval(
      `(() => {
        const button = [...document.querySelectorAll('button')].find((node) => (node.textContent ?? '').trim() === '去登录')
        if (!button) return false
        button.click()
        return true
      })()`
    )
    record('从首页进入登录页', opened)

    const onLogin = await waitFor(`Boolean(document.querySelector('.login__platforms'))`, 15_000, '登录页出现')
    record('登录页出现', onLogin)

    const initial = await snapshot()
    record('平台图标数量', initial.chips === 2, `labels=${JSON.stringify(initial.labels)}`)
    record('默认选中网易云', initial.active === 0, `active=${initial.active}`)
    const neteaseQR = await waitFor(`Boolean(document.querySelector('.qr-grid'))`, 15_000, '网易云二维码矩阵')
    record('默认显示网易云二维码', neteaseQR)
    record('网易云状态文案', /网易云/.test((await snapshot()).status ?? ''), (await snapshot()).status ?? '')

    // 切到 QQ音乐：二维码由平台直接给图片
    await clickChip(1)
    const qqImage = await waitFor(
      `(() => { const img = document.querySelector('.login__qr-image'); return Boolean(img && img.complete && img.naturalWidth > 0) })()`,
      25_000,
      'QQ 二维码图片加载完成'
    )
    const qq = await snapshot()
    record('切到 QQ音乐出现二维码图片', qqImage, `src=${qq.imageSrc}`)
    record('QQ 状态文案', /QQ/.test(qq.status ?? ''), qq.status ?? '')

    // 切回网易云
    await clickChip(0)
    const backToNetease = await waitFor(`Boolean(document.querySelector('.qr-grid'))`, 15_000, '切回网易云二维码')
    record('切回网易云恢复二维码', backToNetease)
  } finally {
    try {
      await cdpEval(`window.close()`)
    } catch {
      /* 忽略 */
    }
    spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
  }

  const failed = results.filter((item) => !item.ok)
  log(`结果: ${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
