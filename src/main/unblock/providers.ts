/**
 * 灰色/付费歌曲的第三方音源解析。
 *
 * 策略分两种：能按网易云歌曲 ID 直取的（聚合音源）先取，天然就是同一首歌；
 * 取不到再按「歌名 + 歌手」在各平台搜索，用严格匹配确认是同一首歌后换直链。
 * 顺序：聚合音源 → 汽水 → 酷狗 → 酷我 → QQ。
 *
 * 严格匹配是搜索这条路能用的关键：只认时长相差 5 秒以内、标题归一化后相同、
 * 且「伴奏/翻唱/remix/live」等版本标记完全一致的结果。宁可返回"没找到"，
 * 也不能拿一首翻唱糊弄用户。
 */
import { QUALITY_OPTIONS, type QualityLevel } from '@shared/types'
import type { Track } from '../netease/models.js'
import { probeStream } from '../player/streamProbe.js'

export type AudioSourceID = 'gdstudio' | 'qishui' | 'kugou' | 'kuwo' | 'qq'

export const AUDIO_SOURCE_IDS: AudioSourceID[] = ['gdstudio', 'qishui', 'kugou', 'kuwo', 'qq']

export const AUDIO_SOURCE_NAMES: Record<AudioSourceID, string> = {
  gdstudio: '聚合音源',
  qishui: '汽水音乐',
  kugou: '酷狗音乐',
  kuwo: '酷我音乐',
  qq: 'QQ音乐'
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
 * 双方时长已知且相差 ≤ `durationToleranceMS`（默认 5 秒）、标题归一化后相等、
 * 版本标记一致、歌手名命中。
 *
 * 跨平台匹配一律用默认的 5 秒（不同平台的时长常有几秒出入，放宽会放进别的版本）；
 * 只有「同一个平台里找替代条目」才放宽——见 controller 的 findSubstitute。
 */
export function matchesTrack(
  track: Track,
  candidate: { title: string; artist: string; durationMS: number },
  options: { durationToleranceMS?: number } = {}
): boolean {
  if (!(track.durationMS > 0 && candidate.durationMS > 0)) return false
  const tolerance = options.durationToleranceMS ?? 5_000
  if (Math.abs(candidate.durationMS - track.durationMS) > tolerance) return false
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

/** 需要自定义请求头（Referer/Accept）的接口走这个。 */
async function fetchJSONWithHeaders(url: string, headers: Record<string, string>): Promise<any> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, ...headers },
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

// ---------------------------------------------------------------------------
// 聚合音源（按网易云歌曲 ID 直取）
// ---------------------------------------------------------------------------

/**
 * 直接拿网易云歌曲 ID 换直链，**不需要搜索与匹配**，因此天然是同一首歌，
 * 也是灰歌/VIP 歌唯一能稳定拿到完整音源的一条路（上游 kumone 把它命名为
 * `pyncmd` 并排在所有音源之前）。返回的是网易云自己的 CDN 直链。
 */
const GD_API = 'https://music-api.gdstudio.xyz/api.php'

/**
 * 用户选的音质档位 → 接口的 `br` 参数。实测档位：128 / 192 / 320 kbps MP3、
 * 999（无损 FLAC）。接口给不出所选档位时会**如实回报实际码率**，界面据此
 * 显示真实音质，不虚报。
 */
const GD_BITRATE_BY_LEVEL: Record<QualityLevel, number> = {
  standard: 128,
  higher: 192,
  exhigh: 320,
  lossless: 999,
  hires: 999,
  jyeffect: 999,
  sky: 999,
  jymaster: 999
}

async function fetchGdstudio(trackID: number, bitrate: number): Promise<ResolvedAudioSource | null> {
  const payload = await fetchJSON(
    `${GD_API}?types=url&source=netease&id=${trackID}&br=${bitrate}`
  )
  const url = typeof payload?.url === 'string' ? payload.url.trim() : ''
  const actual = Number(payload?.br ?? 0)
  if (!url || !(actual > 0)) return null
  return {
    id: 'gdstudio',
    displayName: AUDIO_SOURCE_NAMES.gdstudio,
    url: url.replace(/^http:\/\//, 'https://'),
    bitrate: actual
  }
}

/**
 * 同一首歌上刚刚「起播失败」的聚合档位。聚合接口每次请求给的 CDN 主机/路径
 * 并不固定，所以换一档重新要一次常常就活了（低档位文件更小、更快起播）。
 * 只在内存里记一小会儿：过了时间就当没发生过，别把一次偶发故障记一辈子。
 */
const gdUnplayable = new Map<number, { bitrate: number; at: number }>()
const GD_UNPLAYABLE_TTL_MS = 10 * 60_000

/** 记下「这个档位在这台机器上起播不出来」，下次解析换一档。 */
export function noteGdstudioUnplayable(trackID: number, bitrate?: number): void {
  if (!(trackID > 0)) return
  gdUnplayable.set(trackID, { bitrate: bitrate && bitrate > 0 ? bitrate : 0, at: Date.now() })
}

function gdAvoided(trackID: number): number {
  const record = gdUnplayable.get(trackID)
  if (!record) return 0
  if (Date.now() - record.at > GD_UNPLAYABLE_TTL_MS) {
    gdUnplayable.delete(trackID)
    return 0
  }
  return record.bitrate
}

export async function resolveGdstudio(
  track: Track,
  preferred?: QualityLevel
): Promise<ResolvedAudioSource | null> {
  if (!(track.id > 0)) return null
  let wanted = GD_BITRATE_BY_LEVEL[preferred ?? 'exhigh']
  // 刚失败过的那一档不再问：换成 128k——文件最小、起播最快，
  // 对用户来说「能完整听」比「标着 320k 但卡在 0:00」重要得多。
  const avoided = gdAvoided(track.id)
  if (avoided && (avoided === wanted || wanted === 999)) wanted = 128
  const first = await fetchGdstudio(track.id, wanted).catch(() => null)
  if (first) return first
  // 选无损/母带时接口偶尔只给 MP3 档，或干脆空手；退一档再要一次，
  // 拿不到就交给后面的音源，绝不在这里拖时间。
  if (wanted === 320) return null
  return fetchGdstudio(track.id, 320).catch(() => null)
}

// ---------------------------------------------------------------------------
// 汽水音乐（抖音）
// ---------------------------------------------------------------------------

/** 汽水 PC 端搜索用的 aid。 */
const QISHUI_AID = '386088'
const QISHUI_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  Referer: 'https://music.douyin.com/'
}

interface QishuiCandidate {
  id: string
  title: string
  artist: string
  durationMS: number
}

interface QishuiGear {
  url: string
  bitrate?: number
  /** 由「体积 ÷ 码率」反推出的时长（毫秒），用来识别只给 30 秒片段的付费曲。 */
  durationMS?: number
}

/** 汽水的搜索：`/luna/pc/search/all` 免签名可用，曲目在 `result_groups[tracks]` 里。 */
async function searchQishui(track: Track): Promise<QishuiCandidate[]> {
  // 默认一页只回 5 首，而汽水曲库以翻唱/remix 为主，正主常常排在后面；
  // 多要一些候选（limit=20）能明显提高严格匹配的命中率。
  const payload = await fetchJSONWithHeaders(
    `https://api.qishui.com/luna/pc/search/all?q=${encodeURIComponent(searchKeyword(track))}` +
      `&aid=${QISHUI_AID}&offset=0&limit=20`,
    QISHUI_HEADERS
  )
  const groups: any[] = Array.isArray(payload?.result_groups) ? payload.result_groups : []
  const trackGroup = groups.find((group) => group?.id === 'tracks') ?? groups[0]
  const items: any[] = Array.isArray(trackGroup?.data) ? trackGroup.data : []
  const result: QishuiCandidate[] = []
  for (const item of items) {
    const found = item?.entity?.track
    if (!found?.id || !found?.name) continue
    result.push({
      id: String(found.id),
      title: String(found.name),
      artist: (Array.isArray(found.artists) ? found.artists : [])
        .map((artist: any) => artist?.name)
        .filter((name: unknown): name is string => typeof name === 'string' && name.length > 0)
        .join('/'),
      durationMS: Number(found.duration ?? 0)
    })
  }
  return result
}

/**
 * 汽水的播放地址：走 h5 分享页的 SEO 接口，**免签名、免登录、无需 cookie**
 * （实测 200 / 约 0.8 秒）。返回的 `track_player.video_model` 是一个 JSON 字符串，
 * 里面的 `video_list` 有 3 档**明文 M4A**（实测 64/126/251 kbps，HTTP 206 + Range 可拖动，
 * 前 64KB 不含 senc/tenc，说明没有 CENC 加密、不需要 spade 解密）。
 *
 * 不要走 `/luna/pc/track_v2`：那个接口返回的不是 JSON，拿不到播放地址。
 */
async function fetchQishuiGears(trackID: string): Promise<QishuiGear[]> {
  const payload = await fetchJSONWithHeaders(
    `https://beta-luna.douyin.com/luna/h5/seo_track?track_id=${encodeURIComponent(trackID)}&device_platform=web`,
    QISHUI_HEADERS
  )
  const raw = payload?.track_player?.video_model
  let model: any
  try {
    model = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return []
  }
  const list: any[] = Array.isArray(model?.video_list) ? model.video_list : []
  const gears: QishuiGear[] = []
  for (const entry of list) {
    const url = typeof entry?.main_url === 'string' ? entry.main_url : entry?.backup_url
    if (typeof url !== 'string' || !url.startsWith('http')) continue
    // 接口给的码率是 **bps**（实测 65452 = 65.4kbps，正对应汽水 65 档），
    // 而界面/音质映射用的是 kbps：这里统一换算，否则 65kbps 的 AAC 会被
    // 当成 65452kbps 报成「无损」。URL 里的 `br` 只作兜底。
    const meta = entry?.video_meta
    let rawBps = Number(meta?.bitrate ?? 0)
    if (!(rawBps > 0)) {
      try {
        rawBps = Number(new URL(url).searchParams.get('br') ?? 0)
      } catch {
        rawBps = 0
      }
    }
    if (!(rawBps > 0)) continue
    // 少数情况下该字段确实以 kbps 给出（<1000 时按 kbps 处理）。
    const bitrate = rawBps > 1000 ? Math.round(rawBps / 1000) : Math.round(rawBps)
    const size = Number(meta?.size ?? 0)
    // 时长必须用原始 bps 反推：bitrate 已是 kbps，直接代入会差 1000 倍。
    const durationMS = size > 0 ? (size * 8 * 1000) / rawBps : undefined
    gears.push({ url, bitrate, durationMS })
  }
  return gears
}

/**
 * 按首选档位挑一档：取与首选码率**最接近**的一档。
 * 汽水的档位是 65 / 130 / 258 kbps 这种稀疏档位，硬按「不超过首选」会让选 128 的用户掉到 65。
 * 首选是母带这类未知档位（br=0）时给最高的一档。
 */
function pickQishuiGear(gears: QishuiGear[], preferred?: QualityLevel): QishuiGear | undefined {
  if (gears.length === 0) return undefined
  const sorted = [...gears].sort((left, right) => (left.bitrate ?? 0) - (right.bitrate ?? 0))
  const ceiling = QUALITY_OPTIONS.find((option) => option.level === preferred)?.br ?? 0
  const withBitrate = gears.filter((gear) => (gear.bitrate ?? 0) > 0)
  if (!(ceiling > 0) || withBitrate.length === 0) return sorted[sorted.length - 1]
  return withBitrate.reduce((best, gear) =>
    Math.abs((gear.bitrate ?? 0) - ceiling) < Math.abs((best.bitrate ?? 0) - ceiling) ? gear : best
  )
}

export async function resolveQishui(
  track: Track,
  preferred?: QualityLevel
): Promise<ResolvedAudioSource | null> {
  const candidates = await searchQishui(track)
  const match = candidates.find((candidate) => matchesTrack(track, candidate))
  if (!match) return null
  const gears = await fetchQishuiGears(match.id)
  /*
   * 付费曲在汽水只给 30 秒试听（`video_list` 只有 1 档，体积也小一个数量级）。
   * 用「体积 ÷ 码率」反推时长和歌曲时长比一下就能识破，不需要额外下载：
   * 实测付费曲 487073B/129881bps ≈ 30s，而歌曲 239.5s。绝不能让「换了源却只播半分钟」发生。
   */
  const playable = gears.filter(
    (gear) => gear.durationMS === undefined || gear.durationMS >= track.durationMS * 0.8
  )
  if (playable.length === 0) return null
  const gear = pickQishuiGear(playable, preferred)
  if (!gear) return null
  return {
    id: 'qishui',
    displayName: AUDIO_SOURCE_NAMES.qishui,
    url: gear.url,
    bitrate: gear.bitrate
  }
}

/**
 * 已知汽水 `track_id` 时直接取地址（私人漫游这类「列表本来就是汽水自己的」场景）：
 * 省掉一次搜索 + 严格匹配，起播快一截。
 * `expectedDurationMS` 用来识破付费曲只给 30 秒试听的情况，传 0 表示不校验。
 */
export async function resolveQishuiByID(
  trackID: string,
  preferred?: QualityLevel,
  expectedDurationMS = 0
): Promise<ResolvedAudioSource | null> {
  if (!trackID) return null
  const gears = await fetchQishuiGears(trackID)
  const playable = gears.filter(
    (gear) =>
      gear.durationMS === undefined || expectedDurationMS <= 0 || gear.durationMS >= expectedDurationMS * 0.8
  )
  if (playable.length === 0) return null
  const gear = pickQishuiGear(playable, preferred)
  if (!gear) return null
  return {
    id: 'qishui',
    displayName: AUDIO_SOURCE_NAMES.qishui,
    url: gear.url,
    bitrate: gear.bitrate
  }
}

/**
 * 汽水这首歌能不能**完整播放**：付费曲只给一档 30 秒试听，那种不算。
 * 私人漫游用它筛选曲目——只挑汽水给全曲的歌，漫游才不会一路换源到别的平台。
 * 只做判断、不返回地址；真正播放时再取一次（地址是有时效的）。
 */
export async function qishuiHasFullTrack(trackID: string, expectedDurationMS = 0): Promise<boolean> {
  if (!trackID) return false
  const gears = await fetchQishuiGears(trackID)
  if (gears.length === 0) return false
  return gears.some(
    (gear) =>
      gear.durationMS === undefined || expectedDurationMS <= 0 || gear.durationMS >= expectedDurationMS * 0.8
  )
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
  const url = found[0]

  // 实测酷我对不少歌曲返回的是 4 秒「试听」占位文件（体积完全相同、内容
  // 是版权提示音）。换链前先探一下体积，明显装不下这首歌时直接判失败，
  // 把机会让给下一个音源，别把坏地址带进播放候选循环。
  const probe = await probeStream(url, 5_000)
  if (probe.ok && probe.totalBytes !== undefined) {
    const expectedSeconds = (track.durationMS ?? 0) / 1000
    if (expectedSeconds > 30 && probe.totalBytes < expectedSeconds * 8_000) return null
  }
  return { id: 'kuwo', displayName: AUDIO_SOURCE_NAMES.kuwo, url }
}

// ---------------------------------------------------------------------------
// QQ 音乐
// ---------------------------------------------------------------------------

const QQ_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  Referer: 'https://y.qq.com/'
}

