/**
 * 预热（prefetch）端到端验证：
 *   搜索 → 等 prefetch 后台把顶部曲目的第三方直链解析完 → 播放第一首 → 计时。
 *
 * 预期：日志出现「已预热音源」（搜索时后台预解析）与「复用预热音源」（播放时命中缓存），
 *       出声耗时应大幅低于冷解析（第三方接口那几秒不用再等）。
 *
 * 用法：node scripts/test-prefetch.mjs [关键词]
 */
import { spawn, spawnSync, execSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9371
const userData = path.join(os.tmpdir(), 'youyou-test-prefetch')
const realUserData = path.join(process.env.APPDATA ?? '', 'youyou-music')
const keyword = process.argv[2] ?? '周杰伦'
const PREFETCH_WAIT_MS = 6000

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const stamp = () => new Date().toISOString().slice(11, 23)
const log = (message) => console.log(`[prefetch ${stamp()}] ${message}`)

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
      JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } })
    )
  })
}

const call = (channel, request) =>
  evaluate(`window.youyou.invoke(${JSON.stringify(channel)}, ${JSON.stringify(request ?? null)})`, true)

async function waitForAudio(t0, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let last = 0
  while (Date.now() < deadline) {
    const state = await call('player:state')
    const data = state?.data
    if (data?.playing && typeof data.position === 'number' && data.position > 0.05 && data.position >= last) {
      if (last === 0 || data.position > last) return { ms: Date.now() - t0, position: data.position, title: data.track?.name }
      last = Math.max(last, data.position ?? 0)
    }
    await wait(100)
  }
  return { ms: -1, position: last, title: undefined }
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
      /* already gone */
    }
  }
  killByPort()
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
  childPid = child.pid ?? 0
  await wait(2500)
  await connectCDP()

  const search = await call('search:query', { keywords: keyword, type: 'songs', limit: 6 })
  const tracks = (search?.data?.songs ?? []).slice(0, 4)
  if (!tracks.length) {
    log('搜索无结果，终止')
    killInstance()
    process.exit(1)
  }
  log(`选中：${tracks.map((t) => t.name).join(' / ')}`)

  // 关键：模拟真实用户「看完结果再点」，给后台 prefetch 留出完成时间。
  log(`等待 ${PREFETCH_WAIT_MS}ms 让 prefetch 完成……`)
  await wait(PREFETCH_WAIT_MS)

  const prefetchLogs = appLogs.filter((item) => /已预热音源/.test(item.text))
  log(`prefetch 已完成 ${prefetchLogs.length} 首：`)
  for (const item of prefetchLogs) log(`  ${item.text}`)

  const t0 = Date.now()
  const play = await call('player:playTracks', { tracks, startIndex: 0 })
  const audio = await waitForAudio(t0)
  const finished = Date.now()
  const reuseLogs = appLogs.filter((item) => item.at >= t0 - 500 && item.at <= finished && /复用预热音源/.test(item.text))
  const source = appLogs.find((item) => /已换源播放/.test(item.text))?.text ?? ''

  log(`播放 #1 ${tracks[0].name}：请求=${play?.ok ? 'ok' : 'fail'} 出声=${audio.ms}ms（position=${audio.position?.toFixed(2)}）`)
  log(`复用预热音源 命中 ${reuseLogs.length} 次：`)
  for (const item of reuseLogs) log(`  ${item.text}`)
  log(`音源：${source}`)

  console.log('\n== 结论 ==')
  console.log(`prefetch 完成=${prefetchLogs.length} 复用命中=${reuseLogs.length} 出声=${audio.ms}ms`)

  killInstance()
  process.exit(0)
}

main().catch((cause) => {
  console.error(`[prefetch] 失败: ${cause}`)
  killInstance()
  process.exit(1)
})
