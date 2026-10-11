/**
 * Playback session controller.
 *
 * Owns the queue, the quality ladder, repeat/shuffle state and the scrobble
 * bookkeeping, and drives the mpv backend. The macOS client splits these
 * concerns across `PlaybackEngine`, `PlayerModel` and `PlaybackCoordinator`;
 * on Windows there is one mpv instance and no deck crossfading, so they
 * collapse into a single controller whose state is mirrored to the renderer
 * over IPC.
 */
import { EventEmitter } from 'node:events'
import { NeteaseAPI, SearchType } from '../netease/api.js'
import { NeteaseAPIError } from '../netease/client.js'
import { playability, playabilityReason, type Track } from '../netease/models.js'
import { matchesTrack, AUDIO_SOURCE_NAMES, type AudioSourceID } from '../unblock/providers.js'
import type { UnblockService } from '../unblock/service.js'
import type { MpvController, MpvState } from '../audio/mpv.js'
import { looksLikeNoticeBySize, probeStream, type StreamProbeResult } from './streamProbe.js'
import { toSyntheticTrack } from '../external/search.js'
import type { ExternalTrackDTO, QualityLevel, RepeatMode, TrackDTO } from '@shared/types'

/** 一次解析的最终落点：谁提供了音频、什么音质、能不能缓存。 */
interface ResolvedPlayback {
  /** mpv 直接打开的东西：本地缓存路径或远程 URL。 */
  source: string
  /** 缓存归档用的音质档位（也作为 claimedLevel 缺省时的兜底）。 */
  level: QualityLevel
  /** 对用户声称的音质档位；第三方音源码率未知时为 undefined（不虚报）。 */
  claimedLevel?: QualityLevel
  /** 已知码率（kbps），用于诚实的音质提示。 */
  bitrate?: number
  format?: string
  cached: boolean
  remoteURL?: string
  /** 缓存归档用的音源标记（netease / qishui / kugou / kuwo / qq）。 */
  cacheVariant: string
  /** 走了第三方音源时显示给用户的来源名。 */
  servedFrom?: string
  /** 走了站内替代版本时的说明。 */
  servedNote?: string
}

/**
 * 硬性超时：接口被限流/风控时（weapi 空体重试、第三方源无响应）单次解析
 * 可能拖几分钟。超过上限就把这首歌判为「暂时不可播」，交给上层的
 * 自动跳下一首逻辑，而不是让用户干等。
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (cause) => {
        clearTimeout(timer)
        reject(cause)
      }
    )
  })
}

/** 单次音源解析（含全部回退链）的最长等待时间。 */
const RESOLVE_TIMEOUT_MS = 20_000
/**
 * 换音质的解析预算：用户是「播到一半」去切档位的，等太久比失败更糟——
 * 超过这个时间就当这次换档没成，旧档位继续放（不打断、不弹字）。
 */
const QUALITY_RELOAD_TIMEOUT_MS = 12_000
/**
 * 站外曲目（平台歌单）的解析预算：它要按顺序连撞几个音源，每个源自己就有 12 秒
 * 超时，用 20 秒会把「慢一点但能放」的歌提前判死。
 */
const EXTERNAL_RESOLVE_TIMEOUT_MS = 32_000

/** 起播前探测第三方音源（连通性 + 体积）的超时。 */
const PROBE_TIMEOUT_MS = 5_000

/** 预解析成功后的预热探测：只要连通性和 CDN 边缘，超时给短一点。 */
const PREWARM_TIMEOUT_MS = 4_000

/**
 * 搜索时后台预解析结果的缓存有效期。只缓存第三方音源（汽水/酷狗/酷我/QQ）
 * 的直链，它们不依赖网易云的短时签名；10 分钟内命中直接复用，10 分钟后再
 * 解析也够新鲜（第三方直链一般至少几小时内有效，过期由 mpv 报错自动换源兜底）。
 */
const PREFETCH_TTL_MS = 10 * 60_000

/**
 * 起播后过多久才开始后台整首缓存。
 *
 * 刚出声那几秒是缓冲最脆弱的时候，整首下载会和 mpv 抢同一条带宽
 * （第三方源限速时尤其明显，实测能把起播拖到十几秒）。缓存只是顺手存一份，
 * 晚一点开始用户完全无感。
 */
const CACHE_START_DELAY_MS = 12_000

/** Quality tiers tried in order when the requested one is not entitled. */
const QUALITY_LADDER: QualityLevel[] = [
  'jymaster',
  'hires',
  'lossless',
  'exhigh',
  'higher',
  'standard'
]

export interface PlayerDeps {
  api: NeteaseAPI
  mpv: MpvController
  /** 灰色/受限歌曲的第三方音源解析。 */
  unblock: UnblockService
  /** 换源总开关。 */
  isUnblockEnabled: () => boolean
  /** 已启用的音源，顺序即优先级。 */
  unblockSourceIds: () => AudioSourceID[]
  /** Optional audio cache: playback prefers a cached file over the network. */
  cache?: {
    audioPath: (trackID: number, level: QualityLevel, variant?: string) => Promise<string | undefined>
    cacheAudio: (
      trackID: number,
      level: QualityLevel,
      url: string,
      extensionHint?: string,
      variant?: string
    ) => Promise<string | undefined>
  }
  getQuality: () => QualityLevel
  autoDowngrade: () => boolean
  getScrobble: () => boolean
  /** Whether a session is signed in, for the playability decision. */
  getLoggedIn: () => boolean
  /** The account's VIP tier (0 = none), for the playability decision. */
  getVipType: () => number
  onScrobbleStart?: (track: Track, sourceID: number) => void
  onScrobbleFinish?: (track: Track, sourceID: number, seconds: number) => void
  onTrackChanged?: (track: Track | undefined) => void
  /** 一首歌所有音源都彻底失败、被自动跳过时回调：渲染层据此把该行从列表里拿掉。 */
  onTrackFailed?: (track: Track, externalKey?: string) => void
  onError?: (message: string) => void
  log?: (message: string) => void
  /**
   * 站外曲目（平台歌单）的音频解析：主进程注入 `resolveExternalAudio`。
   * `skip` 是本次已经判定坏链的音源，实现里会跳过它们换下一个。
   */
  resolveExternal?: (
    item: ExternalTrackDTO,
    skip?: ReadonlySet<string>
  ) => Promise<{ url: string; sourceName: string; sourceId: string } | null>
  /** Playback position poll interval in ms while playing. */
  positionIntervalMs?: number
  /**
   * 音源探测实现，默认走真实的 streamProbe；测试可注入假实现，
   * 从而在真实解析链路上确定性地验证「提示音源绝不交给 mpv」。
   */
  probe?: (url: string, timeoutMS: number) => Promise<StreamProbeResult>
}

export interface PlayerSnapshot {
  track?: TrackDTO
  queue: TrackDTO[]
  index: number
  playing: boolean
  position: number
  duration: number
  volume: number
  muted: boolean
  loading: boolean
  repeat: RepeatMode
  shuffle: boolean
  quality: QualityLevel
  /** 实际正在播放的音质档位；第三方音源码率未知时为 undefined（不虚报）。 */
  servedQuality?: QualityLevel
  /** 实际码率（kbps），音源提供了才填。 */
  servedBitrate?: number
  /** 非空表示当前音频来自第三方音源（例如「酷我音乐」）。 */
  servedFrom?: string
  error?: string
  source?: string
}

