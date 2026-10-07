/**
 * The IPC contract between the renderer and the main process.
 *
 * Every entry is an `invoke` channel resolved as `IPCResult<T>` (see
 * `@shared/types`); the renderer never talks to the network, the filesystem or
 * mpv directly. Adding a channel means adding it here first, so the preload
 * bridge and both sides stay in step.
 */
import type {
  AlbumSummaryDTO,
  AppInfoDTO,
  ArtistSummaryDTO,
  AudioDeviceDTO,
  CacheUsageDTO,
  ExternalSource,
  ExternalTrackDTO,
  LyricsDTO,
  PageResult,
  PlaylistSummaryDTO,
  PlayerStateDTO,
  QRLoginStateDTO,
  SettingsDTO,
  TrackDTO,
  UserProfileDTO
} from './types'

export interface PlaylistDetailDTO {
  id: number
  name: string
  coverURL?: string
  description?: string
  creator?: { userId: number; nickname: string; avatarUrl?: string }
  trackCount: number
  playCount: number
  subscribedCount: number
  subscribed: boolean
  specialType: number
  updateTime: number
  tracks: TrackDTO[]
}

export interface AlbumDetailDTO {
  album: AlbumSummaryDTO
  /** Present when the API exposes it, so the page can link to the artist. */
  artistId?: number
  /** Whether the signed-in account has saved this album. */
  subscribed?: boolean
  description?: string
  company?: string
  songs: TrackDTO[]
}

export interface ArtistDetailDTO {
  artist: ArtistSummaryDTO
  hotSongs: TrackDTO[]
}

export interface ToplistDTO {
  id: number
  name: string
  coverImgUrl?: string
  updateFrequency?: string
  playCount: number
  previews: Array<{ first: string; second: string }>
}

export interface HomeFeedDTO {
  dailySongs: TrackDTO[]
  recommendPlaylists: PlaylistSummaryDTO[]
  personalizedPlaylists: PlaylistSummaryDTO[]
  radarPlaylists: PlaylistSummaryDTO[]
  newSongs: TrackDTO[]
  toplists: ToplistDTO[]
}

export interface SearchResultDTO {
  songs?: TrackDTO[]
  albums?: AlbumSummaryDTO[]
  artists?: ArtistSummaryDTO[]
  playlists?: PlaylistSummaryDTO[]
  songCount?: number
  albumCount?: number
  artistCount?: number
  playlistCount?: number
}

export interface SearchSuggestDTO {
  songs?: TrackDTO[]
  artists?: ArtistSummaryDTO[]
  albums?: AlbumSummaryDTO[]
  playlists?: PlaylistSummaryDTO[]
}

export interface PlayRecordDTO {
  playCount: number
  score: number
  song: TrackDTO
}

export interface CloudSongDTO {
  songId: number
  songName?: string
  artist?: string
  fileSize: number
  track?: TrackDTO
}

export interface CloudPageDTO {
  songs: CloudSongDTO[]
  hasMore?: boolean
  used?: number
  capacity?: number
}

export interface LibraryDTO {
  playlists: PlaylistSummaryDTO[]
  likedTrackIDs: number[]
  albums: AlbumSummaryDTO[]
  artists: ArtistSummaryDTO[]
  recent: PlayRecordDTO[]
}

/** Quality levels that are actually entitled for the current account. */
export interface EntitlementDTO {
  vipType: number
  /** Levels the account can request; the rest fall back automatically. */
  available: string[]
}

/** Channels whose payload is `void` take no argument. */
export interface IPCContract {
  // --- auth ---
  'auth:state': { request: void; response: { loggedIn: boolean; profile?: UserProfileDTO } }
  'auth:qrStart': { request: void; response: QRLoginStateDTO }
  'auth:qrPoll': { request: { unikey: string }; response: QRLoginStateDTO }
  'auth:qrCancel': { request: void; response: void }
  'auth:logout': { request: void; response: void }
  'auth:profile': { request: void; response: UserProfileDTO | undefined }
  'auth:sendSMSCode': { request: { phone: string; countryCode?: string }; response: void }
  'auth:loginCellphone': {
    request: { phone: string; captcha: string; countryCode?: string }
    response: void
  }
  /** 账号资料补充：性别/年龄/地区/签名（一起听找听友用）。 */
  'auth:userDetail': {
    request: void
    response: { gender?: 'female' | 'male'; age?: number; region?: string; signature?: string }
  }

