/**
 * bug 猎手 · 路径 4：断网重连。
 * 场景 A：无网启动（--proxy-server 指向死代理，API 全挂），验证：能进 UI、登录态从缓存读、
 *         缓存歌曲照常出声、搜索失败有界（不无限转圈）、不崩溃。
 * 场景 B：正常播放中 mpv 被强杀（模拟 OOM/崩溃），验证：主进程不崩、播放状态正确退出、
 *         再次切歌能重建 mpv 恢复出声（mpv 进程数回到 1）。
 */
import * as path from 'node:path'
import * as os from 'node:os'
import {
  log, wait, launchBugInstance, killInstance, waitReady, cdp, waitFor, playerState, waitPlaying,
  clickNav, typeSearch, collectLogs, freshUserData, killMpvOf, mpvCountOf, waitPortFree
} from './test-qa-bug-lib.mjs'

const PORT_A = 9413
const PORT_B = 9414
const userDataA = path.join(os.tmpdir(), 'youyou-bug-netoff')
const userDataB = path.join(os.tmpdir(), 'youyou-bug-mpvkill')
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

async function scenarioA() {
  log('== 场景 A：无网启动 ==')
  freshUserData(userDataA)
  killInstance(userDataA)
  const inst = await launchBugInstance({ port: PORT_A, userData: userDataA, extraArgs: ['--proxy-server=http://127.0.0.1:9'] })
  try {
    const ready = await waitReady(PORT_A, 90_000)
    record('无网也能启动到 UI', ready)
    if (!ready) return

    const auth = await cdp(PORT_A, `(async () => (await window.youyou.invoke('auth:state')).data)()`)
    record('离线登录态从本地缓存读取', auth.ok && auth.value?.loggedIn === true, JSON.stringify({ nick: auth.value?.profile?.nickname, loggedIn: auth.value?.loggedIn }))

    // 直接 IPC 搜索：应快速失败（有界），不无限等待
    const t0 = Date.now()
    const search = await cdp(PORT_A, `(async () => {
      try {
        const reply = await Promise.race([
          window.youyou.invoke('search:query', { keywords: '周杰伦', type: 'songs', limit: 5, offset: 0 }),
          new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), 15000))
        ])
        return { timeout: reply?.__timeout === true, error: reply?.error ?? null, n: reply?.data?.songs?.length ?? -1 }
      } catch (cause) { return { throw: String(cause).slice(0, 120) } }
    })()`)
    const ms = Date.now() - t0
    record('离线搜索有界失败（≤15s 且不崩溃）', search.ok && search.value?.timeout !== true, `${ms}ms ${JSON.stringify(search.value)}`)
    if (search.ok && search.value?.timeout === true) report(4, '断网后搜索', '搜索接口无限等待无超时', '挂死', `${ms}ms 未返回`)

    // UI 搜索不应无限转圈
    await clickNav(PORT_A, '搜索')
    await wait(1200)
    await typeSearch(PORT_A, '周杰伦')
    await wait(10000)
    const uiState = await cdp(PORT_A, `(() => ({ loading: Boolean(document.querySelector('.search__loading')), rows: document.querySelectorAll('.song-row').length, err: document.querySelector('.toast')?.textContent ?? null }))()`)
    record('离线 UI 搜索不无限转圈（10s 内有落定）', !uiState.value?.loading, JSON.stringify(uiState.value))

    // 缓存歌曲离线出声
    const played = await cdp(PORT_A, `(async () => (await window.youyou.invoke('player:playTracks', { tracks: ${JSON.stringify([FIXTURE_DTO])}, startIndex: 0 })).data)()`)
    const playing = await waitPlaying(PORT_A, 25_000)
    record('离线缓存歌曲真出声', playing.ok, playing.ok ? `servedFrom=${playing.state.servedFrom ?? '?'} pos=${playing.state.position?.toFixed(1)}` : JSON.stringify(playing.state)?.slice(0, 140))

    // 离线切歌到队列尽头：应明确收尾不挂死
    const next = await cdp(PORT_A, `(async () => {
      try { const r = await window.youyou.invoke('player:next'); return { error: r?.error ?? null } }
      catch (cause) { return { throw: String(cause).slice(0, 120) } }
    })()`)
    await wait(2000)
    const post = await playerState(PORT_A)
    record('离线单曲队列切歌不挂死', post.ok, JSON.stringify(post.value ?? post).slice(0, 140))

    const alive = await cdp(PORT_A, `Boolean(window.youyou)`).then((r) => r.ok && r.value === true).catch(() => false)
    record('离线全程实例存活', alive)
  } catch (cause) {
    record('场景A 执行异常', false, String(cause).slice(0, 200))
  } finally {
    killInstance(userDataA, inst?.pid ?? 0)
  }
}