/**
 * QQ音乐 的登录态（设置 → 音源账号里绑定，与网易云主账号互不影响）。
 * vkey 是按账号鉴权的：带上有会员的 cookie 才能拿到付费/VIP 歌的地址与 320kbps。
 */
export interface QqAuth {
  cookie: string
  uin?: string
}

export interface QqOptions {
  auth?: QqAuth
  /** 设置里的音质档位 ≥ 320kbps 时优先请求 M800。 */
  highQuality?: boolean
}

/**
 * 取地址时的档位候选（纯函数，便于单测）：
 * - 未绑定账号：只发匿名 M500（与历史行为一致）。
 * - 绑定了账号：按设置档位（320 → M800）→ M500 → 再退一次匿名 M500（cookie 过期时也不至于整条链路挂掉）。
 * - 没有 media_mid：不传 filename，服务端只给 96kbps AAC。
 */
export function qqFilenamePlan(
  mediaMid: string | undefined,
  options: { authed: boolean; highQuality?: boolean }
): Array<{ filename?: string; bitrate: number; authed: boolean }> {
  const plan: Array<{ filename?: string; bitrate: number; authed: boolean }> = []
  if (!mediaMid) {
    plan.push({ bitrate: 96, authed: options.authed })
    if (options.authed) plan.push({ bitrate: 96, authed: false })
    return plan
  }
  // 匿名拿不到 320：只有带 cookie 时才请求 M800。
  if (options.highQuality && options.authed) {
    plan.push({ filename: `M800${mediaMid}.mp3`, bitrate: 320, authed: true })
  }
  plan.push({ filename: `M500${mediaMid}.mp3`, bitrate: 128, authed: options.authed })
  if (options.authed) plan.push({ filename: `M500${mediaMid}.mp3`, bitrate: 128, authed: false })
  return plan
}

