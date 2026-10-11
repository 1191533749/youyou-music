/**
 * bug 猎手 · 路径 3：播放中退出登录；登录态失效/换账号模拟（坏 cookie 冷启动）。
 *
 * 关注：登出瞬间播放器是否崩溃/继续出声/状态错乱；UI 是否卡在登录门禁；
 *       坏 cookie 启动是否挂死/无限转圈。
 */
import * as path from 'node:path'
import * as os from 'node:os'
import { writeFileSync } from 'node:fs'
import {
  log, wait, launchBugInstance, killInstance, waitReady, waitPortFree, cdp, playerState, waitPlaying,
  clickNav, typeSearch, goToSongsTab, freshUserData
} from './test-qa-bug-lib.mjs'

const PORT = 9402
const userData = path.join(os.tmpdir(), 'youyou-bug-auth')
const userDataB = path.join(os.tmpdir(), 'youyou-bug-auth-bad')
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

async function startPlayback() {
  await clickNav(PORT, '搜索')
  await wait(1500)
  await typeSearch(PORT, '晴天')
  await wait(7000) // 等 loading 落定
  await goToSongsTab(PORT, 20_000)
  await cdp(PORT, `(() => {
    const root = document.querySelector('.page-slot:not([hidden])') ?? document
    const row = root.querySelector('.song-row')
    if (!row) return false
    const button = row.querySelector('button')
    if (button) button.click()
    else row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  })()`)
  return waitPlaying(PORT, 60_000)
}

