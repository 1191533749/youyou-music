/**
 * 补充探针：区分「最小化假死」与「3 秒短文件 EOF 后幽灵态」。
 * fixtures/offline.m4a 实测只有 3 秒（73768 字节），此前最小化探针都在 pos≈2.8s（≈EOF 时刻）
 * 附近最小化 —— 观测到的 pos=0.0 冻结可能与 EOF 重合，而非最小化本身。
 *
 * 阶段 A（PORT 9430）：不最小化，播 3 秒离线缓存曲，EOF 前后逐秒采样 10s。
 *   期望（controller.ts:1339-1354 onTrackEnd）：单曲队列 repeat=off → playing=false 落定。
 *   若 EOF 后 playing=true pos=0.0 冻结 → 是「EOF 幽灵态」而非最小化问题。
 * 阶段 B（PORT 9431）：播网络长歌（搜索页第一首），中途最小化 12s 采样，恢复后 seek 验证。
 *   若最小化期间 pos 正常前进 → 最小化无罪，路径12 的「最小化假死」报告要撤回/改写。
 */
import * as path from 'node:path'
import * as os from 'node:os'
import {
  log, wait, launchBugInstance, killInstance, waitReady, cdp, playerState, waitPlaying,
  clickNav, typeSearch, goToSongsTab, freshUserData, plantCachedAudio, plantCookies
} from './test-qa-bug-lib.mjs'

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

async function phaseA() {
  const PORT = 9430
  const userData = path.join(os.tmpdir(), 'youyou-bug-eof')
  freshUserData(userData)
  killInstance(userData)
  const inst = await launchBugInstance({ port: PORT, userData })
  try {
    if (!(await waitReady(PORT, 90_000))) { record('A 实例启动', false); return }
    await plantCookies(userData)
    await plantCachedAudio(userData, FIXTURE_ID)
    await cdp(PORT, `(async () => (await window.youyou.invoke('player:playTracks', { tracks: ${JSON.stringify([FIXTURE_DTO])}, startIndex: 0 })).data)()`)
    const played = await waitPlaying(PORT, 60_000)
    record('A 起播（3s 短文件）', played.ok, played.ok ? `pos=${played.state.position?.toFixed(2)}` : JSON.stringify(played.state).slice(0, 120))

    const timeline = []
    for (let i = 0; i < 10; i += 1) {
      const s = await playerState(PORT)
      const v = s.ok ? s.value : null
      timeline.push(`${(i + 1)}s:p${v?.playing}@${v?.position?.toFixed(2)}q${v?.queue?.length}`)
      await wait(1000)
    }
    log(`A EOF 时间线: ${timeline.join(' | ')}`)
    const end = await playerState(PORT)
    const ev = end.ok ? end.value : null
    record('A EOF 后 10s 落定 playing=false', ev?.playing === false, `final p=${ev?.playing} pos=${ev?.position?.toFixed(2)} queue=${ev?.queue?.length} repeat=${ev?.repeat}`)
    if (ev?.playing === true && (ev?.position ?? -1) <= 0.05) {
      log('🐛 A 结论：EOF 后幽灵播放态（与最小化无关）——原「最小化假死」可能是 EOF 巧合')
    }
  } catch (cause) {
    record('A 执行异常', false, String(cause).slice(0, 160))
  } finally {
    killInstance(userData, inst?.pid ?? 0)
  }
}

async function phaseB() {
  const PORT = 9431
  const userData = path.join(os.tmpdir(), 'youyou-bug-minnet')
  freshUserData(userData)
  killInstance(userData)
  const inst = await launchBugInstance({ port: PORT, userData })
  try {
    if (!(await waitReady(PORT, 90_000))) { record('B 实例启动', false); return }
    await clickNav(PORT, '搜索')
    await wait(1500)
    await typeSearch(PORT, '孤勇者')
    await wait(7000)
    const tab = await goToSongsTab(PORT, 20_000)
    const rows = tab.ok ? (tab.value?.rows ?? 0) : -1
    record('B 搜索出结果', rows > 0, `rows=${rows}`)
    if (rows <= 0) return
    await cdp(PORT, `(() => {
      const root = document.querySelector('.page-slot:not([hidden])') ?? document
      const row = root.querySelector('.song-row')
      if (!row) return false
      const button = row.querySelector('button')
      if (button) button.click()
      else row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      return true
    })()`)
    const played = await waitPlaying(PORT, 60_000)
    record('B 网络歌起播', played.ok, played.ok ? `${played.state.track?.name} pos=${played.state.position?.toFixed(1)}` : JSON.stringify(played.state).slice(0, 120))
    if (!played.ok) return

    await cdp(PORT, `(async () => (await window.youyou.invoke('window:minimize')).data)()`)
    log('B 已最小化，采样 12s')
    const during = []
    for (let i = 0; i < 3; i += 1) {
      await wait(4000)
      const s = await playerState(PORT)
      const v = s.ok ? s.value : null
      during.push(`p${v?.playing}@${v?.position?.toFixed(1)}`)
    }
    log(`B 最小化期间: ${during.join(' | ')}`)
    await cdp(PORT, `(async () => (await window.youyou.invoke('window:toggleMaximize')).data)()`)
    const restored = await playerState(PORT)
    const rv = restored.ok ? restored.value : null
    log(`B 恢复后: p=${rv?.playing} pos=${rv?.position?.toFixed(1)}`)
    await wait(2000)
    const seek = await cdp(PORT, `(async () => { await window.youyou.invoke('player:seek', { position: 5 }); await new Promise((r) => setTimeout(r, 2000)); return (await window.youyou.invoke('player:state')).data })()`)
    const sv = seek.ok ? seek.value : null
    log(`B seek(5) 后: p=${sv?.playing} pos=${sv?.position?.toFixed(1)}`)

    const frozen = rv?.playing === true && (rv?.position ?? -1) <= 0.05
    record('B 最小化期间播放正常前进（网络歌）', !frozen && (rv?.position ?? 0) > 0.5, JSON.stringify({ during, restored: rv?.position, seeked: sv?.position }))
    if (frozen) log('🐛 B 结论：最小化确实引发假死（与 EOF 无关）')
  } catch (cause) {
    record('B 执行异常', false, String(cause).slice(0, 160))
  } finally {
    killInstance(userData, inst?.pid ?? 0)
  }
}

await phaseA()
await wait(2000)
await phaseB()

const failed = results.filter((item) => !item.ok)
log(`结果: ${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) process.exitCode = 1
