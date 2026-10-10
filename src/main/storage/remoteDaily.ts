/**
 * 每日推荐历史的服务器同步（悠悠音乐自己的跨设备逻辑）。
 *
 * 服务器在 /www/wwwroot/YYyinyue（一起听中继）里按 uid 分文件存每天的日推歌单，
 * 客户端每次取到今日日推就上报一份；点「昨天/前天」先问服务器，再回本地快照。
 * 只要登录了悠悠音乐账号，换设备、重装、退出再登录都能同步回历史推荐。
 *
 * 注意：这些请求全部在主进程发起（Node 全局 fetch），不经过渲染层，也不受 CSP 限制。
 */
import type { TrackDTO } from '@shared/types'

/** 服务器 HTTP 入口：nginx 把 /relay 反代到中继进程（8787 端口）。 */
export const REMOTE_DAILY_BASE = 'https://yy.ytw.asia/relay'
/** 与一起听 WebSocket 一致的连接口令（服务器 RELAY_TOKEN）。 */
export const REMOTE_DAILY_TOKEN = 'yy-7f3a9c2e51d84b06'

const TIMEOUT_MS = 8000

/** 已知的登录 uid 缓存：登录/登出时由 auth 流程写入，避免每次点历史日期都打一次网易云接口。 */
let knownUID: number | undefined
// 真机测试钩子：YOYOU_FORCE_UID=1686312334 直接指定登录 uid，跳过「先问网易云接口」的
// 环节（账号限流时 userAccount() 可能空响应，测试会因此不可复现）。
const forcedUID = process.env.YOYOU_FORCE_UID
if (forcedUID && /^\d{1,12}$/.test(forcedUID)) {
  knownUID = Number(forcedUID)
}
export function setKnownUID(uid: number | undefined): void {
  knownUID = uid
}
export function getKnownUID(): number | undefined {
  return knownUID
}

function buildURL(path: string, uid: number | string, date: string): string {
  return `${REMOTE_DAILY_BASE}/${path}?token=${encodeURIComponent(REMOTE_DAILY_TOKEN)}&uid=${encodeURIComponent(String(uid))}&date=${encodeURIComponent(date)}`
}

/** 上报某天的日推歌单；失败（离线/服务器异常）返回 false，不抛。 */
export async function saveRemoteDaily(uid: number | string, date: string, tracks: TrackDTO[]): Promise<boolean> {
  try {
    const response = await fetch(buildURL('daily/save', uid, date), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!response.ok) return false
    const payload = (await response.json()) as { ok?: boolean }
    return payload?.ok === true
  } catch {
    return false
  }
}

/** 拉取某天的历史日推；没有记录或任何失败都返回 null（调用方回退本地）。 */
export async function fetchRemoteDaily(uid: number | string, date: string): Promise<TrackDTO[] | null> {
  try {
    const response = await fetch(buildURL('daily', uid, date), { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!response.ok) return null
    const payload = (await response.json()) as { ok?: boolean; tracks?: unknown }
    if (payload?.ok !== true || !Array.isArray(payload.tracks) || payload.tracks.length === 0) return null
    const tracks = payload.tracks.map(normalizeTrack).filter((item): item is TrackDTO => item !== null)
    return tracks.length > 0 ? tracks : null
  } catch {
    return null
  }
}

/**
 * 把服务器存的一条记录补齐成完整 TrackDTO。
 * 服务器为了省空间只存 {id,name,artists,album,durationMS} 这几个核心字段，
 * 渲染层会读 alias/transNames/fee 等字段，缺了会整页崩，所以这里一律补默认值。
 */
function normalizeTrack(item: unknown): TrackDTO | null {
  if (!item || typeof item !== 'object') return null
  const raw = item as Record<string, unknown>
  if (typeof raw.id !== 'number' || typeof raw.name !== 'string' || raw.name.length === 0) return null
  const artists = Array.isArray(raw.artists) ? (raw.artists as TrackDTO['artists']) : []
  const albumRaw = raw.album && typeof raw.album === 'object' ? (raw.album as Record<string, unknown>) : {}
  const album: TrackDTO['album'] = {
    id: typeof albumRaw.id === 'number' ? albumRaw.id : 0,
    name: typeof albumRaw.name === 'string' ? albumRaw.name : ''
  }
  if (typeof albumRaw.picUrl === 'string' && albumRaw.picUrl.length > 0) album.picUrl = albumRaw.picUrl
  const PLAYABILITY: readonly TrackDTO['playability'][] = ['playable', 'vipOnly', 'paidAlbum', 'noCopyright', 'delisted']
  const playability = PLAYABILITY.includes(raw.playability as TrackDTO['playability'])
    ? (raw.playability as TrackDTO['playability'])
    : 'playable'
  return {
    id: raw.id,
    name: raw.name,
    artists,
    album,
    durationMS: typeof raw.durationMS === 'number' ? raw.durationMS : 0,
    alias: Array.isArray(raw.alias) ? (raw.alias as string[]) : [],
    transNames: Array.isArray(raw.transNames) ? (raw.transNames as string[]) : [],
    fee: typeof raw.fee === 'number' ? raw.fee : 0,
    mvID: typeof raw.mvID === 'number' ? raw.mvID : 0,
    noCopyright: raw.noCopyright === true,
    isCloud: raw.isCloud === true,
    playability,
    ...(typeof raw.playabilityReason === 'string' ? { playabilityReason: raw.playabilityReason } : {})
  }
}

/** 带超时的 promise：登录态下取 uid 不应拖垮历史日期点击。 */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('超时')), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