  // --- home / discovery ---
  'home:feed': { request: void; response: HomeFeedDTO }
  'home:dailySongs': { request: void; response: TrackDTO[] }
  /** 历史每日推荐：{ date?: 'YYYY-MM-DD' }，不传日期取最近一周。 */
  'home:dailyHistory': { request: { date?: string }; response: TrackDTO[] }
  'home:dislikeDaily': { request: { trackID: number }; response: TrackDTO }
  'home:personalized': { request: { limit?: number }; response: PlaylistSummaryDTO[] }
  'home:newAlbums': { request: { area?: string; limit?: number; offset?: number }; response: AlbumSummaryDTO[] }
  'home:toplists': { request: void; response: ToplistDTO[] }

  // --- explore ---
  'explore:topPlaylists': {
    request: { category: string; order?: string; limit?: number; offset?: number }
    response: PageResult<PlaylistSummaryDTO>
  }
  'explore:highQuality': {
    request: { category?: string; limit?: number; before?: number }
    response: { items: PlaylistSummaryDTO[]; lasttime?: number; more?: boolean }
  }
  'explore:topArtists': { request: { limit?: number }; response: ArtistSummaryDTO[] }

  // --- search ---
  'search:query': {
    request: { keywords: string; type: 'songs' | 'albums' | 'artists' | 'playlists'; limit?: number; offset?: number }
    response: SearchResultDTO
  }
  'search:suggest': { request: { keywords: string }; response: SearchSuggestDTO | undefined }
  'search:defaultKeyword': { request: void; response: string | undefined }
  /** 站外音源搜索（汽水音乐 / 酷狗 / 酷我）：网易云搜不到的歌在这里找。 */
  'search:external': {
    request: { source: ExternalSource; keywords: string; limit?: number }
    response: ExternalTrackDTO[]
  }

  // --- library ---
  'library:overview': { request: void; response: LibraryDTO }
  'library:createPlaylist': { request: { name: string; isPrivate?: boolean }; response: number | undefined }
  'library:deletePlaylist': { request: { id: number }; response: void }
  'library:subscribePlaylist': { request: { id: number; subscribe: boolean }; response: void }
  'library:likeTrack': { request: { id: number; like: boolean }; response: void }
  'library:subscribeAlbum': { request: { id: number; subscribe: boolean }; response: void }
  'library:subscribeArtist': { request: { id: number; subscribe: boolean }; response: void }
  'library:cloud': { request: { limit?: number; offset?: number }; response: CloudPageDTO }
  'library:cloudDelete': { request: { id: number }; response: void }

  // --- playlists ---
  'playlist:detail': { request: { id: number }; response: PlaylistDetailDTO }
  'playlist:manipulateTracks': {
    request: { op: 'add' | 'del'; playlistID: number; trackIDs: number[] }
    response: void
  }

  // --- albums / artists ---
  'album:detail': { request: { id: number }; response: AlbumDetailDTO }
  'artist:detail': { request: { id: number }; response: ArtistDetailDTO }
  'artist:albums': { request: { id: number; limit?: number; offset?: number }; response: ArtistSummaryPage }
  'artist:similar': { request: { id: number }; response: ArtistSummaryDTO[] }

  // --- tracks ---
  'track:detail': { request: { ids: number[] }; response: TrackDTO[] }
  'track:similar': { request: { id: number; limit?: number }; response: TrackDTO[] }
  'track:fm': { request: void; response: TrackDTO[] }
  'track:fmTrash': { request: { id: number }; response: void }
  'track:intelligence': { request: { songID: number; playlistID: number }; response: TrackDTO[] }

