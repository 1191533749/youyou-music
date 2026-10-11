/**
 * bug 猎手 · 路径 9：私人漫游（FM）刁钻操作。
 * - track:fm 取曲池 → playFMTracks 出声（汽水源）
 * - 播放中连点「不喜欢」(track:fmTrash) 20 发 + 切歌风暴
 * - 队列归零（clearQueue）后 next/previous/append 的行为
 * - 归零后重新 playFMTracks 恢复
 */
import * as path from 'node:path'
import * as os from 'node:os'
import {
  log, wait, launchBugInstance, killInstance, waitReady, cdp, playerState, waitPlaying, freshUserData
} from './test-qa-bug-lib.mjs'

const PORT = 9419
const userData = path.join(os.tmpdir(), 'youyou-bug-fm')
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

async function main() {
  freshUserData(userData)
  killInstance(userData)
  const inst = await launchBugInstance({ port: PORT, userData, cookie: true, fixture: false })
  try {
    const ready = await waitReady(PORT, 90_000)
    record('实例启动', ready)
    if (!ready) return

    // 取曲池（预热池通常已满；空池时现场填一轮）
    const t0 = Date.now()
    const fm = await cdp(PORT, `(async () => {
      const t = Date.now()
      try {
        const reply = await Promise.race([
          window.youyou.invoke('track:fm'),
          new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), 90_000))
        ])
        const tracks = reply?.__timeout ? [] : (reply?.data ?? [])
        window.__qaFMTracks = tracks
        return { timeout: reply?.__timeout === true, n: tracks.length, ids: tracks.slice(0, 3).map((x) => x.id), names: tracks.slice(0, 3).map((x) => x.name), error: reply?.error ?? null }
      } catch (cause) { return { throw: String(cause).slice(0, 140) } }
    })()`)
    const fv = fm.value ?? {}
    record('track:fm 返回曲池', fm.ok && !fv.timeout && (fv.n ?? 0) > 0, `${Date.now() - t0}ms ${JSON.stringify(fv)}`.slice(0, 220))
    if (!(fv.n > 0)) {
      log('  曲池为空（汽水接口失败？），漫游场景作废')
      return
    }

    // 漫游出声：playFMTracks 必须回传 track:fm 给的同一批 DTO（负 id 走 recallExternal）
    const played = await cdp(PORT, `(async () => {
      const reply = await window.youyou.invoke('player:playFMTracks', { tracks: window.__qaFMTracks })
      return { error: reply?.error ?? null }
    })()`)
    const playing = await waitPlaying(PORT, 60_000)
    record('漫游起播出声', playing.ok, playing.ok ? `${playing.state.track?.name} id=${playing.state.track?.id} pos=${playing.state.position?.toFixed(1)}` : JSON.stringify(playing.state)?.slice(0, 160))

    // 连点不喜欢 + 切歌风暴
    log('== 不喜欢连点 20 发 + 切歌 ==')
    const storm = await cdp(PORT, `(async () => {
      const errors = []
      for (let i = 0; i < 20; i += 1) {
        try {
          const st = (await window.youyou.invoke('player:state')).data
          const id = st?.track?.id ?? -1
          const trash = await window.youyou.invoke('track:fmTrash', { id })
          if (trash?.error) errors.push('trash:' + trash.error)
          if (i % 3 === 0) {
            const nx = await window.youyou.invoke('player:next')
            if (nx?.error) errors.push('next:' + nx.error)
          }
        } catch (cause) { errors.push(String(cause).slice(0, 100)) }
        await new Promise((resolve) => setTimeout(resolve, 80))
      }
      return { errors: errors.slice(0, 10), count: errors.length }
    })()`)
    const sv = storm.value ?? {}
    record('不喜欢/切歌连点无报错', storm.ok && sv.count === 0, JSON.stringify(sv).slice(0, 200))
    if (sv.count > 0) report(9, '漫游连点不喜欢/切歌', '通道报错', '体验差', JSON.stringify(sv).slice(0, 200))

    await wait(3000)
    const post = await playerState(PORT)
    const p = post.value
    record('风暴后播放器仍在正常播放或明确停止（不假死）', post.ok, JSON.stringify({ playing: p?.playing, name: p?.track?.name, pos: p?.position?.toFixed?.(1) }).slice(0, 140))

    // 队列归零
    log('== 队列归零 ==')
    const zero = await cdp(PORT, `(async () => {
      try {
        await window.youyou.invoke('player:clearQueue')
        await new Promise((resolve) => setTimeout(resolve, 1500))
        const st = (await window.youyou.invoke('player:state')).data
        return { queueLen: st?.queue?.length ?? -1, playing: st?.playing, currentName: st?.track?.name ?? null, error: st?.error ?? null }
      } catch (cause) { return { throw: String(cause).slice(0, 140) } }
    })()`)
    const zv = zero.value ?? {}
    log(`  归零后: ${JSON.stringify(zv)}`)
    record('clearQueue 后队列长度 0', zv.queueLen === 0, JSON.stringify(zv).slice(0, 140))
    if (zv.throw) report(9, '漫游中 clearQueue', '清空队列通道异常', '体验差', String(zv.throw).slice(0, 140))

    // 归零后 next/previous 应无副作用
    const nextZero = await cdp(PORT, `(async () => {
      const errors = []
      try {
        const a = await window.youyou.invoke('player:next')
        if (a?.error) errors.push('next:' + a.error)
        const b = await window.youyou.invoke('player:previous')
        if (b?.error) errors.push('prev:' + b.error)
        const st = (await window.youyou.invoke('player:state')).data
        return { errors, queueLen: st?.queue?.length ?? -1, playing: st?.playing }
      } catch (cause) { return { throw: String(cause).slice(0, 140) } }
    })()`)
    const nv = nextZero.value ?? {}
    record('空队列 next/previous 无报错不崩溃', nextZero.ok && (nv.errors ?? []).length === 0 && !nv.throw, JSON.stringify(nv).slice(0, 160))
    if (nv.throw) report(9, '空队列 next/previous', '空队列切歌崩溃', '崩溃', String(nv.throw).slice(0, 140))

    // 归零后重新漫游仍可用
    const refill = await cdp(PORT, `(async () => {
      const reply = await window.youyou.invoke('track:fm')
      const tracks = reply?.data ?? []
      if (tracks.length === 0) return { n: 0 }
      const play = await window.youyou.invoke('player:playFMTracks', { tracks })
      return { n: tracks.length, error: play?.error ?? null }
    })()`)
    const rv = refill.value ?? {}
    const replay = await waitPlaying(PORT, 60_000)
    record('队列归零后漫游能重新出声', refill.ok && (rv.n ?? 0) > 0 && replay.ok, JSON.stringify({ n: rv.n, playing: replay.state?.track?.name }).slice(0, 140))

    const alive = await cdp(PORT, `Boolean(window.youyou)`).then((r) => r.ok && r.value === true).catch(() => false)
    record('全程实例存活', alive)
    if (!alive) report(9, '漫游全套操作', '实例崩溃', '崩溃', 'cdp 无响应')
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