/** Extra per-track state the queue keeps but a bare Track does not carry. */
interface QueueEntry {
  track: Track
  /** Playability for the current login, computed when the queue was built. */
  playability: 'playable' | 'vipOnly' | 'paidAlbum' | 'noCopyright' | 'delisted'
  playabilityReason?: string
  /**
   * 站外曲目（汽水/酷狗/酷我搜索来的歌）：音频地址已在主进程解析好，
   * 播放时跳过网易云的解析链路。
   */
  preResolved?: { url: string; sourceName: string; sourceId?: string }
  /**
   * 站外曲目本体：平台歌单整条入队时，每首歌都要在播放时（或坏链换源时）
   * 走一次「本平台直取 + 其余音源严格匹配」，所以队列里留着它。
   */
  external?: ExternalTrackDTO
  /** 顺序播放的下一首预解析结果：切歌时直接复用，跳过整条解析链路。 */
  preResolvedFull?: ResolvedPlayback
  /** 预解析时顺手做的音源探测结果：切歌时复用，省掉第二次联网等待。 */
  preProbe?: StreamProbeResult
}

export class PlayerController extends EventEmitter {
  private queue: QueueEntry[] = []
  private index = -1
  private playing = false
  private position = 0
  private duration = 0
  private muteState = false
  /** 静音验证期间屏蔽 mpv 静音回显，防止 UI 静音键闪烁或状态被覆盖。 */
  private suppressMuteEcho = false
  private loading = false
  private repeatMode: RepeatMode = 'off'
  private shuffle = false
  private servedQuality?: QualityLevel
  private servedBitrate?: number
  private error?: string
  /**
   * 连续失败计数：某首歌所有音源都拿不到时自动跳下一首。
   * 上限为队列长度，避免整张列表都放不出来时无限跳。
   */
  private consecutiveFailures = 0
  private source?: string
  private servedFrom?: string
  private volume = 80
  private scrobbleSent = false
  private positionTimer?: NodeJS.Timeout
  /** True while we are switching tracks, so `end-file` is not treated as an end. */
  private switching = false
  /** Guards against an in-flight resolve being overtaken by a newer play(). */
  private resolveGeneration = 0
  /** 每首歌已尝试失败过的第三方音源，避免重复撞死源。 */
  private unblockAttempts = new Map<number, Set<AudioSourceID>>()
  /**
   * 本会话内整首解析彻底失败过的曲目：再次碰到直接快失败（不再为它重走
   * 几十秒的解析链），配合队列剔除保证「放不出来的歌」不会反复拦路。
   */
  private deadTracks = new Set<number>()
  /** 搜索时后台预解析好的第三方直链缓存：命中即跳过联网解析（尤其第三方那几秒）。 */
  private prefetchedSources = new Map<number, { resolved: ResolvedPlayback; at: number }>()
  /** 正在后台预解析中的曲目：播放命中时直接 await 它，复用同一次解析，不再开第二条链路。 */
  private prefetchInflight = new Map<number, Promise<ResolvedPlayback | undefined>>()
  /** 后台整首缓存的串行队列：同一时刻只下载一首，避免多路抢带宽。 */
  private cacheQueue: Promise<void> = Promise.resolve()
  /**
   * 等待缓存的曲目：只有在「这一首已经不在播」时才真正下载。
   * 边播边下会跟 mpv 抢同一条 CDN 连接，用户听到的就是「一卡一卡」。
   */
  private pendingCache?: {
    track: Track
    level: QualityLevel
    url: string
    format?: string
    variant: string
  }
  /** 延迟/重试下载的定时器（见 scheduleCacheInBackground）。 */
  private cacheTimer?: NodeJS.Timeout
  /** mpv 当前载入的曲目 id：切歌时若不同则先 unload 旧音频，避免「歌名变了歌没换」。 */
  private loadedTrackId?: number
  /** 随机模式下预先 roll 好的下一首下标，供 lookahead 预解析、pickNext 消费。 */
  private shuffleNext?: number
  /**
   * 队列已自然播完（onTrackEnd 时没有下一首）。此时 mpv 处于 idle、没有载入
   * 任何文件：play() 必须重新 playIndex 而不是 setPaused(false)（那样会变成
   * 「显示播放中但没有声音」的幽灵态）。
   */
  private ended = false

  constructor(private readonly deps: PlayerDeps) {
    super()
    this.volume = 80
    this.deps.mpv.on('track-end', () => {
      void this.onTrackEnd()
    })
    this.deps.mpv.on('state', (state: MpvState) => this.onMpvState(state))
    // mpv 进程意外退出（崩溃/被强杀）时，不能假装还在播。正常关闭应用走
    // shutdown 里的 mpv.stop()，那时队列已经清空，这个分支不会生效。
    this.deps.mpv.on('exit', () => {
      if (this.queue.length === 0) return
      this.playing = false
      this.position = 0
      this.duration = 0
      this.loading = false
      this.error = '播放器已停止，请重新播放'
      this.stopPositionTimer()
      this.emitSnapshot()
    })
  }

  // MARK: - Snapshot

  snapshot(): PlayerSnapshot {
    const entry = this.queue[this.index]
    return {
      track: entry ? toTrackDTO(entry) : undefined,
      queue: this.queue.map(toTrackDTO),
      index: this.index,
      playing: this.playing,
      position: this.position,
      duration: this.duration || (entry ? entry.track.durationMS / 1000 : 0),
      volume: this.volume,
      muted: this.muteState,
      loading: this.loading,
      repeat: this.repeatMode,
      shuffle: this.shuffle,
      quality: this.deps.getQuality(),
      servedQuality: this.servedQuality,
      servedBitrate: this.servedBitrate,
      servedFrom: this.servedFrom,
      error: this.error,
      source: this.source
    }
  }

  private emitSnapshot(): void {
    this.emit('state', this.snapshot())
  }

  private onMpvState(state: MpvState): void {
    this.position = state.position
    this.duration = state.duration || this.duration
    if (!this.suppressMuteEcho) this.muteState = state.muted
    this.volume = state.volume
    this.loading = state.loading
    // 队列已经空了（登出/清空队列）之后，mpv 迟到的属性推送（idle=false、
    // paused=false）不能把状态扶回「播放中」，否则会出现 track=null 但
    // playing=true 的幽灵播放态，一直冻住。
    if (this.queue.length === 0 || this.index < 0 || this.index >= this.queue.length) {
      this.playing = false
      this.loading = false
      this.position = 0
      return
    }
    // mpv 真出声音的那一刻就当作「播放中」：播放/暂停按钮必须立刻跟着走，
    // 不能等整条解析+验证链跑完——验证（尤其第三方音源）最长几十秒，
    // 期间按钮会一直像「按了没反应」，用户就是这么抱怨的。
    // `!this.ended`：队列自然播完后，EOF 前后迟到的属性推送（idle 仍为 false）
    // 不能再把状态扶回「播放中」——那正是 EOF 幽灵播放态的成因。
    if (!this.ended && !state.idle && !state.loading && !state.paused) {
      this.playing = true
    } else if (state.paused) {
      this.playing = false
    }
    this.emitSnapshot()
  }

  // MARK: - Queue management

  /**
   * Replaces the queue. `startIndex` picks the track to play; `-1` queues
   * without starting playback.
   *
   * 「点播放就随机起播」：调用方显式要求（options.randomStart，即分类页的
   * 「播放全部」按钮）且原本队列为空时，随机选一首开始；点具体某一行不受影响。
   */
  async setQueue(
    tracks: Track[],
    startIndex = 0,
    privileges?: Map<number, any>,
    options: { randomStart?: boolean } = {}
  ): Promise<void> {
    const wasEmpty = this.queue.length === 0
    this.queue = tracks.map((track) => this.toEntry(track, privileges?.get(track.id)))
    if (options.randomStart && wasEmpty && this.queue.length > 1) {
      startIndex = Math.floor(Math.random() * this.queue.length)
    }
    this.index = this.queue.length === 0 ? -1 : clamp(startIndex, 0, this.queue.length - 1)
    this.shuffleNext = undefined
    this.emitSnapshot()
    if (this.index >= 0) await this.playIndex(this.index, { keepQueue: true })
  }

