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
import type { QualityLevel, RepeatMode, TrackDTO } from '@shared/types'

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
  /** 缓存归档用的音源标记（netease / pyncmd / kugou / kuwo）。 */
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
  onError?: (message: string) => void
  log?: (message: string) => void
  /** Playback position poll interval in ms while playing. */
  positionIntervalMs?: number
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
  preResolved?: { url: string; sourceName: string }
  /** 顺序播放的下一首预解析结果：切歌时直接复用，跳过整条解析链路。 */
  preResolvedFull?: ResolvedPlayback
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

  constructor(private readonly deps: PlayerDeps) {
    super()
    this.volume = 80
    this.deps.mpv.on('track-end', () => {
      void this.onTrackEnd()
    })
    this.deps.mpv.on('state', (state: MpvState) => this.onMpvState(state))
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
    // mpv 真出声音的那一刻就当作「播放中」：播放/暂停按钮必须立刻跟着走，
    // 不能等整条解析+验证链跑完——验证（尤其第三方音源）最长几十秒，
    // 期间按钮会一直像「按了没反应」，用户就是这么抱怨的。
    if (!state.idle && !state.loading && !state.paused) {
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
    this.emitSnapshot()
    if (this.index >= 0) await this.playIndex(this.index, { keepQueue: true })
  }

  /**
   * 播放一首站外曲目（汽水/酷狗/酷我 搜索来的歌）。
   * 音频地址由调用方解析好，这里只把它作为队列里的唯一一首歌播放。
   */
  async playExternal(track: Track, resolved: { url: string; sourceName: string }): Promise<void> {
    this.queue = [{ track, playability: 'playable', preResolved: resolved }]
    this.index = 0
    this.consecutiveFailures = 0
    this.emitSnapshot()
    await this.playIndex(0, { keepQueue: true })
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
    await this.deps.mpv.unload().catch(() => undefined)
    this.playing = false
    this.position = 0
    this.duration = 0
    this.emitSnapshot()
  }

  private toEntry(track: Track, privilege?: any): QueueEntry {
    // Playability is decided with the live profile, so the "VIP 专属" label is
    // not baked into a queue built before login.
    const state = playability(track, privilege, this.deps.getLoggedIn(), this.deps.getVipType())
    return { track, playability: state, playabilityReason: playabilityReason(state) }
  }

  // MARK: - Transport

  async playIndex(index: number, options: { keepQueue?: boolean } = {}): Promise<void> {
    if (index < 0 || index >= this.queue.length) return
    const generation = ++this.resolveGeneration
    this.switching = true
    this.index = index
    this.error = undefined
    this.servedQuality = undefined
    this.servedBitrate = undefined
    this.servedFrom = undefined
    this.loading = true
    this.scrobbleSent = false
    this.position = 0
    this.duration = this.queue[index].track.durationMS / 1000
    this.emitSnapshot()
    this.deps.onTrackChanged?.(this.queue[index].track)

    const entry = this.queue[index]
    try {
      let resolved: ResolvedPlayback | undefined
      // 版权提示音防御：第三方音源偶尔返回「当前歌曲仅支持 XX 客户端播放」的
      // 语音占位文件（时长只有十几秒）。逐候选重试：验证失败就把该音源记入
      // attempted，resolveSource 自然会尝试下一个音源，直到拿到真歌。
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
                  cacheVariant: 'netease',
                  servedFrom: entry.preResolved.sourceName
                }
              : await withTimeout(
                  this.resolveSource(entry.track),
                  RESOLVE_TIMEOUT_MS,
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
        // 远程第三方音源先静音播放，验证时长通过后再恢复用户音量——
        // 提示音最长只会在静音窗口里被缓冲，用户听到的永远是验证过的真歌。
        // try/finally 保证任何失败路径（play 抛错、时长读取超时）都恢复静音，
        // 否则 mpv 会永远保持静音，表现为「莫名其妙自己静音」。
        const verifyMuted = !resolved.cached && !!resolved.servedFrom
        const userMuted = this.muteState
        if (verifyMuted) {
          this.suppressMuteEcho = true
          await this.deps.mpv.setMuted(true)
        }
        try {
          // A local cache hit is a file path, not a stream.
          await this.deps.mpv.play(resolved.source, 0)
          if (verifyMuted && (await this.looksLikeNotice(entry.track))) {
            const variant = resolved.cacheVariant
            if (variant && variant !== 'netease') {
              this.attemptedSources(entry.track.id).add(variant as AudioSourceID)
            }
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
        void this.cacheInBackground(
          entry.track,
          resolved.level,
          resolved.remoteURL,
          resolved.format,
          resolved.cacheVariant
        )
      }
      this.playing = true
      this.consecutiveFailures = 0
      this.startPositionTimer()
      this.scrobbleStart()
      // 顺序模式下后台预解析下一首：切歌瞬间就能出声（用户反馈「加载慢、卡顿」）。
      if (!this.shuffle && this.repeatMode !== 'one') {
        void this.prepareLookahead(generation)
      }
      // 真实码率要等 mpv 把文件载入后才能读到：异步补一次，用来诚实显示音质。
      void this.refreshRealBitrate(generation)
    } catch (cause) {
      if (generation !== this.resolveGeneration) return
      const message = describeError(cause)
      this.deps.log?.(`播放失败: ${message}`)
      // 拿不到可播版本时**自动跳下一首**，不要把「版权/受限」这类原因摆到用户面前。
      // 只有整条队列都放过一遍还是不行，才给一句中性提示。
      if (this.queue.length > 1 && this.consecutiveFailures < this.queue.length - 1) {
        this.consecutiveFailures += 1
        this.error = undefined
        void this.next(false)
        return
      }
      this.consecutiveFailures = 0
      this.error = '暂时无法播放，请稍后再试'
      this.playing = false
      this.deps.onError?.(this.error)
    } finally {
      if (generation === this.resolveGeneration) {
        this.loading = false
        this.switching = false
        this.emitSnapshot()
      }
    }
    void options
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

  /**
   * 判断正在播放的远程流是不是「版权提示音」占位文件：
   * mpv 报出的实际时长比曲目时长短 90 秒以上基本可以断定被替换
   * （提示语音通常 10~30 秒）。短歌（<2 分钟）不检查，避免误伤。
   * 超时读不到时长（还在缓冲）宁可放过，不冤枉正常歌曲。
   */
  private async looksLikeNotice(track: Track): Promise<boolean> {
    const expected = track.durationMS / 1000
    if (expected < 120) return false
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
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
   * 顺序模式下后台预解析下一首：正在播的时候把下一条的音源解析好，
   * 切歌瞬间就能出声。失败静默——真正切歌时仍走完整解析链路。
   */
  private async prepareLookahead(generation: number): Promise<void> {
    const nextIndex = this.index + 1
    if (nextIndex >= this.queue.length) return
    const entry = this.queue[nextIndex]
    if (entry.preResolvedFull) return
    try {
      const resolved = await withTimeout(this.resolveSource(entry.track), RESOLVE_TIMEOUT_MS, `预解析《${entry.track.name}》`)
      if (generation !== this.resolveGeneration) return
      if (this.queue[nextIndex] !== entry) return
      entry.preResolvedFull = resolved
      this.deps.log?.(`已预解析下一首：${entry.track.name}`)
    } catch {
      // 预解析失败就等切歌时再走完整链路，绝不影响当前播放。
    }
  }

  /**
   * Decides what mpv should open.
   *
   * 顺序：本次请求音质的本地缓存 → 网易云官方地址 → （受限时）站内替代版本 →
   * 第三方音源。缓存命中是最好情况（完全不联网）。
   */
  private async resolveSource(track: Track): Promise<ResolvedPlayback> {
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

    // 3. 第三方音源（pyncmd / 酷狗 / 酷我）。
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

    const { source } = await this.deps.unblock.resolve(track, this.attemptedSources(track.id))
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
   * 站内替代版本：按「歌名 + 首位歌手」搜索，要求时长相差 ≤ 5 秒、
   * 标题归一化一致、版本标记一致，且该条目自身有播放权限。
   */
  private async findSubstitute(track: Track): Promise<Track | undefined> {
    const keyword = `${track.name} ${track.artists[0]?.name ?? ''}`.trim()
    if (!keyword) return undefined
    const result = await this.deps.api.search(keyword, SearchType.songs, 20, 0)
    const candidates = result.songs ?? []
    for (const candidate of candidates) {
      if (candidate.id === track.id) continue
      if (!matchesTrack(track, {
        title: candidate.name,
        artist: candidate.artists[0]?.name ?? '',
        durationMS: candidate.durationMS
      })) {
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
    this.emitSnapshot()
  }

  /** Re-resolves the current track, e.g. after the user changes the quality. */
  async reloadCurrentTrack(): Promise<void> {
    if (this.index < 0) return
    const position = this.position
    await this.playIndex(this.index)
    if (position > 0) await this.seek(position)
  }

  // MARK: - Playback bookkeeping

  private pickNext(userInitiated: boolean): number {
    if (this.queue.length === 1) return this.repeatMode === 'one' ? 0 : userInitiated ? 0 : -1
    if (this.shuffle) {
      let candidate = Math.floor(Math.random() * this.queue.length)
      if (candidate === this.index) candidate = (candidate + 1) % this.queue.length
      return candidate
    }
    const isLast = this.index === this.queue.length - 1
    if (isLast && this.repeatMode === 'off' && !userInitiated) return -1
    return (this.index + 1) % this.queue.length
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
    artists: track.artists.map((artist) => ({ id: artist.id, name: artist.name })),
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