interface QqCandidate {
  mid: string
  title: string
  artist: string
  durationMS: number
}

async function searchQq(track: Track): Promise<QqCandidate[]> {
  const keyword = encodeURIComponent(searchKeyword(track))
  /*
   * 主入口用旧扁平接口 `search_for_qq_cp`：它**必须带 Referer**（否则返回
   * `{"code":0,"message":"禁止跨域访问","subcode":-10001}`），字段够用、也不会被限流。
   * `client_search_cp` 字段更全，但实测连打几十次后会对所有 UA / http(s) 一律返回
   * 500 并持续十几分钟，所以只当降级入口。
   */
  const entries = [
    `https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?w=${keyword}&format=json&p=1&n=10&flag_qc=0`,
    `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=10&w=${keyword}` +
      `&format=json&aggr=1&cr=1&flag_qc=0&platform=yqq.json&needNewCode=0`
  ]
  for (const url of entries) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, ...QQ_HEADERS },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (!response.ok) continue
      let text = await response.text()
      if (!text.trim()) continue
      if (!text.trimStart().startsWith('{')) {
        const open = text.indexOf('(')
        const close = text.lastIndexOf(')')
        if (open >= 0 && close > open) text = text.slice(open + 1, close)
      }
      const payload = JSON.parse(text)
      if (payload?.subcode === -10001 || payload?.retcode === 500) continue
      const songs: any[] = Array.isArray(payload?.data?.song?.list) ? payload.data.song.list : []
      const list: QqCandidate[] = []
      for (const song of songs) {
        // 付费歌免登录一定拿不到 purl（实测把 songtype/filename/platform/模块穷举过，purl 恒空），
        // 在这里先剔掉，省一次必然失败的请求。
        if (Number(song?.pay?.payplay ?? song?.pay?.pay_play ?? 0) === 1) continue
        const mid = String(song?.songmid ?? song?.mid ?? '')
        const title = String(song?.songname ?? song?.name ?? '')
        if (!mid || !title) continue
        list.push({
          mid,
          title,
          artist: (Array.isArray(song?.singer) ? song.singer : [])
            .map((singer: any) => singer?.name)
            .filter((name: unknown): name is string => typeof name === 'string' && name.length > 0)
            .join('/'),
          durationMS: Number(song?.interval ?? 0) * 1000
        })
      }
      if (list.length > 0) return list
    } catch {
      // 这个入口当下不可用：换下一个
    }
  }
  return []
}

