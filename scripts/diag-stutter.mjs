/**
 * 播放卡顿诊断（mpv 层）：隔离实例播放真实曲目，直接连 mpv 的 JSON IPC 管道，
 * 高频采样 paused-for-cache / cache-buffering-state / demuxer-cache-duration，
 * 精确回答「还是卡顿」到底是：起播慢、还是播放中途缓存 underrun（可闻的音频缺口）。
 *
 * 用法：node scripts/diag-stutter.mjs [关键词]
 */
import { spawn, spawnSync, execSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as net from 'node:net'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9362
const userData = path.join(os.tmpdir(), 'youyou-diag-stutter')
const realUserData = path.join(process.env.APPDATA ?? '', 'youyou-music')
const keyword = process.argv[2] ?? '周杰伦'
const SAMPLE_MS = 300
const SAMPLE_SECONDS = 45

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const stamp = () => new Date().toISOString().slice(11, 23)
const log = (message) => console.log(`[stutter ${stamp()}] ${message}`)

let socket
async function connectCDP() {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  const targets = await response.json()
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error('未找到页面 target')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
}

function evaluate(expression, awaitPromise = false) {
  return new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e9)
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id === id) {
        socket.removeEventListener('message', onMessage)
        resolve(message.result?.result?.value)
      }
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }))
  })
}

const call = (channel, request) =>
  evaluate(`window.youyou.invoke(${JSON.stringify(channel)}, ${JSON.stringify(request ?? null)})`, true)

async function waitForAudio(t0, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await call('player:state')
    const data = state?.data
    if (data?.playing && typeof data.position === 'number' && data.position > 0.05) {
      return { ms: Date.now() - t0, position: data.position, title: data.track?.name, duration: data.duration }
    }
    await wait(120)
  }
  return { ms: -1, position: 0 }
}

