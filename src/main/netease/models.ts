/**
 * Data models for the NetEase Cloud Music API.
 *
 * 解码规则刻意宽容：同一字段在不同接口里有多种拼写与数值类型（v3 的
 * `ar`/`al`/`dt` 与旧版 `artists`/`album`/`duration`，`picUrl`/`coverImgUrl`/`cover`，
 * `playCount` 可能是浮点……），这里用归一化函数处理而不是定义严格 schema，
 * 因为接口未公开且会漂移。
 */

// MARK: - Normalising helpers

type Json = Record<string, any>

function obj(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined
}

function str(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c
    if (typeof c === 'number') return String(c)
  }
  return undefined
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) if (typeof c === 'string') return c
  return undefined
}

function int(...candidates: unknown[]): number {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return Math.trunc(c)
    if (typeof c === 'string' && c.trim() !== '' && Number.isFinite(Number(c))) return Math.trunc(Number(c))
  }
  return 0
}

function strArray(...candidates: unknown[]): string[] {
  for (const c of candidates) {
    if (Array.isArray(c)) return c.filter((v): v is string => typeof v === 'string')
  }
  return []
}

// MARK: - User

export interface UserProfile {
  userId: number
  nickname: string
  avatarUrl?: string
  backgroundUrl?: string
  signature?: string
  vipType: number
}

export function toUserProfile(raw: unknown): UserProfile | undefined {
  const c = obj(raw)
  if (!c) return undefined
  return {
    userId: int(c.userId, c.userid, c.id),
    nickname: str(c.nickname) ?? '',
    avatarUrl: firstString(c.avatarUrl),
    backgroundUrl: firstString(c.backgroundUrl),
    signature: firstString(c.signature),
    vipType: int(c.vipType, c.vipRights?.redVipLevel)
  }
}

// MARK: - Playlist

export interface PlaylistCreator {
  userId: number
  nickname: string
  avatarUrl?: string
}

function toPlaylistCreator(raw: unknown): PlaylistCreator | undefined {
  const c = obj(raw)
  if (!c) return undefined
  return {
    userId: int(c.userId),
    nickname: str(c.nickname) ?? '',
    avatarUrl: firstString(c.avatarUrl)
  }
}

export interface PlaylistSummary {
  id: number
  name: string
  coverURL?: string
  playCount: number
  trackCount: number
  updateTime?: number
  copywriter?: string
  creator?: PlaylistCreator
  specialType: number
  privacy: number
  subscribed: boolean
}

export function toPlaylistSummary(raw: unknown): PlaylistSummary | undefined {
  const c = obj(raw)
  if (!c) return undefined
  const id = int(c.id)
  return {
    id,
    name: str(c.name) ?? '',
    coverURL: firstString(c.picUrl, c.coverImgUrl),
    playCount: int(c.playCount, c.playcount),
    trackCount: int(c.trackCount),
    updateTime: typeof c.updateTime === 'number' ? Math.trunc(c.updateTime) : undefined,
    copywriter: firstString(c.copywriter),
    creator: toPlaylistCreator(c.creator),
    specialType: int(c.specialType),
    privacy: int(c.privacy),
    subscribed: c.subscribed === true
  }
}

/** The auto-created "我喜欢的音乐" playlist. */
export function isLikedSongsList(p: PlaylistSummary): boolean {
  return p.specialType === 5
}

export interface TrackIDRef {
  id: number
}

export interface PlaylistDetail {
  id: number
  name: string
  coverImgUrl?: string
  creator?: PlaylistCreator
  description?: string
  trackCount: number
  playCount: number
  subscribedCount: number
  subscribed: boolean
  trackIds: TrackIDRef[]
  tracks: Track[]
  specialType: number
  updateTime: number
}

export function toPlaylistDetail(raw: unknown): PlaylistDetail | undefined {
  const c = obj(raw)
  if (!c) return undefined
  return {
    id: int(c.id),
    name: str(c.name) ?? '',
    coverImgUrl: firstString(c.coverImgUrl),
    creator: toPlaylistCreator(c.creator),
    description: firstString(c.description),
    trackCount: int(c.trackCount),
    playCount: int(c.playCount),
    subscribedCount: int(c.subscribedCount),
    subscribed: c.subscribed === true,
    trackIds: Array.isArray(c.trackIds)
      ? c.trackIds.map((t: unknown) => ({ id: int(obj(t)?.id) })).filter((t: TrackIDRef) => t.id > 0)
      : [],
    tracks: toTracks(c.tracks),
    specialType: int(c.specialType),
    updateTime: int(c.updateTime)
  }
}

