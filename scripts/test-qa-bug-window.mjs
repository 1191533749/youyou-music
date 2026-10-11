/**
 * bug 猎手 · 路径 12：窗口最小化/恢复、桌面歌词、全屏。
 *  - 最小化后恢复（toggleMaximize 拉起）、播放器持续响应
 *  - 全屏开关（setFullScreen/toggleFullScreen 返回值验证）
 *  - 桌面歌词开关：开→主进程新增 lyrics 窗口（/json/list 多一个 page target）
 *  - 桌面歌词坐标/尺寸：desktopResize 有钳制（140-1200 × 30-320）；desktopMove 无钳制，
 *    大坐标直接持久化进 settings.json → 重启后 createLyricsWindow 用该坐标 setPosition
 *    （src/main/index.ts:186-188，sanitise settings.ts:147-153 也不钳制）→ 歌词窗口跑到屏外无法找回。
 */
import * as path from 'node:path'
import * as os from 'node:os'
import {
  log, wait, launchBugInstance, killInstance, waitReady, cdp, playerState,
  waitPlaying, freshUserData, waitPortFree, plantCachedAudio
} from './test-qa-bug-lib.mjs'

const PORT = 9422
const userData = path.join(os.tmpdir(), 'youyou-bug-window')
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

const invoke = (channel, payload) => `(async () => {
  try { const r = await window.youyou.invoke(${JSON.stringify(channel)}${payload ? `, ${JSON.stringify(payload)}` : ''}); return { error: r?.error ?? null, data: r?.data ?? null } }
  catch (cause) { return { throw: String(cause).slice(0, 160) } }
})()`

async function targets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  const list = await res.json()
  return list.filter((t) => t.type === 'page')
}

