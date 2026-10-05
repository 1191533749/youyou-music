/**
 * 换源播放的端到端验证。
 *
 * 直接用真实网易云 API + 真实第三方音源 + 假的 mpv 后端驱动完整的
 * PlayerController：确认一首必然受限的歌（VIP 单曲）最终能拿到可播放地址，
 * 且来源被标记为第三方音源。这条链路是整个「任何歌曲都能完整播放」需求的
 * 关键路径，必须能在真实网络下跑通。
 *
 * 假的 mpv 只记录「被要求打开什么」，不真的解码——音频输出已由
 * tests/mpv.test.ts 用真实 mpv 覆盖。
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NeteaseClient } from '../src/main/netease/client.js'
import { NeteaseAPI } from '../src/main/netease/api.js'
import { UnblockService } from '../src/main/unblock/service.js'
import { PlayerController } from '../src/main/player/controller.js'
import type { Track } from '../src/main/netease/models.js'

/** 只实现 PlayerController 会用到的那几个方法。 */
class FakeMpv extends EventEmitter {
  opened: string[] = []
  paused = true
  volume = 80

  async play(url: string): Promise<void> {
    this.opened.push(url)
    this.paused = false
  }

  async setPaused(value: boolean): Promise<void> {
    this.paused = value
  }

  async setVolume(value: number): Promise<void> {
    this.volume = value
  }

  async setMuted(): Promise<void> {}

  async seek(): Promise<void> {}

  async unload(): Promise<void> {}

  async stop(): Promise<void> {}

  async trackInfo(): Promise<{ duration: number }> {
    return { duration: 0 }
  }
}

/** 晴天 / 周杰伦：付费单曲，官方接口不会给出完整音频。 */
const VIP_TRACK: Track = {
  id: 186016,
  name: '晴天',
  artists: [{ id: 6452, name: '周杰伦' }],
  album: { id: 34720827, name: '叶惠美' },
  durationMS: 269_000,
  alias: [],
  transNames: [],
  fee: 1,
  mvID: 0,
  trackNo: 3,
  noCopyright: false,
  isCloud: false
}

function buildPlayer(options: { unblock: boolean }) {
  const client = new NeteaseClient({ cookieDirectory: mkdtempSync(join(tmpdir(), 'kumone-unblock-')) })
  const api = new NeteaseAPI(client)
  const mpv = new FakeMpv()
  const unblock = new UnblockService({
    isEnabled: () => options.unblock,
    enabledSources: () => ['pyncmd', 'kugou', 'kuwo'],
    log: () => undefined
  })
  const player = new PlayerController({
    api,
    mpv: mpv as never,
    unblock,
    isUnblockEnabled: () => options.unblock,
    unblockSourceIds: () => ['pyncmd', 'kugou', 'kuwo'],
    getQuality: () => 'exhigh',
    autoDowngrade: () => true,
    getScrobble: () => false,
    getLoggedIn: () => false,
    getVipType: () => 0,
    log: () => undefined
  })
  return { player, mpv }
}

describe('受限歌曲换源播放', () => {
  it('开启换源后，VIP 单曲能拿到可播放地址并标记来源', async () => {
    const { player, mpv } = buildPlayer({ unblock: true })
    await player.setQueue([VIP_TRACK], 0)

    const snapshot = player.snapshot()
    console.log(
      `结果：servedFrom=${snapshot.servedFrom ?? '(官方音源)'} level=${snapshot.servedQuality} ` +
        `error=${snapshot.error ?? '-'}\n     地址=${mpv.opened[0]?.slice(0, 78) ?? '(未打开任何地址)'}`
    )

    expect(mpv.opened.length).toBe(1)
    expect(mpv.opened[0]).toMatch(/^https?:\/\//)
    expect(snapshot.error).toBeUndefined()
    // 官方地址不可能拿到，所以来源必须是第三方音源之一。
    expect(snapshot.servedFrom).toBeTruthy()
    await player.shutdown()
  }, 120_000)

  it('关闭换源后，VIP 单曲给出明确的可行动错误，而不是静默失败', async () => {
    const { player, mpv } = buildPlayer({ unblock: false })
    await player.setQueue([VIP_TRACK], 0)

    const snapshot = player.snapshot()
    console.log(`结果：error=${snapshot.error ?? '(无)'} 地址数=${mpv.opened.length}`)
    expect(mpv.opened.length).toBe(0)
    expect(snapshot.error).toBeTruthy()
    await player.shutdown()
  }, 60_000)
})
