/**
 * Typed NetEase Cloud Music API surface, mapped to the real weapi / eapi
 * endpoints.
 *
 * Every path, payload key and value follows what the live service actually
 * accepts — several of them look odd (`secrete`, `imme`, the `[id,id]`
 * workaround for code 512) because that is what the endpoints expect.
 */
import { NeteaseAPIError, NeteaseClient } from './client.js'
import {
  type AlbumDetail,
  type AlbumSummary,
  type ArtistSummary,
  type CloudSongItem,
  type FreeTrialInfo,
  type LyricResponse,
  type PlayRecordItem,
  type PlaylistDetail,
  type PlaylistSummary,
  type SongURLData,
  type ToplistItem,
  type Track,
  type TrackPrivilege,
  type UserProfile,
  isLikedSongsList,
  toAlbumDetail,
  toAlbumSummary,
  toArtistSummary,
  toCloudSongItem,
  toPlayRecordItem,
  toPlaylistDetail,
  toPlaylistSummary,
  toSongURLData,
  toToplistItem,
  toTrack,
  toTracks,
  toUserProfile
} from './models.js'

export enum SearchType {
  songs = 1,
  albums = 10,
  artists = 100,
  playlists = 1000
}

export interface QRCheckResponse {
  code: number
  message?: string
  nickname?: string
  avatarUrl?: string
}

export interface SearchResult {
  songs?: Track[]
  albums?: AlbumSummary[]
  artists?: ArtistSummary[]
  playlists?: PlaylistSummary[]
  songCount?: number
  albumCount?: number
  artistCount?: number
  playlistCount?: number
}

export interface SearchSuggestResult {
  songs?: Track[]
  artists?: ArtistSummary[]
  albums?: AlbumSummary[]
  playlists?: PlaylistSummary[]
}

export interface CloudResponse {
  data?: CloudSongItem[]
  hasMore?: boolean
  size?: number
  maxSize?: number
}

export interface PlaylistDetailResponse {
  playlist: PlaylistDetail
  privileges?: TrackPrivilege[]
}

export interface SongDetailResponse {
  songs: Track[]
  privileges?: TrackPrivilege[]
}

export interface TopPlaylistResponse {
  playlists: PlaylistSummary[]
  total?: number
  more?: boolean
}

export interface HighQualityResponse {
  playlists: PlaylistSummary[]
  lasttime?: number
  more?: boolean
}

export interface ArtistResponse {
  artist: ArtistSummary
  hotSongs: Track[]
}

export interface ArtistAlbumsResponse {
  hotAlbums: AlbumSummary[]
  more?: boolean
}

export interface AlbumDetailResponse {
  album: AlbumDetail
  songs: Track[]
}

export interface PlaylistBrief {
  id: number
  name?: string
  coverImgUrl?: string
}

/** Download-eligibility descriptor, describing download eligibility. */
export interface OfflineAudioResource {
  trackID: number
  url: string
  level: string
  format: string
  contentMD5: string
  byteCount: number
  duration: number
}

export class OfflineAudioError extends Error {}

export type QualityLevel =
  | 'standard'
  | 'higher'
  | 'exhigh'
  | 'lossless'
  | 'hires'
  | 'jyeffect'
  | 'sky'
  | 'jymaster'

interface DecodedOptions {
  /** Skips the `code != 200` guard, for endpoints that legitimately answer with one. */
  allowNon200?: boolean
}

export class NeteaseAPI {
  constructor(private readonly client: NeteaseClient) {}

  /** 账号资料缓存：避免每次点赞都打一次 /w/nuser/account/get。 */
  private profileCache?: { userId: number; fetchedAt: number }
  private readonly profileTTLMs = 10 * 60 * 1000
  /** 「我喜欢的音乐」歌单 id 缓存，按 uid 区分。 */
  private likedPlaylistCache?: { uid: number; playlistID: number }

  private async loggedInUID(): Promise<number> {
    const now = Date.now()
    if (this.profileCache && now - this.profileCache.fetchedAt < this.profileTTLMs) {
      return this.profileCache.userId
    }
    const profile = await this.userAccount()
    if (!profile) {
      throw new NeteaseAPIError('business', { code: -1, message: '需要登录' })
    }
    this.profileCache = { userId: profile.userId, fetchedAt: now }
    return profile.userId
  }

  private async likedSongsPlaylistID(uid: number): Promise<number> {
    const cached = this.likedPlaylistCache
    if (cached && cached.uid === uid) return cached.playlistID
    const playlists = await this.userPlaylists(uid)
    const liked = playlists.find(isLikedSongsList)
    if (!liked) {
      throw new NeteaseAPIError('business', { code: -1, message: '没有找到「我喜欢的音乐」歌单' })
    }
    this.likedPlaylistCache = { uid, playlistID: liked.id }
    return liked.id
  }

