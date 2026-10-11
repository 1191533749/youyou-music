/**
 * 两条用户反馈的回归用例：
 *
 * 1. 「歌曲播放一半切音质，就半天加载不出来、不播放」——切档位必须**先解析、后动 mpv**：
 *    解析期间不打断当前播放，成功后带回原位置一次到位，解析失败则完全无感。
 * 2. 「音乐播放一卡一卡」——整首后台缓存不能和正在播放的那一首抢带宽：
 *    只有「这一首已经不在播」（切歌/暂停）时才下载。
 *
 * 用假的 mpv / api / unblock / cache 驱动真实的 PlayerController：不联网、不发声。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PlayerController } from '../src/main/player/controller.js'
import type { Track } from '../src/main/netease/models.js'

const TRACK: Track = {
  id: 999000123,
  name: '自检曲目',
  artists: [{ id: 1, name: '自检歌手' }],
  album: { id: 2, name: '自检专辑' },
  durationMS: 200_000,
  alias: [],
  transNames: [],
  fee: 0,
  mvID: 0,
  trackNo: 1,
  noCopyright: false,
  isCloud: false
}

class FakeMpv extends EventEmitter {
  /** 每次 loadfile 的地址与起始位置。 */
  opened: Array<{ url: string; start: number }> = []
  paused = true

  async play(url: string, start = 0): Promise<void> {
    this.opened.push({ url, start })
    this.paused = false
    // 模拟 mpv 真的出声：推一份 position>0.5 的状态，让「起播证据」看门狗
    // 立刻通过（真实 mpv 也是 file-loaded 后连续推 time-pos）。
    this.emit('state', {
      running: true,
      paused: false,
      position: 1.2,
      duration: 200,
      volume: 80,
      muted: false,
      loading: false,
      idle: false,
      path: url
    })
  }

  async setPaused(value: boolean): Promise<void> {
    this.paused = value
  }

  async setVolume(): Promise<void> {}
  async setMuted(): Promise<void> {}
  async seek(): Promise<void> {}
  async unload(): Promise<void> {}
  async stop(): Promise<void> {}
  async trackInfo(): Promise<{ duration: number }> {
    return { duration: 200 }
  }
  async duration(): Promise<number | undefined> {
    return 200
  }
  async audioBitrate(): Promise<number | undefined> {
    return 320
  }
}

interface CacheStub {
  audioPath: (trackID: number, level: string, variant?: string) => Promise<string | undefined>
  cacheAudio: (
    trackID: number,
    level: string,
    url: string,
    format?: string,
    variant?: string
  ) => Promise<string | undefined>
}