  /**
   * 播放一首站外曲目（汽水/酷狗/酷我 搜索来的歌）。
   * 音频地址由调用方解析好，这里只把它作为队列里的唯一一首歌播放。
   */
  async playExternal(
    track: Track,
    resolved: { url: string; sourceName: string; sourceId?: string }
  ): Promise<void> {
    this.queue = [{ track, playability: 'playable', preResolved: resolved }]
    this.index = 0
    this.consecutiveFailures = 0
    this.emitSnapshot()
    await this.playIndex(0, { keepQueue: true })
  }

  /**
   * 站外曲目批量入队（私人漫游补货）：整批追加到队尾，不打断当前播放。
   * 与 `playExternalQueue` 的差别只在于「追加」而不是「替换整条队列」。
   */
  async appendExternalQueue(items: ExternalTrackDTO[]): Promise<void> {
    let added = 0
    for (const item of items) {
      if (!item?.sourceId || !item?.name) continue
      this.queue.push({ track: toSyntheticTrack(item), playability: 'playable', external: item })
      added += 1
    }
    if (added > 0) this.emitSnapshot()
  }

  /**
   * 播放一整串站外曲目（平台歌单）：整条入队，逐首解析音频。
   * 某一首的四个音源都拿不到时由现有逻辑自动跳下一首，不把原因摆到用户面前。
   */
  async playExternalQueue(items: ExternalTrackDTO[], startIndex = 0): Promise<void> {
    const entries: QueueEntry[] = []
    for (const item of items) {
      if (!item?.sourceId || !item?.name) continue
      entries.push({ track: toSyntheticTrack(item), playability: 'playable', external: item })
    }
    if (entries.length === 0) return
    this.queue = entries
    this.index = Math.max(0, Math.min(Math.floor(startIndex) || 0, entries.length - 1))
    this.consecutiveFailures = 0
    this.shuffleNext = undefined
    this.emitSnapshot()
    await this.playIndex(this.index, { keepQueue: true })
  }

  async append(tracks: Track[]): Promise<void> {    const existing = new Set(this.queue.map((entry) => entry.track.id))
    const added = tracks.filter((track) => !existing.has(track.id))
    if (added.length === 0) return
    this.queue.push(...added.map((track) => this.toEntry(track)))
    this.emitSnapshot()
  }

  async removeAt(indices: number[]): Promise<void> {
    const remove = new Set(indices)
    const current = this.queue[this.index]?.track.id
    const kept: QueueEntry[] = []
    this.queue.forEach((entry, i) => {
      if (!remove.has(i)) kept.push(entry)
    })
    this.queue = kept
    const newIndex = current ? this.queue.findIndex((entry) => entry.track.id === current) : -1
    this.index = newIndex
    if (newIndex < 0 && this.queue.length > 0) {
      // The playing track was removed: move to the same slot in the new queue.
      const next = Math.min(indices[0] ?? 0, this.queue.length - 1)
      await this.playIndex(next, { keepQueue: true })
      return
    }
    this.emitSnapshot()
  }

  async clearQueue(): Promise<void> {
    this.queue = []
    this.index = -1
    this.loadedTrackId = undefined
    this.shuffleNext = undefined
    // 作废所有还在飞的解析/预取：否则 playIndex 解析完成后会照常
    // `playing = true` + loadfile，把已经清空的队列「复活」成幽灵播放态。
    this.resolveGeneration += 1
    this.prefetchedSources.clear()
    this.prefetchInflight.clear()
    this.loading = false
    await this.deps.mpv.unload().catch(() => undefined)
    this.playing = false
    this.position = 0
    this.duration = 0
    this.stopPositionTimer()
    this.emitSnapshot()
  }

  private toEntry(track: Track, privilege?: any): QueueEntry {
    // Playability is decided with the live profile, so the "VIP 专属" label is
    // not baked into a queue built before login.
    const state = playability(track, privilege, this.deps.getLoggedIn(), this.deps.getVipType())
    return { track, playability: state, playabilityReason: playabilityReason(state) }
  }

  // MARK: - Transport

