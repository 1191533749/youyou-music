/**
 * 端到端验证「登录页只有网易云 + QQ 音源账号在设置里按需绑定」。
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
        params: { expression, returnByValue: true, awaitPromise: true }
      })
    )
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

const loginSnapshot = () =>
  cdpEval(
    `(() => ({
      platforms: document.querySelectorAll('.login__platform').length,
      hasMatrix: Boolean(document.querySelector('.qr-grid')),
      status: document.querySelector('.login__status')?.textContent ?? null,
      hint: document.querySelector('.login__hint')?.textContent ?? null,
      playlists: document.querySelectorAll('.source-playlist').length
    }))()`
  )

/** 侧栏一级入口（设置 / 首页）。 */
const clickSidebar = (label) =>
  cdpEval(
    `(() => {
      const link = [...document.querySelectorAll('.sidebar__link')].find((node) => (node.textContent ?? '').trim() === ${JSON.stringify(label)})
      if (!link) return false
      link.click()
      return true
    })()`
  )

const sourceSnapshot = () =>
  cdpEval(
    `(() => {
      const group = [...document.querySelectorAll('.settings__group')].find((node) => (node.querySelector('h2')?.textContent ?? '').trim() === '音源账号')
      if (!group) return { found: false }
      const image = group.querySelector('.source-bind img')
      return {
        found: true,
        title: group.querySelector('.source-account-title')?.textContent ?? null,
        hint: group.querySelector('.settings__row-hint')?.textContent ?? null,
        button: group.querySelector('.settings__row-control .button')?.textContent ?? null,
        hasQR: Boolean(group.querySelector('.source-bind')),
        imageOk: image ? image.complete && image.naturalWidth > 0 : false,
        imageSrc: image ? image.getAttribute('src').slice(0, 30) : null,
        status: group.querySelector('.login__status')?.textContent ?? null,
        playlists: group.querySelectorAll('.source-playlist').length
      }
    })()`
  )

async function main() {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  const env = { ...process.env, YOYOU_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    stdio: 'ignore',
    env,
    cwd: root,
    detached: true
  })
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
      'auth:platforms 仍提供 QQ 平台状态',
      Array.isArray(platforms) && platforms.some((item) => item.platform === 'qq' && item.loggedIn === false),
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

    const onLogin = await waitFor(`Boolean(document.querySelector('.login__qr-frame'))`, 15_000, '登录页出现')
    record('登录页出现', onLogin)

    const neteaseQR = await waitFor(`Boolean(document.querySelector('.qr-grid'))`, 15_000, '网易云二维码矩阵')
    const login = await loginSnapshot()
    record('登录页只剩网易云：出二维码', neteaseQR)
    record('登录页不再有平台图标', login.platforms === 0, `platforms=${login.platforms}`)
    record('状态文案是网易云', /网易云/.test(login.status ?? ''), login.status ?? '')
    record('提示文案是网易云扫码', /网易云音乐 App/.test(login.hint ?? ''), login.hint ?? '')

    // 设置 → 音源账号：未绑定 + 扫码绑定
    record('侧栏进入设置页', await clickSidebar('设置'))
    const onSettings = await waitFor(
      `(() => {
        const group = [...document.querySelectorAll('.settings__group')].find((node) => (node.querySelector('h2')?.textContent ?? '').trim() === '音源账号')
        return Boolean(group)
      })()`,
      15_000,
      '音源账号分组出现'
    )
    record('设置页出现音源账号分组', onSettings)

    const before = await sourceSnapshot()
    record('音源账号是 QQ音乐', /QQ音乐/.test(before.title ?? ''), JSON.stringify(before.title))
    record('默认为未绑定', before.hint === '未绑定', JSON.stringify(before.hint))
    record('提供扫码绑定', before.button === '扫码绑定', JSON.stringify(before.button))
    record('未绑定时不显示二维码', before.hasQR === false)

    // 点绑定 → QQ 的二维码图片（ptqrshow 返回的 PNG，data URL 直接显示）
    await cdpEval(
      `(() => {
        const group = [...document.querySelectorAll('.settings__group')].find((node) => (node.querySelector('h2')?.textContent ?? '').trim() === '音源账号')
        const button = group.querySelector('.settings__row-control .button')
        button.click()
        return true
      })()`
    )
    const qrShown = await waitFor(
      `(() => {
        const image = document.querySelector('.source-bind img')
        return Boolean(image && image.complete && image.naturalWidth > 0)
      })()`,
      25_000,
      'QQ 二维码图片加载完成'
    )
    const bound = await sourceSnapshot()
    record('点绑定后出现二维码图片', qrShown, `src=${bound.imageSrc}`)
    record('二维码是 PNG data URL', (bound.imageSrc ?? '').startsWith('data:image/png'), String(bound.imageSrc))
    record('状态文案是请使用 QQ 扫码', bound.status === '请使用 QQ 扫码', JSON.stringify(bound.status))
    record('已进入绑定态', bound.hasQR === true)

    // 离开设置页再回来：不崩、仍是未绑定
    record('侧栏回到首页', await clickSidebar('首页'))
    await wait(1200)
    record('侧栏再次进入设置页', await clickSidebar('设置'))
    const again = await waitFor(`Boolean(document.querySelector('.source-account-title'))`, 15_000, '音源账号重新出现')
    const after = await sourceSnapshot()
    record('切走再回来不崩且未绑定', again && after.hint === '未绑定', `hint=${JSON.stringify(after.hint)}`)
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