  /**
   * weapi request with an automatic eapi fallback.
   *
   * NetEase answers the weapi transport with an **empty 200 body** when it has
   * throttled the caller's IP (or decided the request looks automated). The body
   * carries no error code, so the only signal is its emptiness — and the same
   * request over eapi succeeds. The upstream macOS client does not need this
   * because it only ever hits the API from one signed-in session, but a client
   * that gets throttled would otherwise show every weapi-backed page as broken,
   * so the transport is retried transparently.
   *
   * The service cookies a weapi endpoint might set are not reproduced by the
   * fallback path; that is why auth endpoints keep the explicit ladder in
   * `qrKey()` instead of relying on this.
   */
  private async weapi<T = any>(
    path: string,
    payload: Record<string, unknown> = {},
    options: {
      cookieOverrides?: Record<string, string>
      absorbResponseCookies?: boolean
      decode?: (json: any) => T
      decoded?: DecodedOptions
      /** Set for endpoints where a retry over a different transport is unsafe. */
      noTransportFallback?: boolean
    } = {}
  ): Promise<T> {
    const json = await this.client.weapiJSON(path, payload, {
      cookieOverrides: options.cookieOverrides,
      absorbResponseCookies: options.absorbResponseCookies
    })

    let body = json
    if (body === undefined && !options.noTransportFallback) {
      // Empty body: retry the identical logical request over eapi.
      body = await this.client.eapi(path, payload, { cookieOverrides: options.cookieOverrides })
    }
    if (body === undefined) {
      throw new NeteaseAPIError('business', {
        code: -1,
        message: `${path} 无响应：网易云可能正在限流，请稍后重试`
      })
    }

    const checked = options.decoded?.allowNon200 ? body : NeteaseClient.unwrap(body, path)
    return options.decode ? options.decode(checked) : (checked as T)
  }

  private async eapi<T = any>(
    path: string,
    payload: Record<string, unknown> = {},
    options: {
      cookieOverrides?: Record<string, string>
      decode?: (json: any) => T
      decoded?: DecodedOptions
    } = {}
  ): Promise<T> {
    const json = await this.client.eapi(path, payload, { cookieOverrides: options.cookieOverrides })
    const checked = options.decoded?.allowNon200 ? json : NeteaseClient.unwrap(json, path)
    return options.decode ? options.decode(checked) : (checked as T)
  }

  /**
   * A weapi request that resolves `undefined` for an empty 200 body. NetEase
   * answers some endpoints that way when the request cannot be served, and
   * callers with a fallback transport need to tell "empty" from "an error".
   */
  async weapiJSON(path: string, payload: Record<string, unknown> = {}): Promise<any> {
    return this.client.weapiJSON(path, payload)
  }

  // MARK: - Auth

  /**
   * A login key to render as a QR code.
   *
   * NetEase answers this endpoint with an empty 200 body when the caller's IP
   * is being throttled (repeated logins, VPN or shared egress) rather than with
   * an error code, so this tries the eapi transport before giving up and
   * surfaces a message the login screen can show with a retry button.
   */
  async qrKey(): Promise<string> {
    const fromWeapi = await this.weapiJSON('/login/qrcode/unikey', { type: 1 })
    const unikey = typeof fromWeapi?.unikey === 'string' ? fromWeapi.unikey : undefined
    if (unikey) return unikey

    const fromEapi = await this.client.eapi('/login/qrcode/unikey', { type: 1 })
    const fallback = typeof fromEapi?.unikey === 'string' ? fromEapi.unikey : undefined
    if (fallback) return fallback

    throw new NeteaseAPIError('business', {
      code: fromWeapi?.code ?? -1,
      message: '获取二维码失败，请稍后重试（接口限流）'
    })
  }

  qrLoginURL(unikey: string): string {
    return `https://music.163.com/login?codekey=${unikey}`
  }

  /**
   * Codes: 800 expired · 801 waiting · 802 scanned · 803 success.
   * On 803 the auth cookies arrive via Set-Cookie and are absorbed by the client.
   *
   * These are *returned* statuses, not success/failure: a 801 reply is the
   * normal answer while nobody has scanned yet, so this endpoint must be read
   * without the `code != 200` guard — treating 801 as an error would abort the
   * poll on its very first tick. It also needs the transport fallback: when
   * weapi is throttled the reply is an empty body, which would leave the login
   * screen waiting forever.
   */
  async qrCheck(unikey: string): Promise<QRCheckResponse> {
    return this.weapi<QRCheckResponse>(
      '/login/qrcode/client/login',
      { key: unikey, type: 1 },
      {
        decoded: { allowNon200: true },
        decode: (j) => ({
          code: Number(j?.code ?? 0),
          message: typeof j?.message === 'string' ? j.message : undefined,
          nickname: typeof j?.nickname === 'string' ? j.nickname : undefined,
          avatarUrl: typeof j?.avatarUrl === 'string' ? j.avatarUrl : undefined
        })
      }
    )
  }

