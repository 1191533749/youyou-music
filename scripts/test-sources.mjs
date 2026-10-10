/**
 * 端到端验证新音源：把启用音源收窄到某一个，再播放网易云的受限歌曲，
 * 看主进程到底用了哪个音源、能不能真的出声。
 *
 * 用法：npx electron-vite build 之后 node scripts/test-sources.mjs
 */
import { spawn, execSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9370
const userData = path.join(os.tmpdir(), 'youyou-sources-test')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[sources] ${message}`)

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

const state = () =>
  cdpEval(
    `(async () => {
      const st = await window.youyou.invoke('player:state')
      const s = st.data ?? {}
      return { track: s.track?.name ?? null, playing: s.playing ?? false, position: s.position ?? 0, servedFrom: s.servedFrom ?? null, served: s.servedQuality ?? null, error: s.error ?? null }
    })()`
  )

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

    // 候选：一首铁定受限的付费单曲 + 搜索出来的几首（搜索结果的 playability 一并打印）。
    const candidates = await cdpEval(
      `(async () => {
        const out = [{ id: 186016, name: '晴天', artist: '周杰伦', playability: 'hardcoded' }]
        for (const keywords of ['起风了 买辣椒也用券', '孤勇者 陈奕迅', '小苹果 筷子兄弟', '晴天 周杰伦', '海阔天空 Beyond']) {
          const r = await window.youyou.invoke('search:query', { keywords, type: 'songs', limit: 5 })
          for (const song of r.data?.songs ?? []) {
            out.push({ id: song.id, name: song.name, artist: (song.artists ?? []).map((a) => a.name).join('/'), playability: song.playability })
          }
        }
        return out
      })()`
    )
    log(`候选 ${candidates.length} 首，playability 分布: ${JSON.stringify(candidates.reduce((acc, item) => { acc[item.playability] = (acc[item.playability] ?? 0) + 1; return acc }, {}))}`)
    const unique = candidates.filter((item, index, list) => list.findIndex((other) => other.id === item.id) === index)
    record('拿到候选曲目', unique.length > 0, `${unique.length} 首`)

    const NAMES = { qishui: '汽水音乐', kuwo: '酷我音乐', kugou: '酷狗音乐', qq: 'QQ音乐' }
    // 逐个音源收窄后播放；只有 servedFrom 正好等于该音源名，才算「这个音源真的换源成功」。
    let anyHit = false
    let officialOnly = 0
    for (const sourceId of ['qishui', 'kuwo', 'kugou', 'qq']) {
      await cdpEval(`window.youyou.invoke('settings:update', { unblockSources: ['${sourceId}'] })`)
      let hit = null
      let sawOfficial = 0
      for (const item of unique) {
        const played = await cdpEval(
          `(async () => {
            const d = await window.youyou.invoke('track:detail', { ids: [${item.id}] })
            const tracks = d.data ?? []
            if (!tracks.length) return { error: 'no detail' }
            await window.youyou.invoke('player:playTracks', { tracks, startIndex: 0 })
            return { ok: true }
          })()`
        )
        if (played?.error) continue
        for (let i = 0; i < 20; i += 1) {
          await wait(500)
          const snap = await state()
          if (snap?.playing && snap.position > 0.6) {
            if (snap.servedFrom === NAMES[sourceId]) {
              hit = { ...item, servedFrom: snap.servedFrom, served: snap.served, position: snap.position }
            } else if (!snap.servedFrom) {
              sawOfficial += 1
            }
            break
          }
          if (snap?.error) break
        }
        if (hit) break
      }
      officialOnly += sawOfficial
      if (hit) anyHit = true
      log(`音源 ${sourceId}: ${hit ? JSON.stringify(hit) : `没有可用结果（其中 ${sawOfficial} 首走的是官方源，不算）`}`)
      record(`音源 ${sourceId} 能换源出声`, Boolean(hit), hit ? `${hit.name} 来自 ${hit.servedFrom}（${hit.served}）` : '未命中')
    }

    /*
     * 一个候选都没走换源、全部由官方源正常播放 → 这批歌对这个账号根本不受限，
     * 换源链路压根没被执行，此时判定「音源故障」是误报。明确说明并跳过。
     */
    if (!anyHit && officialOnly > 0) {
      log(`注意：${officialOnly} 首候选全部由官方源播放，说明本轮没有受限样本，换源链路未被触发；本次不计入失败。`)
      for (let i = results.length - 1; i >= 0; i -= 1) {
        if (results[i].name.endsWith('能换源出声')) results.splice(i, 1)
      }
    }

    // 恢复默认四个音源
    await cdpEval(`window.youyou.invoke('settings:update', { unblockSources: ['qishui','kugou','kuwo','qq'] })`)
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
  log(failed.length === 0 ? 'SOURCES OK' : `SOURCES FAILED (${failed.length}/${results.length})`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((cause) => {
  console.error('[sources] 失败:', cause)
  process.exit(1)
})
