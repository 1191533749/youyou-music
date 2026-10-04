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
import type { NeteaseAPI } from '../netease/api.js'
import { NeteaseAPIError } from '../netease/client.js'
import { playability, playabilityReason, type Track } from '../netease/models.js'
import type { MpvController, MpvState } from '../audio/mpv.js'
import type { QualityLevel, RepeatMode, TrackDTO } from '@shared/types'

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
  /** Optional audio cache: playback prefers a cached file over the network. */
  cache?: {
    audioPath: (trackID: number, level: QualityLevel) => Promise<string | undefined>
    cacheAudio: (
      trackID: number,
      level: QualityLevel,
      url: string,
      extensionHint?: string
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
  servedQuality?: QualityLevel
  error?: string
  source?: string
}

/** Extra per-track state the queue keeps but a bare Track does not carry. */
interface QueueEntry {
  track: Track
  /** Playability for the current login, computed when the queue was built. */
  playability: 'playable' | 'vipOnly' | 'paidAlbum' | 'noCopyright' | 'delisted'
  playabilityReason?: string
}

export class PlayerController extends EventEmitter {
  private queue: QueueEntry[] = []
  private index = -1
  private playing = false
  private position = 0
  private duration = 0
  private muteState = false
  private loading = false
  private repeatMode: RepeatMode = 'off'
  private shuffle = false
  private servedQuality?: QualityLevel
  private error?: string
  private source?: string
  private volume = 80
  private scrobbleSent = false
  private positionTimer?: NodeJS.Timeout
  /** True while we are switching tracks, so `end-file` is not treated as an end. */
  private switching = false
  /** Guards against an in-flight resolve being overtaken by a newer play(). */
  private resolveGeneration = 0

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
    this.muteState = state.muted
    this.volume = state.volume
    this.loading = state.loading
    this.emitSnapshot()
  }

  // MARK: - Queue management

  /**
   * Replaces the queue. `startIndex` picks the track to play; `-1` queues
   * without starting playback.
   */
  async setQueue(tracks: Track[], startIndex = 0, privileges?: Map<number, any>): Promise<void> {
    this.queue = tracks.map((track) => this.toEntry(track, privileges?.get(track.id)))
    this.index = this.queue.length === 0 ? -1 : clamp(startIndex, 0, this.queue.length - 1)
    this.emitSnapshot()
    if (this.index >= 0) await this.playIndex(this.index, { keepQueue: true })
  }

  async append(tracks: Track[]): Promise<void> {
    const existing = new Set(this.queue.map((entry) => entry.track.id))
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
    this.loading = true
    this.scrobbleSent = false
    this.position = 0
    this.duration = this.queue[index].track.durationMS / 1000
    this.emitSnapshot()
    this.deps.onTrackChanged?.(this.queue[index].track)

    const entry = this.queue[index]
    try {
      const resolved = await this.resolveSource(entry.track)
      if (generation !== this.resolveGeneration) return
      this.servedQuality = resolved.level
      this.source = resolved.source
      // A local cache hit is a file path, not a stream.
      await this.deps.mpv.play(resolved.source, 0)
      if (resolved.level !== this.deps.getQuality()) {
        this.deps.log?.(`音质降级: 请求 ${this.deps.getQuality()}，实际 ${resolved.level}`)
      }
      if (!resolved.cached && resolved.remoteURL) {
        // Cache in the background: the user should hear the track now, not
        // after a full download.
        void this.cacheInBackground(entry.track, resolved.level, resolved.remoteURL, resolved.format)
      }
      this.playing = true
      this.startPositionTimer()
      this.scrobbleStart()
    } catch (cause) {
      if (generation !== this.resolveGeneration) return
      const message = describeError(cause)
      this.error = message
      this.playing = false
      this.deps.onError?.(message)
      this.deps.log?.(`播放失败: ${message}`)
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
   * Decides what mpv should open: the cached file when we have it, otherwise
   * the CDN URL — plus the resolved quality and format, which the cache needs
   * to key its entry and pick a file extension.
   */
  private async resolveSource(
    track: Track
  ): Promise<{ source: string; level: QualityLevel; format?: string; cached: boolean; remoteURL?: string }> {
    const requested = this.deps.getQuality()

    // A cached copy at the requested tier is the best case: no network at all.
    const cachedAtRequested = await this.deps.cache
      ?.audioPath(track.id, requested)
      .catch(() => undefined)
    if (cachedAtRequested) {
      return { source: cachedAtRequested, level: requested, cached: true }
    }

    const remote = await this.resolveURL(track)
    return { ...remote, cached: false, remoteURL: remote.url, source: remote.url }
  }

  private async cacheInBackground(
    track: Track,
    level: QualityLevel,
    url: string,
    format?: string
  ): Promise<void> {
    if (!this.deps.cache) return
    try {
      await this.deps.cache.cacheAudio(track.id, level, url, format)
    } catch (cause) {
      this.deps.log?.(`后台缓存失败 (${track.id}): ${describeError(cause)}`)
    }
  }

  /**
   * Resolves a playable URL, walking down the quality ladder when the account
   * is not entitled to the requested tier. Explicit grey-track unblocking is
   * handled upstream by the caller, which substitutes a track before it ever
   * reaches the queue.
   */
  private async resolveURL(track: Track): Promise<{ url: string; level: QualityLevel; format?: string }> {
    const requested = this.deps.getQuality()
    const ladder = this.deps.autoDowngrade() ? ladderFrom(requested) : [requested]
    let lastError: unknown
    for (const level of ladder) {
      try {
        const results = await this.deps.api.songURL([track.id], level)
        const data = results.find((item) => item.id === track.id) ?? results[0]
        if (data?.url) {
          return {
            url: httpsURL(data.url),
            level: (data.level as QualityLevel) ?? level,
            format: data.type
          }
        }
        lastError = new NeteaseAPIError('business', {
          code: data?.code ?? -1,
          message: `该音质暂不可用 (${level})`
        })
      } catch (cause) {
        lastError = cause
      }
    }
    throw lastError ?? new Error('没有可用的播放地址')
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

function httpsURL(url: string): string {
  return url.replace(/^http:\/\//, 'https://')
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function describeError(cause: unknown): string {
  if (cause instanceof NeteaseAPIError) return cause.message
  if (cause instanceof Error) return cause.message
  return String(cause)
}