/**
 * QQ 的 `media_mid` 与 `songmid` 不是同一个值：拼 filename 必须用 `media_mid`，
 * 用 `songmid` 拼出来的 purl 虽然非空，但 CDN 会返回 404。
 */
async function fetchQqMediaMid(songmid: string): Promise<string | undefined> {
  try {
    const payload = await fetchJSONWithHeaders(
      `https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=${encodeURIComponent(songmid)}` +
        `&platform=yqq&format=json`,
      QQ_HEADERS
    )
    const mid = payload?.data?.[0]?.file?.media_mid
    return typeof mid === 'string' && mid ? mid : undefined
  } catch {
    return undefined
  }
}

/**
 * QQ 音乐的播放地址：`vkey.GetVkeyServer`。
 *
 * - `guid` 必须是随机 10 位数字：`1234567890` 这个公开示例值已被服务端拉黑
 *   （`retcode=104009`、`msg="<IP>;invalidq;"`、purl 空）。
 * - 想要 128kbps 必须显式传 `filename: ['M500'+media_mid+'.mp3']`；
 *   不传 filename 时服务端只给 96kbps AAC。
 * - 未登录时付费/VIP 歌拿不到 purl，如实返回 null 交给下一个音源，不报错；
 *   带上绑定的 cookie（`QqOptions.auth`）后会员权益生效：VIP 歌有地址、可请求 M800（320kbps）。
 */