  async playIndex(
    index: number,
    options: { keepQueue?: boolean; qualityReload?: boolean } = {}
  ): Promise<void> {
    if (index < 0 || index >= this.queue.length) return
    const generation = ++this.resolveGeneration
    this.ended = false
    this.switching = true
    this.index = index
    this.error = undefined
    this.servedQuality = undefined
    this.servedBitrate = undefined
    this.servedFrom = undefined
    this.loading = true
    // 解析还没出结果时如实呈报「未在播放」：外部源坏链要等 ~20 秒超时，
    // 之前这里沿用上一首的 playing=true，UI 会假显示「在播但进度为 0」。
    this.playing = false
    this.scrobbleSent = false
    this.position = 0
    this.duration = this.queue[index].track.durationMS / 1000
    this.emitSnapshot()
    this.deps.onTrackChanged?.(this.queue[index].track)

    const entry = this.queue[index]
    // 切歌先停掉旧音频：否则歌名已变但旧歌还在继续播（用户反馈「歌名变了歌曲半天不换」）。
    // 重载当前曲目 / 重复播同一首时 id 相同，跳过 unload 避免打断播放。
    if (this.loadedTrackId !== undefined && this.loadedTrackId !== entry.track.id) {
      await this.deps.mpv.unload().catch(() => undefined)
      this.loadedTrackId = undefined
    }
    try {
      let resolved: ResolvedPlayback | undefined
      const expectedSeconds = entry.track.durationMS / 1000
      // 版权提示音 / 死链防御：第三方音源先探测一次再交给 mpv。
      // 旧实现是「静音播放 + 2.5 秒轮询时长」，但第三方流在这个窗口里通常还
      // 读不到时长，等于白等 2.5 秒；连不上的源还要再让用户干等 mpv 的
      // network-timeout。探测失败或判定为提示音就把该音源记入 attempted，
      // resolveSource 自然会换下一个音源，直到拿到真歌。
      let verified = false
      for (let candidate = 0; candidate < 4; candidate += 1) {
        if (generation !== this.resolveGeneration) return
        resolved =
          entry.preResolvedFull
            ? entry.preResolvedFull
            : entry.preResolved && candidate === 0
              ? {
                  source: entry.preResolved.url,
                  level: 'standard',
                  claimedLevel: undefined,
                  cached: false,
                  // 归属真实来源：坏链时 markSourceFailed 才能把源记进 attempted，
                  // 否则 4 个候选会全打同一条坏 URL。
                  cacheVariant: entry.preResolved.sourceId ?? 'netease',
                  servedFrom: entry.preResolved.sourceName
                }
              : await withTimeout(
                  this.resolveSource(entry.track, entry),
                  entry.external ? EXTERNAL_RESOLVE_TIMEOUT_MS : RESOLVE_TIMEOUT_MS,
                  `解析《${entry.track.name}》`
                )
        if (generation !== this.resolveGeneration) return
        // 第三方音源只在码率已知时才声称音质档位；不知道就不虚报。
        this.servedQuality = resolved.servedFrom
          ? resolved.claimedLevel
          : (resolved.claimedLevel ?? resolved.level)
        this.servedBitrate = resolved.bitrate
        this.servedFrom = resolved.servedFrom ?? resolved.servedNote
        this.source = resolved.source
        const remote = !resolved.cached && resolved.remoteURL ? resolved.remoteURL : undefined
        // 第三方音源（有 servedFrom）先探测：拿不到数据就当场换源，
        // 不用等 mpv 建连超时；拿到体积就能提前识破版权提示音。
        let probe: StreamProbeResult | undefined
        if (remote && resolved.servedFrom) {
          // 预解析时已经探过的同一条 URL 直接复用（结果在 entry 上），
          // 切歌就不用再等一次联网；探测失败的重新探一次，避免误杀。
          const reused = entry.preResolvedFull === resolved ? entry.preProbe : undefined
          probe = reused?.ok ? reused : await this.probeRemote(remote, PROBE_TIMEOUT_MS)
          if (generation !== this.resolveGeneration) return
          if (!probe.ok) {
            this.markSourceFailed(entry, resolved)
            this.deps.log?.(
              `音源探测失败（${probe.error ?? '未知原因'}），换下一个音源：${entry.track.name} 来自 ${resolved.servedFrom}`
            )
            continue
          }
          if (looksLikeNoticeBySize(probe.totalBytes, expectedSeconds)) {
            this.markSourceFailed(entry, resolved)
            this.deps.log?.(
              `检测到版权提示音（体积 ${probe.totalBytes} 字节，期望约 ${Math.round(expectedSeconds)} 秒），换下一个音源：${entry.track.name} 来自 ${resolved.servedFrom}`
            )
            continue
          }
        }
        // 只有「体积未知」的流才退回旧的静音时长校验（窗口缩到 1.2 秒）：
        // 远程第三方音源先静音播放，验证通过后再恢复用户音量，提示音最长只会
        // 在静音窗口里被缓冲。try/finally 保证任何失败路径都恢复静音，
        // 否则 mpv 会永远保持静音，表现为「莫名其妙自己静音」。
        const verifyMuted = !!remote && probe?.totalBytes === undefined
        const userMuted = this.muteState
        if (verifyMuted) {
          this.suppressMuteEcho = true
          await this.deps.mpv.setMuted(true)
        }
        try {
          // A local cache hit is a file path, not a stream.
          await this.deps.mpv.play(resolved.source, 0)
          if (verifyMuted && (await this.looksLikeNotice(entry.track))) {
            this.markSourceFailed(entry, resolved)
            this.deps.log?.(
              `检测到版权提示音（时长不符），换下一个音源：${entry.track.name} 来自 ${resolved.servedFrom}`
            )
            continue
          }
          verified = true
          break
        } finally {
          if (verifyMuted) {
            await this.deps.mpv.setMuted(userMuted)
            this.suppressMuteEcho = false
            this.muteState = userMuted
          }
        }
      }
      // 四个候选全是提示音（或全部超时失败）时绝不把最后那个占位文件播出来。
      if (!resolved || !verified) {
        throw new NeteaseAPIError('business', { code: -1, message: '暂时无法播放这首歌' })
      }
      const actual = resolved.claimedLevel ?? resolved.level
      if (actual !== this.deps.getQuality()) {
        this.deps.log?.(
          `音质降级: 请求 ${this.deps.getQuality()}，实际 ${actual}${resolved.servedFrom ? `（来自 ${resolved.servedFrom}）` : ''}`
        )
      }
      if (resolved.servedFrom) {
        this.deps.log?.(`已换源播放：${entry.track.name} 来自 ${resolved.servedFrom}`)
      }
      if (!resolved.cached && resolved.remoteURL) {
        // Cache in the background: the user should hear the track now, not
        // after a full download. 验证通过才缓存，提示音不会污染本地缓存。
        // 起播后延迟一会儿再开始（见 CACHE_START_DELAY_MS），别抢 mpv 的带宽。
        this.scheduleCacheInBackground(
          entry.track,
          resolved.level,
          resolved.remoteURL,
          resolved.format,
          resolved.cacheVariant
        )
      }
      this.playing = true
      this.loadedTrackId = entry.track.id
      this.consecutiveFailures = 0
      this.startPositionTimer()
      this.scrobbleStart()
      // 后台预解析下一首（顺序 + 随机都做）：切歌瞬间就能出声（用户反馈「加载慢、卡顿」）。
      if (this.repeatMode !== 'one') {
        void this.prepareLookahead(generation)
      }
      // 真实码率要等 mpv 把文件载入后才能读到：异步补一次，用来诚实显示音质。
      void this.refreshRealBitrate(generation)
    } catch (cause) {
      if (generation !== this.resolveGeneration) return
      const message = describeError(cause)
      this.deps.log?.(`播放失败: ${message}`)
      // 换音质失败不能像正常播放那样「自动跳下一首」：用户只是想换个档位，
      // 歌还是那一首。抛回去由 reloadCurrentTrack 退回原来那一档。
      if (options.qualityReload) throw cause
      // 拿不到可播版本时**自动跳下一首**，不要把「版权/受限」这类原因摆到用户面前。
      // 失败这首无论有没有下一首都先从队列剔除：本批不会再碰到，渲染层收到
      // player:trackFailed 把行隐藏（搜出来放不了？那就别再展示它）。
      const MAX_AUTO_SKIP = 5
      this.consecutiveFailures += 1
      this.deadTracks.add(entry.track.id)
      const failed = entry.track
      // 站外曲目在渲染层以 `source:sourceId` 为键展示，一并带出去好定位行。
      const externalKey = entry.external ? `${entry.external.source}:${entry.external.sourceId}` : undefined
      this.queue.splice(this.index, 1)
      this.deps.onTrackFailed?.(failed, externalKey)
      if (this.index < this.queue.length && this.consecutiveFailures < MAX_AUTO_SKIP) {
        // 队列少了一位，index 原地正好就是「下一首」。
        this.error = undefined
        void this.playIndex(this.index)
      } else if (this.repeatMode === 'all' && this.queue.length > 0 && this.consecutiveFailures < MAX_AUTO_SKIP) {
        this.error = undefined
        void this.playIndex(0)
      } else {
        // 连续失败给一个绝对上限：全是坏歌的极端列表最多跳 5 首就停，
        // 不会无限滑下去，也不会把用户晾在空错误上。
        this.consecutiveFailures = 0
        this.error = '暂时无法播放，请稍后再试'
        this.playing = false
        this.deps.onError?.(this.error)
      }
      return
    } finally {
      if (generation === this.resolveGeneration) {
        this.loading = false
        this.switching = false
        this.emitSnapshot()
      }
    }
  }

