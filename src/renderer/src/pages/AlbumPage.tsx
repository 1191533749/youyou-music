/**
 * 专辑详情。
 *
 * 数据走 IPC：album:detail（album/description/company/songs）、
 * library:subscribeAlbum 收藏、library:overview 判断当前是否已收藏，
 * 因为 AlbumSummaryDTO 本身不带 subscribed 字段。
 *
 * 专辑里没有 artist.id（DTO 只给了 artistName），歌手入口只能从曲目的
 * artists[0] 反推；推不出来时不渲染跳转按钮，避免点进一个空页面。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { TrackDTO } from '@shared/types'
import {
  call,
  tryCall,
  IPCError,
  SongList,
  coverUrl,
  formatDate,
  formatLongDuration,
  useAuthStore,
  useNavigation,
  usePlayerStore
} from '../lib/contract'
import { useAsync } from '../lib/hooks'
import ContextMenu, { type ContextMenuItem } from '../components/ContextMenu'
import Dialog from '../components/Dialog'
import { useToast, type ToastKind } from '../components/Toast'
import { IconCheck, IconMore, IconMusic, IconPlay, IconPlus } from '../components/Icons'

export default function AlbumPage({ id }: { id: number }): JSX.Element {
  // 换专辑时重建实例，否则会短暂显示上一张专辑的封面与曲目。
  return <AlbumDetail key={id} id={id} />
}

function AlbumDetail({ id }: { id: number }): JSX.Element {
  const navigation = useNavigation()
  const player = usePlayerStore()
  const auth = useAuthStore()
  const { show: showToast, node: toastNode } = useToast()

  const [liked, setLiked] = useState<number[]>([])
  const [subscribed, setSubscribed] = useState<boolean>()
  const [menuAt, setMenuAt] = useState<{ x: number; y: number }>()
  const [descOpen, setDescOpen] = useState(false)

  const notify = useCallback(
    (message: string, kind: ToastKind = 'info') => showToast(message, kind),
    [showToast]
  )

  const { data: detail, loading, error, reload } = useAsync(() => call('album:detail', { id }), [id])

  useEffect(() => {
    // 红心与收藏状态都来自「我的音乐」概览：两个详情接口都不带这两个标记。
    // 未登录时取不到，界面按「未收藏」显示即可，不打扰用户。
    void tryCall('library:overview').then((overview) => {
      if (!overview) return
      setLiked(overview.likedTrackIDs)
      setSubscribed(overview.albums.some((album) => album.id === id))
    })
  }, [id])

  const songs = detail?.songs ?? []
  const likedIDs = useMemo(() => new Set(liked), [liked])
  const artistID = songs[0]?.artists[0]?.id
  const isSubscribed = subscribed ?? false
  const totalSeconds = useMemo(
    () => songs.reduce((sum, track) => sum + track.durationMS, 0) / 1000,
    [songs]
  )

  const playAll = useCallback(() => {
    if (songs.length === 0) return
    const firstPlayable = songs.findIndex((track) => track.playability === 'playable')
    // 整表播放入口带 randomStart：由主进程随机起播（点具体某一行时不带）。
    // store 的 playTracks 只转发 startIndex，这里直接调通道；状态靠 player:state 广播同步。
    void call('player:playTracks', {
      tracks: songs,
      startIndex: firstPlayable < 0 ? 0 : firstPlayable,
      randomStart: true
    })
  }, [songs])

  const appendAll = useCallback(() => {
    if (songs.length === 0) return
    void player.append(songs)
    notify(`已加入播放队列（${songs.length} 首）`, 'success')
  }, [notify, player, songs])

  const toggleSubscribe = useCallback(async () => {
    const next = !isSubscribed
    try {
      await call('library:subscribeAlbum', { id, subscribe: next })
      setSubscribed(next)
      notify(next ? '已收藏专辑' : '已取消收藏', 'success')
    } catch (cause) {
      notify(errorText(cause), 'error')
    }
  }, [id, isSubscribed, notify])

  const toggleLike = useCallback(
    async (track: TrackDTO) => {
      const next = !likedIDs.has(track.id)
      try {
        await call('library:likeTrack', { id: track.id, like: next })
        setLiked((current) =>
          next ? [...current, track.id] : current.filter((value) => value !== track.id)
        )
        notify(next ? '已加入我喜欢的音乐' : '已取消喜欢', 'success')
      } catch (cause) {
        notify(errorText(cause), 'error')
      }
    },
    [likedIDs, notify]
  )

  const openArtist = useCallback(() => {
    if (artistID === undefined) return
    navigation.push({ name: 'artist', id: artistID, title: detail?.album.artistName })
  }, [artistID, detail, navigation])

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    const items: ContextMenuItem[] = [
      { label: '播放全部', disabled: songs.length === 0, onSelect: playAll },
      { label: '加入播放队列', disabled: songs.length === 0, onSelect: appendAll }
    ]
    if (auth.loggedIn) {
      items.push({
        label: isSubscribed ? '取消收藏专辑' : '收藏专辑',
        onSelect: () => void toggleSubscribe()
      })
    }
    if (artistID !== undefined) items.push({ label: '查看歌手', onSelect: openArtist })
    items.push({ label: '刷新', onSelect: reload })
    return items
  }, [appendAll, artistID, auth.loggedIn, isSubscribed, openArtist, playAll, reload, songs.length, toggleSubscribe])

  if (!detail) {
    return (
      <div className="page">
        {loading ? (
          <DetailSkeleton />
        ) : (
          <div className="page__error">
            <div>{error ?? '没有找到这张专辑'}</div>
            <button type="button" className="button detail-status__action" onClick={reload}>
              重试
            </button>
          </div>
        )}
      </div>
    )
  }

  const { album } = detail
  const description = detail.description?.trim()
  const kicker = album.subType?.trim() || '专辑'

  return (
    <div className="page">
      {error ? (
        <div className="page__error">
          <div>{error}</div>
          <button type="button" className="button detail-status__action" onClick={reload}>
            重试
          </button>
        </div>
      ) : null}

      <section
        className="hero"
        onContextMenu={(event) => {
          event.preventDefault()
          setMenuAt({ x: event.clientX, y: event.clientY })
        }}
      >
        <div className="hero__art">
          <RemoteImage
            src={coverUrl(album.picUrl, 512)}
            alt=""
            fallback={
              <span className="card__placeholder">
                <IconMusic size={26} />
              </span>
            }
          />
        </div>

        <div className="hero__body">
          <div className="detail-kicker">{kicker}</div>
          <h1 className="hero__title">{album.name}</h1>

          <div className="hero__meta">
            <div>
              {artistID !== undefined ? (
                <button type="button" className="detail-link" onClick={openArtist}>
                  {album.artistName}
                </button>
              ) : (
                album.artistName
              )}
              {album.alias.length > 0 ? <span className="detail-sub"> · {album.alias.join(' / ')}</span> : null}
            </div>
            <div>
              {songs.length} 首 · {formatLongDuration(totalSeconds)}
              {album.publishTime ? ` · 发行于 ${formatDate(album.publishTime)}` : ''}
              {detail.company ? ` · ${detail.company}` : ''}
            </div>
            {album.size > 0 && songs.length !== album.size ? (
              <div className="detail-sub">专辑共收录 {album.size} 首，当前可见 {songs.length} 首</div>
            ) : null}
          </div>

          {description ? (
            <button type="button" className="detail-desc" title="查看完整专辑介绍" onClick={() => setDescOpen(true)}>
              <span className="detail-desc__text">{description.replace(/\n+/g, ' ')}</span>
              <span className="detail-desc__more">展开</span>
            </button>
          ) : null}

          <div className="hero__actions">
            <button
              type="button"
              className="button button--primary detail-btn"
              disabled={songs.length === 0}
              onClick={playAll}
            >
              <IconPlay size={16} />
              播放全部{songs.length > 0 ? ` (${songs.length})` : ''}
            </button>
            {auth.loggedIn ? (
              <button type="button" className="button detail-btn" onClick={() => void toggleSubscribe()}>
                {isSubscribed ? <IconCheck size={16} /> : <IconPlus size={16} />}
                {isSubscribed ? '已收藏' : '收藏专辑'}
              </button>
            ) : null}
            <button
              type="button"
              className="button detail-btn"
              aria-label="更多操作"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                setMenuAt({ x: rect.left, y: rect.bottom + 4 })
              }}
            >
              <IconMore size={16} />
              更多
            </button>
          </div>
        </div>
      </section>

      <section className="detail-section detail-panel">
        <div className="section__header">
          <h2 className="section__title">曲目</h2>
          <span className="section__more">{songs.length} 首</span>
        </div>

        {songs.length === 0 ? (
          <div className="page__empty">这张专辑还没有曲目</div>
        ) : (
          <SongList
            tracks={songs}
            onPlay={(index) => void player.playTracks(songs, index)}
            currentTrackID={player.current?.id}
            // 专辑页里每一行的专辑列都是同一个名字，去掉更省横向空间。
            showAlbum={false}
            likedTrackIDs={likedIDs}
            onToggleLike={auth.loggedIn ? (track) => void toggleLike(track) : undefined}
            emptyMessage="这张专辑还没有曲目"
          />
        )}
      </section>

      <Dialog
        title="专辑介绍"
        open={descOpen}
        onClose={() => setDescOpen(false)}
        footer={
          <button type="button" className="button button--primary" onClick={() => setDescOpen(false)}>
            关闭
          </button>
        }
      >
        <div className="detail-dialog-text">{description}</div>
      </Dialog>

      {menuAt ? (
        <ContextMenu x={menuAt.x} y={menuAt.y} items={menuItems} onClose={() => setMenuAt(undefined)} />
      ) : null}

      {toastNode}
    </div>
  )
}

/** 加载骨架：占位与最终布局同尺寸，避免加载完成时整页跳动。 */
function DetailSkeleton(): JSX.Element {
  return (
    <>
      <div className="hero">
        <div className="hero__art skeleton" />
        <div className="hero__body detail-skeleton">
          <div className="skeleton" style={{ width: 56, height: 12 }} />
          <div className="skeleton" style={{ width: 260, height: 26 }} />
          <div className="skeleton" style={{ width: 200, height: 12 }} />
          <div className="skeleton" style={{ width: 300, height: 34, marginTop: 12 }} />
        </div>
      </div>
      <div className="detail-skeleton-rows">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="skeleton detail-skeleton__row" />
        ))}
      </div>
    </>
  )
}

/**
 * 远程图片：没有地址或加载失败时退回占位内容，避免出现浏览器默认的破图图标。
 *
 * 与 PlaylistPage 里的同名组件是一份轻量副本：三个页面各自独立，不跨页 import，
 * 免得一页的改动牵连到另一页。
 */
function RemoteImage({
  src,
  alt,
  fallback
}: {
  src?: string
  alt: string
  fallback: ReactNode
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  // 网易云 CDN 对 http 资源会 301 到 https，渲染进程在混合内容策略下可能直接拦掉。
  const url = src?.replace(/^http:\/\//, 'https://')

  useEffect(() => {
    setFailed(false)
  }, [url])

  if (!url || failed) return <>{fallback}</>
  return <img src={url} alt={alt} onError={() => setFailed(true)} />
}

/** IPC 抛出的错误已经带有面向用户的中文消息，这里只兜底非 Error 的情况。 */
function errorText(cause: unknown): string {
  if (cause instanceof IPCError && cause.needsLogin) return '需要登录后才能操作'
  return cause instanceof Error ? cause.message : String(cause)
}
