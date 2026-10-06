/**
 * 灰色/付费歌曲的第三方音源解析。
 *
 * 策略：先在 pyncmd 上按网易云歌曲 ID 直取，取不到再用「站内搜索 + 严格匹配」
 * 从酷狗 / 酷我找同一首歌。
 *
 * 严格匹配是这套方案能用的关键：只认时长相差 5 秒以内、标题归一化后相同、
 * 且「伴奏/翻唱/remix/live」等版本标记完全一致的结果。宁可返回"没找到"，
 * 也不能拿一首翻唱糊弄用户。
 */
import type { Track } from '../netease/models.js'

export type AudioSourceID = 'pyncmd' | 'kugou' | 'kuwo'

export const AUDIO_SOURCE_IDS: AudioSourceID[] = ['pyncmd', 'kugou', 'kuwo']

export const AUDIO_SOURCE_NAMES: Record<AudioSourceID, string> = {
  pyncmd: 'pyncmd',
  kugou: '酷狗音乐',
  kuwo: '酷我音乐'
}

export interface ResolvedAudioSource {
  id: AudioSourceID
  displayName: string
  url: string
  /** 已知码率（kbps）；未知时省略，用于给用户一个诚实的音质提示。 */
  bitrate?: number
}

/** 各音源共用的浏览器 UA；酷我的转链接口对 UA 敏感，额外单独指定。 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

const KUWO_UA = 'okhttp/3.10.0'

const REQUEST_TIMEOUT_MS = 12_000

// ---------------------------------------------------------------------------
// 匹配器
// ---------------------------------------------------------------------------

/** 搜索关键词：歌名 + 首位歌手。 */
export function searchKeyword(track: Track): string {
  return `${track.name} ${track.artists[0]?.name ?? ''}`.trim()
}

const VERSION_MARKERS = ['live', 'remix', '伴奏', 'dj', 'cover', '翻唱', 'instrumental', 'karaoke']

/**
 * 候选是否就是同一首歌。四个条件同时成立才算：
 * 双方时长已知且相差 ≤ 5 秒、标题归一化后相等、版本标记一致、歌手名命中。
 */
export function matchesTrack(
  track: Track,
  candidate: { title: string; artist: string; durationMS: number }
): boolean {
  if (!(track.durationMS > 0 && candidate.durationMS > 0)) return false
  if (Math.abs(candidate.durationMS - track.durationMS) > 5_000) return false
  if (normalize(candidate.title) !== normalize(track.name)) return false
  if (hasVersionConflict(track.name, candidate.title)) return false

  const expectedArtist = normalize(track.artists[0]?.name ?? '')
  if (!expectedArtist) return false
  return artistNames(candidate.artist).includes(expectedArtist)
}

function hasVersionConflict(original: string, candidate: string): boolean {
  const markers = (text: string): string =>
    VERSION_MARKERS.filter((marker) => normalize(text).includes(marker)).sort().join('|')
  return markers(original) !== markers(candidate)
}

function artistNames(value: string): string[] {
  return value
    .split(/[/&、,，;；]/)
    .map((part) => normalize(part))
    .filter((part) => part.length > 0)
}

/** 折叠大小写/变音符/全半角，并只保留字母数字。 */
function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff]/g, '')
}

// ---------------------------------------------------------------------------
// 音源实现
// ---------------------------------------------------------------------------

async function fetchJSON(url: string, ua = USER_AGENT): Promise<any> {
  const response = await fetch(url, {
    headers: { 'User-Agent': ua },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function fetchText(url: string, ua = USER_AGENT): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': ua },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

/**
 * pyncmd：按网易云 ID 直取，最精确的一条路（不需要匹配，天然是同一首歌）。
 * 这一项排在第一位的收益最明显。
 */
export async function resolvePyncmd(track: Track): Promise<ResolvedAudioSource | null> {
  const payload = await fetchJSON(
    `https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=${track.id}&br=320`
  )
  const bitrate = Number(payload?.br ?? 0)
  const url = typeof payload?.url === 'string' ? payload.url : undefined
  if (!(bitrate > 0) || !url) return null
  return {
    id: 'pyncmd',
    displayName: AUDIO_SOURCE_NAMES.pyncmd,
    url: url.replace(/^http:\/\//, 'https://'),
    bitrate
  }
}

/**
 * 酷狗：搜索 → 时长/歌名/歌手严格匹配 → 用 hash 换直链。
 *
 * 换链走 `m.kugou.com/app/i/getSongInfo.php?cmd=playInfo`：老的
 * `trackercdn.kugou.com/i/v2/` 与 `wwwapi .../play/getdata` 现在分别要求
 * 签名（status=2 / err 30020），而 getSongInfo 仍对公开曲目直接返回 `url`，
 * 对收费曲目也老老实实回「需要付费」，语义清楚。
 */
export async function resolveKugou(track: Track): Promise<ResolvedAudioSource | null> {
  const keyword = encodeURIComponent(searchKeyword(track))
  const search = await fetchJSON(
    `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${keyword}&page=1&pagesize=10`
  )
  const info: any[] = Array.isArray(search?.data?.info) ? search.data.info : []

  const match = info.slice(0, 5).find((item) =>
    matchesTrack(track, {
      title: String(item?.songname ?? ''),
      artist: String(item?.singername ?? ''),
      durationMS: Number(item?.duration ?? 0) * 1000
    })
  )
  if (!match) return null

  const hash = String(match.hash)
  const detail = await fetchJSON(
    `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}`,
    USER_AGENT
  )
  const url = Array.isArray(detail?.url) ? detail.url[0] : detail?.url
  if (typeof url !== 'string' || !url.startsWith('http')) return null

  const bitrate = Number(detail?.bitRate ?? 0)
  return {
    id: 'kugou',
    displayName: AUDIO_SOURCE_NAMES.kugou,
    url,
    bitrate: bitrate > 0 ? Math.round(bitrate / 1000) : undefined
  }
}

/** 酷我：搜索 → 严格匹配 → antiserver 转直链（返回的是纯文本 URL）。 */
export async function resolveKuwo(track: Track): Promise<ResolvedAudioSource | null> {
  const keyword = encodeURIComponent(searchKeyword(track))
  const search = await fetchJSON(
    `https://search.kuwo.cn/r.s?&correct=1&vipver=1&stype=comprehensive&encoding=utf8` +
      `&rformat=json&mobi=1&show_copyright_off=1&searchapi=6&all=${keyword}`
  )
  const content: any[] = Array.isArray(search?.content) ? search.content : []
  const songs: any[] = Array.isArray(content[1]?.musicpage?.abslist) ? content[1].musicpage.abslist : []

  const match = songs.slice(0, 5).find((item) => {
    const durationSeconds = Number(item?.DURATION ?? 0)
    return matchesTrack(track, {
      title: String(item?.SONGNAME ?? ''),
      artist: String(item?.ARTIST ?? ''),
      durationMS: durationSeconds * 1000
    })
  })
  if (!match) return null

  const rid = String(match.MUSICRID ?? '').split('_').pop()
  if (!rid) return null

  const text = await fetchText(
    `https://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid=MUSIC_${rid}`,
    KUWO_UA
  )
  const found = /http[^\s$"]+/.exec(text)
  if (!found) return null
  return { id: 'kuwo', displayName: AUDIO_SOURCE_NAMES.kuwo, url: found[0] }
}

export const PROVIDERS: Record<AudioSourceID, (track: Track) => Promise<ResolvedAudioSource | null>> = {
  pyncmd: resolvePyncmd,
  kugou: resolveKugou,
  kuwo: resolveKuwo
}