// MARK: - Album / Artist

export interface AlbumSummary {
  id: number
  name: string
  picUrl?: string
  artistName: string
  publishTime: number
  size: number
  subType?: string
  alias: string[]
}

export function toAlbumSummary(raw: unknown): AlbumSummary | undefined {
  const c = obj(raw)
  if (!c) return undefined
  const id = int(c.id)
  if (!id && !c.name) return undefined
  const single = obj(c.artist)
  const list = Array.isArray(c.artists) ? c.artists : []
  const artistName = firstString(single?.name)
    ?? list
      .map((a: unknown) => firstString(obj(a)?.name))
      .filter((n): n is string => !!n)
      .join(' / ')
  return {
    id,
    name: str(c.name) ?? '',
    picUrl: firstString(c.picUrl, c.cover),
    artistName: artistName ?? '',
    publishTime: int(c.publishTime),
    size: int(c.size),
    subType: firstString(c.subType),
    alias: strArray(c.alia, c.alias)
  }
}

export function publishYear(publishTime: number): string {
  if (publishTime <= 0) return ''
  return String(new Date(publishTime).getFullYear())
}

export interface ArtistSummary {
  id: number
  name: string
  picUrl?: string
  albumSize: number
  musicSize: number
  briefDesc?: string
  alias: string[]
  followed: boolean
}

export function toArtistSummary(raw: unknown): ArtistSummary | undefined {
  const c = obj(raw)
  if (!c) return undefined
  const id = int(c.id)
  if (!id && !c.name) return undefined
  return {
    id,
    name: str(c.name) ?? '',
    picUrl: firstString(c.picUrl, c.cover, c.avatar, c.img1v1Url),
    albumSize: int(c.albumSize),
    musicSize: int(c.musicSize),
    briefDesc: firstString(c.briefDesc),
    alias: strArray(c.alias),
    followed: c.followed === true
  }
}

export interface AlbumDetail {
  id: number
  name: string
  picUrl?: string
  artist?: ArtistSummary
  publishTime: number
  description?: string
  company?: string
  size: number
  subType?: string
}

export function toAlbumDetail(raw: unknown): AlbumDetail | undefined {
  const c = obj(raw)
  if (!c) return undefined
  return {
    id: int(c.id),
    name: str(c.name) ?? '',
    picUrl: firstString(c.picUrl),
    artist: toArtistSummary(c.artist),
    publishTime: int(c.publishTime),
    description: firstString(c.description),
    company: firstString(c.company),
    size: int(c.size),
    subType: firstString(c.subType)
  }
}

// MARK: - Toplist

export interface ToplistTrackPreview {
  first: string
  second: string
}

export interface ToplistItem {
  id: number
  name: string
  coverImgUrl?: string
  updateFrequency?: string
  tracks: ToplistTrackPreview[]
  playCount: number
}

export function toToplistItem(raw: unknown): ToplistItem | undefined {
  const c = obj(raw)
  if (!c) return undefined
  return {
    id: int(c.id),
    name: str(c.name) ?? '',
    coverImgUrl: firstString(c.coverImgUrl),
    updateFrequency: firstString(c.updateFrequency),
    tracks: Array.isArray(c.tracks)
      ? c.tracks.map((t: unknown) => ({
          first: str(obj(t)?.first) ?? '',
          second: str(obj(t)?.second) ?? ''
        }))
      : [],
    playCount: int(c.playCount)
  }
}

// MARK: - Track

export interface ArtistRef {
  id: number
  name: string
  /** 歌手头像（可能缺）：封面缺失时播放详情页用它兜底。 */
  picUrl?: string
}

export interface AlbumRef {
  id: number
  name: string
  picUrl?: string
}

export interface TrackPrivilege {
  id: number
  fee?: number
  pl?: number
  st?: number
  cs?: boolean
  maxbr?: number
}