  /** Sends an SMS verification code for phone-number login. */
  async sendSMSCode(phone: string, countryCode = '86'): Promise<void> {
    const payload = { ctcode: countryCode, cellphone: phone, secrete: 'music_middleuser_pclogin' }
    // eapi 优先：手机验证码登录对风控敏感，eapi 是现行客户端走的通道，
    // weapi 更易被判定为「存在安全风险」。仍保留 weapi 兜底。
    try {
      const json = await this.client.eapi('/sms/captcha/sent', payload)
      NeteaseClient.unwrap(json, '/sms/captcha/sent')
      return
    } catch (cause) {
      if (!(cause instanceof NeteaseAPIError) || cause.kind !== 'decoding') {
        // eapi 返回了明确的业务错误（含「安全风险」），直接透出，不吞。
        const json = await this.client.weapi('/sms/captcha/sent', payload).catch(() => undefined)
        if (json !== undefined) {
          NeteaseClient.unwrap(json, '/sms/captcha/sent')
          return
        }
      }
      // eapi 空响应/降级时再试 weapi。
      await this.weapi('/sms/captcha/sent', payload)
    }
  }

  /**
   * Phone-number login with an SMS code. The auth cookies arrive via Set-Cookie
   * and are absorbed by the client's transport, on either channel.
   *
   * The eapi fallback matters more here than anywhere else: with weapi
   * throttled, an empty reply used to surface as "the endpoint is unreachable",
   * hiding the server's real answer (`{"code":503,"message":"验证码错误"}`).
   * The response's `code` is checked explicitly so a rejected code reads as a
   * rejected code.
   */
  async loginCellphone(phone: string, captcha: string, countryCode = '86'): Promise<void> {
    const payload = {
      type: '1',
      https: 'true',
      phone,
      countrycode: countryCode,
      captcha,
      remember: 'true',
      secureCaptcha: ''
    }
    // eapi 优先（现行客户端通道，风控更宽松），weapi 兜底；两者都拿到业务码时
    // 透出服务器真实信息（「验证码错误」「存在安全风险」等），不吞。
    let response = await this.client.eapi('/login/cellphone', payload).catch(() => undefined)
    if (response === undefined) {
      response = await this.client.weapiJSON('/w/login/cellphone', payload).catch(() => undefined)
    }
    if (response === undefined) {
      throw new NeteaseAPIError('business', { code: -1, message: '登录接口无响应，请稍后重试或改用扫码登录' })
    }
    const code = Number(response?.code ?? 0)
    if (code !== 200) {
      let message =
        typeof response?.message === 'string'
          ? response.message
          : typeof response?.msg === 'string'
            ? response.msg
            : '登录失败，请重试'
      // 风控文案统一给更明确的指引。
      if (/安全风险|risk/i.test(message)) {
        message = '手机号登录触发网易云风控，请稍后重试，或改用扫码登录'
      }
      throw new NeteaseAPIError('business', { code, message })
    }
    if (!this.client.isLoggedIn) {
      throw new NeteaseAPIError('business', { code: -1, message: '登录未生效，请改用扫码登录' })
    }
  }

  async logout(detachedCookies?: Record<string, string>): Promise<void> {
    const oldCookies = detachedCookies ?? this.client.authenticationCookies()
    if (detachedCookies === undefined) this.client.clearAuthCookies()
    try {
      await this.client.weapi('/logout', {}, { cookieOverrides: oldCookies, absorbResponseCookies: false })
    } catch {
      // Logging out locally already succeeded; the server call is best-effort.
    }
  }

  async refreshLogin(): Promise<void> {
    try {
      await this.client.weapi('/login/token/refresh')
    } catch {
      // A failed refresh just means the session expires on its own schedule.
    }
  }

  async userAccount(): Promise<UserProfile | undefined> {
    return this.weapi('/w/nuser/account/get', {}, { decode: (j) => toUserProfile(j.profile) })
  }

  // MARK: - User library

  async userPlaylists(uid: number, limit = 2000, offset = 0): Promise<PlaylistSummary[]> {
    return this.weapi(
      '/user/playlist',
      { uid, limit, offset, includeVideo: true },
      {
        decode: (j) =>
          (Array.isArray(j.playlist) ? j.playlist : [])
            .map(toPlaylistSummary)
            .filter((p: PlaylistSummary | undefined): p is PlaylistSummary => !!p)
      }
    )
  }

  async likedTrackIDs(uid: number): Promise<number[]> {
    return this.weapi('/song/like/get', { uid }, {
      decode: (j) => (Array.isArray(j.ids) ? j.ids.filter((n: unknown) => typeof n === 'number') : [])
    })
  }

