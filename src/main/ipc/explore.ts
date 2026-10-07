/**
 * Explore, search and detail IPC: category playlists, charts, artists, search
 * (including suggestions and the trending default keyword) and every page a
 * list row can navigate to.
 */
import { defineHandler } from './registry.js'
import { searchExternal } from '../external/search.js'
import {
  mappingContextFrom,
  toAlbumDTO,
  toArtistDTO,
  toPlaylistDTO,
  toPlaylistDetailDTO,
  toTracksDTO
} from './mappers.js'
import { SearchType } from '../netease/api.js'
import type { AppContext } from '../context.js'
import type { ToplistDTO } from '@shared/ipc'
import type { Track } from '../netease/models.js'

function ctx(context: AppContext) {
  return mappingContextFrom(context)
}

/** Tracks that are unplayable are kept, but flagged — the UI greys them out. */
function tracks(context: AppContext, list: Track[]) {
  return toTracksDTO(list, ctx(context))
}

export function registerExploreHandlers(context: AppContext): void {
  // --- home ---

  defineHandler('home:feed', async () => {
    const loggedIn = context.client.isLoggedIn
    const [dailySongs, recommendPlaylists, personalized, newSongs, toplists] = await Promise.all([
      loggedIn ? context.api.dailyRecommendSongs().catch(() => []) : Promise.resolve([]),
      loggedIn ? context.api.recommendResource().catch(() => []) : Promise.resolve([]),
      context.api.personalizedPlaylists(30).catch(() => []),
      context.api.personalizedNewSongs(12).catch(() => []),
      context.api.toplists().catch(() => [])
    ])

    // Radar playlists are per-account and only identified by id, so their
    // title and artwork need a second, cheap fetch.
    const radarIDs = extractRadarIDs(recommendPlaylists)
    const radarPlaylists = (
      await Promise.all(
        radarIDs.map((id) =>
          context.api
            .playlistBrief(id)
            .then((brief) =>
              toPlaylistDTO({
                id: brief.id,
                name: brief.name ?? '私人雷达',
                coverURL: brief.coverImgUrl,
                playCount: 0,
                trackCount: 0,
                specialType: 0,
                privacy: 0,
                subscribed: false
              })
            )
            .catch(() => undefined)
        )
      )
    ).filter((playlist): playlist is ReturnType<typeof toPlaylistDTO> => !!playlist)

    const toplistsDTO: ToplistDTO[] = toplists.map((item) => ({
      id: item.id,
      name: item.name,
      coverImgUrl: item.coverImgUrl,
      updateFrequency: item.updateFrequency,
      playCount: item.playCount,
      previews: item.tracks
    }))

    return {
      dailySongs: tracks(context, dailySongs),
      recommendPlaylists: recommendPlaylists.map(toPlaylistDTO),
      personalizedPlaylists: personalized.map(toPlaylistDTO),
      radarPlaylists,
      newSongs: tracks(context, newSongs),
      toplists: toplistsDTO
    }
  })

  defineHandler('home:dailySongs', async () => {
    return tracks(context, await context.api.dailyRecommendSongs())
  })

  /** 历史每日推荐：可选日期（YYYY-MM-DD），不传则返回最近一周抓到的日推。 */
  defineHandler('home:dailyHistory', async ({ date } = {}) => {
    return tracks(context, await context.api.dailyRecommendHistory(date))
  })

  /** 账号资料补充（性别/年龄/地区/签名），一起听的找听友需要。 */
  defineHandler('auth:userDetail', async () => {
    const profile = await context.api.userAccount()
    if (!profile) throw new Error('需要登录')
    return context.api.userDetail(profile.userId)
  })

  defineHandler('home:dislikeDaily', async ({ trackID }) => {
    const replacement = await context.api.dislikeRecommendedSong(trackID)
    return tracks(context, [replacement])[0]
  })

  defineHandler('home:personalized', async ({ limit }) => {
    return (await context.api.personalizedPlaylists(limit ?? 30)).map(toPlaylistDTO)
  })

  defineHandler('home:newAlbums', async ({ area, limit, offset }) => {
    return (await context.api.newAlbums(area ?? 'ALL', limit ?? 30, offset ?? 0)).map(toAlbumDTO)
  })

  defineHandler('home:toplists', async () => {
    return (await context.api.toplists()).map((item) => ({
      id: item.id,
      name: item.name,
      coverImgUrl: item.coverImgUrl,
      updateFrequency: item.updateFrequency,
      playCount: item.playCount,
      previews: item.tracks
    }))
  })

  // --- explore ---

  defineHandler('explore:topPlaylists', async ({ category, order, limit, offset }) => {
    const response = await context.api.topPlaylists(category, order ?? 'hot', limit ?? 50, offset ?? 0)
    return {
      items: response.playlists.map(toPlaylistDTO),
      total: response.total,
      more: response.more
    }
  })

  defineHandler('explore:highQuality', async ({ category, limit, before }) => {
    const response = await context.api.highQualityPlaylists(category ?? '全部', limit ?? 50, before ?? 0)
    return {
      items: response.playlists.map(toPlaylistDTO),
      lasttime: response.lasttime,
      more: response.more
    }
  })

  defineHandler('explore:topArtists', async ({ limit }) => {
    return (await context.api.topArtists(limit ?? 100)).map(toArtistDTO)
  })

  // --- search ---

  /** 站外音源搜索：网易云没有的歌（抖音热歌等）在这里找得到。 */
  defineHandler('search:external', async ({ source, keywords, limit }) => {
    if (!keywords.trim()) return []
    return searchExternal(source, keywords.trim(), limit ?? 30)
  })

  defineHandler('search:query', async ({ keywords, type, limit, offset }) => {
    /*
     * 测试钩子：网易云搜索太「宽容」，正常情况下（含乱码）都会返回结果，
     * 导致渲染层的「站外兜底」分支在真机上无法自然复现。设 YOYOU_FORCE_EXTERNAL=1
     * 时让单曲搜索返回空，就能把兜底链路完整跑一遍。只在显式设了环境变量时生效。
     */
    if (process.env.YOYOU_FORCE_EXTERNAL === '1' && type === 'songs') {
      return { songs: [], songCount: 0, albums: undefined, artists: undefined, playlists: undefined }
    }
    const searchType =
      type === 'songs'
        ? SearchType.songs
        : type === 'albums'
          ? SearchType.albums
          : type === 'artists'
            ? SearchType.artists
            : SearchType.playlists
    const result = await context.api.search(keywords, searchType, limit ?? 30, offset ?? 0)
    return {
      songs: result.songs ? tracks(context, result.songs) : undefined,
      albums: result.albums?.map(toAlbumDTO),
      artists: result.artists?.map(toArtistDTO),
      playlists: result.playlists?.map(toPlaylistDTO),
      songCount: result.songCount,
      albumCount: result.albumCount,
      artistCount: result.artistCount,
      playlistCount: result.playlistCount
    }
  })

  defineHandler('search:suggest', async ({ keywords }) => {
    if (!keywords.trim()) return undefined
    const result = await context.api.searchSuggest(keywords)
    if (!result) return undefined
    return {
      songs: result.songs ? tracks(context, result.songs) : undefined,
      artists: result.artists?.map(toArtistDTO),
      albums: result.albums?.map(toAlbumDTO),
      playlists: result.playlists?.map(toPlaylistDTO)
    }
  })

  defineHandler('search:defaultKeyword', async () => {
    const keyword = await context.api.searchDefaultKeyword()
    // 热搜词是运营文案，可能自带表情符号；界面禁 emoji，所以在数据源头剥离，
    // 而不是让每个消费页面各自过滤。
    return keyword ? stripEmoji(keyword) : keyword
  })

  // --- playlists ---

  defineHandler('playlist:detail', async ({ id }) => {
    const response = await context.api.playlistDetail(id)
    return toPlaylistDetailDTO(response.playlist, response.privileges, ctx(context))
  })

  defineHandler('playlist:manipulateTracks', async ({ op, playlistID, trackIDs }) => {
    if (trackIDs.length === 0) return
    await context.api.playlistTracks(op, playlistID, trackIDs)
  })

  // --- albums / artists ---

  defineHandler('album:detail', async ({ id }) => {
    const response = await context.api.album(id)
    // `artistId` and the saved state are not part of the album payload itself:
    // the artist comes from the album's own artist object, and the saved state
    // from the account's album sublist, which is the only endpoint that reports
    // it. Both are optional so the page can degrade when they are unavailable.
    const artistId = response.album.artist?.id
    let subscribed: boolean | undefined
    if (context.client.isLoggedIn) {
      try {
        const saved = await context.api.likedAlbums(500, 0)
        subscribed = saved.some((album) => album.id === id)
      } catch (cause) {
        context.log(`获取收藏专辑列表失败: ${String(cause)}`)
      }
    }
    return {
      album: toAlbumDTO(response.album),
      artistId: artistId && artistId > 0 ? artistId : undefined,
      subscribed,
      description: response.album.description,
      company: response.album.company,
      songs: tracks(context, response.songs)
    }
  })

  defineHandler('artist:detail', async ({ id }) => {
    const response = await context.api.artist(id)
    return {
      artist: toArtistDTO(response.artist),
      hotSongs: tracks(context, response.hotSongs)
    }
  })

  defineHandler('artist:albums', async ({ id, limit, offset }) => {
    const response = await context.api.artistAlbums(id, limit ?? 100, offset ?? 0)
    return { items: response.hotAlbums.map(toAlbumDTO), more: response.more }
  })

  defineHandler('artist:similar', async ({ id }) => {
    return (await context.api.similarArtists(id)).map(toArtistDTO)
  })

  // --- tracks ---

  defineHandler('track:detail', async ({ ids }) => {
    const response = await context.api.songDetails(ids)
    return toTracksDTO(response.songs, {
      ...ctx(context),
      privileges: response.privileges
        ? new Map(response.privileges.map((item) => [item.id, item]))
        : undefined
    })
  })

  defineHandler('track:similar', async ({ id, limit }) => {
    return tracks(context, await context.api.similarSongs(id, limit ?? 30))
  })

  defineHandler('track:fm', async () => {
    return tracks(context, await context.api.personalFM())
  })

  defineHandler('track:fmTrash', async ({ id }) => {
    await context.api.fmTrash(id)
  })

  defineHandler('track:intelligence', async ({ songID, playlistID }) => {
    return tracks(context, await context.api.intelligenceList(songID, playlistID))
  })
}

/** 私人雷达 family: 336, 337 … are the per-account "radar" recommendations. */
function extractRadarIDs(playlists: Array<{ id: number; name: string }>): number[] {
  const ids: number[] = []
  for (const playlist of playlists) {
    if (/雷达/.test(playlist.name)) {
      ids.push(playlist.id)
      continue
    }
    // The "Personal Radar" family uses ids in the 31xxx range and toplist-style
    // codes; only the titled ones are safe to fetch by id.
    if (playlist.id > 0 && /RADAR|Radar/.test(playlist.name)) ids.push(playlist.id)
  }
  return ids.slice(0, 8)
}

/**
 * 剥掉 emoji 与零宽/修饰符字符。只用于界面文案（热搜词、联想提示），
 * 歌名、歌词这类用户内容原样保留。
 */
export function stripEmoji(text: string): string {
  return text
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{2190}-\u{21FF}]/gu,
      ''
    )
    .replace(/\s{2,}/g, ' ')
    .trim()
}
