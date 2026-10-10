/**
 * 站外音源搜索（汽水音乐 / 酷狗 / 酷我）。
 *
 * 为什么需要：网易云曲库里没有的歌（大量抖音热歌、翻唱、remix）在网易云搜不到。
 * 这里把搜索打到曲库更大的几个平台，点播时再**严格匹配**同一首歌拿到完整音频。
 *
 * 关于「抖音原生音频」：汽水的**搜索**接口免签名可用；播放地址则走 h5 分享页的
 * SEO 接口（`/luna/h5/seo_track`，同样免签名免登录，返回明文 M4A），
 * 见 `unblock/providers.ts` 的 `resolveQishui`。这里仍把汽水当发现层，
 * 播放统一走下面 resolveExternalAudio 的严格匹配链路。
 */
import type { Track } from '../netease/models.js'
import {
  resolveQishui,
  resolveKugou,
  resolveKuwo,
  resolveQq,
  type ResolvedAudioSource
} from '../unblock/providers.js'
import {
  EXTERNAL_SOURCES as SOURCES,
  EXTERNAL_SOURCE_NAMES as SOURCE_NAMES,
  type ExternalSource,
  type ExternalTrackDTO
} from '@shared/types'

export type { ExternalSource }
export type ExternalTrack = ExternalTrackDTO
export const EXTERNAL_SOURCES = SOURCES
export const EXTERNAL_SOURCE_NAMES = SOURCE_NAMES

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
/** 汽水（抖音）客户端 aid，搜索接口用它区分平台。 */
const QISHUI_AID = '386088'

