/**
 * 验证 qa-bug #2 修复：播放中强杀 mpv 进程 → 状态不再假装播放中 →
 * 重新播放能自动重建 mpv（play() 里 await start()）→ 出声且进度前进。
 *
 * 沙箱铁律：杀 mpv 只按「父进程是本实例」过滤，绝不误杀别的实例的 mpv。
 *
 * 用法：node scripts/_probe-mpv-kill.mjs [端口，默认 9426]
 */
import * as path from 'node:path'
import * as os from 'node:os'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import {
  log, wait, launchBugInstance, killInstance, waitReady, cdp, waitPlaying, playerState,
  freshUserData, plantCachedAudio
} from './test-qa-bug-lib.mjs'

const PORT = process.argv[2] ?? '9426'
const userData = path.join(os.tmpdir(), 'youyou-probe-mpvkill')
// 用真实 profile 里一首 ~220s 的缓存曲：3 秒的 qa 夹具测不了「进度持续前进」。
const REAL_CACHE_SRC = path.join(process.env.APPDATA ?? '', 'youyou-music', 'audio-cache', 'audio', '1334295185-exhigh.mp3')
const REAL_CACHE_ID = 1334295185

// 找本实例主进程（electron.exe，命令行带 userData 目录）下挂着的 mpv 子进程。
// 沙箱铁律：不能 pipe 捕获输出，所以让 PowerShell 把结果落文件再读。
function findMpvChildren(rootPid) {
  const outFile = path.join(userData, 'mpv-list.txt')
  execFileSync(
    'powershell',
    ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "Name='mpv.exe'" | Where-Object { $_.ParentProcessId -eq ${rootPid} }).ProcessId | Out-File -FilePath '${outFile.replaceAll('\\', '\\\\')}' -Encoding utf8`],
    { stdio: 'ignore', windowsHide: true }
  )
  if (!existsSync(outFile)) return []
  return readFileSync(outFile, 'utf8')
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
}

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const FIXTURE_DTO = {
  id: REAL_CACHE_ID, name: '强杀恢复探针曲', artists: [{ id: 1, name: 'QA' }],
  album: { id: 1, name: 'QA专辑' }, durationMS: 220000, alias: [], transNames: [],
  fee: 0, mvID: 0, noCopyright: false, isCloud: false
}

function plantRealCache() {
  const directory = path.join(userData, 'audio-cache', 'audio')
  mkdirSync(directory, { recursive: true })
  copyFileSync(REAL_CACHE_SRC, path.join(directory, `${REAL_CACHE_ID}-exhigh.mp3`))
  log('已种入真实缓存曲 1334295185-exhigh.mp3')
}

async function main() {
  freshUserData(userData)
  killInstance(userData)
  const inst = await launchBugInstance({ port: PORT, userData, cookie: false })
  try {
    if (!(await waitReady(PORT, 90_000))) throw new Error('实例启动超时')
    plantCachedAudio(userData)
    plantRealCache()

    await cdp(PORT, `window.youyou.invoke('player:playTracks', { tracks: ${JSON.stringify([FIXTURE_DTO])}, startIndex: 0 })`)
    const played = await waitPlaying(PORT, 60_000)
    record('起播（离线缓存曲）', played.ok, played.ok ? `pos=${played.state.position?.toFixed(2)}` : JSON.stringify(played.state).slice(0, 120))

    // 找到并强杀本实例的 mpv 子进程。
    const mpvPids = findMpvChildren(inst.pid)
    if (mpvPids.length === 0) throw new Error('没找到本实例的 mpv 子进程')
    for (const pid of mpvPids) {
      execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    }
    log(`已强杀 mpv 子进程: ${mpvPids.join(', ')}`)

    // 观察 5s：状态必须落回「已停止」，不能假装还在播。
    await wait(5000)
    const stoppedReply = await playerState(PORT)
    const stopped = stoppedReply.value
    log(`强杀后状态: playing=${stopped?.playing} loading=${stopped?.loading} error=${stopped?.error ?? '-'} pos=${stopped?.position}`)
    record('强杀后不再假装播放中', stopped?.playing === false, `error=${stopped?.error ?? '-'}`)

    // 重新播放：mpv 必须自动重建并出声、进度前进。
    await cdp(PORT, `window.youyou.invoke('player:playTracks', { tracks: ${JSON.stringify([FIXTURE_DTO])}, startIndex: 0 })`)
    const revived = await waitPlaying(PORT, 60_000)
    record('重播自动重建 mpv 并起播', revived.ok, revived.ok ? `pos=${revived.state.position?.toFixed(2)}` : JSON.stringify(revived.state).slice(0, 120))

    // 再等 2s 确认进度在走（不是又卡死的僵尸）。
    await wait(2000)
    const later = (await playerState(PORT)).value
    const progressed = later?.playing === true && (later?.position ?? 0) > (revived.state?.position ?? 0)
    record('进度持续前进', progressed, `pos ${revived.state?.position?.toFixed(2)} → ${later?.position?.toFixed(2)}`)
  } finally {
    killInstance(userData, inst.pid)
  }
  const failed = results.filter((item) => !item.ok).length
  console.log(`\n合计: ${results.length - failed}/${results.length} 通过`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((cause) => {
  console.error('探针失败:', cause)
  killInstance(userData, 0)
  process.exit(1)
})
