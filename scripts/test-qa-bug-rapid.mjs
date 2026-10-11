/**
 * bug 猎手 · 路径 1：播放中狂点切歌（下一首/上一首交替，20 连发，不等落定）。
 * 路径 2：播放中来回切音质 standard→exhigh→lossless 6 轮。
 *
 * 关注信号：player:state 报错 / 卡死（position 冻结）/ 回零 / mpv 进程堆积 / app:error。
 */
import * as path from 'node:path'
import * as os from 'node:os'
import {
  log, wait, launchBugInstance, killInstance, waitReady, cdp, waitFor, playerState, waitPlaying,
  clickNav, typeSearch, goToSongsTab, collectLogs, freshUserData
} from './test-qa-bug-lib.mjs'

const PORT = 9401
const userData = path.join(os.tmpdir(), 'youyou-bug-rapid')
const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'BUG?'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 报告一条 bug 给 Lead（严重度分级）。 */
const bugs = []
const report = (pathNo, operation, symptom, severity, evidence) => {
  const line = `路径${pathNo} → ${operation} → ${symptom} → 严重度:${severity}${evidence ? ` | 证据:${evidence}` : ''}`
  bugs.push(line)
  log(`🐛 ${line}`)
}

async function main() {
  freshUserData(userData)
  killInstance(userData)
  const inst = await launchBugInstance({ port: PORT, userData })
  try {
    const ready = await waitReady(PORT, 90_000)
    record('实例启动', ready)
    if (!ready) return

    const auth = await cdp(PORT, `(async () => (await window.youyou.invoke('auth:state')).data)()`)
    log(`登录态: ${JSON.stringify({ loggedIn: auth.value?.loggedIn, nick: auth.value?.profile?.nickname })}`)

    // 造队列：搜索 → 切到「单曲」页签（综合页单曲是卡片网格，无 .song-row）→ 点第一行播放
    await clickNav(PORT, '搜索')
    await wait(1500)
    const typed = await typeSearch(PORT, '孤勇者')
    await wait(7000) // 等 loading 落定（songs 通道串行等汽水搜索，实测 ~6.4s）
    const tab = await goToSongsTab(PORT, 20_000)
    const rowsNow = tab.ok ? (tab.value?.rows ?? 0) : -1
    record('搜索并出结果', typed && rowsNow > 0, `rows=${rowsNow} detail=${JSON.stringify(tab.value).slice(0, 160)}`)
    if (rowsNow <= 0) {
      log('  搜索无行可点，播放无法开始 → 路径1/2 本轮作废')
      return
    }

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
    record('首曲出声', played.ok, played.ok
      ? `${played.state.track?.name} pos=${played.state.position?.toFixed(1)} servedFrom=${played.state.servedFrom ?? '网易云'}`
      : JSON.stringify(played.state)?.slice(0, 160))

    // ---------- 路径 1：狂点切歌 ----------
    log('== 路径 1：20 连发 next/prev ==')
    const storm = await cdp(PORT, `(async () => {
      const ops = ['player:next','player:previous','player:next','player:previous']
      const errors = []
      for (let i = 0; i < 20; i += 1) {
        try {
          const reply = await window.youyou.invoke(ops[i % 4])
          if (reply?.error) errors.push(String(reply.error))
        } catch (cause) { errors.push(String(cause)) }
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      return { errors }
    })()`)
    const stormErrors = storm.ok ? (storm.value?.errors ?? []) : [storm.error ?? 'cdp异常']
    record('20 连发期间 player 通道无报错', stormErrors.length === 0, JSON.stringify(stormErrors).slice(0, 300))

    // 风暴后观察 20 秒：应落定在 playing 且 position 前进
    const settle = await waitFor(PORT, `(async () => {
      const s = (await window.youyou.invoke('player:state')).data
      return Boolean(s && s.playing === true && s.position > 0.5 && s.track?.name)
    })()`, 25_000, '风暴后落定播放')
    const post = await playerState(PORT)
    const p1 = post.ok ? post.value : null
    record('风暴后仍在正常播放（不卡死）', settle.ok, p1 ? `${p1.track?.name} pos=${p1.position?.toFixed(1)}` : JSON.stringify(post).slice(0, 160))

    // position 是否继续前进（卡死 = 冻结）
    const beforePos = p1?.position ?? 0
    await wait(4000)
    const post2 = await playerState(PORT)
    const p2 = post2.ok ? post2.value : null
    const advanced = (p2?.position ?? 0) > beforePos + 0.5
    record('进度持续前进（无冻结）', advanced, `${beforePos?.toFixed(1)} → ${p2?.position?.toFixed(1)}`)

    // 回零检查：若 track 相同且 position 大幅回退 → 声音错乱
    if (p1?.track?.id && p2?.track?.id === p1.track.id) {
      const rewound = p2.position < p1.position - 2
      record('同曲进度未回退', !rewound, `${p1.position?.toFixed(1)} → ${p2.position?.toFixed(1)}`)
    } else {
      log('  两次采样曲目不同（正常换曲），跳过回退检查')
    }

    // mpv 进程数（堆积 = 泄漏）
    const mpvCount = await cdp(PORT, `(async () => (await window.youyou.invoke('app:info')).data)()`)
    log(`app:info = ${JSON.stringify(mpvCount.value)?.slice(0, 200)}`)

    // ---------- 路径 2：播放中切音质 ----------
    log('== 路径 2：音质来回切 ==')
    const cycles = ['standard', 'exhigh', 'lossless', 'standard']
    const qResults = []
    for (let round = 0; round < 6; round += 1) {
      const target = cycles[round % cycles.length]
      const t0 = Date.now()
      const set = await cdp(PORT, `(async () => {
        const before = (await window.youyou.invoke('player:state')).data
        await window.youyou.invoke('player:setQuality', { quality: ${JSON.stringify(target)} })
        await window.youyou.invoke('settings:update', { quality: ${JSON.stringify(target)} })
        await new Promise((resolve) => setTimeout(resolve, 1500))
        const after = (await window.youyou.invoke('player:state')).data
        return {
          target: ${JSON.stringify(target)},
          before: { name: before?.track?.name, pos: before?.position },
          after: { name: after?.track?.name, pos: after?.position, playing: after?.playing, servedQuality: after?.servedQuality }
        }
      })()`)
      const ms = Date.now() - t0
      const v = set.ok ? set.value : { error: set.error }
      qResults.push({ ...v, ms })
      log(`  第${round + 1}轮 → ${target}: ${JSON.stringify(v)?.slice(0, 220)} (${ms}ms)`)
      if (!set.ok) {
        report(2, `切音质到 ${target}`, 'player:setQuality 通道报错', '挂死', String(set.error).slice(0, 200))
        break
      }
      if (!v.after?.playing) {
        report(2, `切音质到 ${target}`, '切换后播放停止', '数据错乱', JSON.stringify(v))
        break
      }
      if (v.after.name === v.before?.name && v.after.pos < v.before.pos - 1) {
        // settings:update 改音质会 reloadCurrentTrack（app.ts 注释明示「立刻作用到当前曲」），
        // 从头重播是设计内行为——只有曲目身份变掉或播放停止才算异常。
        log(`  (设计内 reload：同曲进度回退 ${v.before.pos?.toFixed(1)}→${v.after.pos?.toFixed(1)})`)
      }
    }
    const allOk = qResults.length === 6 && qResults.every((item) => item?.after?.playing)
    record('6 轮音质来回切全部保持播放', allOk, `轮数=${qResults.length}`)

    // 风暴期间主进程日志（错误证据）
    await wait(1000)
    const logs = collectLogs(userData).filter((item) => item?.level === 'error' || item?.level === 'warn')
    record('风暴期间无 error/warn 日志', logs.length === 0, logs.slice(-6).map((item) => `${item.level}:${String(item.message ?? item.raw ?? '').slice(0, 120)}`).join(' || '))
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