  // --- player ---
  'player:state': { request: void; response: PlayerStateDTO }
  'player:playTracks': {
    request: { tracks: TrackDTO[]; startIndex?: number; playlistID?: number; randomStart?: boolean }
    response: PlayerStateDTO
  }
  /** 播放站外曲目（汽水/酷狗/酷我 搜索来的歌）：主进程解析完整音频后直接播放。 */
  'player:playExternal': { request: { item: ExternalTrackDTO }; response: PlayerStateDTO }
  'player:playFMTracks': { request: { tracks: TrackDTO[] }; response: PlayerStateDTO }
  'player:toggle': { request: void; response: PlayerStateDTO }
  'player:play': { request: void; response: PlayerStateDTO }
  'player:pause': { request: void; response: PlayerStateDTO }
  'player:next': { request: void; response: PlayerStateDTO }
  'player:previous': { request: void; response: PlayerStateDTO }
  'player:seek': { request: { seconds: number }; response: PlayerStateDTO }
  'player:setVolume': { request: { volume: number }; response: PlayerStateDTO }
  'player:setMuted': { request: { muted: boolean }; response: PlayerStateDTO }
  'player:setRepeat': { request: { mode: 'off' | 'all' | 'one' }; response: PlayerStateDTO }
  'player:cycleRepeat': { request: void; response: PlayerStateDTO }
  'player:setShuffle': { request: { shuffle: boolean }; response: PlayerStateDTO }
  'player:setQueue': { request: { tracks: TrackDTO[]; startIndex?: number }; response: PlayerStateDTO }
  'player:append': { request: { tracks: TrackDTO[] }; response: PlayerStateDTO }
  'player:removeAt': { request: { indices: number[] }; response: PlayerStateDTO }
  'player:clearQueue': { request: void; response: PlayerStateDTO }
  'player:setQuality': { request: { quality: string }; response: PlayerStateDTO }
  'player:trackInfo': {
    request: void
    response: { codec?: string; sampleRate?: number; channels?: number; bitrate?: number; fileSize?: number }
  }
  'player:audioDevices': { request: void; response: AudioDeviceDTO[] }

  // --- lyrics ---
  'lyrics:get': { request: { trackID: number }; response: LyricsDTO }
  'lyrics:desktopToggle': { request: { visible: boolean }; response: void }
  'lyrics:desktopMove': { request: { x: number; y: number }; response: void }
  /** 桌面歌词窗口按内容自适配高度：窗口只罩住当前行，不占整条透明区域。 */
  'lyrics:desktopResize': { request: { height: number; width?: number }; response: void }
  /** 鼠标不在歌词文字上时让点击穿透到桌面（forward 模式仍能收到 mousemove）。 */
  'lyrics:desktopClickThrough': { request: { through: boolean }; response: void }

  // --- window ---
  /** 切换主窗口的系统全屏（任务栏也被覆盖的真全屏）。 */
  'window:toggleFullScreen': { request: void; response: boolean }
  'window:setFullScreen': { request: { fullscreen: boolean }; response: boolean }
  'window:minimize': { request: void; response: void }
  'window:toggleMaximize': { request: void; response: boolean }
  'window:isMaximized': { request: void; response: boolean }
  'window:close': { request: void; response: void }

  // --- update ---
  /** 检查更新：有新版本时带 version/notes；否则 version 为空。 */
  'update:check': {
    request: void
    response: { current: string; version?: string; notes?: string; updateType: 'installer' | 'portable' | null }
  }
  /** 下载并应用更新（下载最新资产 → 排定替换/安装流程 → 应用自动退出重开）。 */
  'update:install': { request: void; response: void }

  // --- settings / app ---
  'settings:get': { request: void; response: SettingsDTO }
  'settings:update': { request: Partial<SettingsDTO>; response: SettingsDTO }
  'app:info': { request: void; response: AppInfoDTO }
  'app:cacheUsage': { request: void; response: CacheUsageDTO }
  'app:clearCache': { request: { what: 'audio' | 'images' | 'all' }; response: CacheUsageDTO }
  'app:openExternal': { request: { url: string }; response: void }
  'app:chooseCacheDirectory': { request: void; response: string | undefined }
  'app:entitlements': { request: void; response: EntitlementDTO }
  'app:qrMatrix': { request: { url: string }; response: { size: number; modules: boolean[][] } }
  /** QQ 群二维码（data URL），设置页「加入群聊」用。 */
  'app:qqGroupImage': { request: void; response: string | undefined }
  'app:log': { request: { level: 'info' | 'warn' | 'error'; message: string }; response: void }
}

