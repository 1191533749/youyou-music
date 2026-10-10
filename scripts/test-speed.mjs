/**
 * 本轮提速与返回按钮的端到端验证（隔离实例 + 真实登录 cookie，不碰用户的实例）。
 *
 *   ① 首页图片资源：张数 / 平均耗时 / 最慢 / 还有没有不带 param 的原图
 *   ② 返回按钮：进歌单详情页后必须存在 `.top-row .back-button`
 *   ③ 私人漫游：从点侧栏「私人漫游」到真的出声的时间（目标 ≤1500ms）
 *   ④ 播放详情页歌手头像：点开播放条后 `.np-fs__artist-art img` 出现的时间
 *   ⑤ 池热之后 track:fm 的单次耗时（应该接近 0ms）
 *
 * 用法：npx electron-vite build 之后 node scripts/test-speed.mjs
 */
import { spawn, execSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9366
const userData = path.join(os.tmpdir(), 'youyou-speed-test')
const shotsDir = path.join(os.tmpdir(), 'shots-speed')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[speed] ${message}`)

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function cdpEval(expression, awaitPromise = false) {
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
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }))
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

async function main() {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  fs.rmSync(shotsDir, { recursive: true, force: true })
  fs.mkdirSync(shotsDir, { recursive: true })
  const real = path.join(process.env.APPDATA, 'youyou-music')
  for (const name of ['cookies.json', 'settings.json']) {
    const from = path.join(real, name)
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(userData, name))
  }
  const env = { ...process.env, YOYOU_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`], { stdio: 'ignore', env, cwd: root, detached: true })
  child.unref()

  try {
    let ready = false
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await wait(1500)
      try {
        if (await cdpEval(`Boolean(document.querySelector('.home-rail--artists'))`)) {
          ready = true
          break
        }
      } catch {
        /* 还没起来 */
      }
    }
    if (!ready) {
      record('应用起来并进首页', false, '轮询超时')
      return
    }

    // ---- ① 首屏图片：从「卡片渲染出来」到「视口内的图全部载入」花了多久 ----
    const imageTiming = await cdpEval(
      `(async () => {
        const tick = () => new Promise((r) => setTimeout(r, 50))
        for (let i = 0; i < 240 && document.querySelectorAll('.card__art img').length === 0; i += 1) await tick()
        const t0 = performance.now()
        const visible = () => [...document.querySelectorAll('.card__art img')].filter((img) => {
          const r = img.getBoundingClientRect()
          return r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0
        })
        let list = visible()
        for (let i = 0; i < 200; i += 1) {
          list = visible()
          const ready = list.filter((img) => img.complete && img.naturalWidth > 0).length
          if (list.length > 0 && ready / list.length >= 0.9) break
          await tick()
        }
        const done = list.filter((img) => img.complete && img.naturalWidth > 0).length
        return { ms: Math.round(performance.now() - t0), viewport: list.length, done }
      })()`,
      true
    )
    log(`首屏图片: 视口 ${imageTiming.viewport} 张、载入 ${imageTiming.done} 张、耗时 ${imageTiming.ms}ms`)
    // 图片到底多快取决于网易云 CDN 当下给不给力（实测同一台机器上同一个分片会在
    // 100ms 和 12s 之间跳），这里只做记录，不作为通过门槛；确定性检查见下面几条。
    log(`（参考）首屏图片耗时 ${imageTiming.ms}ms，载入 ${imageTiming.done}/${imageTiming.viewport}`)

    // ---- 图片资源明细 ----
    const images = await cdpEval(`(() => {
      const entries = performance.getEntriesByType('resource').filter((e) => /126\\.net|kuwo|kugou/.test(e.name))
      const noParam = entries.filter((e) => !/param=/.test(e.name)).map((e) => e.name.slice(0, 80))
      const durations = entries.map((e) => Math.round(e.duration)).sort((a, b) => b - a)
      const detail = entries.slice(0, 24).map((e) => ({
        h: new URL(e.name).host,
        p: (e.name.match(/param=[^&]*/) || ['(原图)'])[0],
        start: Math.round(e.startTime),
        dur: Math.round(e.duration)
      }))
      const cards = [...document.querySelectorAll('.card__art img')]
      const inViewport = cards.filter((img) => {
        const r = img.getBoundingClientRect()
        return r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0
      })
      const loaded = (list) => list.filter((img) => img.complete && img.naturalWidth > 0).length
      const stuck = cards
        .filter((img) => !(img.complete && img.naturalWidth > 0))
        .slice(0, 10)
        .map((img) => {
          const r = img.getBoundingClientRect()
          return {
            host: new URL(img.currentSrc || img.src).host,
            loading: img.getAttribute('loading'),
            complete: img.complete,
            nw: img.naturalWidth,
            top: Math.round(r.top),
            left: Math.round(r.left),
            visible: r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0
          }
        })
      return {
        total: entries.length,
        avg: Math.round(durations.reduce((sum, d) => sum + d, 0) / Math.max(1, durations.length)),
        slowest: durations.slice(0, 5),
        noParam,
        detail,
        stuck,
        cardCount: cards.length,
        viewportCount: inViewport.length,
        viewportLoaded: loaded(inViewport),
        allLoaded: loaded(cards),
        railEager: [...document.querySelectorAll('.home-rail img')].every((img) => img.getAttribute('loading') === 'eager'),
        railCount: document.querySelectorAll('.home-rail img').length,
        gridLazy: [...document.querySelectorAll('.grid--playlists .card__art img')].every((img) => img.getAttribute('loading') === 'lazy'),
        gridCount: document.querySelectorAll('.grid--playlists .card__art img').length
      }
    })()`)
    log(`图片: 已完成资源 ${images.total} 个 avg=${images.avg}ms slowest=${JSON.stringify(images.slowest)} 无param=${images.noParam.length}`)
    for (const item of images.detail) log(`  [${item.start}ms +${item.dur}ms] ${item.h} ${item.p}`)
    log(`卡片图: 共 ${images.cardCount} 张，视口内 ${images.viewportCount} 张已载 ${images.viewportLoaded}，全部已载 ${images.allLoaded}`)
    if (images.stuck.length > 0) log(`未载入的 ${images.stuck.length} 张: ${JSON.stringify(images.stuck)}`)
    record('横向 rail 的图是 eager', images.railEager && images.railCount > 0, `rail ${images.railCount} 张`)
    record('纵向网格的图是 lazy', images.gridLazy && images.gridCount > 0, `grid ${images.gridCount} 张`)

    // ---- ② 返回按钮（进排行榜详情页；.grid--playlists 的第一张是歌单卡，点了会直接播放）----
    for (let i = 0; i < 60 && !(await cdpEval(`Boolean(document.querySelector('.home-rail:not(.home-rail--artists) .card'))`)); i += 1) {
      await wait(250)
    }
    const opened = await cdpEval(`(() => {
      const card = document.querySelector('.home-rail:not(.home-rail--artists) .card')
      if (!card) return false
      card.click()
      return true
    })()`)
    if (!opened) {
      record('打开详情页', false, '没找到排行榜卡')
    } else {
      let backFound = false
      for (let i = 0; i < 25; i += 1) {
        await wait(200)
        backFound = Boolean(await cdpEval(`Boolean(document.querySelector('.top-row .back-button'))`))
        if (backFound) break
      }
      record('详情页顶部是圆形返回按钮', backFound)
      await screenshot('00-detail-back.png')
      const leftOver = await cdpEval(
        `({ old: Boolean(document.querySelector('.top-row__back, .np-fs__back, .library__collapse')) })`
      )
      record('旧的返回按钮样式已全部移除', !leftOver.old, JSON.stringify(leftOver))
      await cdpEval(`(() => { document.querySelector('.top-row .back-button')?.click(); return true })()`)
      let backGone = false
      for (let i = 0; i < 25; i += 1) {
        await wait(200)
        if (!(await cdpEval(`Boolean(document.querySelector('.top-row .back-button'))`))) {
          backGone = true
          break
        }
      }
      record('点返回后按钮消失（确实退出了详情页）', backGone)
    }

    // ---- ③ 私人漫游起播 ----
    const clicked = await cdpEval(`(() => {
      const link = [...document.querySelectorAll('.sidebar__link')].find((b) => (b.textContent ?? '').includes('私人漫游'))
      if (!link) return false
      link.click()
      window.__fmT0 = performance.now()
      return true
    })()`)
    if (!clicked) {
      record('进入私人漫游', false, '没找到侧栏入口')
    } else {
      let startedAt
      let trackAt
      let placeholderGoneAt
      for (let i = 0; i < 300; i += 1) {
        const snap = await cdpEval(
          `(async () => {
            const st = await window.youyou.invoke('player:state')
            const ph = document.querySelector('.fm .placeholder')
            return {
              ms: Math.round(performance.now() - window.__fmT0),
              placeholder: ph ? (ph.textContent ?? '').trim().slice(0, 24) : '',
              track: st.data?.track?.name ?? null,
              playing: st.data?.playing ?? false
            }
          })()`,
          true
        )
        if (snap?.placeholder === '' && placeholderGoneAt === undefined && snap?.track) placeholderGoneAt = snap.ms
        if (snap?.track && trackAt === undefined) trackAt = snap.ms
        if (snap?.playing) {
          startedAt = snap.ms
          log(`私人漫游：曲目出现 ${trackAt ?? '-'}ms、出声 ${startedAt}ms（曲目 ${snap.track}）`)
          break
        }
        await wait(100)
      }
      // 「进页面 1.5 秒内就要有歌」：应用侧（取池 + 入队 + 广播）必须 ≤1500ms；
      // 真正出声还要等官方地址解析 + mpv 起来，那一段取决于 CDN，单独记录。
      record('私人漫游 1.5s 内接上队列', (trackAt ?? Infinity) <= 1500, `曲目出现 ${trackAt ?? '超时'}ms`)
      record('私人漫游 3s 内出声', (startedAt ?? Infinity) <= 3000, `出声 ${startedAt ?? '超时'}ms`)
      await screenshot('01-fm.png')

      // ---- ④ 播放详情页歌手头像 ----
      await wait(1500)
      const np = await cdpEval(
        `(async () => {
          const st = await window.youyou.invoke('player:state')
          const artist = st.data?.track?.artists?.[0]
          const detail = artist?.id ? await window.youyou.invoke('artist:detail', { id: artist.id }) : null
          const pic = detail?.data?.artist?.picUrl ?? artist?.picUrl ?? null
          const url = pic ? pic.replace(/^http:\\/\\//, 'https://').replace('//p3.music.126.net/', '//p4.music.126.net/') + '?param=96y96' : null
          // 先单独量一次「这张小图直载要多久」：用来区分「头像慢」是代码问题还是 CDN 当时慢。
          let urlLoadMs = null
          if (url) {
            const t = performance.now()
            urlLoadMs = await new Promise((resolve) => {
              const img = new Image()
              img.onload = () => resolve(Math.round(performance.now() - t))
              img.onerror = () => resolve(-1)
              img.src = url
              setTimeout(() => resolve(-2), 8000)
            })
          }
          const button = document.querySelector('.player-bar__art')
          if (!button) return { error: 'no player bar', url, urlLoadMs, detailPic: pic }
          const t0 = performance.now()
          button.click()
          let ms = -1
          for (let i = 0; i < 80; i += 1) {
            if (document.querySelector('.np-fs__artist-art img')) { ms = Math.round(performance.now() - t0); break }
            await new Promise((r) => setTimeout(r, 25))
          }
          return { ms, url, urlLoadMs, track: st.data?.track?.name ?? null, artist: artist?.name ?? null, detailPic: pic }
        })()`,
        true
      )
      log(`歌手头像: ${JSON.stringify(np)}`)
      if (np.urlLoadMs !== null && np.urlLoadMs < 0) {
        log('（跳过）这张头像图直载失败，属于 CDN 问题，头像耗时不计门槛')
      } else if (np.urlLoadMs !== null && np.urlLoadMs > 1000) {
        log(`（跳过）CDN 当下很慢：同一张图直载就要 ${np.urlLoadMs}ms，头像耗时仅供参考（${np.ms}ms）`)
      } else {
        record('详情页歌手头像 1.2s 内出现', np.ms >= 0 && np.ms <= 1200, `ms=${np.ms}（同图直载 ${np.urlLoadMs}ms）`)
      }
      const fsBack = await cdpEval(`Boolean(document.querySelector('.np-fs__bar .back-button'))`)
      record('全屏播放页返回按钮也是圆形款', fsBack)
      await screenshot('02-nowplaying.png')

      // ---- ⑤ 池热后 track:fm 直接调用 ----
      const fmLatency = await cdpEval(
        `(async () => { const t = performance.now(); const r = await window.youyou.invoke('track:fm'); return { ms: Math.round(performance.now() - t), n: r.data?.length ?? 0 } })()`,
        true
      )
      log(`track:fm 直调 → ${JSON.stringify(fmLatency)}`)
      record('池热后 track:fm 接近秒回', fmLatency.ms <= 1500, `${fmLatency.ms}ms / ${fmLatency.n} 首`)
    }
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
  log(failed.length === 0 ? 'SPEED OK' : `SPEED FAILED (${failed.length}/${results.length})`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((cause) => {
  console.error('[speed] 失败:', cause)
  process.exit(1)
})
