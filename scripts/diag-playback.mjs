/**
 * 播放卡顿诊断：隔离实例实测「起播耗时 / 切歌耗时 / 实际音源 / 后台缓存竞争」。
 *
 * 为什么不靠猜：把真实配置只读副本拷到临时目录（清空音频缓存 → 冷启动），
 * 启动 dev 实例并捕获主进程日志（dev 会打印解析链路），再用 CDP 计时：
 *   t0 = invoke('player:playTracks') 返回
 *   t1 = player:state.playing === true 且 position > 0.05（= 真的出声了）
 * 差值就是用户能感觉到的等待。切歌同理（player:next）。
 *
 * 用法：node scripts/diag-playback.mjs [关键词]
 */
import { spawn, spawnSync, execSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9369
const userData = path.join(os.tmpdir(), 'youyou-diag-playback')
const realUserData = path.join(process.env.APPDATA ?? '', 'youyou-music')
const keyword = process.argv[2] ?? '周杰伦'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const stamp = () => new Date().toISOString().slice(11, 23)
const log = (message) => console.log(`[diag ${stamp()}] ${message}`)

/** 主进程日志（dev 会打印解析链路），带时间戳收集。 */
const appLogs = []
function note(line) {
  const text = line.trim()
  if (!text) return
  appLogs.push({ at: Date.now(), text })
}

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
    socket.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise }
      })
    )
  })
}

const call = (channel, request) =>
  evaluate(
    `window.youyou.invoke(${JSON.stringify(channel)}, ${JSON.stringify(request ?? null)})`,
    true
  )

/** 等到真的出声：playing === true 且 position 前进。 */
async function waitForAudio(t0, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  let last = 0
  while (Date.now() < deadline) {
    const state = await call('player:state')
    const data = state?.data
    if (data?.playing && typeof data.position === 'number') {
      if (data.position > 0.05 && (last === 0 || data.position > last)) {
        return {
          ms: Date.now() - t0,
          position: data.position,
          title: data.track?.name,
          duration: data.duration
        }
      }
      last = Math.max(last, data.position ?? 0)
    }
    await wait(120)
  }
  return { ms: -1, position: last, title: undefined }
}

/** 观察 position 是否出现「停住」（= 卡缓存导致的 audible 卡顿）。 */
async function watchStall(seconds) {
  const events = []
  const deadline = Date.now() + seconds * 1000
  let previous = null
  let previousAt = Date.now()
  while (Date.now() < deadline) {
    const state = await call('player:state')
    const data = state?.data
    const now = Date.now()
    if (data?.playing && typeof data.position === 'number') {
      if (previous !== null) {
        const elapsed = (now - previousAt) / 1000
        const advanced = data.position - previous
        if (elapsed > 1.2 && advanced < elapsed * 0.25) {
          events.push({ at: data.position, advanced, elapsed })
        }
      }
      previous = data.position
      previousAt = now
    }
    await wait(400)
  }
  return events
}

function logsBetween(fromMs, toMs) {
  return appLogs.filter((item) => item.at >= fromMs && item.at <= toMs).map((item) => item.text)
}

function collectCacheFiles() {
  const directory = path.join(userData, 'audio-cache', 'audio')
  try {
    return fs.readdirSync(directory).map((name) => ({
      name,
      bytes: fs.statSync(path.join(directory, name)).size
    }))
  } catch {
    return []
  }
}

/**
 * 按「本脚本专属的调试端口」定位残留实例：只匹配 electron.exe，绝不可能
 * 误伤用户自己开的客户端（它不带这个端口）。
 */
function killByPort() {
  const script =
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ` +
    `Where-Object { $_.CommandLine -like '*--remote-debugging-port=${CDP_PORT}*' } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' })
}

/** 只杀本脚本拉起的进程树（不碰用户正在用的实例）。 */
let childPid = 0
function killInstance() {
  if (childPid) {
    try {
      execSync(`taskkill /PID ${childPid} /T /F`, { stdio: 'ignore' })
    } catch {
      /* 已经退出 */
    }
  }
  killByPort()
}

