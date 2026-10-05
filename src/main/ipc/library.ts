/**
 * Library IPC: the user's own playlists, liked songs, saved albums and artists,
 * recent plays, the cloud drive, and the mutations that change them.
 */
import { defineHandler } from './registry.js'
import { mappingContextFrom, toAlbumDTO, toArtistDTO, toPlaylistDTO, toTracksDTO } from './mappers.js'
import type { AppContext } from '../context.js'
import type { CloudSongDTO } from '@shared/ipc'

function context0(context: AppContext) {
  return mappingContextFrom(context)
}

async function requireProfile(context: AppContext) {
  const profile = await context.api.userAccount()
  if (!profile) throw new Error('需要登录')
  return profile
}

export function registerLibraryHandlers(context: AppContext): void {
  defineHandler('library:overview', async () => {
    if (!context.client.isLoggedIn) {
      // Browsing without a login still works: the daily recommendations and
      // public playlists are served, but the personal lists are empty.
      return { playlists: [], likedTrackIDs: [], albums: [], artists: [], recent: [] }
    }
    const profile = await requireProfile(context)
    const uid = profile.userId
    const [playlists, liked, albums, artists, recent] = await Promise.all([
      context.api.userPlaylists(uid).catch((cause) => {
        context.log(`获取用户歌单失败: ${String(cause)}`)
        return []
      }),
      context.api.likedTrackIDs(uid).catch(() => [] as number[]),
      context.api.likedAlbums().catch(() => []),
      context.api.likedArtists().catch(() => []),
      context.api.playRecords(uid, false).catch(() => [])
    ])
    return {
      playlists: playlists.map(toPlaylistDTO),
      likedTrackIDs: liked,
      albums: albums.map(toAlbumDTO),
      artists: artists.map(toArtistDTO),
      recent: recent.map((item) => ({
        playCount: item.playCount,
        score: item.score,
        song: toTracksDTO([item.song], context0(context))[0]
      }))
    }
  })

  defineHandler('library:createPlaylist', async ({ name, isPrivate }) => {
    if (!name.trim()) throw new Error('歌单名不能为空')
    return context.api.createPlaylist(name.trim(), isPrivate ?? false)
  })

  defineHandler('library:deletePlaylist', async ({ id }) => {
    await context.api.deletePlaylist(id)
  })

  defineHandler('library:subscribePlaylist', async ({ id, subscribe }) => {
    await context.api.subscribePlaylist(id, subscribe)
  })

  defineHandler('library:likeTrack', async ({ id, like }) => {
    await context.api.likeTrack(id, like)
  })

  defineHandler('library:subscribeAlbum', async ({ id, subscribe }) => {
    await context.api.subscribeAlbum(id, subscribe)
  })

  defineHandler('library:subscribeArtist', async ({ id, subscribe }) => {
    await context.api.subscribeArtist(id, subscribe)
  })

  defineHandler('library:cloud', async ({ limit, offset }) => {
    const response = await context.api.cloudSongs(limit ?? 1000, offset ?? 0)
    const songs: CloudSongDTO[] = (response.data ?? []).map((item) => ({
      songId: item.songId,
      songName: item.songName,
      artist: item.artist,
      fileSize: item.fileSize,
      track: item.simpleSong ? toTracksDTO([item.simpleSong], context0(context))[0] : undefined
    }))
    return {
      songs,
      hasMore: response.hasMore,
      used: response.size,
      capacity: response.maxSize
    }
  })

  defineHandler('library:cloudDelete', async ({ id }) => {
    await context.api.cloudDelete(id)
  })
}
