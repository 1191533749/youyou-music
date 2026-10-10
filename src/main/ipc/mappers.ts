/**
 * Model → DTO mapping.
 *
 * The main process works with rich models (privilege objects, embedded
 * playability inputs); the renderer only ever needs presentation-ready track
 * data. Mapping happens here, once, so no feature module has to remember which
 * of the two shapes it is holding.
 */
import {
  playability,
  playabilityReason,
  type AlbumDetail,
  type AlbumSummary,
  type ArtistSummary,
  type PlaylistDetail,
  type PlaylistSummary,
  type Track,
  type TrackPlayability,
  type TrackPrivilege
} from '../netease/models.js'
import type {
  AlbumSummaryDTO,
  ArtistSummaryDTO,
  PlaylistSummaryDTO,
  TrackDTO
} from '@shared/types'
import type { AppContext } from '../context.js'

export interface TrackMappingContext {
  isLoggedIn: boolean
  vipType: number
  privileges?: Map<number, TrackPrivilege>
  /**
   * 开启灰色歌曲解锁后，受限曲目也会由第三方音源播放，因此对用户而言
   * 全部可播。
   * 界面据此不再显示「VIP 专属 / 无版权」这类灰态。
   */
  unblockEnabled?: boolean
}

export function toTrackDTO(track: Track, context: TrackMappingContext): TrackDTO {
  const state: TrackPlayability = context.unblockEnabled
    ? 'playable'
    : playability(track, context.privileges?.get(track.id), context.isLoggedIn, context.vipType)
  return {
    id: track.id,
    name: track.name,
    // 歌手头像（可能没有）：播放详情页在封面缺失时用它兜底，不再用吉祥物占位。
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
    playability: state,
    playabilityReason: context.unblockEnabled ? undefined : playabilityReason(state)
  }
}

export function toTracksDTO(tracks: Track[], context: TrackMappingContext): TrackDTO[] {
  return tracks.map((track) => toTrackDTO(track, context))
}

/**
 * 从运行上下文推导映射参数。集中在这里，才能保证「换源开关一开，
 * 所有页面返回的 playability 同时变成 playable」，而不是各处各写一遍。
 */
export function mappingContextFrom(context: AppContext): TrackMappingContext {
  const settings = context.settings.current
  return {
    isLoggedIn: context.client.isLoggedIn,
    vipType: 0,
    unblockEnabled: settings.unblockGreyTracks && settings.unblockSources.length > 0
  }
}

export function toPlaylistDTO(playlist: PlaylistSummary): PlaylistSummaryDTO {
  return {
    id: playlist.id,
    name: playlist.name,
    coverURL: playlist.coverURL,
    playCount: playlist.playCount,
    trackCount: playlist.trackCount,
    copywriter: playlist.copywriter,
    creator: playlist.creator
      ? {
          userId: playlist.creator.userId,
          nickname: playlist.creator.nickname,
          avatarUrl: playlist.creator.avatarUrl
        }
      : undefined,
    specialType: playlist.specialType,
    privacy: playlist.privacy,
    subscribed: playlist.subscribed,
    isLikedSongsList: playlist.specialType === 5
  }
}

export function toAlbumDTO(album: AlbumSummary | AlbumDetail): AlbumSummaryDTO {
  return {
    id: album.id,
    name: album.name,
    picUrl: album.picUrl,
    // AlbumDetail carries a full artist object rather than a joined name.
    artistName: 'artistName' in album ? album.artistName : (album.artist?.name ?? ''),
    publishTime: album.publishTime,
    size: album.size,
    subType: album.subType,
    alias: 'alias' in album ? album.alias : []
  }
}

export function toArtistDTO(artist: ArtistSummary): ArtistSummaryDTO {
  return {
    id: artist.id,
    name: artist.name,
    picUrl: artist.picUrl,
    albumSize: artist.albumSize,
    musicSize: artist.musicSize,
    briefDesc: artist.briefDesc,
    alias: artist.alias,
    followed: artist.followed
  }
}

export function toPlaylistDetailDTO(
  detail: PlaylistDetail,
  privileges: TrackPrivilege[] | undefined,
  context: Omit<TrackMappingContext, 'privileges'>
) {
  const map = privileges ? new Map(privileges.map((item) => [item.id, item])) : undefined
  return {
    id: detail.id,
    name: detail.name,
    coverURL: detail.coverImgUrl,
    description: detail.description,
    creator: detail.creator
      ? {
          userId: detail.creator.userId,
          nickname: detail.creator.nickname,
          avatarUrl: detail.creator.avatarUrl
        }
      : undefined,
    trackCount: detail.trackCount,
    playCount: detail.playCount,
    subscribedCount: detail.subscribedCount,
    subscribed: detail.subscribed,
    specialType: detail.specialType,
    updateTime: detail.updateTime,
    tracks: toTracksDTO(detail.tracks, { ...context, privileges: map })
  }
}
