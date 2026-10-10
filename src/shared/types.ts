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

/**
 * 歌词字体。用系统自带字体族（Windows 常见安装），保证切换后肉眼可见：
 * default=现代无衬线 / rounded=幼圆 / light=细黑 / kai=楷体 / serif=宋体。
 */
export type LyricFont = 'default' | 'rounded' | 'light' | 'kai' | 'serif' | 'system'

export const LYRIC_FONTS: LyricFont[] = ['default', 'rounded', 'light', 'kai', 'serif', 'system']

/** 字体族映射：同时被播放页与桌面歌词窗口使用。 */
export const LYRIC_FONT_STACKS: Record<LyricFont, string> = {
  default: "'Noto Sans SC', 'Microsoft YaHei UI', 'PingFang SC', system-ui, sans-serif",
  rounded: "'YouYuan', 'MiSans', 'PingFang SC', 'Microsoft YaHei UI', sans-serif",
  light: "'Microsoft YaHei Light', 'STXihei', 'Noto Sans SC', sans-serif",
  kai: "'KaiTi', 'STKaiti', 'Noto Serif SC', serif",
  serif: "'SimSun', 'Songti SC', 'Noto Serif SC', serif",
  system: "system-ui, 'Microsoft YaHei UI', sans-serif"
}

export interface TrackDTO {
  id: number
  name: string
  /** 歌手头像（可能缺）：封面缺失时播放详情页用它兜底，不再用吉祥物占位。 */
  artists: Array<{ id: number; name: string; picUrl?: string }>
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

/**
 * 站外音源（网易云曲库里搜不到的歌，例如大量抖音热歌）。
 * 汽水音乐只作「发现层」：它的搜索接口可用，但播放地址接口需要签名与登录态，
 * 因此点播时统一走严格匹配到酷狗/酷我拿完整音频。
 */
export type ExternalSource = 'qishui' | 'kugou' | 'kuwo'

export const EXTERNAL_SOURCES: ExternalSource[] = ['qishui', 'kugou', 'kuwo']

export const EXTERNAL_SOURCE_NAMES: Record<ExternalSource, string> = {
  qishui: '汽水音乐',
  kugou: '酷狗音乐',
  kuwo: '酷我音乐'
}

export interface ExternalTrackDTO {
  source: ExternalSource
  /** 源内 ID（汽水 track_id / 酷狗 hash / 酷我 rid） */
  sourceId: string
  name: string
  artists: string
  album?: string
  durationMS: number
  coverUrl?: string
}

export type QRLoginStatus = 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error'
export interface QRLoginStateDTO {
  status: QRLoginStatus
  /** URL the QR code encodes; the renderer draws it. */
  url?: string
  /** 有些平台直接给二维码图片（data URL 或图片地址），渲染层直接显示。 */
  image?: string
  unikey?: string
  message?: string
  nickname?: string
  avatarUrl?: string
  /** Present once the scan is confirmed and the profile has been fetched. */
  profile?: UserProfileDTO
}

/**
 * 可登录的平台。
 * 汽水音乐与酷我音乐只作为音源使用，不做登录；酷狗的扫码接口当前对所有参数
 * 组合都返回「参数错误 20006」，登录先搁置（它仍然是一个可用的音源）。
 */
export type AccountPlatform = 'netease' | 'kugou' | 'qq'

/** 登录页上会出现图标的平台。 */
export const ACCOUNT_PLATFORMS: AccountPlatform[] = ['netease', 'qq']

export interface PlatformAccountDTO {
  platform: AccountPlatform
  loggedIn: boolean
  nickname?: string
  avatarUrl?: string
}

/** 平台账号的歌单（只用于展示与后续取歌，不参与网易云的曲库模型）。 */
export interface PlatformPlaylistDTO {
  id: string
  name: string
  trackCount: number
  coverUrl?: string
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
  /** 歌词字体（播放页与桌面歌词共用）。 */
  lyricFont: LyricFont
  /** 锁定桌面歌词位置：锁定后不可拖动，避免误触。 */
  desktopLyricsLocked: boolean
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
  /** 自定义壁纸已设置：渲染层通过 youyou-wallpaper:// 协议读取图片。 */
  wallpaperSet: boolean
  /** 每次换壁纸 +1，渲染层用它拼 URL 做缓存失效。 */
  wallpaperVersion: number
  /** Unlock grey tracks from third-party sources. */
  unblockGreyTracks: boolean
  /**
   * 启用的第三方音源，顺序即尝试优先级：汽水 → 酷狗 → 酷我 → QQ。
   * 任一为启用状态时，受限歌曲都会自动换源播放完整版本。
   */
  unblockSources: Array<'qishui' | 'kugou' | 'kuwo' | 'qq'>
  /** Keep a local copy of played tracks so they play offline. */
  offlineCacheEnabled: boolean
  /** 收集本程序异常日志并上传服务器（设备/系统/版本/时间/IP/异常详情），可随时关闭。 */
  collectLogs: boolean
  /** GPU 加速渲染；关闭后下次启动改用软件渲染（启动早期生效，需重启）。 */
  hardwareAcceleration: boolean
}

export const DEFAULT_SETTINGS: SettingsDTO = {
  quality: 'exhigh',
  autoDowngradeQuality: true,
  volume: 80,
  showDesktopLyrics: false,
  desktopLyricsFontSize: 28,
  desktopLyricsOpacity: 0.92,
  desktopLyricsEffect: 'classic',
  lyricFont: 'default',
  desktopLyricsLocked: false,
  cacheLimitMB: 2048,
  cacheDirectory: '',
  audioDevice: '',
  mediaKeys: true,
  tray: true,
  // 关闭窗口默认收进托盘而不是退出：托盘与任务栏都能恢复窗口（单击即可）。
  closeToTray: true,
  scrobble: true,
  theme: 'system',
  language: 'system',
  wallpaperSet: false,
  wallpaperVersion: 0,
  unblockGreyTracks: true,
  unblockSources: ['qishui', 'kugou', 'kuwo', 'qq'],
  offlineCacheEnabled: true,
  collectLogs: true,
  hardwareAcceleration: true
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