  /**
   * 读取 mpv 报出的真实码率，用来诚实显示音质。
   *
   * 第三方音源（换源播放）没有接口声明的档位，过去就退回显示用户的「首选音质」，
   * 例如实际只有 320kbps 却显示「母带」。这里在文件载入后按真实码率定档：
   * 只用于「未知档位」的补齐，绝不把已知档位往上抬。
   */
  private async refreshRealBitrate(generation: number): Promise<void> {
    // 载入需要时间，隔一会儿重试几次；拿到就停。
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 700))
      if (generation !== this.resolveGeneration) return
      let bitrate: number | undefined
      try {
        bitrate = await this.deps.mpv.audioBitrate()
      } catch {
        continue
      }
      if (!bitrate) continue
      if (generation !== this.resolveGeneration) return
      this.servedBitrate = this.servedBitrate ?? bitrate
      if (!this.servedQuality) {
        this.servedQuality = qualityFromBitrate(bitrate)
      }
      this.emitSnapshot()
      return
    }
  }

  /** 探测一条远程音频流（测试可注入替身，默认走真实实现）。 */
  private probeRemote(url: string, timeoutMS = PROBE_TIMEOUT_MS): Promise<StreamProbeResult> {
    return (this.deps.probe ?? probeStream)(url, timeoutMS)
  }

  /**
   * 把某个换源音源记进「本会话别再撞」的集合；如果它就是预解析好的那一条，
   * 顺手作废预解析结果——否则候选循环每次都会拿到同一个坏地址重试四遍。
   */
  private markSourceFailed(entry: QueueEntry, resolved: ResolvedPlayback): void {
    const variant = resolved.cacheVariant
    if (variant && variant !== 'netease') {
      this.attemptedSources(entry.track.id).add(variant as AudioSourceID)
    } else if (entry.external) {
      // preResolved 没带 sourceId（旧队列路径）时，按曲目所属平台记入：
      // 至少保证下一个候选不会重复解析回同一个平台的同一条坏地址。
      this.attemptedSources(entry.track.id).add(entry.external.source)
    }
    if (entry.preResolvedFull === resolved) {
      entry.preResolvedFull = undefined
      entry.preProbe = undefined
    }
    // 预取缓存里存的可能是同一条坏地址：不删掉的话，候选循环 2-4 会一直
    // 复用同一个坏 URL 重试四遍（表现为日志里反复「同源打转」）。
    this.prefetchedSources.delete(entry.track.id)
    this.prefetchInflight.delete(entry.track.id)
  }

  /**
   * 判断正在播放的远程流是不是「版权提示音」占位文件：
   * mpv 报出的实际时长比曲目时长短 90 秒以上基本可以断定被替换
   * （提示语音通常 10~30 秒）。短歌（<2 分钟）不检查，避免误伤。
   * 超时读不到时长（还在缓冲）宁可放过，不冤枉正常歌曲。
   *
   * 这是**兜底**路径：只有播前探测拿不到体积（分块传输）时才会走到这里，
   * 所以窗口压到 3 × 400ms —— 实测第三方流往往整窗口都读不到时长，
   * 让用户白等更久没有意义。
   */
  private async looksLikeNotice(
    track: Track,
    attempts = 3,
    intervalMS = 400
  ): Promise<boolean> {
    const expected = track.durationMS / 1000
    if (expected < 120) return false
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMS))
      let actual: number | undefined
      try {
        actual = await this.deps.mpv.duration()
      } catch {
        // 继续等下一次
      }
      if (actual !== undefined) {
        return actual < expected - 90
      }
    }
    return false
  }

  /**
   * 后台预解析下一首（顺序 + 随机都覆盖）：正在播的时候把下一条的音源解析好，
   * 切歌瞬间就能出声。失败静默——真正切歌时仍走完整解析链路。
   */
  private async prepareLookahead(generation: number): Promise<void> {
    if (this.repeatMode === 'one') return
    const nextIndex = this.planNextIndex(false)
    if (nextIndex < 0) return
    const entry = this.queue[nextIndex]
    if (entry.preResolvedFull) return
    // 站外曲目（平台歌单）的解析本来就要连撞几个源，预解析它等于替用户提前跑一遍
    // 全网；收益远小于代价，等真正切到那一首再解析。
    if (entry.external) return
    try {
      const resolved = await withTimeout(this.resolveSource(entry.track, entry), RESOLVE_TIMEOUT_MS, `预解析《${entry.track.name}》`)
      if (generation !== this.resolveGeneration) return
      if (this.queue[nextIndex] !== entry) return
      entry.preResolvedFull = resolved
      this.deps.log?.(`已预解析下一首：${entry.track.name}`)
      // 顺手把这条 URL 探测一遍（只取前 96KB）：既提前识破提示音/死链，
      // 也把 DNS/TLS 与 CDN 边缘热起来，切歌时 mpv 首包更快到。
      // 结果存进 entry，切歌时直接复用，不再多等一次联网。
      if (resolved.remoteURL && resolved.servedFrom) {
        const probe = await this.probeRemote(resolved.remoteURL, PREWARM_TIMEOUT_MS)
        if (generation === this.resolveGeneration && this.queue[nextIndex] === entry) {
          entry.preProbe = probe
        }
        if (probe.ok) {
          this.deps.log?.(
            `已预热音源：${entry.track.name}（${probe.elapsedMS}ms${probe.totalBytes ? `，${Math.round(probe.totalBytes / 1024)}KB` : ''}）`
          )
        }
      }
    } catch {
      // 预解析失败就等切歌时再走完整链路，绝不影响当前播放。
    }
  }

  /**
   * 站外曲目（平台歌单）的音频解析：本平台直取 → 汽水 → 酷狗 → 酷我 → QQ 搜索，
   * 每一环都做严格匹配（时长/歌名/歌手），拿不到就换下一个源。
   * 上一次判定坏链的源记在 attemptedSources 里，下一次候选循环不会再撞它。
   */
  private async resolveExternalEntry(entry: QueueEntry): Promise<ResolvedPlayback> {
    const item = entry.external
    if (!item || !this.deps.resolveExternal) {
      throw new NeteaseAPIError('business', { code: -1, message: '暂时无法播放这首歌' })
    }
    const requested = this.deps.getQuality()
    // 同一个站外曲目第二次播放直接放本地缓存，不再联网。
    for (const variant of this.deps.unblockSourceIds()) {
      const cached = await this.deps.cache
        ?.audioPath(entry.track.id, requested, variant)
        .catch(() => undefined)
      if (cached) {
        return {
          source: cached,
          level: requested,
          claimedLevel: undefined,
          cached: true,
          cacheVariant: variant,
          servedFrom: AUDIO_SOURCE_NAMES[variant] ?? variant
        }
      }
    }
    const resolved = await this.deps.resolveExternal(item, this.attemptedSources(entry.track.id))
    if (!resolved) {
      throw new NeteaseAPIError('business', { code: -1, message: '暂时无法播放这首歌' })
    }
    return {
      source: resolved.url,
      level: requested,
      // 第三方音源码率未知：不声称档位，也就不会虚报音质。
      claimedLevel: undefined,
      cached: false,
      remoteURL: resolved.url,
      cacheVariant: resolved.sourceId,
      servedFrom: resolved.sourceName
    }
  }

  /**
   * Decides what mpv should open.
   *
   * 先查搜索时后台预解析好的第三方直链缓存——命中即跳过整条联网解析链，
   * 第三方解析那几秒就不用再等；再查是否正在后台预解析，命中则复用同一次
   * 解析（不再开第二条链路）；都没有才走真正的解析链。
   */
  private async resolveSource(track: Track, entry?: QueueEntry): Promise<ResolvedPlayback> {
    // 本会话内已确认彻底失败的歌：直接快失败，不再为它重走几十秒的解析链。
    if (this.deadTracks.has(track.id)) {
      throw new NeteaseAPIError('business', { code: -1, message: '暂时无法播放这首歌' })
    }
    // 测试钩子：强制整条解析链失败，验证「失败即剔除、快速换下一首、列表不再展示」。
    if (process.env.YOYOU_FAIL_RESOLVE === '1') {
      throw new NeteaseAPIError('business', { code: -1, message: '测试钩子：强制解析失败' })
    }
    // 站外曲目（平台歌单里的歌）没有网易云 ID，整条链路都不一样，单独走。
    if (entry?.external) return this.resolveExternalEntry(entry)
    const key = track.id
    const prefetched = this.prefetchedSources.get(key)
    if (prefetched) {
      // 预热缓存里可能正是刚判定坏链的源（后台预解析不经过候选循环的
      // attempted 检查）：命中前先对照「别再撞」集合，坏源直接作废换下一条链。
      const attempted = this.attemptedSources(key)
      const variant = prefetched.resolved.cacheVariant
      const tainted =
        typeof variant === 'string' && variant !== 'netease' && attempted.has(variant as AudioSourceID)
      if (Date.now() - prefetched.at < PREFETCH_TTL_MS && !tainted) {
        this.deps.log?.(`复用预热音源：${track.name} 来自 ${prefetched.resolved.servedFrom ?? '?'}`)
        return prefetched.resolved
      }
      this.prefetchedSources.delete(key)
    }
    const inflight = this.prefetchInflight.get(key)
    if (inflight) {
      const resolved = await inflight
      if (resolved) return resolved
    }
    return this.resolveSourceUncached(track)
  }

  /**
   * 真正的解析链（不含预热缓存检查）：
   * 顺序：本次请求音质的本地缓存 → 网易云官方地址 → （受限时）站内替代版本 →
   * 第三方音源。缓存命中是最好情况（完全不联网）。
   */
  private async resolveSourceUncached(track: Track): Promise<ResolvedPlayback> {
    const requested = this.deps.getQuality()

    const cachedAtRequested = await this.deps.cache
      ?.audioPath(track.id, requested, 'netease')
      .catch(() => undefined)
    if (cachedAtRequested) {
      return {
        source: cachedAtRequested,
        level: requested,
        claimedLevel: requested,
        cached: true,
        cacheVariant: 'netease'
      }
    }

    // 1. 官方地址：受版权限制时会拿不到 url 或只给试听片段。
    try {
      const official = await this.resolveOfficialURL(track, requested)
      if (official && !official.trialOnly) {
        return {
          source: official.url,
          level: official.level,
          claimedLevel: official.level,
          format: official.format,
          cached: false,
          remoteURL: official.url,
          cacheVariant: 'netease'
        }
      }
    } catch (cause) {
      this.deps.log?.(`官方音源不可用 (${track.id}): ${describeError(cause)}`)
    }

    if (!this.deps.unblock.enabled) {
      throw new NeteaseAPIError('business', {
        code: -1,
        message: '暂时无法播放这首歌'
      })
    }

    // 2. 站内替代版本：同一首歌常因版权在不同专辑/合辑里重复上架，
    //    原条目灰掉时换一个条目往往就能完整播放，且仍是官方音源。
    const substitute = await this.findSubstitute(track).catch(() => undefined)
    if (substitute) {
      try {
        const resolved = await this.resolveOfficialURL(substitute, requested)
        if (resolved && !resolved.trialOnly) {
          this.deps.log?.(`换用站内替代版本：${track.name} → #${substitute.id}`)
          return {
            source: resolved.url,
            level: resolved.level,
            claimedLevel: resolved.level,
            format: resolved.format,
            cached: false,
            remoteURL: resolved.url,
            cacheVariant: 'netease',
            servedNote: '网易云其他版本'
          }
        }
      } catch (cause) {
        this.deps.log?.(`站内替代版本播放失败: ${describeError(cause)}`)
      }
    }

    // 3. 第三方音源（汽水 / 酷狗 / 酷我 / QQ）。
    for (const level of [requested, 'exhigh', 'standard'] as QualityLevel[]) {
      for (const id of this.deps.unblockSourceIds()) {
        const cached = await this.deps.cache?.audioPath(track.id, level, id).catch(() => undefined)
        if (cached) {
          return {
            source: cached,
            level,
            claimedLevel: level,
            cached: true,
            cacheVariant: id,
            servedFrom: AUDIO_SOURCE_NAMES[id] ?? id
          }
        }
      }
    }

    const { source } = await this.deps.unblock.resolve(
      track,
      this.attemptedSources(track.id),
      requested
    )
    if (source) {
      // 第三方音源的码率往往不确定：知道码率就如实映射到音质档位，
      // 不知道就不声称任何档位，只告诉用户「来自哪个音源」。
      const bitrate = source.bitrate && source.bitrate > 0 ? source.bitrate : undefined
      return {
        source: source.url,
        level: qualityForBitrate(bitrate) ?? 'standard',
        claimedLevel: qualityForBitrate(bitrate),
        bitrate,
        cached: false,
        remoteURL: source.url,
        cacheVariant: source.id,
        servedFrom: source.displayName
      }
    }

    // 不把「版权/受限/换源失败」这类原因暴露给用户：上层会自动跳下一首，
    // 整队都失败时只给一句中性提示。
    throw new NeteaseAPIError('business', { code: -1, message: '暂时无法播放这首歌' })
  }

  /**
   * 后台预解析（不播放）：供搜索/首页在结果返回后顺手把顶部曲目的第三方
   * 直链先解析好缓存起来，用户点第一首歌时就不用再等第三方解析那几秒。
   *
   * 只缓存第三方音源结果（`servedFrom` 非空）：官方地址有短时签名、且官方
   * 解析本身够快，缓存收益小、过期风险大；第三方直链才是起播慢的大头。
   * 失败静默（预解析本来就是锦上添花，不该影响任何正常链路）。
   */
  async prefetchSource(track: Track): Promise<void> {
    const key = track.id
    if (this.prefetchedSources.has(key) || this.prefetchInflight.has(key)) return
    const inflight = withTimeout(this.resolveSourceUncached(track), RESOLVE_TIMEOUT_MS, `预热《${track.name}》`)
      .then((resolved) => {
        if (resolved.remoteURL && resolved.servedFrom) {
          this.prefetchedSources.set(key, { resolved, at: Date.now() })
          this.deps.log?.(`已预热音源：${track.name} 来自 ${resolved.servedFrom}`)
          return resolved
        }
        return undefined
      })
      .catch(() => undefined)
    this.prefetchInflight.set(key, inflight)
    void inflight.finally(() => this.prefetchInflight.delete(key))
  }

  /** 本会话内某首歌已经失败过的音源，避免反复撞同一个死源。 */
  private attemptedSources(trackID: number): Set<AudioSourceID> {
    let set = this.unblockAttempts.get(trackID)
    if (!set) {
      set = new Set<AudioSourceID>()
      this.unblockAttempts.set(trackID, set)
      // 只保留最近若干首，避免长会话里无限增长。
      if (this.unblockAttempts.size > 200) {
        const oldest = this.unblockAttempts.keys().next().value
        if (oldest !== undefined) this.unblockAttempts.delete(oldest)
      }
    }
    return set
  }

  /** 设置了换源、但没有勾选任何音源时给出更准确的提示。 */
  private unblockEnabledButEmpty(): boolean {
    return this.deps.isUnblockEnabled() && this.deps.unblockSourceIds().length === 0
  }

  /**
   * 站内替代版本：按「歌名 + 首位歌手」搜索，要求标题归一化一致、版本标记一致、
   * 该条目自身有播放权限。
   *
   * 时长窗口比跨平台匹配（±5 秒）宽到 ±20 秒：同一个平台里同名同歌手的两个条目
   * 常常是不同专辑/母带（用户手动「到单曲里找别的相同歌曲」找的就是它们），
   * 卡在 5 秒会把唯一能播的那条也判掉。版本标记仍然严格一致——不会拿伴奏/remix 顶替。
   */
  private async findSubstitute(track: Track): Promise<Track | undefined> {
    const keyword = `${track.name} ${track.artists[0]?.name ?? ''}`.trim()
    if (!keyword) return undefined
    const result = await this.deps.api.search(keyword, SearchType.songs, 20, 0)
    const candidates = result.songs ?? []
    for (const candidate of candidates) {
      if (candidate.id === track.id) continue
      if (
        !matchesTrack(
          track,
          {
            title: candidate.name,
            artist: candidate.artists[0]?.name ?? '',
            durationMS: candidate.durationMS
          },
          { durationToleranceMS: 20_000 }
        )
      ) {
        continue
      }
      // pl > 0 或 cs 表示这条记录对当前账号可播（含可用的付费/会员判定）。
      const privilege = candidate.embeddedPrivilege
      if (!privilege) {
        // 搜索结果常不带 privilege，这时交给 URL 接口去判定。
        return candidate
      }
      if ((privilege.pl ?? 0) > 0 || privilege.cs === true) return candidate
    }
    return undefined
  }

  /**
   * 官方地址：按音质阶梯尝试。返回的 `trialOnly` 表示接口只给了试听片段
   * （付费歌曲未购买时的典型响应），调用方应当继续尝试换源，而不是播半首。
   */
  private async resolveOfficialURL(
    track: Track,
    requested: QualityLevel
  ): Promise<{ url: string; level: QualityLevel; format?: string; trialOnly: boolean } | undefined> {
    const ladder = this.deps.autoDowngrade() ? ladderFrom(requested) : [requested]
    for (const level of ladder) {
      try {
        const results = await this.deps.api.songURL([track.id], level)
        const data = results.find((item) => item.id === track.id) ?? results[0]
        if (!data?.url) continue
        if (data.freeTrialInfo) {
          // 试听片段：不返回地址，交给换源逻辑继续找完整版本。
          return { url: httpsURL(data.url), level, format: data.type, trialOnly: true }
        }
        return {
          url: httpsURL(data.url),
          level: (data.level as QualityLevel) ?? level,
          format: data.type,
          trialOnly: false
        }
      } catch {
        // 这一档拿不到就试下一档。
      }
    }
    return undefined
  }

  /**
   * 排队做整首缓存。**只有在这一首已经不在播的时候才真的下载**：
   * 边播边下会跟 mpv 抢同一条 CDN 连接（源站限速时尤其明显），用户听到的就是
   * 「一卡一卡」——缓存是为了下次听得更顺，不能反过来毁掉这一次。
   *
   * 触发时机：切到下一首时补上一首、暂停时补当前这一首；如果一直在播同一首，
   * 就每隔 CACHE_START_DELAY_MS 再等一轮（宁可不缓存，也不抢播放的带宽）。
   */
  private scheduleCacheInBackground(
    track: Track,
    level: QualityLevel,
    url: string,
    format: string | undefined,
    variant: string
  ): void {
    if (!this.deps.cache) return
    const previous = this.pendingCache
    this.pendingCache = { track, level, url, format, variant }
    // 上一首已经不在播了：趁现在把它的整首下载补上（这时不抢 mpv 的带宽）。
    if (previous && previous.track.id !== track.id) void this.flushPendingCache(previous)
    this.armCacheTimer()
  }

  private armCacheTimer(): void {
    if (this.cacheTimer) return
    const timer = setTimeout(() => {
      this.cacheTimer = undefined
      void this.flushPendingCache()
    }, CACHE_START_DELAY_MS)
    this.cacheTimer = timer
    timer.unref?.()
  }

  /** 下载 `target`（默认取待缓存的那一首）；还在播同一首就再等一轮。 */
  private async flushPendingCache(target = this.pendingCache): Promise<void> {
    if (!target) return
    if (this.playing && this.loadedTrackId === target.track.id) {
      this.armCacheTimer()
      return
    }
    if (this.pendingCache === target) this.pendingCache = undefined
    this.cacheQueue = this.cacheQueue
      .then(() => this.cacheInBackground(target.track, target.level, target.url, target.format, target.variant))
      .catch(() => undefined)
  }

  private async cacheInBackground(
    track: Track,
    level: QualityLevel,
    url: string,
    format: string | undefined,
    variant: string
  ): Promise<void> {
    if (!this.deps.cache) return
    try {
      await this.deps.cache.cacheAudio(track.id, level, url, format, variant)
    } catch (cause) {
      this.deps.log?.(`后台缓存失败 (${track.id}): ${describeError(cause)}`)
    }
  }

  async play(): Promise<void> {
    if (this.index < 0) return
    // 队列自然播完后再按播放：mpv 此时没有载入任何文件，直接 setPaused(false)
    // 只会得到「显示播放中但无声」的幽灵态——重新播当前这首。
    if (this.ended) {
      await this.playIndex(this.index)
      return
    }
    await this.deps.mpv.setPaused(false)
    this.playing = true
    this.startPositionTimer()
    this.emitSnapshot()
  }

  async pause(): Promise<void> {
    await this.deps.mpv.setPaused(true)
    this.playing = false
    this.stopPositionTimer()
    this.emitSnapshot()
    // 暂停是难得的空窗：这时候把待缓存的整首下回来，不跟播放抢带宽。
    void this.flushPendingCache()
  }

  async toggle(): Promise<void> {
    if (this.playing) await this.pause()
    else await this.play()
  }

  async next(userInitiated = true): Promise<void> {
    if (this.queue.length === 0) return
    const target = this.pickNext(userInitiated)
    if (target < 0) {
      await this.pause()
      return
    }
    await this.playIndex(target)
  }

  async previous(): Promise<void> {
    if (this.queue.length === 0) return
    // Restart the current track when we are more than 3s in, like every other
    // player does.
    if (this.position > 3) {
      await this.seek(0)
      return
    }
    const target = this.shuffle
      ? Math.floor(Math.random() * this.queue.length)
      : (this.index - 1 + this.queue.length) % this.queue.length
    await this.playIndex(target)
  }

  async seek(seconds: number): Promise<void> {
    await this.deps.mpv.seek(seconds)
    this.position = seconds
    this.emitSnapshot()
  }

  async setVolume(volume: number): Promise<void> {
    this.volume = clamp(volume, 0, 150)
    await this.deps.mpv.setVolume(this.volume)
    this.emitSnapshot()
  }

  async setMuted(muted: boolean): Promise<void> {
    this.muteState = muted
    await this.deps.mpv.setMuted(muted)
    this.emitSnapshot()
  }

  setRepeat(mode: RepeatMode): void {
    this.repeatMode = mode
    this.emitSnapshot()
  }

  cycleRepeat(): RepeatMode {
    const order: RepeatMode[] = ['off', 'all', 'one']
    this.repeatMode = order[(order.indexOf(this.repeatMode) + 1) % order.length]
    this.emitSnapshot()
    return this.repeatMode
  }

  setShuffle(enabled: boolean): void {
    this.shuffle = enabled
    this.shuffleNext = undefined
    this.emitSnapshot()
  }

  /**
   * 换音质：**先把新档位的地址解析好，再动 mpv**。
   *
   * 顺序是这里的关键（用户反馈「播到一半切音质就半天加载不出来、不播放」）：
   * 解析这几秒里旧档位照常出声、进度条不归零；解析失败就完全无感——连
   * servedQuality 都不动，更不会跳下一首。成功后用 `mpv.play(source, position)`
   * 带位置一次到位，中途不经过 playIndex，所以 position 不会被清零、也不会重发
   * onTrackChanged（歌名闪一下、进度条弹回 0 都是这么来的）。
   *
   * 为什么必须清预解析缓存：`entry.preResolved*` 与 `prefetchedSources` 都是按
   * track.id 缓存的、跟音质无关，不清就会原样复用旧档位的地址（表现为「切到标准
   * 音质又自己弹回极高」，底部那个受控的音质下拉框跟着弹回去）。
   */
  async reloadCurrentTrack(): Promise<void> {
    if (this.index < 0) return
    const entry = this.queue[this.index]
    // 站外曲目（汽水/酷狗/酷我/QQ 搜来的歌）的音质由音源决定，换档没有意义，
    // 而且它的地址只存在于 preResolved 里，清了就播不了。
    if (entry.track.id < 0) return
    const position = this.position
    const wasPlaying = this.playing
    const previous = {
      servedQuality: this.servedQuality,
      servedBitrate: this.servedBitrate,
      servedFrom: this.servedFrom,
      source: this.source
    }
    entry.preResolved = undefined
    entry.preResolvedFull = undefined
    entry.preProbe = undefined
    // 预解析是「按当时的音质」做的，整条队列的都作废，免得下一首还用旧档位。
    for (const item of this.queue) {
      item.preResolvedFull = undefined
      item.preProbe = undefined
    }
    this.prefetchedSources.delete(entry.track.id)
    this.prefetchInflight.delete(entry.track.id)

    let resolved: ResolvedPlayback
    try {
      resolved = await withTimeout(
        this.resolveSource(entry.track, entry),
        QUALITY_RELOAD_TIMEOUT_MS,
        `切换音质《${entry.track.name}》`
      )
      // 解析期间用户可能已经切歌：这次换档作废，绝不动新歌的播放。
      if (this.queue[this.index] !== entry) return
      const remote = !resolved.cached && resolved.remoteURL ? resolved.remoteURL : undefined
      if (remote && resolved.servedFrom) {
        const probe = await this.probeRemote(remote, PROBE_TIMEOUT_MS)
        if (!probe.ok || looksLikeNoticeBySize(probe.totalBytes, entry.track.durationMS / 1000)) {
          throw new Error(probe.error ?? '音源探测未通过')
        }
      }
      if (this.queue[this.index] !== entry) return
    } catch (cause) {
      // 失败静默：不弹提示文字、不打断当前播放，档位显示维持原样。
      this.deps.log?.(`切换音质失败，保留原音质: ${describeError(cause)}`)
      this.servedQuality = previous.servedQuality
      this.servedBitrate = previous.servedBitrate
      this.servedFrom = previous.servedFrom
      this.source = previous.source
      this.emitSnapshot()
      return
    }

    try {
      await this.deps.mpv.play(resolved.source, position)
      this.servedQuality = resolved.servedFrom
        ? resolved.claimedLevel
        : (resolved.claimedLevel ?? resolved.level)
      this.servedBitrate = resolved.bitrate
      this.servedFrom = resolved.servedFrom ?? resolved.servedNote
      this.source = resolved.source
      this.position = position
      this.duration = entry.track.durationMS / 1000
      this.loading = false
      this.error = undefined
      this.ended = false
      this.playing = wasPlaying
      if (wasPlaying) {
        this.startPositionTimer()
      } else {
        await this.deps.mpv.setPaused(true).catch(() => undefined)
        this.stopPositionTimer()
      }
      if (!resolved.cached && resolved.remoteURL) {
        this.scheduleCacheInBackground(
          entry.track,
          resolved.level,
          resolved.remoteURL,
          resolved.format,
          resolved.cacheVariant
        )
      }
      this.emitSnapshot()
    } catch (cause) {
      this.deps.log?.(`切换音质失败（新地址没接住）: ${describeError(cause)}`)
      this.servedQuality = previous.servedQuality
      this.servedBitrate = previous.servedBitrate
      this.servedFrom = previous.servedFrom
      this.source = previous.source
      this.loading = false
      this.emitSnapshot()
    }
  }

  // MARK: - Playback bookkeeping

  /**
   * 决定「下一首」将落在哪个下标，lookahead 用它预解析、pickNext 用它真正切歌。
   * 随机模式下先 roll 一次并缓存在 shuffleNext，保证预解析与真正切歌是同一首。
   */
  private planNextIndex(userInitiated: boolean): number {
    if (this.queue.length === 1) return this.repeatMode === 'one' ? 0 : userInitiated ? 0 : -1
    if (this.shuffle) {
      if (this.shuffleNext !== undefined && this.shuffleNext !== this.index) return this.shuffleNext
      let candidate = Math.floor(Math.random() * this.queue.length)
      if (candidate === this.index) candidate = (candidate + 1) % this.queue.length
      this.shuffleNext = candidate
      return candidate
    }
    const isLast = this.index === this.queue.length - 1
    if (isLast && this.repeatMode === 'off' && !userInitiated) return -1
    return (this.index + 1) % this.queue.length
  }

  private pickNext(userInitiated: boolean): number {
    const next = this.planNextIndex(userInitiated)
    // 消费掉预 roll 的随机下标：下一次随机再重新 roll。
    if (this.shuffle && next === this.shuffleNext) this.shuffleNext = undefined
    return next
  }

  private async onTrackEnd(): Promise<void> {
    if (this.switching) return
    this.finishScrobble()
    if (this.repeatMode === 'one') {
      await this.playIndex(this.index)
      return
    }
    const target = this.pickNext(false)
    if (target < 0) {
      this.ended = true
      this.playing = false
      this.stopPositionTimer()
      this.emitSnapshot()
      return
    }
    await this.playIndex(target)
  }

  private startPositionTimer(): void {
    if (this.positionTimer) return
    const interval = this.deps.positionIntervalMs ?? 250
    this.positionTimer = setInterval(() => {
      if (!this.playing) return
      // mpv pushes position updates as properties change; the timer is only a
      // backstop so the lyric line advances when mpv is quiet about it.
      this.emitSnapshot()
      if (!this.scrobbleSent && this.duration > 0 && this.position / this.duration > 0.5) {
        this.scrobbleSent = true
        this.finishScrobble()
      }
    }, interval)
    this.positionTimer.unref?.()
  }

  private stopPositionTimer(): void {
    if (!this.positionTimer) return
    clearInterval(this.positionTimer)
    this.positionTimer = undefined
  }

  private scrobbleStart(): void {
    if (!this.deps.getScrobble()) return
    const entry = this.queue[this.index]
    if (!entry) return
    try {
      this.deps.onScrobbleStart?.(entry.track, entry.track.album.id)
    } catch (cause) {
      this.deps.log?.(`记录播放开始失败: ${describeError(cause)}`)
    }
  }

  private finishScrobble(): void {
    if (!this.deps.getScrobble()) return
    const entry = this.queue[this.index]
    if (!entry) return
    const seconds = Math.max(1, Math.floor(this.position))
    try {
      this.deps.onScrobbleFinish?.(entry.track, entry.track.album.id, seconds)
    } catch (cause) {
      this.deps.log?.(`记录播放结束失败: ${describeError(cause)}`)
    }
  }

  /** Stops playback and releases the position timer, e.g. on app quit. */
  async shutdown(): Promise<void> {
    this.resolveGeneration += 1
    this.stopPositionTimer()
    this.finishScrobble()
    await this.deps.mpv.stop().catch(() => undefined)
  }
}

