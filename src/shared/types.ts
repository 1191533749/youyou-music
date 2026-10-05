/**
 * Shared types passed between the main process and the renderer.
 *
 * Everything crossing the IPC boundary is structured-clone friendly, so these
 * types are deliberately plain data — no classes, no functions, no Dates.
 */

/** Playback quality tiers, in ascending order of bitrate. */
export type QualityLevel =
  | 'standard'
  | 'higher'
  | 'exhigh'
  | 'lossless'
  | 'hires'
  | 'jyeffect'
  | 'sky'
  | 'jymaster'

export interface QualityOption {
  level: QualityLevel
  /** Label shown in the quality menu. */
  label: string
  /** Bitrate ceiling in kbps, for the menu's hint text. */
  br: number
  /** True when the tier needs 黑胶 VIP (or higher). */
  vip: boolean
}

export const QUALITY_OPTIONS: QualityOption[] = [
  { level: 'standard', label: '标准音质', br: 128, vip: false },
  { level: 'higher', label: '较高音质', br: 192, vip: false },
  { level: 'exhigh', label: '极高音质', br: 320, vip: false },
  { level: 'lossless', label: '无损音质', br: 1411, vip: true },
  { level: 'hires', label: 'Hi-Res 音质', br: 2304, vip: true },
  { level: 'jyeffect', label: '沉浸环绕声', br: 0, vip: true },
  { level: 'sky', label: '沉浸全景声', br: 0, vip: true },
  { level: 'jymaster', label: '超清母带', br: 0, vip: true }
]

export type RepeatMode = 'off' | 'all' | 'one'

/** 桌面歌词的显示特效。 */
export type DesktopLyricsEffect = 'classic' | 'gradient' | 'neon' | 'karaoke'

/** 特效的展示顺序，也是桌面歌词窗口里切换按钮的循环顺序。 */
export const DESKTOP_LYRICS_EFFECTS: DesktopLyricsEffect[] = ['classic', 'gradient', 'neon', 'karaoke']

export interface TrackDTO {
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
  /** Resolved playability, already accounting for the current login. */
  playability: 'playable' | 'vipOnly' | 'paidAlbum' | 'noCopyright' | 'delisted'
  /** Text shown next to a greyed-out row, e.g. 无版权 / VIP 专属. */
  playabilityReason?: string
}

export interface PlayerStateDTO {
  /** The track the engine is on, if any. */
  track?: TrackDTO
  /** The queue the user is working through. */
  queue: TrackDTO[]
  /** Index into `queue`, or -1 when nothing is playing. */
  index: number
  playing: boolean
  /** Playback position in seconds. */
  position: number
  duration: number
  volume: number
  muted: boolean
  /** True while mpv is loading or buffering. */
  loading: boolean
  repeat: RepeatMode
  shuffle: boolean
  quality: QualityLevel
  /** The quality actually served, which can be lower than the request. */
  servedQuality?: QualityLevel
  /** 实际码率（kbps），音源提供了才填；用于诚实的音质提示。 */
  servedBitrate?: number
  /** Set when a track could not be played at all. */
  error?: string
  /** 非空表示当前音频来自第三方音源，例如「酷我音乐」。 */
  servedFrom?: string
  /** Local file path or remote URL currently loaded, for diagnostics. */
  source?: string
}

export interface UserProfileDTO {
  userId: number
  nickname: string
  avatarUrl?: string
  backgroundUrl?: string
  signature?: string
  vipType: number
}

export interface LoginStateDTO {
  loggedIn: boolean
  profile?: UserProfileDTO
}

export type QRLoginStatus = 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error'

export interface QRLoginStateDTO {
  status: QRLoginStatus
  /** URL the QR code encodes; the renderer draws it. */
  url?: string
  unikey?: string
  message?: string
  nickname?: string
  avatarUrl?: string
  /** Present once the scan is confirmed and the profile has been fetched. */
  profile?: UserProfileDTO
}