async function fetchJSON(url: string, headers: Record<string, string> = {}): Promise<any> {
  const response = await fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    // 站外接口偶发无响应会拖死搜索页兜底与播放解析，统一硬性超时。
    signal: AbortSignal.timeout(12_000)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

// --- 汽水音乐 --------------------------------------------------------------

/** 汽水封面地址：图片 CDN 需要一个 `~template.image` 后缀。 */
export function qishuiCover(urlCover: any): string | undefined {
  const base = urlCover?.urls?.[0]
  const uri = urlCover?.uri
  const template = urlCover?.template_prefix
  if (typeof base !== 'string' || typeof uri !== 'string' || typeof template !== 'string') return undefined
  return `${base}${uri}~${template}.image`
}

/**
 * 汽水歌手头像：搜索响应里 `user_info.medium_avatar_url.urls` 是**可直接访问的完整地址**
 * （实测 HTTP 200）。专辑封面只有 uri+模板，拼出来的地址在图片 CDN 上 404（实测过
 * 48 种组合），所以封面的兜底方案是歌手的头像。
 */
export function qishuiArtistAvatar(track: any): string | undefined {
  const artist = track?.artists?.[0]
  const urls = artist?.user_info?.medium_avatar_url?.urls
  const first = Array.isArray(urls) ? urls[0] : undefined
  if (typeof first === 'string' && first.includes('douyinpic.com')) return first
  return undefined
}

export function parseQishuiSearch(payload: any, limit: number): ExternalTrack[] {
  const groups: any[] = Array.isArray(payload?.result_groups) ? payload.result_groups : []
  const trackGroup = groups.find((group) => group?.id === 'tracks') ?? groups[0]
  const items: any[] = Array.isArray(trackGroup?.data) ? trackGroup.data : []
  const result: ExternalTrack[] = []
  for (const item of items) {
    const track = item?.entity?.track
    if (!track?.id || !track?.name) continue
    result.push({
      source: 'qishui',
      sourceId: String(track.id),
      name: String(track.name),
      artists: (Array.isArray(track.artists) ? track.artists : [])
        .map((artist: any) => artist?.name)
        .filter((name: unknown): name is string => typeof name === 'string' && name.length > 0)
        .join(' / ') || '未知歌手',
      album: typeof track.album?.name === 'string' ? track.album.name : undefined,
      durationMS: Number(track.duration ?? 0),
      // 专辑封面拼不出来时退回歌手头像（头像 URL 实测可加载）。
      coverUrl: qishuiCover(track.album?.url_cover) ?? qishuiArtistAvatar(track)
    })
    if (result.length >= limit) break
  }
  return result
}

export async function searchQishui(keywords: string, limit: number): Promise<ExternalTrack[]> {
  const payload = await fetchJSON(
    `https://api.qishui.com/luna/pc/search/all?q=${encodeURIComponent(keywords)}&aid=${QISHUI_AID}`,
    { Accept: 'application/json', Referer: 'https://music.douyin.com/' }
  )
  return parseQishuiSearch(payload, limit)
}

// --- 酷狗音乐 --------------------------------------------------------------

export function kugouCover(unionCover: unknown): string | undefined {
  if (typeof unionCover !== 'string') return undefined
  // 接口里是模板：http://imge.kugou.com/stdmusic/{size}/xxx.jpg
  return unionCover.replace('{size}', '480')
}

export function parseKugouSearch(payload: any, limit: number): ExternalTrack[] {
  const items: any[] = Array.isArray(payload?.data?.info) ? payload.data.info : []
  const result: ExternalTrack[] = []
  for (const item of items) {
    const name = String(item?.songname ?? '').trim()
    const hash = String(item?.hash ?? '').trim()
    if (!name || !hash) continue
    result.push({
      source: 'kugou',
      sourceId: hash,
      name,
      artists: String(item?.singername ?? '').trim() || '未知歌手',
      album: String(item?.album_name ?? '').trim() || undefined,
      durationMS: Number(item?.duration ?? 0) * 1000,
      coverUrl: kugouCover(item?.trans_param?.union_cover)
    })
    if (result.length >= limit) break
  }
  return result
}

export async function searchKugou(keywords: string, limit: number): Promise<ExternalTrack[]> {
  const payload = await fetchJSON(
    `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(keywords)}` +
      `&page=1&pagesize=${Math.max(limit, 10)}`
  )
  return parseKugouSearch(payload, limit)
}

// --- 酷我音乐 --------------------------------------------------------------

/** 酷我搜索返回的是「单引号 JSON + HTML 实体」，需要先规范化。 */
export function normalizeKuwoJSON(text: string): any {
  const normalized = text
    .replace(/'/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '\\"')
  return JSON.parse(normalized)
}

export function parseKuwoSearch(payload: any, limit: number): ExternalTrack[] {
  const content: any[] = Array.isArray(payload?.content) ? payload.content : []
  const songs: any[] = Array.isArray(content[1]?.musicpage?.abslist)
    ? content[1].musicpage.abslist
    : Array.isArray(payload?.abslist)
      ? payload.abslist
      : []
  const result: ExternalTrack[] = []
  for (const item of songs) {
    const name = String(item?.SONGNAME ?? '').trim()
    const rid = String(item?.MUSICRID ?? '').split('_').pop() ?? ''
    if (!name || !rid) continue
    const short = item?.web_albumpic_short
    result.push({
      source: 'kuwo',
      sourceId: rid,
      name,
      artists: String(item?.ARTIST ?? '').trim() || '未知歌手',
      album: String(item?.ALBUM ?? '').trim() || undefined,
      durationMS: Number(item?.DURATION ?? 0) * 1000,
      coverUrl: typeof short === 'string' && short.length > 0 ? `https://img2.kuwo.cn/star/albumcover/${short}` : undefined
    })
    if (result.length >= limit) break
  }
  return result
}

export async function searchKuwo(keywords: string, limit: number): Promise<ExternalTrack[]> {
  const response = await fetch(
    `https://search.kuwo.cn/r.s?&correct=1&vipver=1&stype=comprehensive&encoding=utf8` +
      `&rformat=json&mobi=1&show_copyright_off=1&searchapi=6&all=${encodeURIComponent(keywords)}`,
    { headers: { 'User-Agent': 'okhttp/3.10.0' }, signal: AbortSignal.timeout(12_000) }
  )
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return parseKuwoSearch(normalizeKuwoJSON(await response.text()), limit)
}

// --- 统一入口 --------------------------------------------------------------

export async function searchExternal(
  source: ExternalSource,
  keywords: string,
  limit = 30
): Promise<ExternalTrack[]> {
  switch (source) {
    case 'qishui':
      return searchQishui(keywords, limit)
    case 'kugou':
      return searchKugou(keywords, limit)
    case 'kuwo':
      return searchKuwo(keywords, limit)
  }
}

/**
 * 站外曲目的稳定负数 ID：与网易云 ID 空间隔开，播放器/歌词等链路据此识别
 * 「这不是网易云的歌」。同一首歌每次得到的值一致，便于队列去重与界面比对。
 */
export function externalTrackID(item: ExternalTrack): number {
  const key = `${item.source}:${item.sourceId}`
  let hash = 0
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0
  }
  return -(Math.abs(hash) % 1_000_000_000) - 1
}

/** 站外曲目 → 现有严格匹配器需要的 Track 形状（ID 用负数，避免与网易云 ID 冲突）。 */
export function toSyntheticTrack(item: ExternalTrack): Track {
  return {
    id: externalTrackID(item),
    name: item.name,
    artists: item.artists
      .split(/\s*\/\s*/)
      .filter(Boolean)
      .map((name, index) => ({ id: -1 - index, name })),
    album: { id: -1, name: item.album ?? item.name, picUrl: item.coverUrl },
    durationMS: item.durationMS
  } as unknown as Track
}

export interface ResolvedExternalAudio {
  url: string
  /** 实际来源（酷狗 / 酷我），用于界面如实标注。 */
  sourceName: string
}

/**
 * 解析站外曲目的可播放地址：依次走 汽水 → 酷狗 → 酷我 → QQ
 * （四个实现都会做「时长 ±5 秒 + 歌名归一化 + 版本标记 + 歌手」严格匹配，
 * 宁可不播也不放错歌）。
 */
export async function resolveExternalAudio(item: ExternalTrack): Promise<ResolvedExternalAudio | null> {
  const synthetic = toSyntheticTrack(item)
  const attempts: Array<() => Promise<ResolvedAudioSource | null>> = [
    () => resolveQishui(synthetic),
    () => resolveKugou(synthetic),
    () => resolveKuwo(synthetic),
    () => resolveQq(synthetic)
  ]
  for (const attempt of attempts) {
    try {
      const source = await attempt()
      if (source) return { url: source.url, sourceName: source.displayName }
    } catch {
      // 某个源不可用时继续试下一个；全失败由上层给用户明确提示
    }
  }
  return null
}