export interface Track {
  id: number
  name: string
  artists: ArtistRef[]
  album: AlbumRef
  durationMS: number
  alias: string[]
  transNames: string[]
  fee: number
  mvID: number
  trackNo: number
  disc?: string
  noCopyright: boolean
  /** Cloud-disk song marker (`pc` field present). */
  isCloud: boolean
  /** Some endpoints (cloudsearch, FM) embed the privilege in the track itself. */
  embeddedPrivilege?: TrackPrivilege
}

export function artistNames(track: Track): string {
  return track.artists.map((a) => a.name).join(' / ')
}

export function trackDuration(track: Track): number {
  return track.durationMS / 1000
}

export function trackSubtitle(track: Track): string | undefined {
  return track.transNames[0] ?? track.alias[0]
}

export function toArtistRef(raw: unknown): ArtistRef {
  const c = obj(raw)
  return {
    id: int(c?.id),
    name: str(c?.name) ?? '',
    picUrl: firstString(c?.picUrl, c?.cover, c?.avatar, c?.img1v1Url)
  }
}

export function toAlbumRef(raw: unknown): AlbumRef {
  const c = obj(raw)
  return { id: int(c?.id), name: str(c?.name) ?? '', picUrl: firstString(c?.picUrl) }
}

export function toTrackPrivilege(raw: unknown): TrackPrivilege | undefined {
  const c = obj(raw)
  if (!c) return undefined
  return {
    id: int(c.id),
    fee: typeof c.fee === 'number' ? c.fee : undefined,
    pl: typeof c.pl === 'number' ? c.pl : undefined,
    st: typeof c.st === 'number' ? c.st : undefined,
    cs: typeof c.cs === 'boolean' ? c.cs : undefined,
    maxbr: typeof c.maxbr === 'number' ? c.maxbr : undefined
  }
}

/**
 * Decodes both the "v3" song shape (`ar`/`al`/`dt`) and the legacy shape
 * (`artists`/`album`/`duration`), exactly like the documented shape `Track` decoder.
 */
export function toTrack(raw: unknown): Track | undefined {
  const c = obj(raw)
  if (!c) return undefined
  const id = int(c.id)
  if (!id) return undefined
  const artistsRaw = Array.isArray(c.ar) ? c.ar : Array.isArray(c.artists) ? c.artists : []
  const albumRaw = obj(c.al) ?? obj(c.album)
  return {
    id,
    name: str(c.name) ?? '',
    artists: artistsRaw.map(toArtistRef),
    album: albumRaw ? toAlbumRef(albumRaw) : { id: 0, name: '' },
    durationMS: int(c.dt, c.duration),
    alias: strArray(c.alia, c.alias),
    transNames: strArray(c.tns),
    fee: int(c.fee),
    mvID: int(c.mv),
    trackNo: int(c.no),
    disc: firstString(c.cd),
    noCopyright: c.noCopyrightRcmd !== undefined && c.noCopyrightRcmd !== null,
    isCloud: c.pc !== undefined && c.pc !== null,
    embeddedPrivilege: toTrackPrivilege(c.privilege)
  }
}

export function toTracks(raw: unknown): Track[] {
  if (!Array.isArray(raw)) return []
  return raw.map(toTrack).filter((t): t is Track => !!t)
}

export type TrackPlayability = 'playable' | 'vipOnly' | 'paidAlbum' | 'noCopyright' | 'delisted'

/**
 * 可播放性判定链：先看 VIP/付费状态，再看版权与下架标记；
 * VIP 判定覆盖到黑胶 SVIP（vipType 110 等）。
 */
export function playability(
  track: Track,
  privilege: TrackPrivilege | undefined,
  isLoggedIn: boolean,
  vipType: number
): TrackPlayability {
  const p = privilege ?? track.embeddedPrivilege
  if (p?.pl !== undefined && p.pl > 0) return 'playable'
  if (isLoggedIn && p?.cs === true) return 'playable'
  const effectiveFee = p?.fee ?? track.fee
  if (effectiveFee === 1) return vipType > 0 ? 'playable' : 'vipOnly'
  if (effectiveFee === 4) return 'paidAlbum'
  if (track.noCopyright) return 'noCopyright'
  if (p?.st !== undefined && p.st < 0 && isLoggedIn) return 'delisted'
  return 'playable'
}