async function fetchQqAudioUrl(
  songmid: string,
  options: QqOptions = {}
): Promise<{ url: string; bitrate?: number } | null> {
  const guid = String(Math.floor(1e9 + Math.random() * 9e9))
  const mediaMid = await fetchQqMediaMid(songmid)
  const cookie = options.auth?.cookie
  const authed = Boolean(cookie)
  const uin = options.auth?.uin && options.auth.uin !== '0' ? options.auth.uin : '0'
  const plan = qqFilenamePlan(mediaMid, { authed, highQuality: options.highQuality })
  for (const step of plan) {
    const param: Record<string, unknown> = {
      guid,
      songmid: [songmid],
      songtype: [0],
      uin: step.authed ? uin : '0',
      loginflag: 1,
      platform: '20'
    }
    if (step.filename) param.filename = [step.filename]
    const data = {
      req_0: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param },
      comm: { uin: step.authed ? Number(uin) || 0 : 0, format: 'json', ct: 24, cv: 0 }
    }
    const headers =
      step.authed && cookie ? { ...QQ_HEADERS, Cookie: cookie } : QQ_HEADERS
    try {
      const payload = await fetchJSONWithHeaders(
        `https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(JSON.stringify(data))}`,
        headers
      )
      const info = payload?.req_0?.data?.midurlinfo?.[0]
      const purl = typeof info?.purl === 'string' ? info.purl : ''
      if (purl) {
        return {
          url: purl.startsWith('http') ? purl : `https://ws.stream.qqmusic.qq.com/${purl}`,
          bitrate: step.bitrate
        }
      }
    } catch {
      // 这一档没拿到（网络或鉴权）：试下一档
    }
  }
  return null
}

