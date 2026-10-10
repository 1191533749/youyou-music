/**
 * 9 项优化验收截图：深色液态纯黑 + 皮肤选择器 + 搜索页头像墙 + 全屏播放页卡拉OK。
 * 用途：给用户看效果（lead 自查视觉 + 交付截图）。
 * 前置：electron-vite build 已完成（页面从 out/ 加载）。
 * 隔离：真实配置复制到 %TEMP%\youyou-shot-test（只读使用，不写回真实配置），
 *       跑完 taskkill + 删临时目录。弹窗 watchdog 自动点掉（兑现「自己点弹窗」承诺）。
 * 用法：node scripts/shot-ui.mjs [输出目录，默认 shots-9items]
 */
import { spawn, execSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.argv[2] ?? join(ROOT, 'shots-9items')
const PORT = 9349
const CDP_BASE = `http://127.0.0.1:${PORT}`
const PROFILE_SRC = join(process.env.APPDATA ?? '', 'youyou-music')
const PROFILE_TMP = join(os.tmpdir(), 'youyou-shot-test')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, ...opts, stdio: 'inherit' })
    p.on('exit', (code) => resolve(code ?? 1))
  })
}

// ---------- CDP 客户端（原生 http + ws 不引依赖：用 JSON over /json + Runtime.evaluate） ----------
async function fetchJSON(url, opts) {
  const res = await fetch(url, opts)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

async function waitCDP(timeoutMs = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const tabs = await fetchJSON(`${CDP_BASE}/json`)
      if (Array.isArray(tabs) && tabs.length > 0) return tabs
    } catch { /* retry */ }
    await sleep(400)
  }
  throw new Error('CDP 未就绪')
}

