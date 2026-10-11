/**
 * 歌手详情：热门单曲、专辑/EP 分页、相似歌手、关注。
 *
 * 数据走 IPC：artist:detail、artist:albums（分页）、artist:similar、
 * library:subscribeArtist。
 *
 * 关于 key：usePaged 的分页游标是在首次渲染时捕获 loadPage 的，而路由切换
 * 会复用同一个组件实例，所以外层用 key={id} 强制重建，换歌手时游标才不会串。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AlbumSummaryDTO, ArtistSummaryDTO, ExternalTrackDTO, TrackDTO } from '@shared/types'
import FishAvatar, { useImageReady } from '../components/FishAvatar'
import {
  call,
  tryCall,
  IPCError,
  ArtCard,
  SongList,
  coverUrl,
  formatDate,
  useAuthStore,
  useNavigation,
  usePlayerStore
} from '../lib/contract'
import { useAsync, usePaged } from '../lib/hooks'
import { applyLikeOverrides, clearLikeOverride, markLike } from '../lib/likes'
import ContextMenu, { type ContextMenuItem } from '../components/ContextMenu'
import Dialog from '../components/Dialog'
import ExternalRows from '../components/ExternalRows'
import { useToast, type ToastKind } from '../components/Toast'
import { IconCheck, IconMore, IconMusic, IconPlay, IconPlus } from '../components/Icons'

export default function ArtistPage({ id }: { id: number }): JSX.Element {
  return <ArtistDetail key={id} id={id} />
}

function ArtistDetail({ id }: { id: number }): JSX.Element {
  const navigation = useNavigation()
  const player = usePlayerStore()
  const auth = useAuthStore()
  const { show: showToast, node: toastNode } = useToast()

  const [liked, setLiked] = useState<number[]>([])
  const [similar, setSimilar] = useState<ArtistSummaryDTO[]>([])
  const [followed, setFollowed] = useState<boolean>()
  const [menuAt, setMenuAt] = useState<{ x: number; y: number }>()
  const [descOpen, setDescOpen] = useState(false)

  const notify = useCallback(
    (message: string, kind: ToastKind = 'info') => showToast(message, kind),
    [showToast]
  )

  const { data: detail, loading, error, reload } = useAsync(() => call('artist:detail', { id }), [id])

  const albums = usePaged<AlbumSummaryDTO>(
    (offset, limit) =>
      call('artist:albums', { id, limit, offset }).then((page) => ({ items: page.items, more: page.more })),
    [id],
    24
  )

  useEffect(() => {
    void tryCall('library:overview').then((overview) => setLiked(overview?.likedTrackIDs ?? []))
  }, [])

  useEffect(() => {
    // 相似歌手是「锦上添花」的数据，接口失败（例如未登录）时留空即可。
    let cancelled = false
    void tryCall('artist:similar', { id }).then((items) => {
      if (!cancelled) setSimilar(items ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [id])

  const hotSongs = detail?.hotSongs ?? []
  // 汽水音乐里该歌手的可播版本（主进程已过滤掉只有 30 秒试听的），与热门歌并排展示。
  const external = detail?.external ?? []
  // 渲染用的集合要套一层本地覆盖：overview 刷新可能还是旧数据，不能盖掉刚点的喜欢。
  const likedIDs = useMemo(() => applyLikeOverrides(liked), [liked])
  const artist = detail?.artist
  // 歌手头像：地址为空 / 加载中 / 加载失败时先顶一张小鱼，图一到立刻换真图。
  const artistArt = coverUrl(artist?.picUrl, 512)
  const artistArtReady = useImageReady(artistArt)
  const isFollowed = followed ?? artist?.followed ?? false
  const discography = useMemo(() => albums.items.filter((album) => album.size > 1), [albums.items])
  const epsAndSingles = useMemo(() => albums.items.filter((album) => album.size <= 1), [albums.items])

  const playHot = useCallback(() => {
    if (hotSongs.length === 0) return
    const firstPlayable = hotSongs.findIndex((track) => track.playability === 'playable')
    // 整表播放入口带 randomStart：由主进程随机起播（点具体某一行时不带）。
    // store 的 playTracks 只转发 startIndex，这里直接调通道；状态靠 player:state 广播同步。
    void call('player:playTracks', {
      tracks: hotSongs,
      startIndex: firstPlayable < 0 ? 0 : firstPlayable,
      randomStart: true
    })
  }, [hotSongs])

  const appendHot = useCallback(() => {
    if (hotSongs.length === 0) return
    void player.append(hotSongs)
    notify(`已加入播放队列（${hotSongs.length} 首）`, 'success')
  }, [hotSongs, notify, player])

  /**
   * 点播站外曲目：主进程会严格匹配到完整音频，匹配不到直接抛错。
   * 同一时刻只允许一条在途，避免连点排出一串播放请求。
   */
  const [playingKey, setPlayingKey] = useState<string | undefined>()
  const playExternal = useCallback(
    async (item: ExternalTrackDTO): Promise<void> => {
      const key = `${item.source}:${item.sourceId}`
      if (playingKey) return
      setPlayingKey(key)
      try {
        await call('player:playExternal', { item })
        notify(`正在播放：${item.name}${item.artists ? ` - ${item.artists}` : ''}`, 'success')
      } catch (cause) {
        notify(cause instanceof Error ? cause.message : '播放失败，换一首试试', 'error')
      } finally {
        setPlayingKey(undefined)
      }
    },
    [playingKey, notify]
  )

  const toggleFollow = useCallback(async () => {
    const next = !isFollowed
    try {
      await call('library:subscribeArtist', { id, subscribe: next })
      setFollowed(next)
      notify(next ? '已关注歌手' : '已取消关注', 'success')
    } catch (cause) {
      notify(errorText(cause), 'error')
    }
  }, [id, isFollowed, notify])

  const toggleLike = useCallback(
    async (track: TrackDTO) => {
      const next = !likedIDs.has(track.id)
      // 先记下乐观结果：随后的任何刷新在 TTL 内都不会改变这一颗心。
      markLike(track.id, next)
      try {
        await call('library:likeTrack', { id: track.id, like: next })
        setLiked((current) =>
          next ? [...current, track.id] : current.filter((value) => value !== track.id)
        )
        notify(next ? '已加入我喜欢的音乐' : '已取消喜欢', 'success')
      } catch (cause) {
        // 失败就撤销覆盖，立刻回到服务器状态。
        clearLikeOverride(track.id)
        notify(errorText(cause), 'error')
      }
    },
    [likedIDs, notify]
  )

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    const items: ContextMenuItem[] = [
      { label: '播放热门单曲', disabled: hotSongs.length === 0, onSelect: playHot },
      { label: '加入播放队列', disabled: hotSongs.length === 0, onSelect: appendHot }
    ]
    if (auth.loggedIn) {
      items.push({ label: isFollowed ? '取消关注' : '关注歌手', onSelect: () => void toggleFollow() })
    }
    if (artist?.briefDesc) items.push({ label: '查看歌手简介', onSelect: () => setDescOpen(true) })
    items.push({ label: '刷新', onSelect: reload })
    return items
  }, [appendHot, artist, auth.loggedIn, isFollowed, playHot, reload, hotSongs.length, toggleFollow])

  if (!detail || !artist) {
    return (
      <div className="page">
        {loading ? (
          <DetailSkeleton />
        ) : (
          <div className="page__error">
            <div>{error ?? '没有找到这位歌手'}</div>
            <button type="button" className="button detail-status__action" onClick={reload}>
              重试
            </button>
          </div>
        )}
      </div>
    )
  }

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
        <div className="hero__art hero__art--round">
          {artistArt && artistArtReady ? (
            <img src={artistArt} alt="" />
          ) : (
            <FishAvatar className="fish-avatar--hero" label="歌手头像加载中" />
          )}
        </div>

        <div className="hero__body">
          <div className="detail-kicker">歌手</div>
          <h1 className="hero__title">{artist.name}</h1>

          <div className="hero__meta">
            {artist.alias.length > 0 ? <div className="detail-sub">{artist.alias.join(' / ')}</div> : null}
            <div>
              {artist.musicSize} 首歌曲 · {artist.albumSize} 张专辑
            </div>
          </div>

          {artist.briefDesc ? (
            <button type="button" className="detail-desc" title="查看完整歌手简介" onClick={() => setDescOpen(true)}>
              <span className="detail-desc__text">{artist.briefDesc.replace(/\n+/g, ' ')}</span>
              <span className="detail-desc__more">展开</span>
            </button>
          ) : null}

          <div className="hero__actions">
            <button
              type="button"
              className="button button--primary detail-btn"
              disabled={hotSongs.length === 0}
              onClick={playHot}
            >
              <IconPlay size={16} />
              播放热门{hotSongs.length > 0 ? ` (${hotSongs.length})` : ''}
            </button>
            {auth.loggedIn ? (
              <button type="button" className="button detail-btn" onClick={() => void toggleFollow()}>
                {isFollowed ? <IconCheck size={16} /> : <IconPlus size={16} />}
                {isFollowed ? '已关注' : '关注'}
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
          <h2 className="section__title">热门单曲</h2>
          <span className="section__more">{hotSongs.length} 首</span>
        </div>
        {hotSongs.length === 0 && external.length === 0 ? (
          <div className="page__empty">这位歌手暂无热门单曲</div>
        ) : (
          <>
            {hotSongs.length > 0 ? (
              <SongList
                tracks={hotSongs}
                onPlay={(index) => void player.playTracks(hotSongs, index)}
                currentTrackID={player.current?.id}
                likedTrackIDs={likedIDs}
                onToggleLike={auth.loggedIn ? (track) => void toggleLike(track) : undefined}
                emptyMessage="这位歌手暂无热门单曲"
              />
            ) : null}
            {external.length > 0 ? (
              <ExternalRows
                items={external}
                offset={hotSongs.length}
                playingKey={playingKey}
                currentName={player.current?.name}
                onPlay={(item) => void playExternal(item)}
              />
            ) : null}
          </>
        )}
      </section>

      <AlbumSection
        title="专辑"
        albums={discography}
        loading={albums.loading}
        emptyMessage="暂无专辑"
        onOpen={(album) => navigation.push({ name: 'album', id: album.id, title: album.name })}
      />

      {epsAndSingles.length > 0 ? (
        <AlbumSection
          title="EP 与单曲"
          albums={epsAndSingles}
          loading={false}
          emptyMessage="暂无 EP 或单曲"
          onOpen={(album) => navigation.push({ name: 'album', id: album.id, title: album.name })}
        />
      ) : null}

      {albums.error ? (
        <div className="page__error">
          <div>{albums.error}</div>
          <button type="button" className="button detail-status__action" onClick={albums.reset}>
            重试
          </button>
        </div>
      ) : null}

      {albums.more && !albums.loading ? (
        <div className="detail-pager">
          <button type="button" className="button" disabled={albums.loadingMore} onClick={albums.loadMore}>
            {albums.loadingMore ? '加载中' : '加载更多专辑'}
          </button>
        </div>
      ) : null}

      <section className="detail-section">
        <div className="section__header">
          <h2 className="section__title">相似歌手</h2>
        </div>
        {similar.length === 0 ? (
          <div className="page__empty">暂无相似歌手</div>
        ) : (
          <div className="grid grid--artists">
            {similar.map((item) => (
              <ArtCard
                key={item.id}
                title={item.name}
                subtitle={`${item.musicSize} 首歌曲`}
                imageUrl={coverUrl(item.picUrl, 256)}
                round
                onClick={() => navigation.push({ name: 'artist', id: item.id, title: item.name })}
              />
            ))}
          </div>
        )}
      </section>

      <Dialog
        title="歌手简介"
        open={descOpen}
        onClose={() => setDescOpen(false)}
        footer={
          <button type="button" className="button button--primary" onClick={() => setDescOpen(false)}>
            关闭
          </button>
        }
      >
        <div className="detail-dialog-text">{artist.briefDesc}</div>
      </Dialog>

      {menuAt ? (
        <ContextMenu x={menuAt.x} y={menuAt.y} items={menuItems} onClose={() => setMenuAt(undefined)} />
      ) : null}

      {toastNode}
    </div>
  )
}