async function main() {
  // 上一轮可能留下没杀干净的实例（spawn 走了包装器时 taskkill 未必命中）：它占着
  // userData 目录，直接 rmSync 会 EPERM，所以先按端口清一遍再重建目录。
  killInstance()
  await wait(700)
  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  // 真实配置只读副本：登录态 + 设置；故意不拷 audio-cache（要测冷启动）
  for (const entry of ['settings.json', 'cookies.json', 'Preferences', 'Local State', 'Local Storage', 'Network']) {
    const from = path.join(realUserData, entry)
    if (fs.existsSync(from)) {
      fs.cpSync(from, path.join(userData, entry), { recursive: true })
    }
  }
  log(`隔离配置已就绪: ${userData}`)

  const env = { ...process.env, YOYOU_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    cwd: root,
    detached: true
  })
  child.stdout.on('data', (chunk) => String(chunk).split('\n').forEach(note))
  child.stderr.on('data', (chunk) => String(chunk).split('\n').forEach(note))
  child.unref()
  log(`实例 PID=${child.pid}`)

  await wait(2500)
  await connectCDP()
  log('CDP 已连接')
  const bridge = await evaluate(`Boolean(window.youyou && window.youyou.invoke)`)
  log(`window.youyou = ${bridge}`)

  const auth = await call('auth:state')
  log(`登录态 = ${JSON.stringify(auth?.data)}`)

  const search = await call('search:query', { keywords: keyword, type: 'songs', limit: 6 })
  const tracks = (search?.data?.songs ?? []).slice(0, 4)
  if (tracks.length === 0) {
    log('搜索无结果，终止')
    killInstance()
    process.exit(1)
  }
  log(`选中 ${tracks.length} 首：${tracks.map((t) => t.name).join(' / ')}`)

  const rows = []
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index]
    const before = collectCacheFiles().length
    const t0 = Date.now()
    const play =
      index === 0
        ? await call('player:playTracks', { tracks, startIndex: 0 })
        : await call('player:next')
    const callMs = Date.now() - t0
    const audio = await waitForAudio(t0)
    const finished = Date.now()
    const logs = logsBetween(t0 - 1500, finished)
    const source = logs.find((line) => line.includes('已换源播放')) ?? ''
    const presolved = logs.some((line) => line.includes('已预解析下一首'))
    const cachePart = collectCacheFiles().filter((file) => file.name.endsWith('.part')).length
    const stallEvents = await watchStall(6)
    rows.push({
      index: index + 1,
      title: track.name,
      artist: track.artists?.[0]?.name ?? '',
      callMs,
      firstAudioMs: audio.ms,
      source: source.replace(/^已换源播放：/, '') || '网易云官方',
      presolved,
      cacheNew: collectCacheFiles().length - before,
      cachePart,
      stallEvents: stallEvents.length,
      ok: play?.ok
    })
    log(
      `#${index + 1} ${track.name} — 请求 ${callMs}ms / 出声 ${audio.ms}ms / ${rows.at(-1).source} / 停住 ${stallEvents.length} 次`
    )
  }

  console.log('\n== 起播耗时实测 ==')
  for (const row of rows) {
    console.log(
      `#${row.index} ${row.title}（${row.artist}）请求=${row.callMs}ms 出声=${row.firstAudioMs === -1 ? '未出声' : `${row.firstAudioMs}ms`} 音源=${row.source} 预解析=${row.presolved} 新增缓存=${row.cacheNew} 停住=${row.stallEvents}`
    )
  }

  console.log('\n== 解析链路日志（关键行）==')
  for (const item of appLogs.filter((entry) =>
    /已换源|已预解析|已预热|音质降级|播放失败|缓存音频失败|提示音|音源探测失败|响应体为空/.test(
      entry.text
    )
  )) {
    console.log(`  ${String(item.at).slice(-6)}ms  ${item.text}`)
  }

  killInstance()
  process.exit(0)
}

main().catch((cause) => {
  console.error(`[diag] 失败: ${cause}`)
  killInstance()
  process.exit(1)
})