export interface SettingsDTO {
  quality: QualityLevel
  /** Fall back to a lower tier when the requested one is not entitled. */
  autoDowngradeQuality: boolean
  volume: number
  /** Prefer `https://` and third-party mirrors for cover art. */
  showDesktopLyrics: boolean
  desktopLyricsFontSize: number
  desktopLyricsOpacity: number
  /** 桌面歌词特效：经典 / 渐变 / 霓虹 / 逐字卡拉OK。 */
  desktopLyricsEffect: DesktopLyricsEffect
  /** Always-on-top desktop lyric window position, in screen coordinates. */
  desktopLyricsPosition?: { x: number; y: number }
  /** Cache cap in megabytes; 0 disables eviction. */
  cacheLimitMB: number
  /** Directory for cached audio; empty means "next to userData". */
  cacheDirectory: string
  /** Explicit audio output device for mpv (`wasapi/{...}`), empty = system default. */
  audioDevice: string
  /** Enable the system media-key / SMTC integration. */
  mediaKeys: boolean
  /** Enable the tray icon. */
  tray: boolean
  /** Close to tray instead of quitting. */
  closeToTray: boolean
  /** Scrobble playback to the account. */
  scrobble: boolean
  /** Follow the system light/dark theme. */
  theme: 'system' | 'light' | 'dark'
  /** UI language: follow the system, or force one. */
  language: 'system' | 'zh-Hans' | 'en'
  /** Unlock grey tracks from third-party sources. */
  unblockGreyTracks: boolean
  /**
   * 启用的第三方音源，顺序即尝试优先级：pyncmd → kugou → kuwo。
   * 任一为启用状态时，受限歌曲都会自动换源播放完整版本。
   */
  unblockSources: Array<'pyncmd' | 'kugou' | 'kuwo'>
  /** Keep a local copy of played tracks so they play offline. */
  offlineCacheEnabled: boolean
}

export const DEFAULT_SETTINGS: SettingsDTO = {
  quality: 'exhigh',
  autoDowngradeQuality: true,
  volume: 80,
  showDesktopLyrics: false,
  desktopLyricsFontSize: 28,
  desktopLyricsOpacity: 0.92,
  desktopLyricsEffect: 'classic',
  cacheLimitMB: 2048,
  cacheDirectory: '',
  audioDevice: '',
  mediaKeys: true,
  tray: true,
  closeToTray: false,
  scrobble: true,
  theme: 'system',
  language: 'system',
  unblockGreyTracks: true,
  unblockSources: ['pyncmd', 'kugou', 'kuwo'],
  offlineCacheEnabled: true
}

export interface AudioDeviceDTO {
  /** mpv's device specifier, e.g. `wasapi/{0.0.0.00000000}.{guid}`. */
  id: string
  name: string
  isDefault: boolean
}

export interface CacheUsageDTO {
  /** Bytes used by the audio cache. */
  audioBytes: number
  /** Bytes used by the image cache. */
  imageBytes: number
  /** Number of cached tracks. */
  trackCount: number
  limitBytes: number
  directory: string
}

export interface AppInfoDTO {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  /** mpv version banner, when the backend was found. */
  mpv?: string
  mpvPath?: string
}

/** One lyric line as the renderer consumes it. */
export interface LyricLineDTO {
  id: number
  time: number
  text: string
  translation?: string
  romaji?: string
  words?: Array<{ text: string; start: number; duration: number }>
}

export interface LyricsDTO {
  trackID: number
  lines: LyricLineDTO[]
  isInstrumental: boolean
  contributor?: string
  translationContributor?: string
  /** True when the song has no lyrics at all. */
  empty: boolean
}

export interface PlaylistSummaryDTO {
  id: number
  name: string
  coverURL?: string
  playCount: number
  trackCount: number
  copywriter?: string
  creator?: { userId: number; nickname: string; avatarUrl?: string }
  specialType: number
  privacy: number
  subscribed: boolean
  isLikedSongsList: boolean
}

export interface AlbumSummaryDTO {
  id: number
  name: string
  picUrl?: string
  artistName: string
  publishTime: number
  size: number
  subType?: string
  alias: string[]
}

export interface ArtistSummaryDTO {
  id: number
  name: string
  picUrl?: string
  albumSize: number
  musicSize: number
  briefDesc?: string
  alias: string[]
  followed: boolean
}

export interface PageResult<T> {
  items: T[]
  total?: number
  more?: boolean
}

/** The IPC envelope: every handler either resolves `data` or rejects with `error`. */
export interface IPCResult<T> {
  ok: boolean
  data?: T
  error?: string
  /** Machine-readable error kind so the UI can special-case 需要登录 etc. */
  kind?: 'http' | 'business' | 'needLogin' | 'decoding' | 'network' | 'internal'
}