  /**
   * 收藏/取消收藏一首歌。
   *
   * 这里往「我喜欢的音乐」歌单里加/删（`/playlist/manipulate/tracks`），
   * 而不是旧的 `/radio/like`：后者是私人漫游(FM)的好恶接口，点了红心
   * 并不会进「我喜欢的音乐」——这正是「点小心心收藏不成功」的根因。
   * 读取侧 `/song/like/get` 返回的正是这张歌单，读写口径一致。
   */
  async likeTrack(id: number, like: boolean): Promise<void> {
    const uid = await this.loggedInUID()
    const playlistID = await this.likedSongsPlaylistID(uid)
    await this.playlistTracks(like ? 'add' : 'del', playlistID, [id])
  }

  async likedAlbums(limit = 500, offset = 0): Promise<AlbumSummary[]> {
    return this.weapi('/album/sublist', { limit, offset, total: true }, {
      decode: (j) => toSummaryList(j.data, toAlbumSummary)
    })
  }

  async likedArtists(limit = 500, offset = 0): Promise<ArtistSummary[]> {
    return this.weapi('/artist/sublist', { limit, offset, total: true }, {
      decode: (j) => toSummaryList(j.data, toArtistSummary)
    })
  }

  async playRecords(uid: number, week: boolean): Promise<PlayRecordItem[]> {
    return this.weapi('/v1/play/record', { uid, type: week ? 1 : 0 }, {
      decode: (j) => {
        const list = week ? j.weekData : j.allData
        return (Array.isArray(list) ? list : [])
          .map(toPlayRecordItem)
          .filter((r: PlayRecordItem | undefined): r is PlayRecordItem => !!r)
      }
    })
  }

  async cloudSongs(limit = 1000, offset = 0): Promise<CloudResponse> {
    return this.weapi('/v1/cloud/get', { limit, offset }, {
      decode: (j) => ({
        data: (Array.isArray(j.data) ? j.data : [])
          .map(toCloudSongItem)
          .filter((c: CloudSongItem | undefined): c is CloudSongItem => !!c),
        hasMore: typeof j.hasMore === 'boolean' ? j.hasMore : undefined,
        size: numeric(j.size),
        maxSize: numeric(j.maxSize)
      })
    })
  }

  async cloudDelete(id: number): Promise<void> {
    await this.weapi('/cloud/del', { songIds: `[${id}]` })
  }

  /**
   * `startplay` weblog — writes the song into the 最近播放 (recent-plays) list.
   * NetEase needs this *and* the `play` weblog; sending only `play` bumps the
   * listening ranking but never writes 最近播放.
   */
  async scrobbleStart(trackID: number, sourceID: number): Promise<void> {
    await this.sendWeblog([
      {
        action: 'startplay',
        json: {
          id: trackID,
          type: 'song',
          mainsite: '1',
          mainsiteWeb: '1',
          content: `id=${sourceID}`
        }
      }
    ])
  }

  /** `play` weblog — increments the listening-ranking play count and time. */
  async scrobbleFinish(trackID: number, sourceID: number, seconds: number): Promise<void> {
    await this.sendWeblog([
      {
        action: 'play',
        json: {
          download: 0,
          end: 'playend',
          id: trackID,
          sourceId: String(sourceID),
          time: seconds,
          type: 'song',
          wifi: 0,
          source: 'list',
          mainsite: '1',
          mainsiteWeb: '1',
          content: `id=${sourceID}`
        }
      }
    ])
  }

  /** Routed via eapi with the desktop-client cookie (`os=osx`) to match the reference impl. */
  private async sendWeblog(log: Array<Record<string, unknown>>): Promise<void> {
    try {
      await this.client.eapi('/feedback/weblog', { logs: JSON.stringify(log) }, {
        cookieOverrides: { os: 'osx' }
      })
    } catch {
      // Scrobbling must never break playback.
    }
  }

  // MARK: - Playlists

  async personalizedPlaylists(limit = 30): Promise<PlaylistSummary[]> {
    return this.weapi('/personalized/playlist', { limit, total: true, n: 1000 }, {
      decode: (j) => toSummaryList(j.result, toPlaylistSummary)
    })
  }

  /** Logged-in daily recommended playlists. */
  async recommendResource(): Promise<PlaylistSummary[]> {
    return this.weapi('/v1/discovery/recommend/resource', {}, {
      decode: (j) => toSummaryList(j.recommend, toPlaylistSummary)
    })
  }

  async dailyRecommendSongs(): Promise<Track[]> {
    return this.weapi('/v3/discovery/recommend/songs', {}, {
      decode: (j) => toTracks(j.data?.dailySongs ?? [])
    })
  }

