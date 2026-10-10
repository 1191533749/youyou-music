/**
 * Player IPC: transport, queue, quality and audio devices.
 *
 * The queue the renderer manipulates is made of `TrackDTO`s, but playback needs
 * full `Track` models (privileges, fee, duration) — so `player:playTracks`
 * re-hydrates the ids through `/v3/song/detail` and falls back to the DTO data
 * when that call fails, rather than refusing to play.
 */
import { defineHandler } from './registry.js'
import { mappingContextFrom, toTracksDTO } from './mappers.js'
import { localDateKey } from '../storage/dailyHistory.js'
import { pushDailyToServer } from './explore.js'
import { resolveExternalAudio, toSyntheticTrack } from '../external/search.js'
import type { AppContext } from '../context.js'
import type { QualityLevel, AudioDeviceDTO } from '@shared/types'
import type { Track } from '../netease/models.js'

const VALID_QUALITIES: QualityLevel[] = [
  'standard',
  'higher',
  'exhigh',
  'lossless',
  'hires',
  'jyeffect',
  'sky',
  'jymaster'
]

function mappingContext(context: AppContext) {
  return mappingContextFrom(context)
}

/** Rebuilds a Track from a DTO when the detail endpoint cannot be reached. */
function trackFromDTO(dto: {
  id: number
  name: string
  artists: Array<{ id: number; name: string }>
  album: { id: number; name: string; picUrl?: string }
  durationMS: number
  alias: string[]
  transNames: string[]
  fee: number
  mvID: number
  noCopyright: boolean
  isCloud: boolean
}): Track {
  return {
    id: dto.id,
    name: dto.name,
    artists: dto.artists.map((artist) => ({ id: artist.id, name: artist.name })),
    album: { id: dto.album.id, name: dto.album.name, picUrl: dto.album.picUrl },
    durationMS: dto.durationMS,
    alias: dto.alias,
    transNames: dto.transNames,
    fee: dto.fee,
    mvID: dto.mvID,
    trackNo: 0,
    noCopyright: dto.noCopyright,
    isCloud: dto.isCloud
  }
}