/** Artist album page — kept separate to avoid a generic that IPC cannot carry. */
export interface ArtistSummaryPage {
  items: AlbumSummaryDTO[]
  more?: boolean
}

export type IPCChannel = keyof IPCContract
export type IPCRequest<C extends IPCChannel> = IPCContract[C]['request']
export type IPCResponse<C extends IPCChannel> = IPCContract[C]['response']

/** Push channels: main → renderer, no reply. */
export interface IPCEvents {
  'player:state': PlayerStateDTO
  'player:track': { track?: TrackDTO }
  'auth:changed': { loggedIn: boolean; profile?: UserProfileDTO }
  'lyrics:line': { trackID: number; lines: LyricsDTO }
  'app:error': { message: string }
  'app:navigate': { route: string }
  'settings:changed': SettingsDTO
  'window:maximized': { maximized: boolean }
}

export type IPCEventName = keyof IPCEvents

export const IPC_INVOKE_CHANNELS: IPCChannel[] = [
  'auth:state',
  'auth:qrStart',
  'auth:qrPoll',
  'auth:qrCancel',
  'auth:logout',
  'auth:profile',
  'auth:sendSMSCode',
  'auth:loginCellphone',
  'auth:userDetail',
  'home:feed',
  'home:dailySongs',
  'home:dailyHistory',
  'home:dislikeDaily',
  'home:personalized',
  'home:newAlbums',
  'home:toplists',
  'explore:topPlaylists',
  'explore:highQuality',
  'explore:topArtists',
  'search:query',
  'search:suggest',
  'search:defaultKeyword',
  'search:external',
  'library:overview',
  'library:createPlaylist',
  'library:deletePlaylist',
  'library:subscribePlaylist',
  'library:likeTrack',
  'library:subscribeAlbum',
  'library:subscribeArtist',
  'library:cloud',
  'library:cloudDelete',
  'playlist:detail',
  'playlist:manipulateTracks',
  'album:detail',
  'artist:detail',
  'artist:albums',
  'artist:similar',
  'track:detail',
  'track:similar',
  'track:fm',
  'track:fmTrash',
  'track:intelligence',
  'player:state',
  'player:playTracks',
  'player:playExternal',
  'player:playFMTracks',
  'player:toggle',
  'player:play',
  'player:pause',
  'player:next',
  'player:previous',
  'player:seek',
  'player:setVolume',
  'player:setMuted',
  'player:setRepeat',
  'player:cycleRepeat',
  'player:setShuffle',
  'player:setQueue',
  'player:append',
  'player:removeAt',
  'player:clearQueue',
  'player:setQuality',
  'player:trackInfo',
  'player:audioDevices',
  'lyrics:get',
  'lyrics:desktopToggle',
  'lyrics:desktopMove',
  'lyrics:desktopResize',
  'lyrics:desktopClickThrough',
  'window:toggleFullScreen',
  'window:setFullScreen',
  'window:minimize',
  'window:toggleMaximize',
  'window:isMaximized',
  'window:close',
  'update:check',
  'update:install',
  'settings:get',
  'settings:update',
  'app:info',
  'app:cacheUsage',
  'app:clearCache',
  'app:openExternal',
  'app:chooseCacheDirectory',
  'app:entitlements',
  'app:qrMatrix',
  'app:qqGroupImage',
  'app:log'
]

export const IPC_EVENT_NAMES: IPCEventName[] = [
  'player:state',
  'player:track',
  'auth:changed',
  'lyrics:line',
  'app:error',
  'app:navigate',
  'settings:changed',
  'window:maximized'
]