/** 从进程命令行里找出 mpv 命名管道名（youyou-mpv-<pid>-<suffix>）。 */
function findMpvPipe() {
  const script =
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'youyou-mpv-[0-9-]+' } | ` +
    `ForEach-Object { if ($_.CommandLine -match 'youyou-mpv-[0-9-]+') { $matches[0] } } | Select-Object -First 1`
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
  const name = (out.stdout ?? '').trim()
  return name || null
}

function killByPort() {
  const script =
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ` +
    `Where-Object { $_.CommandLine -like '*--remote-debugging-port=${CDP_PORT}*' } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' })
}

let childPid = 0
function killInstance() {
  if (childPid) {
    try {
      execSync(`taskkill /PID ${childPid} /T /F`, { stdio: 'ignore' })
    } catch {
      /* 已退出 */
    }
  }
  killByPort()
}

// ---- mpv JSON IPC 采样 ----
const MPV_PROPS = ['paused-for-cache', 'cache-buffering-state', 'demuxer-cache-duration', 'time-pos', 'duration', 'paused', 'eof-reached']
function makeMpvSampler(pipeName) {
  const PIPE = `\\\\.\\pipe\\${pipeName}`
  let sock
  let rid = 0
  const pending = new Map()
  let buffer = ''

  const connect = () =>
    new Promise((resolve, reject) => {
      sock = net.connect(PIPE)
      sock.setEncoding('utf8')
      sock.once('error', reject)
      sock.once('connect', () => {
        sock.removeAllListeners('error')
        sock.on('error', () => {})
        sock.on('data', (chunk) => {
          buffer += chunk
          let nl = buffer.indexOf('\n')
          while (nl >= 0) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (line) {
              let msg
              try {
                msg = JSON.parse(line)
              } catch {
                msg = null
              }
              if (msg && typeof msg.request_id === 'number' && pending.has(msg.request_id)) {
                const resolve = pending.get(msg.request_id)
                pending.delete(msg.request_id)
                resolve(msg.data ?? null)
              }
            }
            nl = buffer.indexOf('\n')
          }
        })
        resolve()
      })
    })

  const get = (prop, timeoutMS = 1200) =>
    new Promise((resolve) => {
      const id = ++rid
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve(null)
      }, timeoutMS)
      pending.set(id, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
      sock.write(`${JSON.stringify({ command: ['get_property', prop], request_id: id })}\n`)
    })

  const sample = async () => {
    const out = { at: Date.now() }
    for (const prop of MPV_PROPS) out[prop] = await get(prop)
    out.position = out['time-pos']
    return out
  }

  const destroy = () => {
    try {
      sock?.destroy()
    } catch {}
  }

  return { connect, sample, destroy }
}

/** 采样 N 秒，统计 paused-for-cache（缓存 underrun）与 cache 曲线。 */
async function sampleStutter(sampler, seconds, label) {
  await sampler.connect()
  log(`开始采样 ${label}（${seconds}s @ ${SAMPLE_MS}ms）`)
  const samples = []
  const underrunEvents = []
  let underrunStart = null
  let prev = null
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const s = await sampler.sample()
    samples.push(s)
    const pfk = !!s['paused-for-cache']
    if (pfk && !underrunStart) underrunStart = s.at
    if (!pfk && underrunStart) {
      underrunEvents.push({ at: underrunStart, ms: s.at - underrunStart })
      underrunStart = null
    }
    if (prev) {
      const moved = (s.position ?? 0) - (prev.position ?? 0)
      const wall = (s.at - prev.at) / 1000
      if (moved <= 0 && !s.paused && !pfk && (s.duration ?? 0) > 0 && s.position < s.duration - 0.5) {
        log(`  ⚠ 疑似停顿 wall=${wall.toFixed(2)}s pos=${(s.position ?? 0).toFixed(1)}→${(prev.position ?? 0).toFixed(1)}（未暂停/未等缓存）`)
      }
    }
    prev = s
    await wait(SAMPLE_MS)
  }
  if (underrunStart) underrunEvents.push({ at: underrunStart, ms: Date.now() - underrunStart })

  const buffering = samples.map((s) => s['cache-buffering-state']).filter((v) => typeof v === 'number')
  const cacheDur = samples.map((s) => s['demuxer-cache-duration']).filter((v) => typeof v === 'number')
  const minBuf = buffering.length ? Math.min(...buffering) : null
  const maxBuf = buffering.length ? Math.max(...buffering) : null
  const minCache = cacheDur.length ? Math.min(...cacheDur) : null
  const maxCache = cacheDur.length ? Math.max(...cacheDur) : null
  const ended = samples.some((s) => s['eof-reached'])
  const pfkCount = underrunEvents.length
  const pfkTotalMs = underrunEvents.reduce((sum, e) => sum + e.ms, 0)

  log(
    `  ${label} 采样 ${samples.length} 次 | 缓存缓冲 ${minBuf}%..${maxBuf}% | 已缓存 ${minCache}..${maxCache}s | ` +
      `paused-for-cache ${pfkCount} 次共 ${pfkTotalMs}ms | 播完=${ended}`
  )
  for (const e of underrunEvents) log(`    ⚠ 缓存 underrun ${e.ms}ms @ ${new Date(e.at).toISOString().slice(11, 23)}`)
  return { samples: samples.length, minBuf, maxBuf, minCache, maxCache, pfkCount, pfkTotalMs, ended }
}

async function main() {
  killInstance()
  await wait(700)
  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  for (const entry of ['settings.json', 'cookies.json', 'Preferences', 'Local State', 'Local Storage', 'Network']) {
    const from = path.join(realUserData, entry)
    if (fs.existsSync(from)) fs.cpSync(from, path.join(userData, entry), { recursive: true })
  }
  log(`隔离配置就绪: ${userData}`)

  const env = { ...process.env, YOYOU_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`], { stdio: 'ignore', env, cwd: root, detached: true })
  child.unref()
  childPid = child.pid
  log(`实例 PID=${child.pid}`)

  await wait(2500)
  await connectCDP()
  log('CDP 已连接')

  const auth = await call('auth:state')
  log(`登录态 = ${JSON.stringify(auth?.data)}`)

  const search = await call('search:query', { keywords: keyword, type: 'songs', limit: 6 })
  const tracks = (search?.data?.songs ?? []).slice(0, 3)
  if (tracks.length === 0) {
    log('搜索无结果，终止')
    killInstance()
    process.exit(1)
  }
  log(`选中：${tracks.map((t) => t.name).join(' / ')}`)

  // 播放第一首，测起播耗时
  const t0 = Date.now()
  await call('player:playTracks', { tracks, startIndex: 0 })
  const audio = await waitForAudio(t0)
  log(`#1 ${tracks[0].name} 出声耗时 ${audio.ms}ms（position=${audio.position}）`)

  // 找 mpv 管道（mpv 启动在首次播放时）
  let pipe = null
  for (let i = 0; i < 20 && !pipe; i += 1) {
    pipe = findMpvPipe()
    if (!pipe) await wait(300)
  }
  if (!pipe) {
    log('找不到 mpv 管道，终止')
    killInstance()
    process.exit(1)
  }
  log(`mpv 管道 = ${pipe}`)

  const sampler = makeMpvSampler(pipe)
  const report = []
  report.push({ track: tracks[0].name, startMs: audio.ms, ...(await sampleStutter(sampler, SAMPLE_SECONDS, `#1 ${tracks[0].name}`)) })

  // 切第二首（走预解析预热链路）
  if (tracks[1]) {
    const t1 = Date.now()
    await call('player:next')
    const a2 = await waitForAudio(t1)
    log(`#2 ${tracks[1].name} 出声耗时 ${a2.ms}ms（position=${a2.position}）`)
    report.push({ track: tracks[1].name, startMs: a2.ms, ...(await sampleStutter(sampler, SAMPLE_SECONDS, `#2 ${tracks[1].name}`)) })
  }

  sampler.destroy()
  console.log('\n== 卡顿诊断结论 ==')
  for (const r of report) {
    console.log(
      `${r.track} 起播=${r.startMs}ms 缓冲=${r.minBuf}%..${r.maxBuf}% 已缓存=${r.minCache}..${r.maxCache}s ` +
        `缓存underrun=${r.pfkCount}次/${r.pfkTotalMs}ms 播完=${r.ended}`
    )
  }

  killInstance()
  process.exit(0)
}

main().catch((cause) => {
  console.error(`[stutter] 失败: ${cause}`)
  killInstance()
  process.exit(1)
})