  /**
   * 历史每日推荐。
   *  - 不传日期：`/history/recommend/songs` 返回最近一周里抓取到的日推；
   *  - 传日期（YYYY-MM-DD）：`/history/recommend/songs/detail` 返回那一天的日推。
   * 两个接口的返回结构在不同版本里略有差异，这里都做了兜底解析。
   */
  async dailyRecommendHistory(date?: string): Promise<Track[]> {
    const path = date ? '/history/recommend/songs/detail' : '/history/recommend/songs'
    const payload = date ? { date } : {}
    return this.weapi(path, payload, {
      decoded: { allowNon200: true },
      decode: (j) => {
        const songs = j?.data?.songs ?? j?.songs ?? (Array.isArray(j?.data) ? j.data : [])
        return toTracks(Array.isArray(songs) ? songs : [])
      }
    })
  }

  /**
   * 账号资料补充：性别、生日（换算年龄）、省市区、个性签名。
   * 登录接口返回的 profile 不含这些字段，一起听的「找听友」需要真实资料。
   */
  async userDetail(uid: number): Promise<{
    gender?: 'female' | 'male'
    age?: number
    region?: string
    signature?: string
  }> {
    const json = await this.weapi(`/v1/user/detail/${uid}`, {}, { decoded: { allowNon200: true } })
    const profile = json?.profile ?? {}
    const gender = profile.gender === 2 ? 'female' : profile.gender === 1 ? 'male' : undefined
    let age: number | undefined
    if (typeof profile.birthday === 'number' && profile.birthday > 0) {
      const born = new Date(profile.birthday)
      const now = new Date()
      let years = now.getFullYear() - born.getFullYear()
      const beforeBirthday =
        now.getMonth() < born.getMonth() ||
        (now.getMonth() === born.getMonth() && now.getDate() < born.getDate())
      if (beforeBirthday) years -= 1
      if (years > 0 && years < 120) age = years
    }
    const region = [profile.province, profile.city]
      .filter((part: unknown) => typeof part === 'string' && part.length > 0 && part !== 'None')
      .join(' ')
    return {
      gender,
      age,
      region: region || undefined,
      signature: typeof profile.signature === 'string' ? profile.signature : undefined
    }
  }

  /** Throws when the replacement payload is incomplete, so a malformed reply is rejected. */
  async dislikeRecommendedSong(id: number): Promise<Track> {
    return this.weapi(
      '/v2/discovery/recommend/dislike',
      { resId: id, resType: 4, sceneType: 1 },
      {
        decode: (j) => {
          const track = toTrack(j.data)
          if (!track || track.id <= 0 || track.name.trim() === '') {
            throw new NeteaseAPIError('decoding', { message: '推荐替换结果不完整' })
          }
          return track
        }
      }
    )
  }

  async playlistDetail(id: number): Promise<PlaylistDetailResponse> {
    return this.weapi(
      '/v6/playlist/detail',
      { id, n: 100_000, s: 8 },
      {
        decode: (j) => ({
          playlist: toPlaylistDetail(j.playlist) ?? {
            id,
            name: '',
            trackCount: 0,
            playCount: 0,
            subscribedCount: 0,
            subscribed: false,
            trackIds: [],
            tracks: [],
            specialType: 0,
            updateTime: 0
          },
          privileges: toPrivileges(j.privileges)
        })
      }
    )
  }

  /** Lightweight name + cover fetch (used for the per-account radar playlists). */
  async playlistBrief(id: number): Promise<PlaylistBrief> {
    return this.weapi('/v6/playlist/detail', { id, n: 1, s: 0 }, {
      decode: (j) => ({
        id: Number(j.playlist?.id ?? id),
        name: typeof j.playlist?.name === 'string' ? j.playlist.name : undefined,
        coverImgUrl: typeof j.playlist?.coverImgUrl === 'string' ? j.playlist.coverImgUrl : undefined
      })
    })
  }

  async songDetails(ids: number[]): Promise<SongDetailResponse> {
    if (ids.length === 0) return { songs: [], privileges: [] }
    const c = `[${ids.map((id) => `{"id":${id}}`).join(',')}]`
    return this.weapi('/v3/song/detail', { c }, {
      decode: (j) => ({ songs: toTracks(j.songs), privileges: toPrivileges(j.privileges) })
    })
  }

  async topPlaylists(category: string, order = 'hot', limit = 50, offset = 0): Promise<TopPlaylistResponse> {
    // 实测（2026-10）：网易云 `/playlist/list` 在 order=new 下**恒返回 0 条**
    // （code 200、total 0；各种变体 cat 空/华语、new:true、sort:new 都一样），
    // 而 order=hot 正常。所以「最新」改用精品歌单接口：它按更新时间倒序返回，
    // 是真正的「最新歌单」且数据稳定。该接口用 lasttime 游标而非 offset，
    // 因此「最新」只提供首页（more=false 让前端停止无限滚动）。
    if (order === 'new') {
      const latest = await this.highQualityPlaylists(category, limit, 0)
      return { playlists: latest.playlists, total: latest.playlists.length, more: false }
    }
    return this.weapi(
      '/playlist/list',
      { cat: category, order, limit, offset, total: true },
      {
        decode: (j) => ({
          playlists: toSummaryList(j.playlists, toPlaylistSummary),
          total: typeof j.total === 'number' ? j.total : undefined,
          more: typeof j.more === 'boolean' ? j.more : undefined
        })
      }
    )
  }

