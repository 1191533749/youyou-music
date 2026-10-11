/**
 * bug 猎手 · 路径 8：播放失败歌曲的跳过耗时与行为（新构建复测版）。
 * 场景 a：队列夹坏歌 → next 跳过耗时、是否落到下一首好歌（事件采集改用 window.youyou.on，观察窗 30s）。
 * 场景 b：player:playExternal 假源 → 报错文案与耗时。
 * 场景 c：全坏队列 → 状态落定。
 * 场景 d：同一坏歌二次入队 → deadTracks 快失败（新构建修复验证）。
 */
import * as path from 'node:path'
import * as os from 'node:os'
import {
  log, wait, launchBugInstance, killInstance, waitReady, cdp, playerState, waitPlaying, freshUserData
} from './test-qa-bug-lib.mjs'

const PORT = 9418
const userData = path.join(os.tmpdir(), 'youyou-bug-failskip')
const results = []
const bugs = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'BUG?'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const report = (pathNo, operation, symptom, severity, evidence) => {
  bugs.push(`路径${pathNo} → ${operation} → ${symptom} → 严重度:${severity}${evidence ? ` | 证据:${evidence}` : ''}`)
  log(`🐛 ${bugs[bugs.length - 1]}`)
}

const GOOD = { id: 999000001, name: '同步测试曲', artists: [{ id: 1, name: 'QA' }], album: { id: 1, name: 'QA专辑' }, durationMS: 20000, alias: [], transNames: [], fee: 0, mvID: 0, noCopyright: false, isCloud: false }
const BAD = { id: 999000009, name: '坏源测试曲', artists: [{ id: 9, name: 'QA' }], album: { id: 9, name: 'QA专辑' }, durationMS: 20000, alias: [], transNames: [], fee: 0, mvID: 0, noCopyright: false, isCloud: false }

/** 页内：订阅 player:state 事件 + 执行动作 + 观察 windowMs，返回样本序列与终态 */
const observe = (action, windowMs) => `(async () => {
  const t0 = Date.now()
  const samples = []
  window.__qaOff?.()
  window.__qaOff = window.youyou.on('player:state', (p) => {
    samples.push({ t: Date.now() - t0, name: p?.track?.name ?? null, playing: !!p?.playing, pos: p?.position ?? 0, err: p?.error ?? null })
  })
  ${action}
  await new Promise((resolve) => setTimeout(resolve, ${windowMs}))
  window.__qaOff?.()
  const final = (await window.youyou.invoke('player:state')).data
  return { samples: samples.slice(0, 200), final: { name: final?.track?.name ?? null, playing: !!final?.playing, pos: final?.position ?? 0, error: final?.error ?? null } }
})()`