// MARK: - helpers

function toTrackDTO(entry: QueueEntry): TrackDTO {
  const track = entry.track
  return {
    id: track.id,
    name: track.name,
    artists: track.artists.map((artist) => ({
      id: artist.id,
      name: artist.name,
      ...(artist.picUrl ? { picUrl: artist.picUrl } : {})
    })),
    album: { id: track.album.id, name: track.album.name, picUrl: track.album.picUrl },
    durationMS: track.durationMS,
    alias: track.alias,
    transNames: track.transNames,
    fee: track.fee,
    mvID: track.mvID,
    noCopyright: track.noCopyright,
    isCloud: track.isCloud,
    playability: entry.playability,
    playabilityReason: entry.playabilityReason
  }
}

function ladderFrom(requested: QualityLevel): QualityLevel[] {
  const start = QUALITY_LADDER.indexOf(requested)
  if (start < 0) return [requested, ...QUALITY_LADDER]
  return QUALITY_LADDER.slice(start)
}

/** 把第三方音源报告的码率映射到我们自己的音质档位；未知返回 undefined。 */
function qualityForBitrate(bitrate: number | undefined): QualityLevel | undefined {
  if (!bitrate || bitrate <= 0) return undefined
  if (bitrate >= 900) return 'lossless'
  if (bitrate >= 256) return 'exhigh'
  if (bitrate >= 160) return 'higher'
  return 'standard'
}

function httpsURL(url: string): string {
  return url.replace(/^http:\/\//, 'https://')
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 码率（kbps）→ 音质档位。
 *
 * 阈值按各档位的常见码率取下界：128 以下算标准、192 以上算较高、256 以上算极高、
 * 900 以上按无损对待（第三方 flac 常见 900~1100kbps）。
 * 只用来给「接口没声明档位」的第三方音源兜底，不会把已知档位抬高。
 */
function qualityFromBitrate(kbps: number): QualityLevel {
  if (kbps >= 900) return 'lossless'
  if (kbps >= 256) return 'exhigh'
  if (kbps >= 160) return 'higher'
  return 'standard'
}

export function describeError(cause: unknown): string {
  if (cause instanceof NeteaseAPIError) return cause.message
  if (cause instanceof Error) return cause.message
  return String(cause)
}