function build(options: {
  cache: CacheStub
  unblockSource?: boolean
  quality?: () => string
  unblockResolve?: (track: Track, attempted: Set<string>) => Promise<unknown>
}) {
  const mpv = new FakeMpv()
  const api = new Proxy({}, { get: () => () => Promise.reject(new Error('stub: no netease')) }) as never
  const enabled = options.unblockSource === true
  const unblock = {
    enabled,
    resolve: async (track: Track, attempted: Set<string>) => {
      if (!enabled) throw new Error('stub: no third-party source')
      if (options.unblockResolve) return options.unblockResolve(track, attempted)
      return {
        source: { id: 'kuwo', url: 'https://stub/real.mp3', displayName: '酷我音乐', bitrate: 320 },
        attempted
      }
    }
  }
  const changes: number[] = []
  const player = new PlayerController({
    api,
    mpv: mpv as never,
    unblock: unblock as never,
    isUnblockEnabled: () => options.unblockSource === true,
    unblockSourceIds: () => ['kuwo'],
    getQuality: () => (options.quality ? options.quality() : 'exhigh') as never,
    autoDowngrade: () => true,
    getScrobble: () => false,
    getLoggedIn: () => false,
    getVipType: () => 0,
    log: () => undefined,
    onTrackChanged: (track) => {
      if (track) changes.push(track.id)
    },
    // 体积已知 → playIndex 不做「静音 + 读时长」的兜底校验，用例里不会卡在定时器上。
    probe: async () => ({ ok: true, totalBytes: 5_000_000, elapsedMS: 4 }),
    cache: options.cache as never
  })
  return { player, mpv, changes }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('切音质不打断播放', () => {
  it('先解析后换档：带回原位置、进度不归零、不再发一次曲目变更', async () => {
    let quality = 'exhigh'
    const { player, mpv, changes } = build({
      quality: () => quality,
      cache: {
        audioPath: async (_trackID: number, level: string) => `C:/fake/${level}.m4a`,
        cacheAudio: async () => undefined
      }
    })
    await player.setQueue([TRACK], 0)
    expect(mpv.opened).toHaveLength(1)
    expect(mpv.opened[0].url).toContain('exhigh')
    expect(changes).toEqual([TRACK.id])

    // 播到 42 秒再切档位：新地址要从 42 秒接着放，既不能从头也不能把进度条清零。
    await player.seek(42)
    quality = 'standard'
    await player.reloadCurrentTrack()

    const snapshot = player.snapshot()
    console.log(
      `结果：opened=${JSON.stringify(mpv.opened)} servedQuality=${snapshot.servedQuality} ` +
        `position=${snapshot.position} playing=${snapshot.playing} loading=${snapshot.loading} ` +
        `error=${snapshot.error ?? '-'} onTrackChanged=${changes.length}`
    )
    expect(mpv.opened).toHaveLength(2)
    expect(mpv.opened[1].url).toContain('standard')
    expect(mpv.opened[1].start).toBe(42)
    expect(snapshot.servedQuality).toBe('standard')
    expect(snapshot.position).toBe(42)
    expect(snapshot.playing).toBe(true)
    expect(snapshot.loading).toBe(false)
    expect(snapshot.error).toBeUndefined()
    expect(changes).toEqual([TRACK.id])
    await player.shutdown()
  })

  it('新档位解析不出来时：保持原样、不报错、不打断', async () => {
    let quality = 'exhigh'
    const { player, mpv } = build({
      quality: () => quality,
      // 未开启换源，且只有 exhigh 有缓存 → 切到 standard 时解析必然失败。
      cache: {
        audioPath: async (_trackID: number, level: string) =>
          level === 'exhigh' ? 'C:/fake/exhigh.m4a' : undefined,
        cacheAudio: async () => undefined
      }
    })
    await player.setQueue([TRACK], 0)
    await player.seek(30)
    quality = 'standard'
    await player.reloadCurrentTrack()

    const snapshot = player.snapshot()
    console.log(
      `结果：error=${snapshot.error ?? '-'} servedQuality=${snapshot.servedQuality} position=${snapshot.position} ` +
        `playing=${snapshot.playing} opened=${mpv.opened.length}`
    )
    expect(mpv.opened).toHaveLength(1)
    expect(snapshot.error).toBeUndefined()
    expect(snapshot.playing).toBe(true)
    expect(snapshot.position).toBe(30)
    expect(snapshot.servedQuality).toBe('exhigh')
    await player.shutdown()
  })
})

describe('后台整首缓存不抢播放带宽', () => {
  it('正在播这一首时到点也不下载，暂停后才补下载', async () => {
    vi.useFakeTimers()
    let cacheCalls = 0
    const { player, mpv } = build({
      unblockSource: true,
      cache: {
        audioPath: async () => undefined,
        cacheAudio: async () => {
          cacheCalls += 1
          return undefined
        }
      }
    })
    await player.setQueue([TRACK], 0)
    expect(mpv.opened).toHaveLength(1)
    expect(player.snapshot().playing).toBe(true)
    expect(cacheCalls).toBe(0)

    // 还在播同一首：每个周期都再等一轮，绝不与 mpv 抢同一条连接。
    await vi.advanceTimersByTimeAsync(12_000)
    expect(cacheCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(36_000)
    expect(cacheCalls).toBe(0)

    // 暂停是空窗：这时候把整首补下来。
    await player.pause()
    await vi.advanceTimersByTimeAsync(1)
    console.log(`结果：暂停后下载次数=${cacheCalls}`)
    expect(cacheCalls).toBe(1)
    await player.shutdown()
  })
})

describe('mpv 异常退出与幽灵播放态', () => {
  it('mpv 进程退出时不再假装播放中，且界面不给失败文案', async () => {
    const { player, mpv } = build({
      unblockSource: true,
      cache: {
        audioPath: async () => undefined,
        cacheAudio: async () => undefined
      }
    })
    await player.setQueue([TRACK], 0)
    expect(player.snapshot().playing).toBe(true)

    mpv.emit('exit')
    const snapshot = player.snapshot()
    console.log(
      `结果：playing=${snapshot.playing} position=${snapshot.position} loading=${snapshot.loading} ` +
        `error=${snapshot.error ?? '-'}`
    )
    expect(snapshot.playing).toBe(false)
    expect(snapshot.position).toBe(0)
    expect(snapshot.loading).toBe(false)
    // 用户要求（m11996）：界面里不得出现失败文案——播放器没了就静静收成暂停态，
    // 点播放会重新拉起 mpv，而不是甩一句「播放器已停止」给用户。
    expect(snapshot.error).toBeUndefined()
    await player.shutdown()
  })

  it('清空队列后 mpv 迟到的属性推送不能把 playing 扶回 true', async () => {
    const { player, mpv } = build({
      unblockSource: true,
      cache: {
        audioPath: async () => undefined,
        cacheAudio: async () => undefined
      }
    })
    await player.setQueue([TRACK], 0)
    expect(player.snapshot().playing).toBe(true)

    // 登出/清空队列：控制器自己置 playing=false。
    await player.clearQueue()
    expect(player.snapshot().playing).toBe(false)

    // 之后 mpv 把清空前的旧状态补推过来（idle=false、paused=false）——
    // 这正是幽灵播放态的成因，必须被忽略。
    mpv.emit('state', {
      position: 2.8,
      duration: 200,
      idle: false,
      paused: false,
      loading: false,
      muted: false,
      volume: 80,
      running: true
    })
    const snapshot = player.snapshot()
    console.log(`结果：playing=${snapshot.playing} position=${snapshot.position} track=${snapshot.track ? '有' : '无'}`)
    expect(snapshot.playing).toBe(false)
    expect(snapshot.position).toBe(0)
    expect(snapshot.track).toBeUndefined()
    await player.shutdown()
  })

  it('clearQueue 作废还在飞的 playIndex 解析：不会把空队列复活成播放中', async () => {
    const { player, mpv } = build({
      unblockSource: true,
      unblockResolve: async () => {
        // 模拟一次慢解析：clearQueue 时它还在半路。
        await new Promise((resolve) => setTimeout(resolve, 200))
        return {
          source: { id: 'kuwo', url: 'https://stub/slow.mp3', displayName: '酷我音乐', bitrate: 320 },
          attempted: new Set<string>()
        }
      },
      cache: {
        audioPath: async () => undefined,
        cacheAudio: async () => undefined
      }
    })
    // 不等它播起来，趁解析在半路就清空队列。
    const playing = player.setQueue([TRACK], 0)
    await player.clearQueue()
    await playing
    await new Promise((resolve) => setTimeout(resolve, 300))

    const snapshot = player.snapshot()
    console.log(
      `结果：playing=${snapshot.playing} track=${snapshot.track ? '有' : '无'} opened=${mpv.opened.length} ` +
        `queue=${snapshot.queue.length}`
    )
    expect(snapshot.playing).toBe(false)
    expect(snapshot.queue).toHaveLength(0)
    expect(snapshot.track).toBeUndefined()
    // 关键证据：被作废的解析绝不能再去 loadfile（否则空队列却有声音）。
    expect(mpv.opened).toHaveLength(0)
    await player.shutdown()
  })

  it('队列自然播完后：EOF 迟到的状态不扶回播放中，再按播放能从头重播', async () => {
    const { player, mpv } = build({
      unblockSource: true,
      cache: {
        audioPath: async () => undefined,
        cacheAudio: async () => undefined
      }
    })
    await player.setQueue([TRACK], 0)
    expect(player.snapshot().playing).toBe(true)

    // 单曲队列、repeat=off：EOF 后没有下一首 → playing=false。
    mpv.emit('track-end')
    expect(player.snapshot().playing).toBe(false)

    // EOF 前后的陈旧推送（idle 仍为 false）——必须继续忽略，不能扶回 true。
    mpv.emit('state', {
      position: 0,
      duration: 200,
      idle: false,
      paused: false,
      loading: false,
      muted: false,
      volume: 80,
      running: true
    })
    mpv.emit('state', {
      position: 0,
      duration: 200,
      idle: true,
      paused: false,
      loading: false,
      muted: false,
      volume: 80,
      running: true
    })
    const frozen = player.snapshot()
    console.log(`结果：EOF 后 playing=${frozen.playing} position=${frozen.position}`)
    expect(frozen.playing).toBe(false)
    expect(frozen.position).toBe(0)

    // 此时按播放必须重新载入文件（mpv 里什么都没有），而不是无声地假装在播。
    await player.play()
    const resumed = player.snapshot()
    console.log(`结果：play 后 playing=${resumed.playing} opened=${mpv.opened.length}`)
    expect(mpv.opened).toHaveLength(2)
    expect(resumed.playing).toBe(true)
    await player.shutdown()
  })
})

describe('死流看门狗：开播后 0:00 永挂的源自动换掉', () => {
  it('文件载入完成但永远不出数据：8 秒后换下一个音源，出声即停', async () => {
    class DeadMpv extends EventEmitter {
      opened: Array<{ url: string; start: number }> = []
      paused = true

      async play(url: string, start = 0): Promise<void> {
        this.opened.push({ url, start })
        this.paused = false
        // 死流：file-loaded 已到（loading=false）、mpv 声称在播（idle=false、
        // paused=false）但 position 永远 0——正是线上「0:00 永挂」的样本。
        const dead = url.includes('dead')
        this.emit('state', {
          running: true,
          paused: false,
          position: dead ? 0 : 1.2,
          duration: 200,
          volume: 80,
          muted: false,
          loading: false,
          idle: false,
          path: url
        })
      }

      async setPaused(): Promise<void> {}
      async setVolume(): Promise<void> {}
      async setMuted(): Promise<void> {}
      async seek(): Promise<void> {}
      async unload(): Promise<void> {}
      async stop(): Promise<void> {}
      async trackInfo(): Promise<{ duration: number }> {
        return { duration: 200 }
      }
      async duration(): Promise<number | undefined> {
        return 200
      }
      async audioBitrate(): Promise<number | undefined> {
        return 320
      }
    }

    const mpv = new DeadMpv()
    const api = new Proxy(
      {},
      { get: () => () => Promise.reject(new Error('stub: no netease')) }
    ) as never
    const seenAttempted: Set<string>[] = []
    const unblock = {
      enabled: true,
      resolve: async (_track: Track, attempted: Set<string>) => {
        seenAttempted.push(new Set(attempted))
        if (attempted.has('kuwo')) {
          return {
            source: { id: 'kugou', url: 'https://stub/live.mp3', displayName: '酷狗音乐', bitrate: 320 },
            attempted
          }
        }
        return {
          source: { id: 'kuwo', url: 'https://stub/dead.mp3', displayName: '酷我音乐', bitrate: 320 },
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
      probe: async () => ({ ok: true, totalBytes: 5_000_000, elapsedMS: 4 })
    })
    await player.setQueue([TRACK], 0)

    const snapshot = player.snapshot()
    console.log(
      `结果：opened=${JSON.stringify(mpv.opened.map((o) => o.url))} servedFrom=${snapshot.servedFrom ?? '-'} ` +
        `playing=${snapshot.playing} error=${snapshot.error ?? '-'}`
    )
    expect(mpv.opened.length).toBe(2)
    expect(mpv.opened[0].url).toContain('dead')
    expect(mpv.opened[1].url).toContain('live')
    // 死源（酷我）必须被记进 attempted，第二次解析才拿到酷狗而不是再撞一次死链。
    expect(seenAttempted[1]?.has('kuwo')).toBe(true)
    expect(snapshot.servedFrom).toBe('酷狗音乐')
    expect(snapshot.playing).toBe(true)
    expect(snapshot.error).toBeUndefined()
    await player.shutdown()
  }, 30_000)
})