export function playabilityReason(p: TrackPlayability): string | undefined {
  switch (p) {
    case 'playable':
      return undefined
    case 'vipOnly':
      return 'VIP 专属'
    case 'paidAlbum':
      return '付费专辑'
    case 'noCopyright':
      return '无版权'
    case 'delisted':
      return '已下架'
  }
}

// MARK: - Lyrics

export interface LyricResponse {
  lrc?: { lyric?: string }
  tlyric?: { lyric?: string }
  romalrc?: { lyric?: string }
  /** Verbatim (word-by-word) lyrics for karaoke highlighting. */
  yrc?: { lyric?: string }
  ytlrc?: { lyric?: string }
  yromalrc?: { lyric?: string }
  lyricUser?: { nickname?: string }
  transUser?: { nickname?: string }
  nolyric?: boolean
  uncollected?: boolean
}

// MARK: - Song URL

export interface FreeTrialInfo {
  start?: number
  end?: number
}

export interface SongURLData {
  id: number
  url?: string
  br: number
  size: number
  type?: string
  level?: string
  fee: number
  freeTrialInfo?: FreeTrialInfo
  time: number
  code?: number
  md5?: string
}

export function toSongURLData(raw: unknown): SongURLData | undefined {
  const c = obj(raw)
  if (!c) return undefined
  return {
    id: int(c.id),
    url: firstString(c.url),
    br: int(c.br),
    size: int(c.size),
    type: firstString(c.type),
    level: firstString(c.level),
    fee: int(c.fee),
    freeTrialInfo: obj(c.freeTrialInfo)
      ? {
          start: typeof c.freeTrialInfo.start === 'number' ? c.freeTrialInfo.start : undefined,
          end: typeof c.freeTrialInfo.end === 'number' ? c.freeTrialInfo.end : undefined
        }
      : undefined,
    time: int(c.time),
    code: typeof c.code === 'number' ? c.code : undefined,
    md5: firstString(c.md5)
  }
}

// MARK: - Cloud disk

export interface CloudSongItem {
  songId: number
  songName?: string
  artist?: string
  fileSize: number
  simpleSong?: Track
}

export function toCloudSongItem(raw: unknown): CloudSongItem | undefined {
  const c = obj(raw)
  if (!c) return undefined
  const nested = obj(c.privateCloud)
  const simpleSong = toTrack(c.simpleSong)
  const songId = int(c.songId) || int(nested?.songId) || simpleSong?.id || 0
  return {
    songId,
    songName: firstString(c.songName, nested?.song, simpleSong?.name),
    artist: firstString(c.artist, nested?.artist),
    fileSize: int(c.fileSize) || int(nested?.fileSize),
    simpleSong
  }
}

// MARK: - Play record

export interface PlayRecordItem {
  playCount: number
  score: number
  song: Track
}

export function toPlayRecordItem(raw: unknown): PlayRecordItem | undefined {
  const c = obj(raw)
  if (!c) return undefined
  const song = toTrack(c.song)
  if (!song) return undefined
  return { playCount: int(c.playCount), score: int(c.score), song }
}

// MARK: - Formatting helpers

export function formatPlayCount(count: number, chinese = true): string {
  if (chinese) {
    if (count >= 100_000_000) return `${(count / 100_000_000).toFixed(1)}亿`
    if (count >= 10_000) return `${(count / 10_000).toFixed(1)}万`
    return String(count)
  }
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 10_000) return `${(count / 1_000).toFixed(1)}K`
  return String(count)
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function formatLongDuration(seconds: number): string {
  const total = Math.floor(seconds)
  if (total >= 3600) return `${Math.floor(total / 3600)} 小时 ${Math.floor((total % 3600) / 60)} 分钟`
  return `${Math.floor(total / 60)} 分钟`
}

export function formatDate(ms: number): string {
  if (ms <= 0) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * NetEase image CDN resize convention: `<picUrl>?param=<W>y<H>`.
 * Also upgrades `http:` to `https:`.
 */
export function resizedImageURL(url: string | undefined, size: number): string | undefined {
  if (!url) return undefined
  const https = url.replace(/^http:\/\//, 'https://')
  const sep = https.includes('?') ? '&' : '?'
  return `${https}${sep}param=${size}y${size}`
}
