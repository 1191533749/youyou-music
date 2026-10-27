/**
 * Library IPC: the user's own playlists, liked songs, saved albums and artists,
 * recent plays, the cloud drive, and the mutations that change them.
 */
import { defineHandler } from './registry.js'
import { recallExternal } from '../external/registry.js'
import { httpsCover, mappingContextFrom, toAlbumDTO, toArtistDTO, toPlaylistDTO, toTracksDTO } from './mappers.js'
import type { AppContext } from '../context.js'
import type { CloudSongDTO } from '@shared/ipc'
import type { YYTrackRefDTO } from '@shared/types'


/**
 * 把渲染层传来的曲目 id 还原成自建账号的收藏条目：
 * 正 id 是网易云曲目（取详情补歌名/歌手/封面），负 id 是站外合成 id（从登记表取原样曲目）。
 * 没有网易云登录时，收藏必须走这里——这正是「站外音源的歌收不了」的修法。
 */
async function refOf(context: AppContext, id: number): Promise<YYTrackRefDTO | undefined> {
  if (id < 0) {
    const external = recallExternal(id)
    if (!external) return undefined
    return {
      key: `${external.source}:${external.sourceId}`,
      source: external.source,
      sourceId: external.sourceId,
      name: external.name,
      artist: external.artists,
      album: external.album,
      cover: httpsCover(external.coverUrl),
      durationMs: external.durationMS,
      addedAt: Date.now()
    }
  }
  const response = await context.api.songDetails([id]).catch(() => undefined)
  const track = response ? toTracksDTO(response.songs, mappingContextFrom(context))[0] : undefined
  if (!track) return undefined
  return {
    key: `netease:${id}`,
    source: 'netease',
    sourceId: String(id),
    name: track.name,
    artist: track.artists.map((artist) => artist.name).join(' / '),
    album: track.album?.name,
    cover: httpsCover(track.album?.picUrl),
    durationMs: track.durationMS,
    addedAt: Date.now()
  }
}

function context0(context: AppContext) {
  return mappingContextFrom(context)
}

async function requireProfile(context: AppContext) {
  const profile = await context.api.userAccount()
  if (!profile) throw new Error('需要登录')
  return profile
}

/*
 * 测试钩子：设 YOYOU_FAIL_LIBRARY=<N> 时，library:overview 前 N 次调用直接失败，
 * 用来在真机上复现「网络一过性抖动导致首个接口报错」，验证渲染层的静默重试
 * （见 scripts/test-auto-retry.mjs）。不设环境变量时恒为 0，对正常使用无影响。
 */
let libraryFailBudget: number | undefined

export function registerLibraryHandlers(context: AppContext): void {
  defineHandler('library:overview', async () => {
    if (libraryFailBudget === undefined) {
      libraryFailBudget = Math.max(0, Number(process.env.YOYOU_FAIL_LIBRARY ?? 0) || 0)
    }
    if (libraryFailBudget > 0) {
      libraryFailBudget -= 1
      throw new Error('服务器连接失败，请检查网络后重试')
    }
    if (!context.client.isLoggedIn) {
      // 没有网易云登录时，个人库由我们自己的账号接管（自建收藏 / 自建歌单）。
      // 这里只把「网易云曲目」的收藏 id 还给渲染层，心形状态照旧用 likedTrackIDs 判断；
      // 站外曲目的收藏在自建「我的音乐」页里直接读 account:* 数据。
      const liked = context.youyouAccount.favoriteList
        .filter((item) => item.source === 'netease')
        .map((item) => Number(item.sourceId))
        .filter((value) => Number.isFinite(value) && value > 0)
      return { playlists: [], likedTrackIDs: liked, albums: [], artists: [], recent: [] }
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
    if (!context.client.isLoggedIn) {
      const ref = await refOf(context, id)
      if (!ref) throw new Error('这首歌暂时收不进收藏')
      await context.youyouAccount.toggleFavorite(ref, like)
      return
    }
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
