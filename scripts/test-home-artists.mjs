/**
 * 取证「首页歌手图片加载不出来」：隔离实例 + 真实登录 cookie，进首页，
 * 统计「热门歌手」rail 里每张卡是 <img>（已载入/未载入）还是 placeholder，
 * 并截图。用来区分「数据缺字段 / CDN 拦截 / 懒加载没触发 / onError 粘性破图」。
 *
 * 用法：npx electron-vite build 之后 node scripts/test-home-artists.mjs
 */
import { spawn, execSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9361
const userData = path.join(os.tmpdir(), 'youyou-home-artists-test')
const shotsDir = path.join(os.tmpdir(), 'shots-home-artists')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[home-artists] ${message}`)

async function cdp(expression) {
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
      if (message.id === id) {
        ws.removeEventListener('message', onMessage)
        resolve(message.result?.result?.value)
      }
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
  })
  ws.close()
  return value
}

async function cdpAsync(expression) {
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
      if (message.id === id) {
        ws.removeEventListener('message', onMessage)
        resolve(message.result?.result?.value)
      }
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
  ws.close()
  return value
}

async function screenshot(name) {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
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
      if (message.id === id) {
        ws.removeEventListener('message', onMessage)
        resolve(message.result?.data)
      }
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } }))
  })
  ws.close()
  fs.writeFileSync(path.join(shotsDir, name), Buffer.from(data, 'base64'))
  log(`截图 ${name}`)
}

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.rmSync(shotsDir, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(shotsDir, { recursive: true })

  // 复制真实登录 cookie + 设置，让首页 feed/热歌与用户一致。
  const real = path.join(process.env.APPDATA, 'youyou-music')
  for (const name of ['cookies.json', 'settings.json']) {
    const from = path.join(real, name)
    const to = path.join(userData, name)
    if (fs.existsSync(from)) fs.copyFileSync(from, to)
  }

  const env = { ...process.env, YOYOU_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    stdio: 'ignore',
    env,
    cwd: root,
    detached: true
  })
  child.unref()
  log(`dev 实例 PID=${child.pid}`)

  try {
    let ready = false
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await wait(1500)
      try {
        if (await cdp(`Boolean(document.querySelector('.home-rail--artists'))`)) {
          ready = true
          break
        }
      } catch {
        /* 还没起来 */
      }
    }
    if (!ready) {
      record('热门歌手 rail 出现', false, '24 次轮询未出现')
      return
    }
    await wait(8000) // 等图片载入（eager 后 14 张同时起拉，给 CDN 多点时间）

    await screenshot('01-home.png')

    const cards = await cdp(`(() => {
      const rail = document.querySelector('.home-rail--artists')
      const children = [...rail.children]
      return {
        count: children.length,
        railWidth: rail.scrollWidth,
        clientWidth: rail.clientWidth,
        items: children.map((el) => {
          const img = el.querySelector('img')
          const ph = el.querySelector('.card__placeholder')
          return {
            title: el.querySelector('.card__title')?.textContent ?? '',
            hasImg: !!img,
            hasPlaceholder: !!ph,
            src: img?.getAttribute('src') ?? null,
            naturalWidth: img?.naturalWidth ?? 0,
            complete: img?.complete ?? false,
            loading: img?.getAttribute('loading') ?? null
          }
        })
      }
    })()`)

    record('热门歌手 rail 存在', true, `卡数=${cards.count}`)
    log(`rail 尺寸 scroll=${cards.railWidth} client=${cards.clientWidth}`)
    const imgs = cards.items.filter((i) => i.hasImg)
    const loaded = cards.items.filter((i) => i.hasImg && i.naturalWidth > 0)
    const placeholders = cards.items.filter((i) => i.hasPlaceholder)
    for (const item of cards.items) {
      const state = item.hasImg
        ? item.naturalWidth > 0
          ? `IMG已载入(${item.naturalWidth})`
          : 'IMG未载入(naturalWidth=0)'
        : 'PLACEHOLDER'
      log(`  ${item.title || '(无标题)'} ${state} complete=${item.complete} loading=${item.loading} src=${item.src?.slice(0, 70) ?? '-'}`)
    }
    record('所有歌手卡都有 <img>', imgs.length === cards.count, `${imgs.length}/${cards.count}`)
    const eagerCount = cards.items.filter((i) => i.loading === 'eager').length
    record('所有歌手图都是 eager 加载', eagerCount === cards.count, `${eagerCount}/${cards.count} eager`)
    record('全部歌手图已载入', loaded.length === cards.count, `${loaded.length}/${cards.count} 占位=${placeholders.length}`)

    // 对未载入的 img 强制用 new Image() 拉一次，区分「懒加载没触发」vs「网络真失败」。
    const stuckSrcs = cards.items.filter((i) => i.hasImg && i.naturalWidth === 0).map((i) => i.src)
    if (stuckSrcs.length > 0) {
      const forced = await cdpAsync(`(async () => {
        const out = []
        for (const src of ${JSON.stringify(stuckSrcs)}) {
          const r = await new Promise((resolve) => {
            const im = new Image()
            let done = false
            const finish = (v) => { if (!done) { done = true; resolve(v) } }
            im.onload = () => finish('onload')
            im.onerror = () => finish('onerror')
            im.src = src
            setTimeout(() => finish('timeout'), 5000)
          })
          out.push({ src: src.slice(0, 70), result: r })
        }
        return out
      })()`)
      for (const item of forced) log(`  强制加载 ${item.src}… → ${item.result}`)
      const allForcedOk = forced.every((i) => i.result === 'onload')
      record('未载入的图强制 new Image() 能载入', allForcedOk, JSON.stringify(forced.map((i) => i.result)))
    }

    // 横向滚动到底再取一次：验证懒加载是否在滚动后才补载。
    await cdp(`(() => { const rail = document.querySelector('.home-rail--artists'); rail.scrollLeft = rail.scrollWidth; return true })()`)
    await wait(2500)
    const afterScroll = await cdp(`(() => {
      const rail = document.querySelector('.home-rail--artists')
      return [...rail.children].map((el) => {
        const img = el.querySelector('img')
        return img ? img.naturalWidth > 0 : false
      })
    })()`)
    const loadedAfter = afterScroll.filter(Boolean).length
    log(`滚动后已载入 ${loadedAfter}/${cards.count}`)
    await screenshot('02-home-scrolled.png')
  } catch (cause) {
    record('测试执行异常', false, String(cause).slice(0, 200))
  } finally {
    try {
      execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--remote-debugging-port=${CDP_PORT}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'ignore' }
      )
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((item) => !item.ok)
  log(failed.length === 0 ? 'HOME-ARTISTS OK' : `HOME-ARTISTS FAILED (${failed.length}/${results.length})`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((cause) => {
  console.error(`[home-artists] 失败: ${cause}`)
  process.exit(1)
})
