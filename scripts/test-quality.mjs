/**
 * 验证「切换音质」：
 *   ① 底部播放条换档（player:setQuality）后，实际生效的档位必须跟着变
 *      （修之前会复用上一次解析好的旧音源，servedQuality 不变 → 下拉框弹回原值）
 *   ② 设置里改默认音质（settings:update）也要作用到当前这首歌
 *   ③ 换档期间必须继续播放，位置不能回到 0
 *   ④ 用 mpv 报出的真实码率交叉验证音质真的换了
 *
 * 用法：npx electron-vite build 之后 node scripts/test-quality.mjs
 */
import { spawn, execSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9368
const userData = path.join(os.tmpdir(), 'youyou-quality-test')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[quality] ${message}`)

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function cdpEval(expression, awaitPromise = true) {
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

/** 当前播放状态 + mpv 真实码率。 */
function snapshot() {
  return cdpEval(
    `(async () => {
      const st = await window.youyou.invoke('player:state')
      let info = null
      try { const r = await window.youyou.invoke('player:trackInfo'); info = r.ok ? r.data : null } catch { info = null }
      const s = st.data ?? {}
      return {
        ok: st.ok,
        quality: s.quality ?? null,
        served: s.servedQuality ?? null,
        servedFrom: s.servedFrom ?? null,
        playing: s.playing ?? false,
        loading: s.loading ?? false,
        position: s.position ?? 0,
        track: s.track?.name ?? null,
        bitrate: info?.bitrate ?? null
      }
    })()`
  )
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

    // 起播一首（用漫游池里的歌，官方源优先）
    const started = await cdpEval(
      `(async () => {
        const fm = await window.youyou.invoke('track:fm')
        if (!fm.ok || !fm.data?.length) return { error: 'track:fm 无数据' }
        await window.youyou.invoke('player:playTracks', { tracks: fm.data, startIndex: 0 })
        return { count: fm.data.length }
      })()`
    )
    log(`起播: ${JSON.stringify(started)}`)

    let base = null
    for (let i = 0; i < 40; i += 1) {
      await wait(500)
      const snap = await snapshot()
      if (snap?.playing && snap.track) {
        base = snap
        break
      }
    }
    if (!base) {
      record('起播成功', false, '30 秒内没进入播放')
      return
    }
    log(`起播状态: ${JSON.stringify(base)}`)
    record('起播成功', true, `${base.track} served=${base.served} bitrate=${base.bitrate}`)

    // ---- ① 播放条换档：先切到 exhigh，再切到 standard ----
    await cdpEval(`window.youyou.invoke('player:setQuality', { quality: 'exhigh' })`)
    await wait(4000)
    const high = await snapshot()
    log(`切到 exhigh 后: ${JSON.stringify(high)}`)

    const beforeSwitch = high
    await cdpEval(`window.youyou.invoke('player:setQuality', { quality: 'standard' })`)
    await wait(4000)
    const low = await snapshot()
    log(`切到 standard 后: ${JSON.stringify(low)}`)

    record('换档后设置里的首选音质 = standard', low?.quality === 'standard', `quality=${low?.quality}`)
    record('换档后实际生效档位 = standard', low?.served === 'standard', `served=${low?.served}（切换前 ${beforeSwitch?.served}）`)
    record('换档后仍在播放', low?.playing === true, `playing=${low?.playing}`)
    record(
      '换档没有把播放位置重置到开头',
      (low?.position ?? 0) > 0 && (low?.position ?? 0) >= (beforeSwitch?.position ?? 0),
      `切换前 ${beforeSwitch?.position?.toFixed?.(1) ?? beforeSwitch?.position}s → 切换后 ${low?.position?.toFixed?.(1) ?? low?.position}s`
    )
    if (beforeSwitch?.served && beforeSwitch.served !== 'standard') {
      record('档位确实发生了变化（不是复用旧音源）', low?.served !== beforeSwitch.served, `${beforeSwitch.served} → ${low?.served}`)
    } else {
      log('（跳过档位对比）这首歌最高只到标准音质，切换前后都是 standard')
    }
    if (beforeSwitch?.bitrate && low?.bitrate) {
      record('mpv 真实码率跟着降下来', low.bitrate < beforeSwitch.bitrate, `${beforeSwitch.bitrate} → ${low.bitrate}`)
    } else {
      log(`（跳过码率对比）before=${beforeSwitch?.bitrate} after=${low?.bitrate}`)
    }

    // ---- ② 设置页改默认音质也要作用到当前这首歌 ----
    await cdpEval(`window.youyou.invoke('settings:update', { quality: 'exhigh' })`)
    await wait(4000)
    const back = await snapshot()
    log(`设置里改成 exhigh 后: ${JSON.stringify(back)}`)
    record('设置页改音质后首选 = exhigh', back?.quality === 'exhigh', `quality=${back?.quality}`)
    record('设置页改音质作用到了当前这首歌', back?.served !== low?.served || back?.bitrate !== low?.bitrate, `${low?.served}/${low?.bitrate} → ${back?.served}/${back?.bitrate}`)
    record('设置页改音质后仍在播放', back?.playing === true, `playing=${back?.playing}`)
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
  log(failed.length === 0 ? 'QUALITY OK' : `QUALITY FAILED (${failed.length}/${results.length})`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((cause) => {
  console.error('[quality] 失败:', cause)
  process.exit(1)
})
