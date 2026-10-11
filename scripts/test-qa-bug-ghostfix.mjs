/**
 * 幽灵态三修复在新构建（11:12:55）上的复测：
 *  A EOF 幽灵态：3s 缓存曲播完 → 应落定 playing=false（旧：playing=true pos=0 永久冻结）
 *  B clearQueue 幽灵态：播放中清队列 → playing=false 且 positionTimer 停止（旧：P/0 快照每 261ms 持续）
 *  C mpv 强杀：killMpvOf → 应 playing=false + error 文案（旧：playing=true 冻结挂死）→ 再 play 应自愈出声
 */
import * as path from 'node:path'
import * as os from 'node:os'
import {
  log, wait, launchBugInstance, killInstance, waitReady, cdp,
  playerState, waitPlaying, freshUserData, waitPortFree, plantCachedAudio, killMpvOf, mpvCountOf
} from './test-qa-bug-lib.mjs'

const PORTS = { A: 9437, B: 9438, C: 9439 }
const DTO = { id: 999000001, name: '同步测试曲', artists: [{ id: 1, name: 'QA' }], album: { id: 1, name: 'QA专辑' }, durationMS: 60000, alias: [], transNames: [], fee: 0, mvID: 0, noCopyright: false, isCloud: false }
const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'BUG?'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const invoke = (channel, payload) => `(async () => {
  try { const r = await window.youyou.invoke(${JSON.stringify(channel)}${payload ? `, ${JSON.stringify(payload)}` : ''}); return { error: r?.error ?? null, data: r?.data ?? null } }
  catch (cause) { return { throw: String(cause).slice(0, 160) } }
})()`

async function scenarioA() {
  const port = PORTS.A
  const userData = path.join(os.tmpdir(), 'youyou-bug-ghost-a')
  freshUserData(userData)
  killInstance(userData)
  const inst = await launchBugInstance({ port, userData, fixture: false })
  try {
    if (!(await waitReady(port))) return
    plantCachedAudio(userData)
    await cdp(port, `(async () => { await window.youyou.invoke('player:playTracks', { tracks: ${JSON.stringify([DTO])}, startIndex: 0 }) })()`)
    await waitPlaying(port, 20_000)
    // EOF 约在 3s 处；采样 0.5s 间隔 × 16 次观察落定
    let settled = false
    let frozenSamples = 0
    for (let i = 0; i < 16; i += 1) {
      const s = await playerState(port)
      const p = s.value ?? {}
      if (!p.playing) { settled = true; break }
      if ((p.position ?? -1) === 0) frozenSamples += 1
      await wait(500)
    }
    record('A EOF 后落定 playing=false', settled, `frozenSamples=${frozenSamples}`)
  } finally {
    killInstance(userData, inst?.pid ?? 0)
    await waitPortFree(port)
  }
}

async function scenarioB() {
  const port = PORTS.B
  const userData = path.join(os.tmpdir(), 'youyou-bug-ghost-b')
  freshUserData(userData)
  killInstance(userData)
  const inst = await launchBugInstance({ port, userData, fixture: false })
  try {
    if (!(await waitReady(port))) return
    plantCachedAudio(userData)
    await cdp(port, `(async () => { await window.youyou.invoke('player:playTracks', { tracks: ${JSON.stringify([DTO])}, startIndex: 0 }) })()`)
    await waitPlaying(port, 20_000)
    await cdp(port, invoke('player:clearQueue'))
    await wait(300)
    // 清队列后 2s 内采样 4 次：应稳定 playing=false 且无 positionTimer 心跳（旧：261ms 一帧 P/0）
    const samples = []
    for (let i = 0; i < 4; i += 1) {
      const s = await playerState(port)
      samples.push({ playing: s.value?.playing, pos: s.value?.position, track: s.value?.track?.name ?? null, q: s.value?.queue?.length ?? -1 })
      await wait(500)
    }
    const allStopped = samples.every((s) => s.playing === false)
    record('B clearQueue 后稳定 playing=false', allStopped, JSON.stringify(samples))
  } finally {
    killInstance(userData, inst?.pid ?? 0)
    await waitPortFree(port)
  }
}

async function scenarioC() {
  const port = PORTS.C
  const userData = path.join(os.tmpdir(), 'youyou-bug-ghost-c')
  freshUserData(userData)
  killInstance(userData)
  const inst = await launchBugInstance({ port, userData, fixture: false })
  try {
    if (!(await waitReady(port))) return
    plantCachedAudio(userData)
    await cdp(port, `(async () => { await window.youyou.invoke('player:playTracks', { tracks: ${JSON.stringify([DTO])}, startIndex: 0 }) })()`)
    await waitPlaying(port, 20_000)
    const before = mpvCountOf(inst.pid)
    killMpvOf(inst.pid)
    await wait(4000)
    const after = mpvCountOf(inst.pid)
    const s = await playerState(port)
    const stopped = after === 0 && s.value?.playing === false && s.value?.position === 0
    record('C mpv 强杀后 playing=false（不再假死）', stopped, `mpv ${before}→${after} playing=${s.value?.playing} error=${JSON.stringify(s.value?.error)?.slice(0, 60)}`)
    // 自愈：再 play 应重启 mpv 并真出声
    await cdp(port, invoke('player:play'))
    const healed = await waitPlaying(port, 30_000)
    const mpvBack = mpvCountOf(inst.pid)
    record('C 强杀后 play 自愈出声（mpv 重启）', healed.ok && mpvBack > 0, `pos=${healed.state?.position?.toFixed(1)} mpv=${mpvBack}`)
  } finally {
    killInstance(userData, inst?.pid ?? 0)
    await waitPortFree(port)
  }
}

await scenarioA()
await scenarioB()
await scenarioC()

const failed = results.filter((item) => !item.ok)
log(`结果: ${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) process.exitCode = 1
