/**
 * 每日推荐历史（服务器端持久化，零依赖）。
 *
 * 悠悠音乐自己的逻辑：客户端每天取到「每日推荐」后把歌单上报到这里，
 * 按用户 uid 分文件保存。用户无论换设备还是重新登录，只要登录了账号，
 * 点击「昨天/前天/近 7 天」任意日期都能同步到当时推荐过的歌。
 *
 * 数据目录：data/daily-history/<uid>.json
 * 文件结构：{ dates: { "YYYY-MM-DD": [TrackDTO, ...] } }
 * 保留策略：每个账号最近 14 天；每天最多 60 首。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
export const dailyDir = path.join(root, 'data', 'daily-history')

/** 每个账号保留最近 N 天。 */
const MAX_DAYS = 14
/** 每天最多保存多少首（接口返回通常 30 首，留足余量）。 */
const MAX_TRACKS_PER_DAY = 60

const UID_RE = /^\d{1,12}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

mkdirSync(dailyDir, { recursive: true })

function dailyFile(uid) {
  return path.join(dailyDir, `${uid}.json`)
}

/** 读取某账号的全部历史（文件不存在或损坏都返回空映射）。 */
function loadDates(uid) {
  try {
    if (!existsSync(dailyFile(uid))) return {}
    const parsed = JSON.parse(readFileSync(dailyFile(uid), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !parsed.dates || typeof parsed.dates !== 'object') return {}
    const out = {}
    for (const [date, tracks] of Object.entries(parsed.dates)) {
      if (!DATE_RE.test(date)) continue
      if (!Array.isArray(tracks)) continue
      out[date] = tracks.slice(0, MAX_TRACKS_PER_DAY)
    }
    return out
  } catch {
    return {}
  }
}

/** 校验单曲：必须有数字 id 与字符串歌名，其余字段不强求。 */
function sanitiseTrack(track) {
  if (!track || typeof track !== 'object') return null
  if (typeof track.id !== 'number' || !Number.isFinite(track.id)) return null
  if (typeof track.name !== 'string' || track.name.length === 0) return null
  const out = { id: track.id, name: track.name.slice(0, 200) }
  if (Array.isArray(track.artists)) out.artists = track.artists.slice(0, 16)
  if (track.album && typeof track.album === 'object') out.album = track.album
  else if (typeof track.album === 'string') out.album = { name: track.album.slice(0, 200) }
  if (typeof track.durationMS === 'number') out.durationMS = track.durationMS
  return out
}

/** 校验并裁剪 tracks：非法项剔除、超长截断；返回 null 表示整体非法。 */
export function sanitiseTracks(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0 || tracks.length > MAX_TRACKS_PER_DAY * 2) return null
  const out = []
  for (const track of tracks) {
    const ok = sanitiseTrack(track)
    if (ok) out.push(ok)
  }
  if (out.length === 0) return null
  return out.slice(0, MAX_TRACKS_PER_DAY)
}

/** 覆盖保存某天记录，并裁剪到最近 MAX_DAYS 天。返回保存的日期键列表。 */
export function saveDaily(uid, date, tracks) {
  const dates = loadDates(uid)
  dates[date] = tracks
  const keys = Object.keys(dates).sort().slice(-MAX_DAYS)
  const pruned = {}
  for (const key of keys) pruned[key] = dates[key]
  writeFileSync(dailyFile(uid), JSON.stringify({ dates: pruned }), 'utf8')
  return pruned
}

/** 读取某天记录；没有则返回空数组。 */
export function getDaily(uid, date) {
  const dates = loadDates(uid)
  return Array.isArray(dates[date]) ? dates[date] : []
}

/** 删除某个账号的全部历史（账号注销/清数据时用）。 */
export function clearDaily(uid) {
  try {
    if (existsSync(dailyFile(uid))) unlinkSync(dailyFile(uid))
    return true
  } catch {
    return false
  }
}

/**
 * 从 HTTP 请求参数里解析 token / uid / date。
 * 返回 { error } 或 { uid, date, searchParams }。
 */
export function parseDailyRequest(url, headers) {
  let searchParams
  try {
    searchParams = new URL(url ?? '/', 'http://localhost').searchParams
  } catch {
    return { error: '无效的请求地址' }
  }
  return { uid: searchParams.get('uid'), date: searchParams.get('date'), searchParams }
}

export function validUid(uid) {
  return typeof uid === 'string' && UID_RE.test(uid)
}

export function validDate(date) {
  return typeof date === 'string' && DATE_RE.test(date)
}