// 页面级 evaluate：通过 /json 拿 webSocketDebuggerUrl 裸连 WebSocket（Node 22 内置 WebSocket）
async function connectPage() {
  const tabs = await waitCDP()
  const page = tabs.find((t) => t.type === 'page') ?? tabs[0]
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
  }
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP 调用超时: ${method}`))
      }, 15000)
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) }
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  ws.onclose = () => {
    for (const { reject } of pending.values()) reject(new Error('CDP 连接已断开'))
    pending.clear()
  }
  return { ws, call }
}

async function evaluate(call, expression) {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(`页面异常: ${JSON.stringify(r.exceptionDetails)}`)
  return r.result.value
}

async function capture(call, file) {
  const shot = await call('Page.captureScreenshot', { format: 'png' })
  const buf = Buffer.from(shot.data, 'base64')
  const dest = join(OUT, file)
  // 不引依赖，直接写盘（Buffer 是 node 内置）
  const { writeFileSync } = await import('node:fs')
  writeFileSync(dest, buf)
  return dest
}

async function main() {
  // 1. 准备隔离配置（真实 cookie，读-only 用途）
  rmSync(PROFILE_TMP, { recursive: true, force: true })
  mkdirSync(PROFILE_TMP, { recursive: true })
  if (existsSync(PROFILE_SRC)) {
    for (const name of readdirSync(PROFILE_SRC)) {
      const src = join(PROFILE_SRC, name)
      const st = statSync(src)
      if (st.isDirectory()) continue // 跳过 Chromium 缓存目录
      copyFileSync(src, join(PROFILE_TMP, name))
    }
  }
  mkdirSync(OUT, { recursive: true })

  // 2. 起实例
  const env = { ...process.env, YOYOU_USER_DATA: PROFILE_TMP }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(
    join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ['.', `--remote-debugging-port=${PORT}`],
    {
      cwd: ROOT,
      env,
      stdio: 'ignore',
      windowsHide: true
    }
  )
  const pid = child.pid
  // 硬性总超时：任何一步卡住都强制收尾退出（不留下孤儿实例）。
  const hardExit = setTimeout(() => {
    console.error('SHOT-UI TIMEOUT：240s 未完成，强制收尾')
    try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch {}
    try { rmSync(PROFILE_TMP, { recursive: true, force: true }) } catch {}
    process.exit(2)
  }, 240000)
  try {
    await sleep(4000)
    const { ws, call } = await connectPage()
    await call('Page.enable')
    await call('Runtime.enable')

    // watchdog：自动点掉一切弹窗按钮
    const watchdog = setInterval(() => {
      evaluate(call, `(() => {
        for (const label of ['确定','知道了','关闭','取消','重试','稍后','好的','知道了，不再提示']) {
          const el = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label && b.offsetParent !== null)
          if (el) { el.click(); return label }
        }
        return null
      })()`).catch(() => {})
    }, 2500)

    // 3. 设置页：皮肤选择器（默认皮肤 + 深色）
    console.log('[shot] 进入设置页')
    await evaluate(call, `(() => {
      const item = [...document.querySelectorAll('.sidebar__link')]
        .find((b) => (b.textContent ?? '').includes('设置'))
      item?.click()
      return !!item
    })()`)
    await sleep(2500)
    await capture(call, '01-settings-skins.png')
    console.log('[shot] 01 完成')

    // 深色主题（主题是 select，不是按钮：选「深色」并确认生效）
    const darkOk = await evaluate(call, `(() => {
      const select = document.querySelector('select option[value="dark"]')?.closest('select')
      if (!select) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
      setter.call(select, 'dark')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await sleep(2000)
    const darkOn = await evaluate(call, `document.documentElement.dataset.theme === 'dark'`)
    if (!darkOk || !darkOn) throw new Error(`深色主题未生效（select=${darkOk} data-theme=${darkOn}）`)
    await capture(call, '02-settings-dark.png')
    console.log('[shot] 02 完成')

    // 切皮肤 qqmusic
    await evaluate(call, `(() => {
      const sw = document.querySelector('[data-skin="qqmusic"], .skin-swatch[data-skin="qqmusic"]')
      if (sw) sw.click()
      return !!sw
    })()`)
    await sleep(1200)
    await capture(call, '03-settings-skin-qqmusic.png')
    console.log('[shot] 03 完成')

    // 4. 搜索页头像墙
    await evaluate(call, `(() => {
      const item = [...document.querySelectorAll('.sidebar__link')]
        .find((b) => (b.textContent ?? '').includes('搜索'))
      item?.click()
      return !!item
    })()`)
    await sleep(2500)
    await capture(call, '04-search-wall.png')
    console.log('[shot] 04 完成')

    // 5. 全屏播放页卡拉OK：从搜索页搜一首带歌词的歌播放
    console.log('[shot] 搜索 晴天 周杰伦')
    await evaluate(call, `(() => {
      const input = document.querySelector('.search-hero__input, .search-hero input')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '晴天 周杰伦')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    // React 状态更新是异步的：先等 value 落进 state，再按 Enter 提交。
    await sleep(400)
    await evaluate(call, `(() => {
      const input = document.querySelector('.search-hero__input, .search-hero input')
      if (!input) return false
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)
    // 结果可能要兜底站外源，轮询等第一行出现；优先网易云行（才有歌词，KTV 截图需要）。
    let clicked = false
    for (let attempt = 0; attempt < 20 && !clicked; attempt += 1) {
      await sleep(1500)
      clicked = await evaluate(call, `(() => {
        const rows = [...document.querySelectorAll('.song-row:not(.song-row--external)')]
        const first = rows.find((r) => r.offsetParent !== null)
        if (!first) return false
        first.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        return true
      })()`)
      if (!clicked) console.log(`[shot] 结果未出，第 ${attempt + 1} 次等待`)
    }
    if (!clicked) throw new Error('搜索结果没点到（跳过全屏页截图）')
    await sleep(6000)
    // 打开全屏播放页（播放条封面按钮）
    await evaluate(call, `(() => {
      const btn = document.querySelector('.player-bar__art')
      if (!btn) return false
      btn.click()
      return true
    })()`)
    // 等歌词加载（走网络，限流时更慢）
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const lyrics = await evaluate(call, `document.querySelectorAll('.np-lyric').length`)
      if (lyrics > 0) break
      await sleep(2000)
    }
    await sleep(2500)
    await capture(call, '05-nowplaying-ktv.png')
    console.log('[shot] 05 完成')

    clearInterval(watchdog)
    ws.close()
    console.log(`SHOT-UI OK → ${OUT}`)
  } finally {
    clearTimeout(hardExit)
    try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch {}
    await sleep(500)
    rmSync(PROFILE_TMP, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(`SHOT-UI FAIL: ${err.message}`)
  process.exit(1)
})