async function main() {
  freshUserData(userData)
  killInstance(userData)
  plantCachedAudio(userData)
  const inst = await launchBugInstance({ port: PORT, userData })
  try {
    const ready = await waitReady(PORT, 90_000)
    record('实例启动', ready)
    if (!ready) return

    await cdp(PORT, `(window.__qaErrors = [], window.addEventListener('error', (e) => window.__qaErrors.push(String(e.message)), true))`)

    // 起播一首，验证最小化期间播放不中断
    await cdp(PORT, `(async () => {
      const dto = ${JSON.stringify({ id: 999000001, name: '同步测试曲', artists: [{ id: 1, name: 'QA' }], album: { id: 1, name: 'QA专辑' }, durationMS: 60000, alias: [], transNames: [], fee: 0, mvID: 0, noCopyright: false, isCloud: false })}
      await window.youyou.invoke('player:playTracks', { tracks: [dto], startIndex: 0 })
      return true
    })()`)
    const played = await waitPlaying(PORT, 30_000)
    record('起播成功', played.ok, `pos=${played.state?.position?.toFixed(1)}`)

    // 1. 最大化/还原
    const m0 = await cdp(PORT, invoke('window:isMaximized'))
    const m1 = await cdp(PORT, invoke('window:toggleMaximize'))
    await wait(600)
    const m2 = await cdp(PORT, invoke('window:isMaximized'))
    const m3 = await cdp(PORT, invoke('window:toggleMaximize'))
    await wait(600)
    const m4 = await cdp(PORT, invoke('window:isMaximized'))
    record('最大化/还原往返', m0.value?.data === false && m1.value?.data === true && m2.value?.data === true && m3.value?.data === false && m4.value?.data === false, `${m0.value?.data}→${m1.value?.data}→${m2.value?.data}→${m3.value?.data}→${m4.value?.data}`)

    // 2. 全屏开关
    const f1 = await cdp(PORT, invoke('window:setFullScreen', { fullscreen: true }))
    await wait(800)
    const f2 = await cdp(PORT, invoke('window:setFullScreen', { fullscreen: false }))
    await wait(800)
    const f3 = await cdp(PORT, invoke('window:toggleFullScreen'))
    await wait(800)
    const f4 = await cdp(PORT, invoke('window:toggleFullScreen'))
    record('全屏开关往返（返回值即时生效）', f1.value?.data === true && f2.value?.data === false && f3.value?.data === true && f4.value?.data === false, `${f1.value?.data},${f2.value?.data},${f3.value?.data},${f4.value?.data}`)
    if (f1.value?.throw || f2.value?.throw || f3.value?.throw || f4.value?.throw) report(12, '全屏开关', '全屏通道抛错', '体验差', `${f1.value?.throw ?? f3.value?.throw}`)

    // 3. 最小化 → 播放不断 → 恢复
    await cdp(PORT, invoke('window:minimize'))
    await wait(3000)
    const pMin = await playerState(PORT)
    const posBefore = played.state?.position ?? 0
    const posMin = pMin.value?.position ?? -1
    await cdp(PORT, invoke('window:toggleMaximize'))
    await wait(800)
    const isMax = await cdp(PORT, invoke('window:isMaximized'))
    await cdp(PORT, invoke('window:toggleMaximize'))
    await wait(500)
    const restored = await cdp(PORT, `(async () => {
      await window.youyou.invoke('window:toggleMaximize')
      await new Promise((resolve) => setTimeout(resolve, 300))
      const a = (await window.youyou.invoke('window:isMaximized')).data
      await window.youyou.invoke('window:toggleMaximize')
      const b = (await window.youyou.invoke('window:isMaximized')).data
      return { a, b }
    })()`)
    record('最小化期间播放持续推进（音频不断）', pMin.ok && posMin > posBefore, `pos ${posBefore.toFixed(1)} → ${posMin.toFixed(1)}`)
    record('最小化后可恢复窗口', isMax.value?.data === true && restored.value?.b === false, `拉起=${isMax.value?.data} 往返=${JSON.stringify(restored.value)}`)
    if (!(pMin.ok && posMin > posBefore)) report(12, '最小化', '最小化后播放停顿/通道不响应', '体验差', `pos=${posMin}`)

    // 4. 桌面歌词：开 → 独立窗口出现
    const pagesBefore = (await targets(PORT)).length
    const on1 = await cdp(PORT, invoke('lyrics:desktopToggle', { visible: true }))
    await wait(1500)
    const pagesOn = (await targets(PORT)).length
    const settingsOn = await cdp(PORT, invoke('settings:get'))
    record('桌面歌词开启（独立窗口创建+设置持久化）', on1.value?.error == null && pagesOn === pagesBefore + 1 && settingsOn.value?.data?.showDesktopLyrics === true, `targets ${pagesBefore}→${pagesOn} show=${settingsOn.value?.data?.showDesktopLyrics}`)
    if (pagesOn !== pagesBefore + 1) report(12, '桌面歌词开关', '开启后未创建歌词窗口', '体验差', `targets ${pagesBefore}→${pagesOn}`)

    // 5. 尺寸钳制（不崩即可；代码钳 140-1200 × 30-320）
    const resize = await cdp(PORT, invoke('lyrics:desktopResize', { height: 99999, width: 99999 }))
    await wait(400)
    const resize2 = await cdp(PORT, invoke('lyrics:desktopResize', { height: -500, width: -1 }))
    record('歌词尺寸极端值不崩溃', resize.value?.error == null && resize2.value?.error == null && !resize.value?.throw && !resize2.value?.throw, `${JSON.stringify(resize.value)}`)

    // 6. 坐标无钳制 → 屏外坐标持久化（bug 候选）
    const move1 = await cdp(PORT, invoke('lyrics:desktopMove', { x: 99999, y: 99999 }))
    await wait(400)
    const posCheck = await cdp(PORT, invoke('settings:get'))
    const stored = posCheck.value?.data?.desktopLyricsPosition ?? null
    const unclamped = stored && stored.x === 99999 && stored.y === 99999
    record('歌词坐标极端值被钳制（预期钳制）', unclamped === false, `存储=${JSON.stringify(stored)}`)
    if (unclamped) report(12, '桌面歌词坐标', '歌词窗口坐标无钳制，可持久化到屏外(99999,99999)——重启后歌词窗口出现在屏外无法找回', '体验差', `settings.json desktopLyricsPosition=${JSON.stringify(stored)}`)

    // 7. 点击穿透开关
    const ct1 = await cdp(PORT, invoke('lyrics:desktopClickThrough', { through: true }))
    const ct2 = await cdp(PORT, invoke('lyrics:desktopClickThrough', { through: false }))
    record('点击穿透开关不崩溃', ct1.value?.error == null && ct2.value?.error == null, `${JSON.stringify(ct1.value)}`)

    // 8. 歌词开关快速连打 10 次
    let rapidErr = []
    for (let i = 0; i < 10; i += 1) {
      const r = await cdp(PORT, invoke('lyrics:desktopToggle', { visible: i % 2 === 0 }))
      if (r.value?.error != null || r.value?.throw) rapidErr.push(i)
      await wait(250)
    }
    await wait(800)
    const settingsEnd = await cdp(PORT, invoke('settings:get'))
    record('桌面歌词快速连打 10 次无报错', rapidErr.length === 0, `errors=${JSON.stringify(rapidErr)}`)
    const finalShow = settingsEnd.value?.data?.showDesktopLyrics === false
    if (!finalShow) {
      await cdp(PORT, invoke('lyrics:desktopToggle', { visible: false }))
    }

    // 9. 全程存活 + 播放器仍响应
    const alive = await cdp(PORT, `Boolean(window.youyou)`)
    const st = await playerState(PORT)
    record('全程实例存活且播放器仍响应', alive.value === true && st.ok, `playing=${st.value?.playing}`)

    const errs = await cdp(PORT, `window.__qaErrors ?? []`)
    record('渲染层无未捕获错误', (errs.value ?? []).length === 0, JSON.stringify(errs.value).slice(0, 160))
  } catch (cause) {
    record('执行异常', false, String(cause).slice(0, 200))
  } finally {
    killInstance(userData, inst?.pid ?? 0)
    await waitPortFree(PORT)
  }
}

await main()

const failed = results.filter((item) => !item.ok)
log(`结果: ${results.length - failed.length}/${results.length} 通过，bugs=${bugs.length}`)
for (const line of bugs) console.log(`REPORT|${line}`)
if (failed.length > 0 || bugs.length > 0) process.exitCode = 1
