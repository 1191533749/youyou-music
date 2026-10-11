/**
 * 补充探针：clearQueue 幽灵态事件流取证（与 eoftrace 同法）。
 * 订阅 player:state 事件流 → 播离线缓存曲（3s）→ waitPlaying → clearQueue → 记录 10s 事件流。
 * 目标：找出 clearQueue 后 playing 被谁扶回 true（若复现）。
 */
import * as path from 'node:path'
import * as os from 'node:os'
import {
  log, wait, launchBugInstance, killInstance, waitReady, cdp, waitPlaying,
  freshUserData, plantCachedAudio, plantCookies
} from './test-qa-bug-lib.mjs'

const PORT = 9433
const userData = path.join(os.tmpdir(), 'youyou-bug-cleartrace')
const FIXTURE_ID = 999000001
const FIXTURE_DTO = {
  id: FIXTURE_ID, name: '同步测试曲', artists: [{ id: 1, name: 'QA' }],
  album: { id: 1, name: 'QA专辑' }, durationMS: 20000, alias: [], transNames: [],
  fee: 0, mvID: 0, noCopyright: false, isCloud: false
}

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'BUG?'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const main = async () => {
  freshUserData(userData)
  killInstance(userData)
  const inst = await launchBugInstance({ port: PORT, userData })
  try {
    if (!(await waitReady(PORT, 90_000))) { record('实例启动', false); return }
    await plantCookies(userData)
    await plantCachedAudio(userData, FIXTURE_ID)

    await cdp(PORT, `(() => {
      window.__qaT0 = Date.now()
      window.__qaTrace = []
      window.youyou.on('player:state', (s) => {
        window.__qaTrace.push({
          t: Date.now() - window.__qaT0,
          playing: s.playing, pos: +(s.position ?? 0).toFixed(2),
          loading: s.loading, name: s.track?.name ?? null, q: s.queue?.length ?? -1, idx: s.index ?? -1
        })
      })
      return true
    })()`)

    await cdp(PORT, `(async () => (await window.youyou.invoke('player:playTracks', { tracks: ${JSON.stringify([FIXTURE_DTO])}, startIndex: 0 })).data)()`)
    const played = await waitPlaying(PORT, 60_000)
    record('起播', played.ok, `pos=${played.state.position?.toFixed(2)}`)

    await cdp(PORT, `(async () => (await window.youyou.invoke('player:clearQueue')).data)()`)
    log('clearQueue 已调用，记录 10s')
    await wait(10_000)
    const trace = await cdp(PORT, `window.__qaTrace`)
    const events = trace.ok ? trace.value : []
    const afterClear = events.filter((e) => e.t > 5000) // 起播到 clearQueue 大约 2-4s，取后半段
    log(`clearQueue 后事件流: ${afterClear.map((e) => `${e.t}s:${e.playing ? 'P' : 'p'}/${e.pos}/${e.name ?? '-'}/${e.q}/${e.idx}`).join(' | ')}`)

    const finalState = await cdp(PORT, `(async () => (await window.youyou.invoke('player:state')).data)()`)
    const fv = finalState.ok ? finalState.value : null
    const ghost = fv?.playing === true && fv?.queue?.length === 0
    record('clearQueue 后落定 playing=false', !ghost, fv ? `p=${fv.playing} pos=${fv.position?.toFixed(2)} q=${fv.queue?.length} track=${fv.track?.name ?? 'null'}` : 'err')
    if (ghost) log('🐛 clearQueue 幽灵态复现（离线缓存曲路径，可稳定复现）')
  } catch (cause) {
    record('执行异常', false, String(cause).slice(0, 160))
  } finally {
    killInstance(userData, inst?.pid ?? 0)
  }

  const failed = results.filter((item) => !item.ok)
  log(`结果: ${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
