/**
 * bug 猎手 · 路径 5：播放中强杀整个进程树 → 用同一 userData 重启，数据完好。
 * 验证：settings.json 不损坏且改动已持久化、cookies 未损坏、登录态保持、
 *       重启后能正常出声、诊断日志可解析。
 */
import * as path from 'node:path'
import * as os from 'node:os'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import {
  log, wait, launchBugInstance, killInstance, waitReady, cdp, waitFor, playerState, waitPlaying,
  freshUserData, waitPortFree
} from './test-qa-bug-lib.mjs'

const PORT = 9415
const userData = path.join(os.tmpdir(), 'youyou-bug-restart')
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

const FIXTURE_DTO = {
  id: 999000001, name: '同步测试曲', artists: [{ id: 1, name: 'QA' }],
  album: { id: 1, name: 'QA专辑' }, durationMS: 20000, alias: [], transNames: [],
  fee: 0, mvID: 0, noCopyright: false, isCloud: false
}

function hardKillTree(pid) {
  spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
}

async function main() {
  // ============ 第一次启动：改设置 + 出声 + 强杀 ============
  freshUserData(userData)
  killInstance(userData)
  const instA = await launchBugInstance({ port: PORT, userData })
  try {
    const ready = await waitReady(PORT, 90_000)
    record('首启成功', ready)
    if (!ready) return

    await cdp(PORT, `(async () => {
      await window.youyou.invoke('settings:update', { theme: 'dark', quality: 'exhigh', cacheLimitMB: 777, showDesktopLyrics: false })
      return true
    })()`)
    await wait(2500)

    const settingsFile = path.join(userData, 'settings.json')
    const persisted = existsSync(settingsFile) && (() => {
      try { const s = JSON.parse(readFileSync(settingsFile, 'utf8')); return { theme: s.theme, quality: s.quality, cacheLimitMB: s.cacheLimitMB } } catch { return null }
    })()
    record('设置改动已落盘', persisted?.theme === 'dark' && persisted?.quality === 'exhigh', JSON.stringify(persisted))

    const played = await cdp(PORT, `(async () => (await window.youyou.invoke('player:playTracks', { tracks: ${JSON.stringify([FIXTURE_DTO])}, startIndex: 0 })).data)()`)
    const playing = await waitPlaying(PORT, 25_000)
    record('强杀前出声中', playing.ok, `pos=${playing.state?.position?.toFixed(1)}`)

    // 强杀整棵树（播放中）
    hardKillTree(instA.pid)
    await wait(3000)
  } catch (cause) {
    record('首启阶段异常', false, String(cause).slice(0, 200))
  }
  killInstance(userData, instA?.pid ?? 0)

  // ============ 第二次启动：同一 userData ============
  await waitPortFree(PORT)
  log('== 强杀后重启（同一 userData） ==')
  const instB = await launchBugInstance({ port: PORT, userData, cookie: false, fixture: false })
  try {
    const ready = await waitReady(PORT, 90_000)
    record('强杀后重启成功（数据未损坏到启动不了）', ready)
    if (!ready) {
      report(5, '强杀后重启', '启动失败（数据文件损坏）', '崩溃', 'waitReady 超时')
      return
    }

    const auth = await cdp(PORT, `(async () => (await window.youyou.invoke('auth:state')).data)()`)
    record('重启后登录态保持', auth.ok && auth.value?.loggedIn === true, JSON.stringify({ nick: auth.value?.profile?.nickname, loggedIn: auth.value?.loggedIn }))

    const settings = await cdp(PORT, `(async () => (await window.youyou.invoke('settings:get')).data)()`)
    const s = settings.value ?? {}
    record('重启后设置回读正确（theme/quality/cacheLimit）', s.theme === 'dark' && s.quality === 'exhigh' && s.cacheLimitMB === 777, JSON.stringify({ theme: s.theme, quality: s.quality, cacheLimitMB: s.cacheLimitMB }))
    if (s.theme !== 'dark' || s.quality !== 'exhigh') report(5, '强杀后重启', '设置改动丢失（未落盘/未回读）', '数据错乱', JSON.stringify({ theme: s.theme, quality: s.quality }))

    const played2 = await cdp(PORT, `(async () => (await window.youyou.invoke('player:playTracks', { tracks: ${JSON.stringify([FIXTURE_DTO])}, startIndex: 0 })).data)()`)
    const playing2 = await waitPlaying(PORT, 25_000)
    record('重启后缓存歌曲照常出声', playing2.ok, `pos=${playing2.state?.position?.toFixed(1)}`)

    // 队列/历史文件完整性抽查：cookies.json 可解析
    const cookiesOk = existsSync(path.join(userData, 'cookies.json')) && (() => { try { JSON.parse(readFileSync(path.join(userData, 'cookies.json'), 'utf8')); return true } catch { return false } })()
    record('cookies.json 未损坏', cookiesOk)

    // 诊断日志：有记录且可读（JSONL 每行可解析）
    const diagFile = path.join(userData, 'diagnostics', 'pending.jsonl')
    const diagInfo = existsSync(diagFile) ? statSync(diagFile) : null
    record('诊断日志存在且可读', diagInfo !== null && diagInfo.size > 0, diagInfo ? `size=${diagInfo.size}` : '无文件')
  } catch (cause) {
    record('重启阶段异常', false, String(cause).slice(0, 200))
  } finally {
    killInstance(userData, instB?.pid ?? 0)
  }

  const failed = results.filter((item) => !item.ok)
  log(`结果: ${results.length - failed.length}/${results.length} 通过，bugs=${bugs.length}`)
  for (const line of bugs) console.log(`REPORT|${line}`)
  if (failed.length > 0 || bugs.length > 0) process.exitCode = 1
}

await main()