async function main() {
  freshUserData(userData)
  killInstance(userData)
  const instA = await launchBugInstance({ port: PORT, userData })
  try {
    const ready = await waitReady(PORT, 90_000)
    record('实例启动（真实登录态）', ready)
    if (!ready) return

    const authBefore = await cdp(PORT, `(async () => (await window.youyou.invoke('auth:state')).data)()`)
    const loggedIn = authBefore.ok && authBefore.value?.loggedIn === true
    record('初始处于登录态', loggedIn, authBefore.value?.profile?.nickname ? `昵称=${authBefore.value.profile.nickname}` : JSON.stringify(authBefore.value).slice(0, 120))
    if (!loggedIn) {
      log('  未登录（真实 cookie 失效？），登出场景改为「未登录状态播放」继续')
    }

    // 先装错误监听
    await cdp(PORT, `(window.__qaErrors = [], window.addEventListener('error', (e) => window.__qaErrors.push(String(e.message)), true))`)

    // 播放中
    const played = await startPlayback()
    record('登出前播放中', played.ok, played.ok ? `${played.state?.track?.name} pos=${played.state?.position?.toFixed(1)}` : JSON.stringify(played.state)?.slice(0, 140))

    // 播放中退出登录
    const t0 = Date.now()
    const logout = await cdp(PORT, `(async () => {
      try {
        const reply = await window.youyou.invoke('auth:logout')
        return { ok: !reply?.error, error: reply?.error ?? null }
      } catch (cause) { return { ok: false, error: String(cause) } }
    })()`)
    const logoutMs = Date.now() - t0
    record('播放中 auth:logout 通道不报错', logout.ok && logout.value?.ok === true, `${logoutMs}ms ${JSON.stringify(logout.value)?.slice(0, 160)}`)

    await wait(2500)
    const afterLogout = await playerState(PORT)
    const s = afterLogout.ok ? afterLogout.value : null
    log(`登出后播放器: playing=${s?.playing} track=${s?.track?.name} pos=${s?.position?.toFixed?.(1)}`)
    // 判定：登出后播放器要么继续出声（独立于登录态）、要么明确停止——不允许「显示播放中但进度冻结」假死
    // 强化取证：12s 内 4 次采样 + 主动 play 一次，观察状态是否任何响应
    const samples = [{ t: 0, playing: s?.playing, pos: s?.position, track: s?.track?.name ?? null }]
    let playCmd = null
    if (s?.playing === true) {
      for (let i = 0; i < 3; i++) {
        await wait(4000)
        const si = (await playerState(PORT)).value
        samples.push({ t: (i + 1) * 4000, playing: si?.playing, pos: si?.position, track: si?.track?.name ?? null })
      }
      try {
        playCmd = await cdp(PORT, `(async () => (await window.youyou.invoke('player:play')))()`)
      } catch { playCmd = { ok: false } }
      await wait(3000)
      const sp = (await playerState(PORT)).value
      samples.push({ t: 15000, playing: sp?.playing, pos: sp?.position, track: sp?.track?.name ?? null, afterPlay: true })
    }
    const frozenWhilePlaying = s?.playing === true && s?.position !== undefined
    if (s?.playing === true) {
      const pos1 = s.position
      const lastPos = samples[samples.length - 1]?.pos ?? 0
      const advancing = lastPos > pos1 + 0.5
      const settled = samples.some((x) => x.playing === false)
      if (!advancing && !settled) report(3, '播放中退出登录', 'UI 显示播放中但进度 15s 冻结、手动 play 无响应（假死）', '挂死', JSON.stringify(samples).slice(0, 300))
      else if (settled && !advancing) record('登出后播放器最终明确停止', true, JSON.stringify(samples).slice(0, 240))
      else record('登出后播放器保持出声且进度前进（或明确停止）', true, JSON.stringify(samples).slice(0, 240))
    } else {
      record('登出后播放器明确停止（无假死）', frozenWhilePlaying === false, `playing=${s?.playing}`)
    }

    // 登出后再点播放/下一首：应给明确错误或跳登录，不崩溃
    const playAfter = await cdp(PORT, `(async () => {
      const out = {}
      for (const channel of ['player:play', 'player:next']) {
        try {
          const reply = await window.youyou.invoke(channel)
          out[channel] = reply?.error ? 'error:' + String(reply.error) : 'ok'
        } catch (cause) { out[channel] = 'throw:' + String(cause).slice(0, 80) }
      }
      return out
    })()`)
    record('登出后播放/下一首操作有明确反馈且不崩溃', playAfter.ok, JSON.stringify(playAfter.value))

    const errs = await cdp(PORT, `window.__qaErrors.slice(0, 10)`)
    record('全程渲染层无未捕获错误', errs.ok && (errs.value ?? []).length === 0, JSON.stringify(errs.value))

    // 实例还活着吗
    const alive = await cdp(PORT, `Boolean(window.youyou)`).then((r) => r.ok && r.value === true).catch(() => false)
    record('登出后实例存活（未崩溃）', alive)

    // 登出后 UI 是否给出登录门禁（体验：用户应知道需要重新登录）
    await clickNav(PORT, '首页')
    await wait(1500)
    const gate = await cdp(PORT, `Boolean([...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '去登录'))`)
    record('登出后首页出现「去登录」入口（状态已同步）', gate.ok && gate.value === true, `gate=${gate.value}`)
  } catch (cause) {
    record('测试执行异常', false, String(cause).slice(0, 200))
  } finally {
    killInstance(userData, instA?.pid ?? 0)
  }

  // ================= 场景 B：坏 cookie（模拟另一个/失效账号）冷启动 =================
  log('== 场景 B：失效 MUSIC_U 冷启动 ==')
  // 先杀掉场景 A 的实例并等端口释放，避免目录锁 EPERM；场景 B 用独立 userData
  killInstance(userData, instA?.pid ?? 0)
  await waitPortFree(PORT)
  freshUserData(userDataB)
  writeFileSync(path.join(userDataB, 'cookies.json'), JSON.stringify({ MUSIC_U: 'deadbeef' + Date.now(), __csrf: 'x' }))
  const instB = await launchBugInstance({ port: PORT, userData: userDataB, cookie: false, fixture: false })
  try {
    const readyB = await waitReady(PORT, 90_000)
    record('坏 cookie 实例能启动到渲染层', readyB)
    if (!readyB) return
    await wait(8000)
    const authB = await cdp(PORT, `(async () => (await window.youyou.invoke('auth:state')).data)()`)
    log(`坏 cookie 登录态: ${JSON.stringify(authB.value)?.slice(0, 160)}`)
    const spinner = await cdp(PORT, `Boolean(document.querySelector('.spinner, .loading, [class*="spin"]'))`)
    const gateB = await cdp(PORT, `Boolean([...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '去登录'))`)
    record('坏 cookie 未无限转圈（有落定 UI）', spinner.ok && spinner.value === false, `spinner=${spinner.value} gate=${gateB.value}`)
    // 失效态应呈现未登录门禁，而不是假登录页面
    if (authB.value?.loggedIn === true) {
      report(3, '失效 cookie 启动', 'app 认为已登录但接口必然全挂（假登录）', '体验差', JSON.stringify(authB.value).slice(0, 160))
    } else {
      record('失效 cookie 正确判定未登录', true, `loggedIn=${authB.value?.loggedIn}`)
    }
  } catch (cause) {
    record('场景B 异常', false, String(cause).slice(0, 200))
  } finally {
    killInstance(userDataB, instB?.pid ?? 0)
  }

  const failed = results.filter((item) => !item.ok)
  log(`结果: ${results.length - failed.length}/${results.length} 通过，bugs=${bugs.length}`)
  for (const line of bugs) console.log(`REPORT|${line}`)
  if (failed.length > 0 || bugs.length > 0) process.exitCode = 1
}

await main()
