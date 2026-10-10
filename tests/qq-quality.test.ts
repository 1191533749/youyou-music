/**
 * QQ 音源取地址的档位计划（纯函数，不联网）。
 *
 * 这一层决定了「绑定 QQ 会员之后到底请求哪一档」：
 * 匿名只能拿 128kbps，320kbps 必须带 cookie，所以 M800 只在
 * 「已绑定 + 设置里选了 ≥320kbps」时才会出现；同时必须保留匿名兜底，
 * 否则 cookie 一旦过期，连免费歌都会解析失败。
 */
import { describe, expect, it } from 'vitest'
import { qqFilenamePlan } from '../src/main/unblock/providers.js'

const MEDIA_MID = '003Qui1q2u1Zho'

describe('QQ 取地址的档位计划', () => {
  it('未绑定账号：只发一条匿名 M500', () => {
    expect(qqFilenamePlan(MEDIA_MID, { authed: false })).toEqual([
      { filename: `M500${MEDIA_MID}.mp3`, bitrate: 128, authed: false }
    ])
  })

  it('未绑定账号即使设置选了 320kbps 也不会去要 M800（匿名拿不到）', () => {
    expect(qqFilenamePlan(MEDIA_MID, { authed: false, highQuality: true })).toEqual([
      { filename: `M500${MEDIA_MID}.mp3`, bitrate: 128, authed: false }
    ])
  })

  it('绑定 + 设置选 320kbps：先 M800，再 M500，最后匿名 M500 兜底', () => {
    expect(qqFilenamePlan(MEDIA_MID, { authed: true, highQuality: true })).toEqual([
      { filename: `M800${MEDIA_MID}.mp3`, bitrate: 320, authed: true },
      { filename: `M500${MEDIA_MID}.mp3`, bitrate: 128, authed: true },
      { filename: `M500${MEDIA_MID}.mp3`, bitrate: 128, authed: false }
    ])
  })

  it('绑定但设置是 128kbps：不请求 M800', () => {
    expect(qqFilenamePlan(MEDIA_MID, { authed: true, highQuality: false })).toEqual([
      { filename: `M500${MEDIA_MID}.mp3`, bitrate: 128, authed: true },
      { filename: `M500${MEDIA_MID}.mp3`, bitrate: 128, authed: false }
    ])
  })

  it('拿不到 media_mid：只有 96kbps 的一条（已绑定再补匿名兜底）', () => {
    expect(qqFilenamePlan(undefined, { authed: false })).toEqual([{ bitrate: 96, authed: false }])
    expect(qqFilenamePlan(undefined, { authed: true })).toEqual([
      { bitrate: 96, authed: true },
      { bitrate: 96, authed: false }
    ])
  })

  it('已绑定的候选里永远保留一条匿名请求', () => {
    const plan = qqFilenamePlan(MEDIA_MID, { authed: true, highQuality: true })
    expect(plan.some((step) => !step.authed)).toBe(true)
    expect(plan[plan.length - 1].authed).toBe(false)
  })
})
