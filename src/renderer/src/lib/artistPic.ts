/**
 * 歌手头像：取一次、缓存一份，并在切歌时提前取好。
 *
 * 网易云歌曲级的 `ar`/`artists[]` 对象多数不带头像（实测搜索 / 热歌 / 日推里
 * 0 首带），所以播放详情页的头像只能按歌手 id 再打一次 `artist:detail`。
 * 底部播放条用的是专辑封面（曲目里就有），于是会出现「下面有图、详情页头像半天
 * 才出来」的观感 —— 根本原因是这个网络请求发生在用户点进详情页之后。
 *
 * 这里把它前移：切歌时（App 外壳）就预取并顺手把详情页要用的 96px 图下好，
 * 用户点进详情页时头像已经在缓存里。
 */
import { useEffect, useState } from 'react'
import { coverUrl } from './format'
import { call } from './ipc'

/** `undefined` 也是一条有效结果（该歌手确实没有头像），切歌不重复请求。 */
const cache = new Map<number, string | undefined>()
/** 同一歌手的请求只发一次：预热与页面渲染共用同一个 Promise。 */
const inflight = new Map<number, Promise<string | undefined>>()

/** 详情页头像用的尺寸，与 NowPlaying.tsx 里 `coverUrl(artistPic, 96)` 保持一致。 */
const DETAIL_ART_SIZE = 96

function fetchArtistPic(artistID: number): Promise<string | undefined> {
  const ongoing = inflight.get(artistID)
  if (ongoing) return ongoing
  const task = call('artist:detail', { id: artistID })
    .then((detail) => detail.artist?.picUrl)
    .catch(() => undefined)
    .then((pic) => {
      cache.set(artistID, pic)
      inflight.delete(artistID)
      return pic
    })
  inflight.set(artistID, task)
  return task
}

/**
 * 切歌时预取歌手头像。曲目自带 `inline` 头像时无需请求；
 * 拿到 URL 后顺手把详情页那张小图也塞进浏览器缓存。
 */
export function usePrefetchArtistPic(artistID: number | undefined, inline: string | undefined): void {
  useEffect(() => {
    if (!artistID || inline || cache.has(artistID)) return
    void fetchArtistPic(artistID).then((pic) => {
      const url = coverUrl(pic, DETAIL_ART_SIZE)
      if (!url) return
      const image = new Image()
      image.src = url
    })
  }, [artistID, inline])
}

/**
 * 歌手头像 URL：曲目自带的 `artists[0].picUrl` 优先，缺席时用按 id 取回并缓存的结果。
 * 两条路都拿不到（或图片加载失败）时返回 undefined，由调用方退回占位，不破图。
 */
export function useArtistPic(artistID: number | undefined, inline: string | undefined): string | undefined {
  const [resolved, setResolved] = useState<string | undefined>(() =>
    artistID ? cache.get(artistID) : undefined
  )

  useEffect(() => {
    if (!artistID || inline) {
      setResolved(undefined)
      return
    }
    if (cache.has(artistID)) {
      setResolved(cache.get(artistID))
      return
    }
    let cancelled = false
    setResolved(undefined)
    void fetchArtistPic(artistID).then((pic) => {
      if (!cancelled) setResolved(pic)
    })
    return () => {
      cancelled = true
    }
  }, [artistID, inline])

  return inline ?? resolved
}
