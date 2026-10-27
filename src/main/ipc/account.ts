/**
 * 悠悠账号 IPC：自建登录、资料、收藏、自建歌单，以及不依赖网易云登录的每日推荐。
 *
 * 收藏的最小单位是 `YYTrackRefDTO`（source + sourceId + 展示字段），
 * 与音源解耦：网易云、汽水、酷狗、酷我、QQ 源的歌都能收。
 */
import { defineHandler } from './registry.js'
import { httpsCover, mappingContextFrom, toTracksDTO } from './mappers.js'
import { SearchType } from '../netease/api.js'
import type { Track } from '../netease/models.js'
import type { AppContext } from '../context.js'
import type { TrackDTO, YYTrackRefDTO } from '@shared/types'

/** 服务端的每日推荐（按北京时间日期做种子，返回歌名 + 歌手）。 */
const DAILY_URL = 'https://yy.ytw.asia/player-api/daily?limit=20'
const APP_KEY = 'b9ae8468c1c32ab0e1aa0223807791ef'
const DAILY_CACHE_MS = 30 * 60 * 1000

/** 去掉括号注释与标点，只留字母数字，用于歌名/歌手的严格比较。 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[（(【[].*?[)）】\]]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * 「歌名 + 歌手」→ 网易云曲目。
 *
 * 每日推荐只给名字，要在网易云里找同一首；匹配宁缺毋滥：
 * 歌名归一化后必须相等（或互相包含），歌手能对上再加分。
 */
async function resolveSong(
  context: AppContext,
  name: string,
  artist: string
): Promise<Track | undefined> {
  const result = await context.api.search(name, SearchType.songs, 12)
  const target = normalise(name)
  if (!target) return undefined
  const wantedArtist = normalise(artist)
  let best: { track: Track; score: number } | undefined
  for (const track of result.songs ?? []) {
    const title = normalise(track.name)
    if (!title) continue
    let score = 0
    if (title === target) score += 10
    else if (title.includes(target) || target.includes(title)) score += 4
    else continue
    const artists = (track.artists ?? []).map((item) => normalise(item.name)).join('/')
    if (wantedArtist && artists.includes(wantedArtist)) score += 8
    if (!best || score > best.score) best = { track, score }
  }
  return best?.track
}

let dailyCache: { at: number; tracks: TrackDTO[] } | undefined

export function registerAccountHandlers(context: AppContext): void {
  const account = context.youyouAccount

  defineHandler('account:state', async () => account.state())

  defineHandler('account:sync', async ({ revision }) => account.sync(revision))

  defineHandler('account:requestCode', async ({ email }) => {
    const trimmed = email.trim()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) throw new Error('邮箱格式不对')
    return account.requestCode(trimmed)
  })

  defineHandler('account:verify', async ({ email, code }) => {
    const trimmed = code.trim()
    if (!/^\d{4,8}$/.test(trimmed)) throw new Error('验证码是 6 位数字')
    return account.verify(email.trim(), trimmed)
  })

  defineHandler('account:updateProfile', async ({ nickname }) => account.updateProfile(nickname))

  defineHandler('account:uploadAvatar', async ({ image }) => {
    if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(image)) throw new Error('只支持 png / jpeg / webp 图片')
    if (image.length > 900_000) throw new Error('图片太大了，换一张小一点的')
    return account.uploadAvatar(image)
  })

  defineHandler('account:logout', async () => {
    await account.logout()
  })

  defineHandler('account:favorite', async ({ track, like }) => account.toggleFavorite(track, like))

  defineHandler('account:playlistDetail', async ({ id }) => account.playlistDetail(id))
  defineHandler('account:playlistCreate', async ({ name }) => account.playlistCreate(name.trim()))
  defineHandler('account:playlistRename', async ({ id, name }) => account.playlistRename(id, name.trim()))
  defineHandler('account:playlistDelete', async ({ id }) => account.playlistDelete(id))
  defineHandler('account:playlistAdd', async ({ id, tracks }) => account.playlistAdd(id, tracks))
  defineHandler('account:playlistRemove', async ({ id, tracks }) => account.playlistRemove(id, tracks))

  /**
   * 当前播放曲目的「收藏引用」。
   *
   * 站外曲目在队列里带 `external`（source + sourceId），网易云曲目用 id；
   * 收藏 / 加歌单都靠它拿到正确的来源，不会把负 id 当成网易云 id 发出去。
   */
  defineHandler('account:currentTrack', async (): Promise<YYTrackRefDTO | undefined> => {
    const external = context.player.currentExternal()
    if (external) {
      return {
        key: `${external.source}:${external.sourceId}`,
        source: external.source,
        sourceId: external.sourceId,
        name: external.name,
        artist: external.artists,
        album: external.album,
        cover: httpsCover(external.coverUrl),
        durationMs: external.durationMS
      }
    }
    const track = context.player.snapshot().track
    if (!track) return undefined
    return {
      key: `netease:${track.id}`,
      source: 'netease',
      sourceId: String(track.id),
      name: track.name,
      artist: track.artists.map((item) => item.name).join('/'),
      album: track.album.name,
      cover: httpsCover(track.album.picUrl),
      durationMs: track.durationMS
    }
  })

  defineHandler('account:daily', async (): Promise<TrackDTO[]> => {
    if (dailyCache && Date.now() - dailyCache.at < DAILY_CACHE_MS) return dailyCache.tracks
    const response = await fetch(DAILY_URL, {
      headers: { 'x-yy-app': APP_KEY, accept: 'application/json' }
    })
    if (!response.ok) throw new Error(`每日推荐暂时不可用（${response.status}）`)
    const payload = (await response.json()) as { songs?: Array<{ name?: string; artist?: string }> }
    const wanted = (payload.songs ?? [])
      .map((item) => ({ name: String(item.name ?? ''), artist: String(item.artist ?? '') }))
      .filter((item) => item.name)
    if (wanted.length === 0) return []

    const resolved: Track[] = []
    const seen = new Set<number>()
    const queue = [...wanted]
    // 4 路并发：20 首歌每首一次搜索，串行会让每日推荐等半分钟。
    const workers = Array.from({ length: 4 }, async () => {
      for (;;) {
        const item = queue.shift()
        if (!item) return
        try {
          const track = await resolveSong(context, item.name, item.artist)
          if (!track || seen.has(track.id)) continue
          seen.add(track.id)
          resolved.push(track)
        } catch (cause) {
          context.log(`每日推荐解析失败（${item.name}）：${String(cause)}`)
        }
      }
    })
    await Promise.all(workers)
    const tracks = toTracksDTO(resolved.slice(0, 20), mappingContextFrom(context))
    dailyCache = { at: Date.now(), tracks }
    return tracks
  })

  // 封面兜底：汽水/抖音的封面链接会过期（实测 400），用歌名 + 歌手在网易云重新找一张。
  const coverCache = new Map<string, string | undefined>()

  defineHandler('account:cover', async ({ name, artist }): Promise<{ cover?: string }> => {
    const key = `${name} ${artist}`.trim()
    if (!key) return {}
    if (coverCache.has(key)) return { cover: coverCache.get(key) }
    let cover: string | undefined
    try {
      const track = await resolveSong(context, name.trim(), artist.trim())
      cover = httpsCover(track?.album?.picUrl)
    } catch (cause) {
      context.log(`封面兜底失败（${key}）：${String(cause)}`)
    }
    if (coverCache.size > 300) coverCache.clear()
    coverCache.set(key, cover)
    return { cover }
  })
}