export async function resolveQq(
  track: Track,
  _preferred?: QualityLevel,
  options: QqOptions = {}
): Promise<ResolvedAudioSource | null> {
  const candidates = await searchQq(track)
  const match = candidates.find((candidate) => matchesTrack(track, candidate))
  if (!match) return null
  const audio = await fetchQqAudioUrl(match.mid, options)
  if (!audio) return null
  return {
    id: 'qq',
    displayName: AUDIO_SOURCE_NAMES.qq,
    url: audio.url,
    bitrate: audio.bitrate
  }
}

/**
 * 已知 songmid 时直接取地址（QQ 歌单里的曲目走这条路）：平台自己给的曲目
 * 不需要再经搜索与同名匹配，省一次请求，也避免匹配到别的版本。
 */
export async function resolveQqByMid(
  songmid: string,
  options: QqOptions = {}
): Promise<ResolvedAudioSource | null> {
  if (!songmid) return null
  const audio = await fetchQqAudioUrl(songmid, options)
  if (!audio) return null
  return {
    id: 'qq',
    displayName: AUDIO_SOURCE_NAMES.qq,
    url: audio.url,
    bitrate: audio.bitrate
  }
}

export type AudioSourceProvider = (
  track: Track,
  preferred?: QualityLevel
) => Promise<ResolvedAudioSource | null>

export const PROVIDERS: Record<AudioSourceID, AudioSourceProvider> = {
  gdstudio: resolveGdstudio,
  qishui: resolveQishui,
  kugou: resolveKugou,
  kuwo: resolveKuwo,
  qq: resolveQq
}