  async highQualityPlaylists(category = '全部', limit = 50, before = 0): Promise<HighQualityResponse> {
    return this.weapi(
      '/playlist/highquality/list',
      { cat: category, limit, lasttime: before, total: true },
      {
        decode: (j) => ({
          playlists: toSummaryList(j.playlists, toPlaylistSummary),
          lasttime: typeof j.lasttime === 'number' ? j.lasttime : undefined,
          more: typeof j.more === 'boolean' ? j.more : undefined
        })
      }
    )
  }

  async toplists(): Promise<ToplistItem[]> {
    return this.eapi('/toplist', {}, { decode: (j) => toSummaryList(j.list, toToplistItem) })
  }

  async createPlaylist(name: string, isPrivate: boolean): Promise<number | undefined> {
    return this.weapi('/playlist/create', { name, privacy: isPrivate ? 10 : 0, type: 'NORMAL' }, {
      decode: (j) => (typeof j.id === 'number' ? j.id : undefined)
    })
  }

  async deletePlaylist(id: number): Promise<void> {
    await this.weapi('/playlist/remove', { ids: `[${id}]` })
  }

  async subscribePlaylist(id: number, subscribe: boolean): Promise<void> {
    await this.weapi(`/playlist/${subscribe ? 'subscribe' : 'unsubscribe'}`, { id })
  }

  async playlistTracks(op: 'add' | 'del', playlistID: number, trackIDs: number[]): Promise<void> {
    const ids = `[${trackIDs.map(String).join(',')}]`
    // eapi 优先：这个接口的 weapi 通道经常被限流成空响应体（实测稳定空体）。
    // 空体/失败时退回 weapi 兜底一次。
    const attempt = async (value: string): Promise<any> => {
      const payload = { op, pid: playlistID, trackIds: value, imme: 'true' }
      let json = await this.client.eapi('/playlist/manipulate/tracks', payload).catch(() => undefined)
      if (json === undefined) {
        json = await this.client.weapiJSON('/playlist/manipulate/tracks', payload)
      }
      return json
    }
    const json = await attempt(ids)
    if (json === undefined) {
      throw new NeteaseAPIError('decoding', { message: '/playlist/manipulate/tracks 返回了空响应' })
    }
    if (typeof json?.code === 'number' && json.code !== 200) {
      // 512: already-in-playlist quirk — retry with doubled ids like the reference impl.
      if (json.code === 512 && op === 'add') {
        await attempt(`[${[...trackIDs, ...trackIDs].map(String).join(',')}]`)
        return
      }
      throw new NeteaseAPIError('business', {
        code: json.code,
        message: typeof json.message === 'string' ? json.message : undefined
      })
    }
  }

  /** 心动模式 — builds a heartbeat-mode queue from a seed song in a playlist. */
  async intelligenceList(songID: number, playlistID: number): Promise<Track[]> {
    return this.weapi(
      '/playmode/intelligence/list',
      { songId: songID, type: 'fromPlayOne', playlistId: playlistID, startMusicId: songID, count: 1 },
      {
        decode: (j) =>
          (Array.isArray(j.data) ? j.data : [])
            .map((item: any) => toTrack(item?.songInfo))
            .filter((t: Track | undefined): t is Track => !!t)
      }
    )
  }

  // MARK: - Tracks

  async songURL(ids: number[], level: QualityLevel | string): Promise<SongURLData[]> {
    const idString = `[${ids.map(String).join(',')}]`
    const payload: Record<string, unknown> = { ids: idString, level, encodeType: 'flac' }
    if (level === 'sky') payload.immerseType = 'c51'
    return this.eapi('/song/enhance/player/url/v1', payload, {
      decode: (j) =>
        (Array.isArray(j.data) ? j.data : [])
          .map(toSongURLData)
          .filter((d: SongURLData | undefined): d is SongURLData => !!d)
    })
  }

  /** Download eligibility is resolved independently of the playback URL. */
  async songDownloadResource(
    track: Track,
    level: string,
    client: NeteaseClient = this.client
  ): Promise<OfflineAudioResource> {
    const data = await this.songDownloadURL(track.id, level, client)
    return buildOfflineResource(data, track)
  }

