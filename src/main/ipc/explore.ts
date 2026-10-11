/**
 * Explore, search and detail IPC: category playlists, charts, artists, search
 * (including suggestions and the trending default keyword) and every page a
 * list row can navigate to.
 */
import { defineHandler } from './registry.js'
import { searchExternal } from '../external/search.js'
import { qishuiRadio } from '../external/qishuiRadio.js'
import { rememberExternalTracks } from '../external/registry.js'
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
import { playability } from '../netease/models.js'
import type { AppContext } from '../context.js'
import type { ToplistDTO } from '@shared/ipc'
import type { ExternalTrackDTO } from '@shared/types'
import type { Track } from '../netease/models.js'

function ctx(context: AppContext) {
  return mappingContextFrom(context)
}

/** 同名同歌手归一化：并进搜索结果的汽水曲目按它去重。 */
function searchKey(name: string, artist: string): string {
  return `${name}${artist}`
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
}

/** Tracks that are unplayable are kept, but flagged — the UI greys them out. */
function tracks(context: AppContext, list: Track[]) {
  return toTracksDTO(list, ctx(context))
}

/** 一次想攒多少首漫游曲；攒满就不再打接口。 */
const FM_TARGET = 30
/** 单次填充最多打几轮接口（轮与轮之间留一口气，别把限流窗口顶穿）。 */
const FM_MAX_ROUNDS = 12

/**
 * 私人漫游曲池（**全部来自汽水音乐**）。
 *
 * 用户要求：漫游里放的全部是汽水的歌、而且是随机的。汽水没有可用的个性推荐接口，
 * 所以「随机」由 `qishuiRadio` 用「随机风格词 × 搜索」造；这里只负责把曲池攒厚。
 *
 * 漫游的网易云接口一次只给 2~3 首、单次要 1 秒以上，现场连打十来次凑 30 首要二十秒
 * （用户反馈「半天了还是 正在为你挑选漫游曲目」）。所以仍然是后台慢慢攒：
 * 进页面直接取现成的，取完立刻在后台接着攒下一批。
 */
const fmPool = {
  items: [] as ExternalTrackDTO[],
  seen: new Set<string>(),
  filling: undefined as Promise<void> | undefined
}

/** 攒池子；同一时刻只跑一条填充链，重复调用复用进行中的那条。 */
function fillFMPool(context: AppContext, rounds: number): Promise<void> {
  const ongoing = fmPool.filling
  if (ongoing) return ongoing
  const task = (async () => {
    for (let round = 0; round < rounds; round += 1) {
      if (fmPool.items.length >= FM_TARGET) break
      const batch = await qishuiRadio(FM_TARGET - fmPool.items.length, fmPool.seen)
      if (batch.length === 0) break
      fmPool.items.push(...batch)
      if (fmPool.items.length >= FM_TARGET) break
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  })()
    .catch((cause) => {
      // 攒池失败不算错误路径：下次进页面或补货会再试。
      context.log(`私人漫游攒池失败: ${String(cause)}`)
    })
    .finally(() => {
      fmPool.filling = undefined
    })
  fmPool.filling = task
  return task
}

/** 启动后预热漫游曲池：用户真正进页面时 `track:fm` 才能秒回。 */
export function warmFMPool(context: AppContext): void {
  void fillFMPool(context, FM_MAX_ROUNDS)
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
    /* 测试钩子：设 YOYOU_FAIL_SEARCH=1 让搜索整条链路直接 reject（模拟风控报错），
     * 用于真机复现渲染层的「出错静默兜底」catch 支路。 */
    if (process.env.YOYOU_FAIL_SEARCH === '1') {
      throw new Error('检测到您的网络环境存在风险，请稍后再试')
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

    const wantsSongs = type === undefined || type === 'songs'
    const mapping = ctx(context)
    /*
     * 只展示「点了就能完整播放」的单曲：播不了的条目放在列表里，用户点了只会白等
     * （用户反馈「搜出来的歌曲 既然无法播放 为什么要展示出来呢」）。判定只看原始权限，
     * 不理会换源开关——换源开关只影响灰态展示，不代表这一条一定换得到完整音源。
     * 全部不可播时返回空列表，渲染层会走既有兜底（汽水/酷狗/酷我）另找可播版本。
     */
    const playableSongs = wantsSongs
      ? (result.songs ?? []).filter(
          (song) =>
            playability(song, song.embeddedPrivilege, mapping.isLoggedIn, mapping.vipType) ===
            'playable'
        )
      : (result.songs ?? [])

    /*
     * 汽水那边有的版本并进单曲列表：网易云没版权/只有 VIP 版时，用户要找的往往就是
     * 这一版（用户反馈「渡情 对唱 我是在汽水音乐看到的」）。同名同歌手的条目不重复展示。
     */
    let external: ExternalTrackDTO[] | undefined
    if (wantsSongs) {
      const seen = new Set(playableSongs.map((song) => searchKey(song.name, song.artists[0]?.name ?? '')))
      const fromQishui = await searchExternal('qishui', keywords, 12).catch(() => [] as ExternalTrackDTO[])
      external = fromQishui.filter(
        (item) => !seen.has(searchKey(item.name, item.artists.split(/[/&、,，;；]/)[0] ?? ''))
      )
    }

    // 后台预解析顶部曲目的第三方直链：用户点第一首歌时不必再等第三方解析那几秒。
    // 只对单曲搜索生效（type 缺省也是歌曲），失败静默、不影响返回。
    if (wantsSongs && playableSongs.length) {
      for (const song of playableSongs.slice(0, 3)) {
        void context.player.prefetchSource(song)
      }
    }

    return {
      songs: tracks(context, playableSongs),
      albums: result.albums?.map(toAlbumDTO),
      artists: result.artists?.map(toArtistDTO),
      playlists: result.playlists?.map(toPlaylistDTO),
      external,
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

  /**
   * 私人漫游：从预热好的汽水曲池里取一批就走，不在请求里等十来轮接口。
   * 池子空了才现场等一轮，取完立刻在后台把池子补回来，供「队列快见底时补货」和下次进入使用。
   * 返回的是「合成曲目」的 DTO（id 为负），`player:playFMTracks` / `player:append`
   * 会用 `recallExternal` 认出它们并把整批交给站外队列。
   */
  defineHandler('track:fm', async () => {
    if (fmPool.items.length === 0) await fillFMPool(context, 1)
    const take = fmPool.items.splice(0, fmPool.items.length)
    void fillFMPool(context, FM_MAX_ROUNDS)
    return tracks(context, rememberExternalTracks(take))
  })

  defineHandler('track:fmTrash', async ({ id }) => {
    // 漫游曲目来自汽水音乐，负 id 是本地合成 id：网易云的「不喜欢」对它们没有意义，
    // 直接返回，让界面照常换下一首。
    if (id < 0) return
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
