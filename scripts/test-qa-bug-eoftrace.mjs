/**
 * 补充探针：EOF 幽灵态事件流取证。
 * 订阅 player:state 事件流，播 3 秒离线缓存曲（单曲队列，repeat=off），
 * 记录 EOF 前后的完整状态迁移，并测试三种恢复手段（play / pause+play / next）。
 *
 * 要回答：
 * 1. EOF 后 playing 是否短暂 false 过又被扶回 true（谁在重播）？还是从头到尾一直 true（end-file 没送达）？
 * 2. 用户能靠哪种操作恢复？都不能 → 挂死级；能 → 体验差级。
 */
import * as path from 'node:path'
import * as os from 'node:os'
import {
  log, wait, launchBugInstance, killInstance, waitReady, cdp, waitPlaying,
  freshUserData, plantCachedAudio, plantCookies
} from './test-qa-bug-lib.mjs'

const PORT = 9432
const userData = path.join(os.tmpdir(), 'youyou-bug-eoftrace')
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

    // 事件流订阅：必须挂在播放开始之前
    await cdp(PORT, `(() => {
      window.__qaT0 = Date.now()
      window.__qaTrace = []
      window.youyou.on('player:state', (s) => {
        window.__qaTrace.push({
          t: Date.now() - window.__qaT0,
          playing: s.playing, pos: +(s.position ?? 0).toFixed(2),
          loading: s.loading, name: s.track?.name ?? null, q: s.queue?.length ?? -1,
          idx: s.index ?? -1
        })
      })
      return true
    })()`)

    await cdp(PORT, `(async () => (await window.youyou.invoke('player:playTracks', { tracks: ${JSON.stringify([FIXTURE_DTO])}, startIndex: 0 })).data)()`)
    const played = await waitPlaying(PORT, 60_000)
    record('起播（3s 短文件）', played.ok, played.ok ? `pos=${played.state.position?.toFixed(2)}` : JSON.stringify(played.state).slice(0, 120))

    await wait(6000) // 3s 处 EOF，再观察 3s
    const trace = await cdp(PORT, `window.__qaTrace`)
    const events = trace.ok ? trace.value : []
    log(`事件流(${events.length}): ${events.map((e) => `${e.t}s:${e.playing ? 'P' : 'p'}/${e.pos}${e.loading ? '/L' : ''}/${e.name ?? '-'}/${e.q}/${e.idx}`).join(' | ')}`)

    const firstFalse = events.find((e) => !e.playing)
    const lastState = events[events.length - 1] ?? null
    const ghost = lastState && lastState.playing === true && lastState.pos === 0
    record('EOF 后落定 playing=false', !ghost, lastState ? `t=${lastState.t}s p=${lastState.playing} pos=${lastState.pos}` : 'no state')
    log(firstFalse ? `  EOF 后曾短暂 playing=false（t=${firstFalse.t}s）后又被扶回 true → 有重播者` : '  playing 从头到尾 true → end-file/track-end 未送达或无人处理')

    // 恢复手段测试（仅当进入幽灵态）
    if (ghost) {
      log('  进入幽灵态，测试恢复手段…')
      const tryPlay = await cdp(PORT, `(async () => {
        await window.youyou.invoke('player:play')
        await new Promise((r) => setTimeout(r, 2500))
        return (await window.youyou.invoke('player:state')).data
      })()`)
      const v1 = tryPlay.ok ? tryPlay.value : null
      record('恢复手段1: player:play', (v1?.position ?? -1) > 0.3, v1 ? `pos=${v1.position?.toFixed(2)} p=${v1.playing}` : 'err')

      const tryPausePlay = await cdp(PORT, `(async () => {
        await window.youyou.invoke('player:pause')
        await new Promise((r) => setTimeout(r, 800))
        await window.youyou.invoke('player:play')
        await new Promise((r) => setTimeout(r, 2500))
        return (await window.youyou.invoke('player:state')).data
      })()`)
      const v2 = tryPausePlay.ok ? tryPausePlay.value : null
      record('恢复手段2: pause+play', (v2?.position ?? -1) > 0.3, v2 ? `pos=${v2.position?.toFixed(2)} p=${v2.playing}` : 'err')

      const tryNext = await cdp(PORT, `(async () => {
        await window.youyou.invoke('player:next')
        await new Promise((r) => setTimeout(r, 3000))
        return (await window.youyou.invoke('player:state')).data
      })()`)
      const v3 = tryNext.ok ? tryNext.value : null
      record('恢复手段3: player:next', (v3?.position ?? -1) > 0.3, v3 ? `pos=${v3.position?.toFixed(2)} p=${v3.playing} name=${v3.track?.name}` : 'err')
    }
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
