/**
 * bug 猎手 · 路径 11：设置页来回切（theme/quality/cacheDirectory + 非法值灌入）。
 * 期望：合法值立刻生效并持久化；非法值被 sanitise 丢弃（回读为默认/旧值）；
 *       播放中改音质不打断播放；settings.json 始终可解析；改缓存目录不崩。
 */
import * as path from 'node:path'
import * as os from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import {
  log, wait, launchBugInstance, killInstance, waitReady, cdp, playerState, waitPlaying, freshUserData
} from './test-qa-bug-lib.mjs'

const PORT = 9420
const userData = path.join(os.tmpdir(), 'youyou-bug-settings')
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

async function main() {
  freshUserData(userData)
  killInstance(userData)
  const inst = await launchBugInstance({ port: PORT, userData })
  try {
    const ready = await waitReady(PORT, 90_000)
    record('实例启动', ready)
    if (!ready) return

    // 起播（缓存曲）
    await cdp(PORT, `(async () => (await window.youyou.invoke('player:playTracks', { tracks: ${JSON.stringify([FIXTURE_DTO])}, startIndex: 0 })).data)()`)
    const playing = await waitPlaying(PORT, 30_000)
    record('设置切换前出声中', playing.ok, JSON.stringify({ name: playing.state?.track?.name, pos: playing.state?.position?.toFixed?.(1) }))
    if (!playing.ok) return

    // 合法值来回切 6 轮（播放中改 quality 会 reloadCurrentTrack）
    const legal = []
    const rounds = [
      { theme: 'dark', quality: 'standard' },
      { theme: 'light', quality: 'exhigh' },
      { theme: 'system', quality: 'lossless' },
      { theme: 'dark', quality: 'higher' },
      { theme: 'light', quality: 'standard' },
      { theme: 'dark', quality: 'exhigh' }
    ]
    const cycled = await cdp(PORT, `(async () => {
      const results = []
      for (const patch of ${JSON.stringify(rounds)}) {
        try {
          const reply = await window.youyou.invoke('settings:update', patch)
          results.push({ error: reply?.error ?? null, theme: reply?.data?.theme, quality: reply?.data?.quality })
        } catch (cause) { results.push({ throw: String(cause).slice(0, 100) }) }
        await new Promise((resolve) => setTimeout(resolve, 1200))
      }
      const st = (await window.youyou.invoke('player:state')).data
      return { results, playing: st?.playing, pos: st?.position, servedQuality: st?.servedQuality }
    })()`)
    const cv = cycled.value ?? {}
    const allApplied = cv.results?.length === 6 && cv.results.every((r) => !r.error && !r.throw)
    record('6 轮 theme/quality 全部应用无报错', cycled.ok && allApplied, JSON.stringify(cv.results).slice(0, 220))
    record('设置来回切期间播放未被打断', cv.playing === true, `pos=${cv.pos?.toFixed?.(1)} q=${cv.servedQuality}`)
    if (cv.playing !== true) report(11, '播放中来回切 theme/quality', '切换导致播放停止', '数据错乱', JSON.stringify({ playing: cv.playing, pos: cv.pos }))

    // 非法值灌入：应被 sanitise 丢弃，回读为合法值
    const illegal = await cdp(PORT, `(async () => {
      const shots = [
        { theme: 'neon', quality: 'ultra', cacheLimitMB: -999, desktopLyricsFontSize: 9999, desktopLyricsOpacity: 99 },
        { theme: 42, quality: 7, language: 'klingon', volume: 1e9, unblockSources: ['hacker', 'qishui'] },
        { theme: null, cacheDirectory: '', audioDevice: 123, desktopLyricsLocked: 'yes' }
      ]
      const out = []
      for (const patch of shots) {
        try {
          const reply = await window.youyou.invoke('settings:update', patch)
          out.push({ error: reply?.error ?? null })
        } catch (cause) { out.push({ throw: String(cause).slice(0, 100) }) }
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
      const got = await window.youyou.invoke('settings:get')
      const s = got?.data ?? {}
      return { out, final: { theme: s.theme, quality: s.quality, cacheLimitMB: s.cacheLimitMB, desktopLyricsFontSize: s.desktopLyricsFontSize, desktopLyricsOpacity: s.desktopLyricsOpacity, language: s.language, volume: s.volume, desktopLyricsLocked: s.desktopLyricsLocked, unblockSources: s.unblockSources } }
    })()`)
    const iv = illegal.value ?? {}
    record('非法值灌入不报错（通道层）', illegal.ok && (iv.out ?? []).every((r) => !r.error && !r.throw), JSON.stringify(iv.out).slice(0, 160))
    const sane =
      ['dark', 'light', 'system'].includes(iv.final?.theme) &&
      ['standard', 'higher', 'exhigh', 'lossless', 'hires', 'jyeffect', 'sky', 'jymaster'].includes(iv.final?.quality) &&
      iv.final?.cacheLimitMB >= 0 &&
      iv.final?.desktopLyricsFontSize >= 12 && iv.final?.desktopLyricsFontSize <= 96 &&
      iv.final?.desktopLyricsOpacity >= 0.2 && iv.final?.desktopLyricsOpacity <= 1 &&
      ['system', 'zh-Hans', 'en'].includes(iv.final?.language) &&
      iv.final?.volume >= 0 && iv.final?.volume <= 150 &&
      typeof iv.final?.desktopLyricsLocked === 'boolean'
    record('非法值全部被消毒（回读值合法）', Boolean(sane), JSON.stringify(iv.final).slice(0, 240))
    if (!sane) report(11, '灌入非法设置值', '非法值穿透写入配置', '数据错乱', JSON.stringify(iv.final).slice(0, 240))

    // 缓存目录切到不存在的盘符路径：更新本身应成功（写发生在下载时），后续播放不受影响
    const badDir = await cdp(PORT, `(async () => {
      try {
        const reply = await window.youyou.invoke('settings:update', { cacheDirectory: 'Q:\\\\不存在的盘\\\\cache' })
        const st = (await window.youyou.invoke('player:state')).data
        return { error: reply?.error ?? null, got: reply?.data?.cacheDirectory ?? null, playing: st?.playing }
      } catch (cause) { return { throw: String(cause).slice(0, 120) } }
    })()`)
    const bv = badDir.value ?? {}
    record('切缓存目录到坏路径不崩、播放继续', badDir.ok && !bv.error && !bv.throw && bv.playing === true, JSON.stringify(bv).slice(0, 160))

    // settings.json 落盘可解析
    const fileOk = existsSync(path.join(userData, 'settings.json')) && (() => {
      try { JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8')); return true } catch { return false }
    })()
    record('settings.json 落盘且可解析', fileOk)

    const alive = await cdp(PORT, `Boolean(window.youyou)`).then((r) => r.ok && r.value === true).catch(() => false)
    record('全程实例存活', alive)
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