async function main() {
  freshUserData(userData)
  killInstance(userData)
  const inst = await launchBugInstance({ port: PORT, userData })
  try {
    const ready = await waitReady(PORT, 90_000)
    record('实例启动', ready)
    if (!ready) return

    // ---- 场景 a：好歌 → 坏歌 → 好歌，next 后量跳过耗时 ----
    await cdp(PORT, `window.youyou.invoke('player:setQueue', { tracks: [${JSON.stringify(GOOD)}, ${JSON.stringify(BAD)}, ${JSON.stringify(GOOD)}], startIndex: 0 })`)
    const playing = await waitPlaying(PORT, 30_000)
    record('队列起播（好歌）', playing.ok, JSON.stringify({ name: playing.state?.track?.name }).slice(0, 100))

    log('== 切到坏歌，量跳过行为（30s 窗口） ==')
    const skipRaw = await cdp(PORT, observe(`await window.youyou.invoke('player:next')`, 30_000))
    const v = skipRaw.value ?? {}
    const evs = v.samples ?? []
    log(`  事件 ${evs.length} 条: ${JSON.stringify(evs.slice(0, 14))}`)
    log(`  终态: ${JSON.stringify(v.final)}`)
    // 坏歌占用时长：以 name==='坏源测试曲' 的样本跨度计
    const badTs = evs.filter((e) => e.name === '坏源测试曲').map((e) => e.t)
    const badSpan = badTs.length >= 2 ? Math.max(...badTs) - Math.min(...badTs) : 0
    const firstBadAt = badTs.length > 0 ? Math.min(...badTs) : -1
    // 坏歌之后是否恢复播放好歌
    const resumed = evs.some((e) => e.name === '同步测试曲' && e.playing && e.pos > 0 && (firstBadAt < 0 || e.t > firstBadAt + 500))
    const finalGood = v.final?.name === '同步测试曲' && v.final?.playing === true
    const reachedGood = resumed || finalGood
    record('坏歌被跳过且落到好歌播放', reachedGood, JSON.stringify({ resumed, final: v.final }).slice(0, 140))
    if (!reachedGood) report(8, '队列夹坏歌 + next', '未落到下一首好歌（卡住/中断）', '挂死', JSON.stringify({ final: v.final, n: evs.length }).slice(0, 180))
    if (badSpan > 8000) report(8, '队列夹坏歌 + next', `坏歌跳过耗时 ${badSpan}ms（等外部源超时）`, '体验差', `坏歌状态持续 ${badSpan}ms`)
    else record('坏歌停留 <8s（快速跳过）', true, `跨度 ${badSpan}ms${firstBadAt >= 0 ? `（首次出现 ${firstBadAt}ms）` : ''}`)

    // ---- 场景 b：playExternal 假源 ----
    log('== playExternal 假源 ==')
    const ext = await cdp(PORT, `(async () => {
      const t0 = Date.now()
      try {
        const reply = await window.youyou.invoke('player:playExternal', { item: { source: 'kuwo', sourceId: 'deadbeef-not-exist', name: '不存在的歌', artists: 'QA' } })
        await new Promise((resolve) => setTimeout(resolve, 4000))
        const st = (await window.youyou.invoke('player:state')).data
        return { ok: true, error: reply?.error ?? null, ms: Date.now() - t0, state: { playing: !!st?.playing, name: st?.track?.name ?? null, id: st?.track?.id ?? null, servedFrom: st?.servedFrom ?? null, queueLen: st?.queue?.length ?? -1 } }
      } catch (cause) { return { ok: false, ms: Date.now() - t0, error: String(cause).slice(0, 160) } }
    })()`)
    const ev = ext.value ?? {}
    const explicitError = typeof ev.error === 'string' && ev.error.includes('没有找到这首歌的完整音源')
    const silentNoop = ev.ok === true && !explicitError && (ev.state?.queueLen <= 0 || ev.state?.name === '不存在的歌')
    record('playExternal 假源明确报错（不限时）', ext.ok && explicitError, JSON.stringify({ error: ev.error, ms: ev.ms }).slice(0, 160))
    if (ev.ms > 15_000) report(8, 'playExternal 假源', `假源报错耗时 ${ev.ms}ms（超 15s 才明确失败）`, '体验差', JSON.stringify({ error: ev.error, ms: ev.ms, state: ev.state }).slice(0, 180))
    if (silentNoop) report(8, 'playExternal 假源', '假源静默无动作却返回成功（无反馈）', '体验差', JSON.stringify(ev).slice(0, 200))
    if (ev.ok === true && ev.state?.playing === true && ev.state?.name === '不存在的歌') report(8, 'playExternal 假源', '假源显示播放中（假死）', '数据错乱', JSON.stringify(ev).slice(0, 200))

    // ---- 场景 c：全坏队列落定 ----
    log('== 全坏队列 ==')
    const allBad = await cdp(PORT, observe(`await window.youyou.invoke('player:setQueue', { tracks: [${JSON.stringify(BAD)}], startIndex: 0 })`, 25_000))
    const bv = allBad.value ?? {}
    log(`  事件 ${(bv.samples ?? []).length} 条: ${JSON.stringify((bv.samples ?? []).slice(0, 10))}`)
    log(`  终态: ${JSON.stringify(bv.final)}`)
    const settled = bv.final && (bv.final.playing === false || bv.final.name !== '坏源测试曲')
    record('全坏队列 25s 内落定（不假死播放中）', Boolean(settled), JSON.stringify(bv.final).slice(0, 120))
    if (!settled) report(8, '队列全是坏歌', '播放器显示播放中但无声音/不落定', '挂死', JSON.stringify(bv.final).slice(0, 160))

    // ---- 场景 d：同一坏歌二次入队 → deadTracks 快失败 ----
    log('== 坏歌二次入队（deadTracks 快失败） ==')
    const redo = await cdp(PORT, observe(`await window.youyou.invoke('player:setQueue', { tracks: [${JSON.stringify(BAD)}], startIndex: 0 })`, 5000))
    const dv = redo.value ?? {}
    log(`  事件 ${(dv.samples ?? []).length} 条: ${JSON.stringify((dv.samples ?? []).slice(0, 8))}`)
    log(`  终态: ${JSON.stringify(dv.final)}`)
    const fastFail = dv.final?.playing === false
    record('坏歌二次入队快速失败（deadTracks 生效）', fastFail, JSON.stringify(dv.final).slice(0, 120))
    if (!fastFail) report(8, '坏歌二次入队', '同一坏歌重复入队仍慢速解析（deadTracks 未生效）', '体验差', JSON.stringify(dv.final).slice(0, 160))
  } catch (cause) {
    record('测试执行异常', false, String(cause).slice(0, 200))
  } finally {
    killInstance(userData, inst?.pid ?? 0)
  }

  const failed = results.filter((item) => !item.ok)
  log(`结果: ${results.length - failed.length}/${results.length} 通过，bugs=${bugs.length}`)
  for (const line of bugs) console.log(`REPORT|${line}`)
  if (failed.length > 0 || bugs.length > 0) process.exitCode = 1
}

await main()