async function scenarioB() {
  log('== 场景 B：播放中强杀 mpv ==')
  freshUserData(userDataB)
  killInstance(userDataB)
  const inst = await launchBugInstance({ port: PORT_B, userData: userDataB })
  const mainPid = inst.pid
  try {
    const ready = await waitReady(PORT_B, 90_000)
    record('实例启动', ready)
    if (!ready) return

    // 用离线缓存曲直接起播（保证能出声，不依赖网络搜索）
    const got = await cdp(PORT_B, `(async () => {
      const reply = await window.youyou.invoke('player:playTracks', { tracks: ${JSON.stringify([FIXTURE_DTO])}, startIndex: 0 })
      return { ok: !reply?.error, error: reply?.error ?? null }
    })()`)
    const played = await waitPlaying(PORT_B, 60_000)
    record('起播成功（mpv 在线）', played.ok, `name=${played.state?.track?.name} ${JSON.stringify(got.value ?? got).slice(0, 100)}`)
    if (!played.ok) return

    const stateBefore = await playerState(PORT_B)
    const before = mpvCountOf(mainPid)
    killMpvOf(mainPid)
    await wait(1500)
    const afterKill = mpvCountOf(mainPid)
    record('mpv 已被强杀', afterKill === 0 && before >= 1, `before=${before} after=${afterKill}`)

    // 观察：主进程不崩、状态正确退出播放
    const aliveAfter = await cdp(PORT_B, `Boolean(window.youyou)`).then((r) => r.ok && r.value === true).catch(() => false)
    record('mpv 死亡后主进程/渲染层存活', aliveAfter)
    if (!aliveAfter) {
      report(4, '播放中强杀 mpv', '主进程随 mpv 一起崩溃', '崩溃', 'cdp 无响应')
      return
    }
    await wait(3000)
    const s1 = await playerState(PORT_B)
    await wait(3000)
    const s2 = await playerState(PORT_B)
    const s = s2.value
    const frozen = s1.value?.position === s2.value?.position && s1.value?.track?.id === s2.value?.track?.id
    record('mpv 死亡后播放状态正确落定（非假死）', aliveAfter && s?.playing !== true, JSON.stringify(s)?.slice(0, 160))
    if (s?.playing === true && frozen) report(4, '播放中强杀 mpv', 'mpv 已死但状态仍显示播放中（假死）', '挂死', `mpv=${afterKill} playing=true pos=${s1.value?.position?.toFixed(1)}→${s2.value?.position?.toFixed(1)} 冻结 track=${s?.track?.name}`)

    // 恢复方式 1：切歌，应重建 mpv 并出声
    const qBefore = stateBefore.value?.queue?.length ?? -1
    await cdp(PORT_B, `(async () => { await window.youyou.invoke('player:next'); return true })()`)
    const recoveredNext = await waitPlaying(PORT_B, 30_000)
    const countNext = mpvCountOf(mainPid)
    record('mpv 死亡后切歌能重建并恢复出声', recoveredNext.ok && countNext === 1, `mpv=${countNext} ${recoveredNext.ok ? `track=${recoveredNext.state.track?.name}` : JSON.stringify(recoveredNext.state)?.slice(0, 120)}`)
    if (!recoveredNext.ok) report(4, 'mpv 死亡后切歌', '无法恢复播放', '体验差', `mpv进程=${countNext} 杀前队列=${qBefore}`)

    // 恢复方式 2：重新 playTracks，验证是否需要重启 app
    await cdp(PORT_B, `(async () => {
      const reply = await window.youyou.invoke('player:playTracks', { tracks: ${JSON.stringify([FIXTURE_DTO])}, startIndex: 0 })
      return { ok: !reply?.error, error: reply?.error ?? null }
    })()`)
    const recoveredReplay = await waitPlaying(PORT_B, 30_000)
    const countReplay = mpvCountOf(mainPid)
    record('mpv 死亡后重新播放可自愈（无需重启 app）', recoveredReplay.ok && countReplay === 1, `mpv=${countReplay} track=${recoveredReplay.state?.track?.name}`)
    if (!recoveredReplay.ok) report(4, 'mpv 死亡后重新播放', '播放器无法自愈，必须重启 app', '挂死', `mpv进程=${countReplay}`)

    const logs = collectLogs(userDataB).filter((item) => item?.level === 'error').slice(-8)
    log(`错误日志样例: ${JSON.stringify(logs.map((item) => String(item.message ?? item.raw ?? '').slice(0, 100)))}`)
  } catch (cause) {
    record('场景B 执行异常', false, String(cause).slice(0, 200))
  } finally {
    killInstance(userDataB, mainPid ?? 0)
  }
}

await scenarioA()
await waitPortFree(PORT_A)
await scenarioB()

const failed = results.filter((item) => !item.ok)
log(`结果: ${results.length - failed.length}/${results.length} 通过，bugs=${bugs.length}`)
for (const line of bugs) console.log(`REPORT|${line}`)
if (failed.length > 0 || bugs.length > 0) process.exitCode = 1