export function registerPlayerHandlers(context: AppContext): void {
  defineHandler('player:state', () => context.player.snapshot())

  /**
   * 队列为空时点播放：立即从今日推荐随机起播一首（用户 0.4.1 反馈第 6 项）。
   * 取不到（未登录/限流）就静默放弃，交给原有空队列行为。
   */
  async function ensureQueueHasMusic(ctx: AppContext): Promise<void> {
    if (ctx.player.snapshot().queue.length > 0) return
    try {
      const daily = await ctx.api.dailyRecommendSongs()
      if (daily.length > 0) {
        // 顺手把今天的列表落进历史快照：如果用户今天第一次播放就走这条路
        // （没打开过每日推荐页），「昨天的日推」明天也要能回看。
        ctx.dailyHistory.save(localDateKey(0), toTracksDTO(daily, mappingContext(ctx)))
        void pushDailyToServer(ctx, localDateKey(0), toTracksDTO(daily, mappingContext(ctx)))
        ctx.log(`队列为空，自动从今日推荐随机起播（共 ${daily.length} 首）`)
        await ctx.player.setQueue(daily, 0, undefined, { randomStart: true })
      }
    } catch (cause) {
      ctx.log(`队列为空时取今日推荐失败: ${String(cause)}`)
    }
  }

  /** 起播前等曲目详情的上限：整页最多 200 首，接口一慢点一下就卡住（用户反馈第 6 项）。 */
  const DETAIL_DEADLINE_MS = 1500

  defineHandler('player:playTracks', async ({ tracks, startIndex, randomStart }) => {
    if (tracks.length === 0) return context.player.snapshot()
    const ids = tracks.map((track) => track.id)
    let hydrated: Track[] = []
    let privileges
    try {
      // 起播不能被「整页曲目详情」拖住：最多等 1.5 秒，超时就用列表自带的数据先播。
      // 列表页拿到的 TrackDTO 已经够起播；详情接口额外给的只是特权/封面数据，
      // 缺了它 VIP 标签可能显示得保守一点，但站外兜底链路照样能把这歌放出来。
      const detailPromise = context.api.songDetails(ids)
      detailPromise.catch(() => undefined) // 超时后没人 await，别让它变成 unhandled rejection
      const detail = await Promise.race([
        detailPromise,
        new Promise<undefined>((resolve) => {
          setTimeout(() => resolve(undefined), DETAIL_DEADLINE_MS).unref?.()
        })
      ])
      if (!detail) {
        context.log(`曲目详情超过 ${DETAIL_DEADLINE_MS}ms 未返回，先用列表数据起播（共 ${ids.length} 首）`)
      } else {
        hydrated = detail.songs
        privileges = detail.privileges
        // Preserve the caller's ordering; the detail endpoint does not guarantee it.
        const byID = new Map(hydrated.map((track) => [track.id, track]))
        hydrated = ids.map((id) => byID.get(id)).filter((track): track is Track => !!track)
      }
    } catch (cause) {
      context.log(`获取歌曲详情失败，改用列表数据播放: ${String(cause)}`)
    }
    if (hydrated.length === 0) hydrated = tracks.map(trackFromDTO)

    const privilegeMap = privileges ? new Map(privileges.map((item) => [item.id, item])) : undefined
    await context.player.setQueue(hydrated, startIndex ?? 0, privilegeMap, { randomStart: randomStart === true })
    return context.player.snapshot()
  })

  /**
   * 播放站外曲目：主进程负责严格匹配到完整音频（酷狗/酷我），再把 URL 交给播放器。
   * 匹配不到就明确报错，绝不播翻唱或半截。
   */
  defineHandler('player:playExternal', async ({ item }) => {
    const resolved = await resolveExternalAudio(item)
    if (!resolved) {
      throw new Error('没有找到这首歌的完整音源，已跳过（不会播放翻唱或片段）')
    }
    const track = toSyntheticTrack(item)
    context.log(`播放站外曲目：${item.name} - ${item.artists}（来自 ${resolved.sourceName}）`)
    await context.player.playExternal(track, resolved)
    return context.player.snapshot()
  })

  defineHandler('player:playFMTracks', async ({ tracks }) => {
    const hydrated = tracks.length > 0 ? tracks.map(trackFromDTO) : await context.api.personalFM()
    await context.player.setQueue(hydrated as Track[], 0)
    return context.player.snapshot()
  })

  defineHandler('player:toggle', async () => {
    await ensureQueueHasMusic(context)
    await context.player.toggle()
    return context.player.snapshot()
  })

  defineHandler('player:play', async () => {
    await ensureQueueHasMusic(context)
    await context.player.play()
    return context.player.snapshot()
  })

  defineHandler('player:pause', async () => {
    await context.player.pause()
    return context.player.snapshot()
  })

  defineHandler('player:next', async () => {
    await context.player.next()
    return context.player.snapshot()
  })

  defineHandler('player:previous', async () => {
    await context.player.previous()
    return context.player.snapshot()
  })

  defineHandler('player:seek', async ({ seconds }) => {
    await context.player.seek(Math.max(0, seconds))
    return context.player.snapshot()
  })

  defineHandler('player:setVolume', async ({ volume }) => {
    await context.player.setVolume(volume)
    await context.settings.update({ volume: Math.round(Math.min(150, Math.max(0, volume))) })
    return context.player.snapshot()
  })

  defineHandler('player:setMuted', async ({ muted }) => {
    await context.player.setMuted(muted)
    return context.player.snapshot()
  })

  defineHandler('player:setRepeat', ({ mode }) => {
    context.player.setRepeat(mode)
    return context.player.snapshot()
  })

  defineHandler('player:cycleRepeat', () => {
    context.player.cycleRepeat()
    return context.player.snapshot()
  })

  defineHandler('player:setShuffle', ({ shuffle }) => {
    context.player.setShuffle(shuffle)
    return context.player.snapshot()
  })

  defineHandler('player:setQueue', async ({ tracks, startIndex }) => {
    const hydrated = tracks.map(trackFromDTO) as Track[]
    await context.player.setQueue(hydrated, startIndex ?? 0)
    return context.player.snapshot()
  })

  defineHandler('player:append', async ({ tracks }) => {
    await context.player.append(tracks.map(trackFromDTO) as Track[])
    return context.player.snapshot()
  })

  defineHandler('player:removeAt', async ({ indices }) => {
    await context.player.removeAt(indices)
    return context.player.snapshot()
  })

  defineHandler('player:clearQueue', async () => {
    await context.player.clearQueue()
    return context.player.snapshot()
  })

  defineHandler('player:setQuality', async ({ quality }) => {
    const level = quality as QualityLevel
    if (!VALID_QUALITIES.includes(level)) {
      throw new Error(`未知音质: ${quality}`)
    }
    await context.settings.update({ quality: level })
    // Re-resolve the current track so the change is audible immediately.
    await context.player.reloadCurrentTrack()
    return context.player.snapshot()
  })

  defineHandler('player:trackInfo', async () => {
    try {
      const info = await context.mpv.trackInfo()
      return {
        codec: info.audioCodec,
        sampleRate: info.audioSampleRate,
        channels: info.audioChannels,
        bitrate: info.audioBitrate,
        fileSize: info.fileSize
      }
    } catch {
      return {}
    }
  })

  defineHandler('player:audioDevices', async () => {
    // mpv enumerates devices itself; the renderer only needs the list, and the
    // "auto" entry stands for the system default.
    const devices: AudioDeviceDTO[] = [{ id: 'auto', name: '系统默认输出设备', isDefault: true }]
    try {
      const listed = await context.mpv.listAudioDevices()
      for (const device of listed) {
        if (device.id === 'auto') continue
        devices.push({ id: device.id, name: device.label, isDefault: false })
      }
    } catch (cause) {
      context.log(`枚举音频设备失败: ${String(cause)}`)
    }
    return devices
  })

  void mappingContext
  void toTracksDTO
  void mappingContextFrom
}
