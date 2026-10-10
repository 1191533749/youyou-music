/**
 * 性能取证：① 首页图片资源的加载耗时（区分 DNS/连接排队 vs 单图慢）；
 * ② 私人漫游 track:fm 的耗时与批次规模；③ playTracks 的耗时构成；
 * ④ 从点击「私人漫游」到真正出声的时间线。
 *
 * 用法：npx electron-vite build 之后 node scripts/probe-perf.mjs
 */
import { spawn, execSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9364
const userData = path.join(os.tmpdir(), 'youyou-probe-perf')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[perf] ${message}`)

async function cdpEval(expression, awaitPromise = false) {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  const page = targets.find((target) => target.type === 'page')
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

async function main() {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
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
    for (let attempt = 0; attempt < 24; attempt += 1) {
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
      log('首页未就绪')
      return
    }
    await wait(6000)

    // ---- ① 首页图片资源 ----
    const images = await cdpEval(`(() => {
      const entries = performance.getEntriesByType('resource').filter((e) => /126\\.net|kuwo|kugou/.test(e.name))
      const byHost = {}
      for (const e of entries) { const h = new URL(e.name).host; byHost[h] = (byHost[h] || 0) + 1 }
      const summarize = (list) => list.map((e) => ({
        host: new URL(e.name).host,
        param: (e.name.match(/param=[^&]*/) || ['(原图)'])[0],
        start: Math.round(e.startTime),
        dur: Math.round(e.duration),
        size: e.transferSize,
        decoded: e.decodedBodySize
      }))
      return {
        total: entries.length,
        byHost,
        first20: summarize(entries.slice(0, 20)),
        slowest12: summarize([...entries].sort((a, b) => b.duration - a.duration).slice(0, 12)),
        avgDur: Math.round(entries.reduce((sum, e) => sum + e.duration, 0) / Math.max(1, entries.length))
      }
    })()`)
    log(`首页图片资源 total=${images.total} avg=${images.avgDur}ms byHost=${JSON.stringify(images.byHost)}`)
    for (const item of images.first20) {
      log(`  [${item.start}ms +${item.dur}ms] ${item.host} ${item.param} size=${item.size} decoded=${item.decoded}`)
    }
    log('最慢 12 张:')
    for (const item of images.slowest12) log(`  [${item.start}ms +${item.dur}ms] ${item.host} ${item.param} size=${item.size}`)

    // ---- ② track:fm 单独计时 ----
    const fm = await cdpEval(
      `(async () => { const t = performance.now(); const r = await window.youyou.invoke('track:fm'); return { ms: Math.round(performance.now() - t), ok: r.ok, n: r.data?.length ?? 0, error: r.error ?? null } })()`,
      true
    )
    log(`track:fm → ${JSON.stringify(fm)}`)

    if (fm.ok && fm.n > 0) {
      // ---- ③ playTracks 计时 ----
      const play = await cdpEval(
        `(async () => {
          const t = performance.now()
          const r = await window.youyou.invoke('track:fm')
          const t2 = performance.now()
          const p = await window.youyou.invoke('player:playTracks', { tracks: r.data, startIndex: 0 })
          return {
            fmMs: Math.round(t2 - t),
            fmCount: r.data?.length ?? 0,
            playMs: Math.round(performance.now() - t2),
            playOk: p.ok,
            track: p.data?.track?.name ?? null,
            source: p.data?.track ? 'ok' : 'none',
            loading: p.data?.loading,
            playing: p.data?.playing
          }
        })()`,
        true
      )
      log(`playTracks 计时 → ${JSON.stringify(play)}`)
    }

    // ---- ④ 点击「私人漫游」到出声 ----
    const clicked = await cdpEval(
      `(() => {
        const link = [...document.querySelectorAll('.sidebar__link')].find((b) => (b.textContent ?? '').includes('私人漫游'))
        if (!link) return false
        link.click()
        window.__fmT0 = performance.now()
        return true
      })()`
    )
    if (!clicked) {
      log('未找到私人漫游入口')
      return
    }
    const timeline = []
    let placeholderFirstSeen = undefined
    let placeholderGoneAt = undefined
    let trackAt = undefined
    let playingAt = undefined
    let loadingSeen = false
    for (let i = 0; i < 120; i += 1) {
      const snap = await cdpEval(
        `(async () => {
          const st = await window.youyou.invoke('player:state')
          const ph = document.querySelector('.fm .placeholder')
          return {
            ms: Math.round(performance.now() - window.__fmT0),
            placeholder: ph ? (ph.textContent ?? '').trim().slice(0, 24) : '',
            title: (document.querySelector('.fm__title')?.textContent ?? '').trim(),
            track: st.data?.track?.name ?? null,
            playing: st.data?.playing ?? false,
            loading: st.data?.loading ?? false
          }
        })()`,
        true
      )
      const ms = snap?.ms ?? i * 200
      if (snap?.placeholder) {
        if (placeholderFirstSeen === undefined) placeholderFirstSeen = ms
        if (placeholderGoneAt !== undefined) placeholderGoneAt = undefined
      } else if (placeholderFirstSeen !== undefined && placeholderGoneAt === undefined) {
        placeholderGoneAt = ms
        timeline.push({ at: ms, event: '占位消失' })
      }
      if (snap?.track && trackAt === undefined) {
        trackAt = ms
        timeline.push({ at: ms, event: `曲目出现：${snap.track}` })
      }
      if (snap?.playing) {
        if (playingAt === undefined) {
          playingAt = ms
          timeline.push({ at: ms, event: '开始播放' })
        }
        break
      }
      if (snap?.loading) loadingSeen = true
      await wait(200)
    }
    log(`点击时间线: ${JSON.stringify(timeline)}`)
    log(`占位首现=${placeholderFirstSeen ?? '-'}ms 占位消失=${placeholderGoneAt ?? '-'}ms 曲目=${trackAt ?? '-'}ms 出声=${playingAt ?? '-'}ms loadingSeen=${loadingSeen}`)
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
}

main().catch((cause) => {
  console.error('[perf] 失败:', cause)
  process.exit(1)
})
