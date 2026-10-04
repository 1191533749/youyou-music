/**
 * Player IPC: transport, queue, quality and audio devices.
 *
 * The queue the renderer manipulates is made of `TrackDTO`s, but playback needs
 * full `Track` models (privileges, fee, duration) — so `player:playTracks`
 * re-hydrates the ids through `/v3/song/detail` and falls back to the DTO data
 * when that call fails, rather than refusing to play.
 */
import { defineHandler } from './registry.js'
import { toTracksDTO } from './mappers.js'
import type { AppContext } from '../context.js'
import type { QualityLevel } from '@shared/types'
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
  return {
    isLoggedIn: context.client.isLoggedIn,
    vipType: 0
  }
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

  defineHandler('player:playTracks', async ({ tracks, startIndex }) => {
    if (tracks.length === 0) return context.player.snapshot()
    const ids = tracks.map((track) => track.id)
    let hydrated: Track[] = []
    let privileges
    try {
      const detail = await context.api.songDetails(ids)
      hydrated = detail.songs
      privileges = detail.privileges
      // Preserve the caller's ordering; the detail endpoint does not guarantee it.
      const byID = new Map(hydrated.map((track) => [track.id, track]))
      hydrated = ids.map((id) => byID.get(id)).filter((track): track is Track => !!track)
    } catch (cause) {
      context.log(`获取歌曲详情失败，改用列表数据播放: ${String(cause)}`)
    }
    if (hydrated.length === 0) hydrated = tracks.map(trackFromDTO)

    const privilegeMap = privileges ? new Map(privileges.map((item) => [item.id, item])) : undefined
    await context.player.setQueue(hydrated, startIndex ?? 0, privilegeMap)
    return context.player.snapshot()
  })

  defineHandler('player:playFMTracks', async ({ tracks }) => {
    const hydrated = tracks.length > 0 ? tracks.map(trackFromDTO) : await context.api.personalFM()
    await context.player.setQueue(hydrated as Track[], 0)
    return context.player.snapshot()
  })

  defineHandler('player:toggle', async () => {
    await context.player.toggle()
    return context.player.snapshot()
  })

  defineHandler('player:play', async () => {
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
    const devices = [{ id: 'auto', name: '系统默认输出设备', isDefault: true }]
    try {
      const listed = await context.mpv.listAudioDevices()
      for (const device of listed) {
        if (device === 'auto') continue
        devices.push({
          id: device,
          name: prettyDeviceName(device),
          isDefault: false
        })
      }
    } catch (cause) {
      context.log(`枚举音频设备失败: ${String(cause)}`)
    }
    return devices
  })

  void mappingContext
  void toTracksDTO
}

/** `wasapi/{0.0.0.00000000}.{guid}` → a name the user can recognise. */
function prettyDeviceName(device: string): string {
  const match = /^wasapi\/(.+)$/.exec(device)
  if (!match) return device
  const label = match[1].trim()
  // Windows device ids are GUIDs; the UI cannot resolve friendly names without
  // another API, so show a shortened id rather than pretending.
  return label.length > 40 ? `${label.slice(0, 37)}…` : label
}
