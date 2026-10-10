/**
 * Explore, search and detail IPC: category playlists, charts, artists, search
 * (including suggestions and the trending default keyword) and every page a
 * list row can navigate to.
 */
import { defineHandler } from './registry.js'
import { searchExternal } from '../external/search.js'
import { localDateKey } from '../storage/dailyHistory.js'
import { fetchRemoteDaily, getKnownUID, saveRemoteDaily, setKnownUID, withTimeout } from '../storage/remoteDaily.js'
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
    const dtos = tracks(context, await context.api.dailyRecommendSongs())
    // 网易云的历史日推接口已下线（weapi 空响应、eapi/明文 404），
    // 「昨天的日推」只能靠快照：每次拿到今日列表就按日期落盘一份（本地+服务器）。
    if (dtos.length > 0) {
      const date = localDateKey(0)
      context.dailyHistory.save(date, dtos)
      void pushDailyToServer(context, date, dtos)
    }
    return dtos
  })

  /** 首页「今日热歌」的曲库：飙升榜 / 热歌榜 / 新歌榜三张官方榜单。 */
  const HOT_CHART_IDS = [19723756, 3778678, 3779629]

  /**
   * 首页「今日热歌」：用户要求首页内容不能和任何一个分类一样——
   * 每日推荐（home:dailySongs）给了「今日推荐」，首页这里就从三张榜单
   * 里随机挑 12 首（每次打开都会重新洗牌，所以叫「随机挑选今日热歌」）。
   */
  defineHandler('home:hotSongs', async () => {
    const pool: Track[] = []
    for (const id of HOT_CHART_IDS) {
      const response = await context.api.playlistDetail(id).catch(() => undefined)
      if (!response) continue
      for (const track of response.playlist.tracks) pool.push(track)
    }
    const seen = new Set<number>()
    const unique = pool.filter((track) => (seen.has(track.id) ? false : (seen.add(track.id), true)))
    // Fisher–Yates 洗牌：每次进入首页都是不同的一批热歌。
    for (let index = unique.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1))
      ;[unique[index], unique[swap]] = [unique[swap], unique[index]]
    }
    return tracks(context, unique.slice(0, 12))
  })

  /**
   * 历史每日推荐：先问悠悠音乐自己的服务器（跨设备同步），拿不到就回本地快照，
   * 最后再试网易云（个别账号/时期可能仍可用）。
   */
  defineHandler('home:dailyHistory', async ({ date } = {}) => {
    if (typeof date !== 'string' || date.length === 0) return []
    const uid = await resolveUID(context)
    if (uid !== undefined) {
      const fromServer = await fetchRemoteDaily(uid, date)
      if (fromServer) return fromServer
    }
    const local = context.dailyHistory.load(date)
    if (local.length > 0) return local
    const remote = tracks(context, await context.api.dailyRecommendHistory(date).catch(() => []))
    if (remote.length > 0) {
      context.dailyHistory.save(date, remote)
      void pushDailyToServer(context, date, remote)
      return remote
    }
    return []
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

/** 当前登录账号 uid：优先用登录时缓存的已知值，避免每次都打网易云接口。 */
export async function resolveUID(context: AppContext): Promise<number | undefined> {
  const known = getKnownUID()
  if (known !== undefined) return known
  if (!context.client.isLoggedIn) return undefined
  try {
    const profile = await withTimeout(context.api.userAccount(), 8000)
    if (profile?.userId) {
      setKnownUID(profile.userId)
      return profile.userId
    }
  } catch {
    // 网易云限流/超时：拿不到 uid 就只回本地快照，不让历史日期点击卡死。
  }
  return undefined
}

/** 把某天的日推上报到悠悠音乐服务器（登录了才上报；失败静默，不影响本地）。 */
export async function pushDailyToServer(context: AppContext, date: string, dtos: ReturnType<typeof toTracksDTO>): Promise<void> {
  const uid = await resolveUID(context)
  if (uid === undefined) return
  const ok = await saveRemoteDaily(uid, date, dtos)
  context.log(ok ? `日推历史已同步到服务器 (${date}, ${dtos.length} 首)` : `日推历史同步服务器失败 (${date})`)
}
