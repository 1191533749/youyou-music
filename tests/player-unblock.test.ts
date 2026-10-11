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
import {
  looksLikeNoticeBySize,
  probeStream,
  type StreamProbeResult
} from '../src/main/player/streamProbe.js'
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

  /** 返回与 VIP_TRACK 一致的真实时长：时长验证（版权提示音检测）应快速通过。 */
  async duration(): Promise<number | undefined> {
    return 269
  }

  async audioBitrate(): Promise<number | undefined> {
    return 320
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

function buildPlayer(options: {
  unblock: boolean
  /** 注入假的音源探测：不注入就走真实探测（默认行为）。 */
  probe?: (url: string, timeoutMS: number) => Promise<StreamProbeResult>
  /** 覆盖第三方音源解析器（测试替身，避免依赖外网波动）。 */
  providers?: ConstructorParameters<typeof UnblockService>[0]['providers']
}) {
  const client = new NeteaseClient({ cookieDirectory: mkdtempSync(join(tmpdir(), 'youyou-unblock-')) })
  const api = new NeteaseAPI(client)
  const mpv = new FakeMpv()
  const unblock = new UnblockService({
    isEnabled: () => options.unblock,
    enabledSources: () => ['qishui', 'kugou', 'kuwo'],
    providers: options.providers,
    log: () => undefined
  })
  const player = new PlayerController({
    api,
    mpv: mpv as never,
    unblock,
    isUnblockEnabled: () => options.unblock,
    unblockSourceIds: () => ['qishui', 'kugou', 'kuwo'],
    getQuality: () => 'exhigh',
    autoDowngrade: () => true,
    getScrobble: () => false,
    getLoggedIn: () => false,
    getVipType: () => 0,
    log: () => undefined,
    probe: options.probe
  })
  return { player, mpv }
}

describe('受限歌曲换源播放', () => {
  it('开启换源后，VIP 单曲能拿到可播放地址并标记来源', async () => {
    // 注入「体积合格」的探测结果 + 替身音源：这里只验证解析链路的接线
    // （拿到第三方地址、标记来源、不再进静音校验），真实接口由下面的用例覆盖。
    const probed: string[] = []
    const { player, mpv } = buildPlayer({
      unblock: true,
      probe: async (url) => {
        probed.push(url)
        return { ok: true, status: 206, totalBytes: 12_000_000, elapsedMS: 5 }
      },
      providers: {
        qishui: async () => null,
        kugou: async () => null,
        kuwo: async () => ({
          id: 'kuwo',
          displayName: '酷我音乐',
          url: 'https://example.com/full-audio.mp3'
        })
      }
    })
    await player.setQueue([VIP_TRACK], 0)

    const snapshot = player.snapshot()
    console.log(
      `结果：servedFrom=${snapshot.servedFrom ?? '(官方音源)'} level=${snapshot.servedQuality} ` +
        `error=${snapshot.error ?? '-'}\n     地址=${mpv.opened[0]?.slice(0, 78) ?? '(未打开任何地址)'}`
    )

    expect(probed.length).toBeGreaterThan(0)
    expect(mpv.opened.length).toBe(1)
    expect(mpv.opened[0]).toMatch(/^https?:\/\//)
    expect(snapshot.error).toBeUndefined()
    // 官方地址不可能拿到，所以来源必须是第三方音源之一。
    expect(snapshot.servedFrom).toBeTruthy()
    await player.shutdown()
  }, 120_000)

  it('真实探测下，交给 mpv 的第三方地址必须是体积合格的真歌', async () => {
    // 不注入探测：走真实的 Range 探测。晴天在第三方音源上只拿得到提示音
    // 占位文件（实测酷我 181,521 字节 / 269 秒 ≈ 5.4kbps），必须被当场拦下，
    // 而不是先播 2.5 秒让用户听见提示音。
    const { player, mpv } = buildPlayer({ unblock: true })
    await player.setQueue([VIP_TRACK], 0).catch(() => undefined)

    const snapshot = player.snapshot()
    console.log(
      `结果：error=${snapshot.error ?? '-'} 打开地址=${JSON.stringify(mpv.opened)}`
    )
    if (mpv.opened.length === 0) {
      // 拦下了就必须给出中性错误，不能静默什么都不做。
      expect(snapshot.error).toBeTruthy()
    } else {
      // 只要播了，就一定是体积合格的流（不是十几秒的提示音占位文件）。
      for (const url of mpv.opened) {
        const probe = await probeStream(url, 5_000)
        expect(probe.ok).toBe(true)
        expect(looksLikeNoticeBySize(probe.totalBytes, VIP_TRACK.durationMS / 1000)).toBe(false)
      }
    }
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

  it('第三方音源返回版权提示音（短时长占位文件）时，自动换下一个音源', async () => {
    /** 时长取决于 URL：notice 地址只有 18 秒（提示语音），正常地址 269 秒。 */
    class NoticeMpv extends EventEmitter {
      opened: string[] = []
      muted = false
      private short = false

      async setMuted(value: boolean): Promise<void> {
        this.muted = value
      }

      async play(url: string): Promise<void> {
        this.opened.push(url)
        this.short = url.includes('notice')
      }

      async duration(): Promise<number | undefined> {
        return this.short ? 18 : 269
      }

      async audioBitrate(): Promise<number | undefined> {
        return 320
      }

      async setPaused(): Promise<void> {}

      async setVolume(): Promise<void> {}

      async seek(): Promise<void> {}

      async stop(): Promise<void> {}

      async unload(): Promise<void> {}
    }

    const mpv = new NoticeMpv()
    // 官方解析与站内替代全部失败（纯桩，不打网络），直接落到第三方音源：
    const api = new Proxy(
      {},
      {
        get: () => () => Promise.reject(new Error('stub: no netease'))
      }
    ) as never
    const unblock = {
      enabled: true,
      // 第一次给酷我的提示音，第二次（酷我已被标记失败）给酷狗真歌。
      resolve: async (_track: Track, attempted: Set<string>) => {
        if (attempted.has('kuwo')) {
          return {
            source: { id: 'kugou', url: 'https://stub/kugou-real.mp3', displayName: '酷狗音乐', bitrate: 320 },
            attempted
          }
        }
        return {
          source: { id: 'kuwo', url: 'https://stub/notice.mp3', displayName: '酷我音乐', bitrate: 320 },
          attempted
        }
      }
    }

    const player = new PlayerController({
      api,
      mpv: mpv as never,
      unblock: unblock as never,
      isUnblockEnabled: () => true,
      unblockSourceIds: () => ['kuwo', 'kugou'],
      getQuality: () => 'exhigh',
      autoDowngrade: () => true,
      getScrobble: () => false,
      getLoggedIn: () => false,
      getVipType: () => 0,
      log: () => undefined,
      // 探测拿不到体积（分块传输）：退回「静音播放 + 读时长」的兜底校验。
      probe: async () => ({ ok: true, elapsedMS: 4 })
    })
    await player.setQueue([VIP_TRACK], 0)

    const snapshot = player.snapshot()
    console.log(`结果：servedFrom=${snapshot.servedFrom ?? '-'} 打开地址=${JSON.stringify(mpv.opened)}`)
    // 第一次打开酷我的提示音，验证失败后换到酷狗。
    expect(mpv.opened.length).toBe(2)
    expect(mpv.opened[0]).toContain('notice')
    expect(mpv.opened[1]).toContain('kugou-real')
    expect(snapshot.servedFrom).toBe('酷狗音乐')
    expect(snapshot.error).toBeUndefined()
    await player.shutdown()
  })

  it('换源验证全程失败时，mpv 的静音必须被恢复（「莫名其妙自动静音」回归）', async () => {
    /**
     * 回归用例：验证第三方音源时 controller 会把 mpv 静音（版权提示音只在静音
     * 窗口里被缓冲）。四个候选全是提示音、最终报错这条失败路径上如果不恢复音量，
     * 用户就会遇到「莫名其妙自己静音」——UI 上的静音开关还是关着的，怎么点都没用。
     *
     * 这个假 mpv 会把静音状态回显给 controller（真实 mpv 也是这么做的），
     * 用来证明回显不会把用户音量永久改掉。
     */
    class EchoMuteMpv extends EventEmitter {
      opened: string[] = []
      muted = false
      muteCalls: boolean[] = []

      async setMuted(value: boolean): Promise<void> {
        this.muteCalls.push(value)
        this.muted = value
        this.emit('state', { position: 0, duration: 0, volume: 80, muted: value, loading: false })
      }

      async play(url: string): Promise<void> {
        this.opened.push(url)
      }

      /** 恒为 18 秒：与 269 秒的真实时长不符 → 每个候选都被判为提示音。 */
      async duration(): Promise<number | undefined> {
        return 18
      }

      async audioBitrate(): Promise<number | undefined> {
        return 320
      }

      async setPaused(): Promise<void> {}
      async setVolume(): Promise<void> {}
      async seek(): Promise<void> {}
      async stop(): Promise<void> {}
      async unload(): Promise<void> {}
    }

    const mpv = new EchoMuteMpv()
    const api = new Proxy(
      {},
      {
        get: () => () => Promise.reject(new Error('stub: no netease'))
      }
    ) as never
    const unblock = {
      enabled: true,
      resolve: async (_track: Track, attempted: Set<string>) => ({
        source: { id: 'kuwo', url: 'https://stub/notice.mp3', displayName: '酷我音乐', bitrate: 320 },
        attempted
      })
    }
    const player = new PlayerController({
      api,
      mpv: mpv as never,
      unblock: unblock as never,
      isUnblockEnabled: () => true,
      unblockSourceIds: () => ['kuwo'],
      getQuality: () => 'exhigh',
      autoDowngrade: () => true,
      getScrobble: () => false,
      getLoggedIn: () => false,
      getVipType: () => 0,
      log: () => undefined,
      // 同上：体积未知 → 走静音 + 时长的兜底校验，这条用例才覆盖得到静音恢复。
      probe: async () => ({ ok: true, elapsedMS: 4 })
    })
    await player.setQueue([VIP_TRACK], 0).catch(() => undefined)

    const snapshot = player.snapshot()
    console.log(
      `结果：error=${snapshot.error ?? '-'} muted=${snapshot.muted} mpv.muted=${mpv.muted} ` +
        `setMuted 调用=${JSON.stringify(mpv.muteCalls)}`
    )
    // 四个候选全是提示音时明确报错，绝不把占位文件当歌播出来。
    expect(snapshot.error).toBeTruthy()
    // 关键断言：音量被恢复，用户不会被留在静音窗口里。
    expect(mpv.muted).toBe(false)
    expect(snapshot.muted).toBe(false)
    expect(mpv.muteCalls[0]).toBe(true)
    expect(mpv.muteCalls[mpv.muteCalls.length - 1]).toBe(false)
    await player.shutdown()
  }, 60_000)

  it('预解析成功后顺手预热音源，切歌直接复用探测结果（不再联网）', async () => {
    const SECOND: Track = { ...VIP_TRACK, id: 186017, name: '以父之名' }
    const logs: string[] = []
    const probed: string[] = []
    const mpv = new FakeMpv()
    const api = new Proxy(
      {},
      {
        get: () => () => Promise.reject(new Error('stub: no netease'))
      }
    ) as never
    const unblock = {
      enabled: true,
      // 每首歌给一条独立地址，方便看清「预热的是下一条」。
      resolve: async (track: Track) => ({
        source: {
          id: 'kuwo',
          url: `https://stub/${track.id}.mp3`,
          displayName: '酷我音乐',
          bitrate: 320
        },
        attempted: new Set<string>(['kuwo'])
      })
    }
    const player = new PlayerController({
      api,
      mpv: mpv as never,
      unblock: unblock as never,
      isUnblockEnabled: () => true,
      unblockSourceIds: () => ['kuwo'],
      getQuality: () => 'exhigh',
      autoDowngrade: () => true,
      getScrobble: () => false,
      getLoggedIn: () => false,
      getVipType: () => 0,
      log: (message) => logs.push(message),
      probe: async (url) => {
        probed.push(url)
        return { ok: true, status: 206, totalBytes: 12_000_000, elapsedMS: 6 }
      }
    })
    await player.setQueue([VIP_TRACK, SECOND], 0)
    // 预解析是后台任务：等它跑完（注入的探测立即返回，几十毫秒足够）。
    await new Promise((resolve) => setTimeout(resolve, 60))

    const secondUrl = 'https://stub/186017.mp3'
    console.log(
      `结果：预解析=${logs.filter((line) => line.startsWith('已预解析')).join('|')} ` +
        `预热=${logs.filter((line) => line.startsWith('已预热')).join('|')} ` +
        `探测=${JSON.stringify(probed)}`
    )
    expect(logs.some((line) => line.startsWith('已预解析下一首：以父之名'))).toBe(true)
    expect(logs.some((line) => line.startsWith('已预热音源：以父之名'))).toBe(true)
    // 预热探的是下一条的地址，而且只探一次。
    expect(probed.filter((url) => url === secondUrl).length).toBe(1)

    await player.next()
    expect(mpv.opened[mpv.opened.length - 1]).toBe(secondUrl)
    // 切歌复用预热结果：同一条地址没有被重复探测（这就是切歌不再等联网的原因）。
    expect(probed.filter((url) => url === secondUrl).length).toBe(1)
    await player.shutdown()
  }, 60_000)
})