/** 一排专辑卡片；空数据时给出「暂无」而不是留白。 */
function AlbumSection({
  title,
  albums,
  loading,
  emptyMessage,
  onOpen
}: {
  title: string
  albums: AlbumSummaryDTO[]
  loading: boolean
  emptyMessage: string
  onOpen: (album: AlbumSummaryDTO) => void
}): JSX.Element {
  return (
    <section className="detail-section">
      <div className="section__header">
        <h2 className="section__title">{title}</h2>
        <span className="section__more">{albums.length > 0 ? `${albums.length} 张` : ''}</span>
      </div>
      {loading ? (
        <div className="detail-skeleton-rows">
          <div className="skeleton detail-skeleton__row" />
          <div className="skeleton detail-skeleton__row" />
        </div>
      ) : albums.length === 0 ? (
        <div className="page__empty">{emptyMessage}</div>
      ) : (
        <div className="grid grid--albums">
          {albums.map((album) => (
            <ArtCard
              key={album.id}
              title={album.name}
              subtitle={`${formatDate(album.publishTime)} · ${album.size} 首`}
              imageUrl={coverUrl(album.picUrl, 384)}
              badge={album.subType}
              onClick={() => onOpen(album)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/** 加载骨架：占位与最终布局同尺寸，避免加载完成时整页跳动。 */
function DetailSkeleton(): JSX.Element {
  return (
    <>
      <div className="hero">
        <div className="hero__art hero__art--round skeleton" />
        <div className="hero__body detail-skeleton">
          <div className="skeleton" style={{ width: 56, height: 12 }} />
          <div className="skeleton" style={{ width: 200, height: 26 }} />
          <div className="skeleton" style={{ width: 160, height: 12 }} />
          <div className="skeleton" style={{ width: 280, height: 34, marginTop: 12 }} />
        </div>
      </div>
      <div className="detail-skeleton-rows">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="skeleton detail-skeleton__row" />
        ))}
      </div>
    </>
  )
}

/** IPC 抛出的错误已经带有面向用户的中文消息，这里只兜底非 Error 的情况。 */
function errorText(cause: unknown): string {
  if (cause instanceof IPCError && cause.needsLogin) return '需要登录后才能操作'
  return cause instanceof Error ? cause.message : String(cause)
}