  async songDownloadURL(id: number, level: string, client: NeteaseClient = this.client): Promise<SongURLData> {
    const json = await client.eapi('/song/enhance/download/url/v1', {
      id,
      level,
      immerseType: 'c51'
    })
    NeteaseClient.unwrap(json, '/song/enhance/download/url/v1')
    const data = toSongURLData(json.data)
    if (!data) throw new OfflineAudioError('下载资源不可用')
    return data
  }

  /**
   * Lyrics, preferring the verbatim (`yrc`) endpoint and falling back to the
   * classic one — the same "never regress" ladder. The
   * transport hop is handled by `weapi()` itself, which retries an empty reply
   * over eapi.
   */
  async lyric(id: number): Promise<LyricResponse> {
    const attempts: Array<() => Promise<LyricResponse>> = [
      () =>
        this.weapi<LyricResponse>(
          '/song/lyric/v1',
          { id, cp: false, lv: 0, kv: 0, tv: 0, rv: 0, yv: 0, ytv: 0, yrv: 0 },
          { decoded: { allowNon200: true } }
        ),
      () =>
        this.weapi<LyricResponse>('/song/lyric', { id, lv: -1, kv: -1, tv: -1, rv: -1 }, {
          decoded: { allowNon200: true }
        })
    ]

    let firstNonEmpty: LyricResponse | undefined
    for (const attempt of attempts) {
      try {
        const response = await attempt()
        firstNonEmpty ??= response
        if (response.lrc?.lyric || response.yrc?.lyric) return response
      } catch {
        // Try the next endpoint.
      }
    }
    return firstNonEmpty ?? {}
  }

  async personalFM(): Promise<Track[]> {
    return this.weapi('/v1/radio/get', {}, { decode: (j) => toTracks(j.data ?? []) })
  }

  async fmTrash(id: number): Promise<void> {
    await this.weapi(`/radio/trash/add?alg=RT&songId=${id}&time=25`, { songId: id })
  }

  async similarSongs(id: number, limit = 30): Promise<Track[]> {
    return this.weapi('/v1/discovery/simiSong', { songid: id, limit, offset: 0 }, {
      decode: (j) => toTracks(j.songs ?? [])
    })
  }

  // MARK: - Albums

  async album(id: number): Promise<AlbumDetailResponse> {
    return this.weapi(`/v1/album/${id}`, {}, {
      decode: (j) => ({ album: toAlbumDetail(j.album) as AlbumDetail, songs: toTracks(j.songs ?? []) })
    })
  }

  async newAlbums(area = 'ALL', limit = 30, offset = 0): Promise<AlbumSummary[]> {
    return this.weapi('/album/new', { area, limit, offset, total: true }, {
      decode: (j) => toSummaryList(j.albums, toAlbumSummary)
    })
  }

  async albumDynamic(id: number): Promise<{ isSub?: boolean; subCount?: number }> {
    return this.eapi('/album/detail/dynamic', { id }, {
      decode: (j) => ({
        isSub: typeof j.isSub === 'boolean' ? j.isSub : undefined,
        subCount: typeof j.subCount === 'number' ? j.subCount : undefined
      })
    })
  }

  async subscribeAlbum(id: number, subscribe: boolean): Promise<void> {
    await this.weapi(`/album/${subscribe ? 'sub' : 'unsub'}`, { id })
  }

  // MARK: - Artists

  async artist(id: number): Promise<ArtistResponse> {
    return this.weapi(`/v1/artist/${id}`, {}, {
      decode: (j) => ({
        artist: toArtistSummary(j.artist) as ArtistSummary,
        hotSongs: toTracks(j.hotSongs ?? [])
      })
    })
  }

  async artistAlbums(id: number, limit = 100, offset = 0): Promise<ArtistAlbumsResponse> {
    return this.weapi(`/artist/albums/${id}`, { limit, offset, total: true }, {
      decode: (j) => ({
        hotAlbums: toSummaryList(j.hotAlbums, toAlbumSummary),
        more: typeof j.more === 'boolean' ? j.more : undefined
      })
    })
  }

  async subscribeArtist(id: number, subscribe: boolean): Promise<void> {
    await this.weapi(`/artist/${subscribe ? 'sub' : 'unsub'}`, {
      artistId: id,
      artistIds: `[${id}]`
    })
  }

  async topArtists(limit = 100): Promise<ArtistSummary[]> {
    return this.weapi('/toplist/artist', { type: 1, limit, offset: 0, total: true }, {
      decode: (j) => toSummaryList(j.list?.artists, toArtistSummary)
    })
  }

  async similarArtists(id: number): Promise<ArtistSummary[]> {
    return this.weapi('/discovery/simiArtist', { artistid: id }, {
      decode: (j) => toSummaryList(j.artists, toArtistSummary)
    })
  }

  // MARK: - Search

  async search(keywords: string, type: SearchType, limit = 30, offset = 0): Promise<SearchResult> {
    return this.eapi(
      '/cloudsearch/pc',
      { s: keywords, type: type as number, limit, offset, total: true },
      {
        decode: (j) => {
          const r = j.result ?? {}
          return {
            songs: r.songs ? toTracks(r.songs) : undefined,
            albums: r.albums ? toSummaryList(r.albums, toAlbumSummary) : undefined,
            artists: r.artists ? toSummaryList(r.artists, toArtistSummary) : undefined,
            playlists: r.playlists ? toSummaryList(r.playlists, toPlaylistSummary) : undefined,
            songCount: typeof r.songCount === 'number' ? r.songCount : undefined,
            albumCount: typeof r.albumCount === 'number' ? r.albumCount : undefined,
            artistCount: typeof r.artistCount === 'number' ? r.artistCount : undefined,
            playlistCount: typeof r.playlistCount === 'number' ? r.playlistCount : undefined
          }
        }
      }
    )
  }

  async searchSuggest(keywords: string): Promise<SearchSuggestResult | undefined> {
    return this.weapi('/search/suggest/web', { s: keywords }, {
      decode: (j) => {
        if (!j.result) return undefined
        return {
          songs: j.result.songs ? toTracks(j.result.songs) : undefined,
          artists: j.result.artists ? toSummaryList(j.result.artists, toArtistSummary) : undefined,
          albums: j.result.albums ? toSummaryList(j.result.albums, toAlbumSummary) : undefined,
          playlists: j.result.playlists ? toSummaryList(j.result.playlists, toPlaylistSummary) : undefined
        }
      }
    })
  }

  async searchDefaultKeyword(): Promise<string | undefined> {
    return this.eapi('/search/defaultkeyword/get', {}, {
      decode: (j) => (typeof j.data?.showKeyword === 'string' ? j.data.showKeyword : undefined)
    })
  }

  // MARK: - Personalized extras

  async personalizedNewSongs(limit = 10): Promise<Track[]> {
    return this.weapi('/personalized/newsong', { type: 'recommend', limit, areaId: 0 }, {
      decode: (j) =>
        (Array.isArray(j.result) ? j.result : [])
          .map((item: any) => toTrack(item?.song))
          .filter((t: Track | undefined): t is Track => !!t)
    })
  }
}

// MARK: - Shared decoding helpers

function toSummaryList<T>(raw: unknown, mapper: (item: unknown) => T | undefined): T[] {
  if (!Array.isArray(raw)) return []
  return raw.map(mapper).filter((item): item is T => item !== undefined)
}

function toPrivileges(raw: unknown): TrackPrivilege[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.map((item) => ({
    id: Number(item?.id ?? 0),
    fee: typeof item?.fee === 'number' ? item.fee : undefined,
    pl: typeof item?.pl === 'number' ? item.pl : undefined,
    st: typeof item?.st === 'number' ? item.st : undefined,
    cs: typeof item?.cs === 'boolean' ? item.cs : undefined,
    maxbr: typeof item?.maxbr === 'number' ? item.maxbr : undefined
  }))
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/**
 * Validates a download URL into a descriptor: identity check, https upgrade,
 * duration agreement and MD5 presence, exactly like the documented shape
 * `downloadResource(data:track:accountScope:)`.
 */
export function buildOfflineResource(data: SongURLData, track: Track): OfflineAudioResource {
  if (data.id !== track.id || data.code !== 200) throw new OfflineAudioError('下载资源不可用')
  if (data.freeTrialInfo) throw new OfflineAudioError('仅提供试听片段')
  const md5 = data.md5?.toLowerCase()
  const level = data.level
  const format = data.type?.toLowerCase()
  const rawURL = data.url
  if (!md5 || !level || !format || !rawURL) throw new OfflineAudioError('下载资源不完整')
  let parsed: URL
  try {
    parsed = new URL(rawURL)
  } catch {
    throw new OfflineAudioError('下载地址无效')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new OfflineAudioError('下载地址无效')
  }
  parsed.protocol = 'https:'

  // Some download responses omit time, and some songs (cloud drive, simplified
  // entries) omit dt. Whichever is known supplies the duration; when both are,
  // they must agree, which also rejects a trial URL.
  const trackDuration = track.durationMS / 1000
  const responseDuration = data.time > 0 ? data.time / 1000 : 0
  if (
    responseDuration > 0 &&
    trackDuration > 0 &&
    Math.abs(responseDuration - trackDuration) > Math.max(2, trackDuration * 0.03)
  ) {
    throw new OfflineAudioError('音频时长不匹配')
  }
  const duration = trackDuration > 0 ? trackDuration : responseDuration
  if (!(duration > 0)) throw new OfflineAudioError('下载资源不可用')

  return {
    trackID: track.id,
    url: parsed.toString(),
    level,
    format,
    contentMD5: md5,
    byteCount: data.size,
    duration
  }
}

export type { FreeTrialInfo }
