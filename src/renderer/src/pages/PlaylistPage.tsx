/**
 * 歌单详情（排行榜 route 'toplist' 也复用本页）。
 *
 * 所有数据都走 IPC：playlist:detail、playlist:manipulateTracks、library:*、
 * search:query。渲染进程不直接访问网易云接口，因为 cookie 与签名都在主进程，
 * CSP 也不允许渲染进程发这种请求。
 *
 * 「我喜欢的音乐」是 specialType === 5 的特殊歌单：它没有「增删歌曲」的概念，
 * 对应用户的喜欢列表，所以那一行操作换成 library:likeTrack。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TrackDTO } from '@shared/types'
import {
  call,
  tryCall,
  IPCError,
  SongList,
  artistLine,
  coverUrl,
  formatDate,
  formatDuration,
  formatPlayCount,
  useAuthStore,
  useNavigation,
  usePlayerStore
} from '../lib/contract'
import { useAsync, useDebounced } from '../lib/hooks'
import ContextMenu, { type ContextMenuItem } from '../components/ContextMenu'
import Dialog from '../components/Dialog'
import { useToast, type ToastKind } from '../components/Toast'
import {
  IconCheck,
  IconMore,
  IconMusic,
  IconPlay,
  IconPlus,
  IconUser
} from '../components/Icons'

/** 网易云协议里「我喜欢的音乐」用 specialType 5 标记。 */
const LIKED_PLAYLIST_TYPE = 5

export default function PlaylistPage({ id, kicker }: { id: number; kicker?: string }): JSX.Element {
  // 用 key 重建：从歌单 A 跳到歌单 B 时 React 会复用同一个组件实例，
  // 不重建就会先闪一下上一张歌单的封面和曲目。
  return <PlaylistDetail key={id} id={id} kicker={kicker} />
}

function PlaylistDetail({ id, kicker: kickerOverride }: { id: number; kicker?: string }): JSX.Element {
  const navigation = useNavigation()
  const player = usePlayerStore()
  const auth = useAuthStore()
  const { show: showToast, node: toastNode } = useToast()

  const [liked, setLiked] = useState<number[]>([])
  const [menuAt, setMenuAt] = useState<{ x: number; y: number }>()
  const [descOpen, setDescOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const notify = useCallback(
    (message: string, kind: ToastKind = 'info') => showToast(message, kind),
    [showToast]
  )

  const { data: detail, loading, error, reload, setData } = useAsync(
    () => call('playlist:detail', { id }),
    [id]
  )

  useEffect(() => {
    // 详情接口不返回「哪些歌已喜欢」，红心状态只能从我的音乐概览里取；
    // 未登录时这里本来就会失败，静默忽略。
    void tryCall('library:overview').then((overview) => setLiked(overview?.likedTrackIDs ?? []))
  }, [])

  const tracks = detail?.tracks ?? []
  const likedIDs = useMemo(() => new Set(liked), [liked])
  const existingIDs = useMemo(() => new Set(tracks.map((track) => track.id)), [tracks])
  const isLikedList = detail?.specialType === LIKED_PLAYLIST_TYPE
  const isOwn = detail?.creator !== undefined && detail.creator.userId === auth.profile?.userId
  const kicker =
    kickerOverride ?? (navigation.route.name === 'toplist' ? '排行榜' : isLikedList ? '我喜欢的音乐' : '歌单')

  const playAll = useCallback(() => {
    if (tracks.length === 0) return
    // 以第一首可播曲目为起点；受限歌曲已由主进程自动换源，通常整张列表都可播，
    // 万一全都不可播就退回第 0 首，交给播放器与主进程处理。
    const firstPlayable = tracks.findIndex((track) => track.playability === 'playable')
    // 整表播放入口带 randomStart：由主进程随机起播（点具体某一行时不带）。
    // 直接调通道是因为 store 的 playTracks 只转发 startIndex；setQueue 会广播
    // player:state，所以播放器状态照常同步。
    void call('player:playTracks', {
      tracks,
      startIndex: firstPlayable < 0 ? 0 : firstPlayable,
      randomStart: true
    })
  }, [tracks])

  const appendAll = useCallback(() => {
    if (tracks.length === 0) return
    void player.append(tracks)
    notify(`已加入播放队列（${tracks.length} 首）`, 'success')
  }, [notify, player, tracks])

  const toggleSubscribe = useCallback(async () => {
    if (!detail) return
    const next = !detail.subscribed
    try {
      await call('library:subscribePlaylist', { id: detail.id, subscribe: next })
      setData((current) =>
        current
          ? {
              ...current,
              subscribed: next,
              subscribedCount: Math.max(0, current.subscribedCount + (next ? 1 : -1))
            }
          : current
      )
      notify(next ? '已收藏歌单' : '已取消收藏', 'success')
    } catch (cause) {
      notify(errorText(cause), 'error')
    }
  }, [detail, notify, setData])

  const toggleLike = useCallback(
    async (track: TrackDTO) => {
      const next = !likedIDs.has(track.id)
      try {
        await call('library:likeTrack', { id: track.id, like: next })
        setLiked((current) =>
          next ? [...current, track.id] : current.filter((value) => value !== track.id)
        )
      } catch (cause) {
        notify(errorText(cause), 'error')
      }
    },
    [likedIDs, notify]
  )

  const removeTrack = useCallback(
    async (track: TrackDTO) => {
      if (!detail) return
      try {
        await call('playlist:manipulateTracks', { op: 'del', playlistID: detail.id, trackIDs: [track.id] })
        // 本地先摘掉这一行，避免整页重新拉取造成的闪烁。
        setData((current) =>
          current
            ? {
                ...current,
                tracks: current.tracks.filter((item) => item.id !== track.id),
                trackCount: Math.max(0, current.trackCount - 1)
              }
            : current
        )
        notify('已从歌单移除', 'success')
      } catch (cause) {
        notify(errorText(cause), 'error')
      }
    },
    [detail, notify, setData]
  )

  const deletePlaylist = useCallback(async () => {
    if (!detail) return
    setDeleteOpen(false)
    try {
      await call('library:deletePlaylist', { id: detail.id })
      notify('歌单已删除', 'success')
      navigation.back()
    } catch (cause) {
      notify(errorText(cause), 'error')
    }
  }, [detail, navigation, notify])

  const rowAction = useMemo(() => {
    if (isLikedList && auth.loggedIn) {
      return { label: '取消喜欢', onSelect: (track: TrackDTO) => void toggleLike(track) }
    }
    if (isOwn) {
      return { label: '从歌单删除', onSelect: (track: TrackDTO) => void removeTrack(track) }
    }
    return undefined
  }, [auth.loggedIn, isLikedList, isOwn, removeTrack, toggleLike])

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    const items: ContextMenuItem[] = [
      { label: '播放全部', disabled: tracks.length === 0, onSelect: playAll },
      { label: '加入播放队列', disabled: tracks.length === 0, onSelect: appendAll }
    ]
    if (isOwn) items.push({ label: '添加歌曲', onSelect: () => setAddOpen(true) })
    if (!isLikedList && auth.loggedIn && detail) {
      items.push({
        label: detail.subscribed ? '取消收藏歌单' : '收藏歌单',
        onSelect: () => void toggleSubscribe()
      })
    }
    items.push({ label: '刷新', onSelect: reload })
    if (isOwn) items.push({ label: '删除歌单', danger: true, onSelect: () => setDeleteOpen(true) })
    return items
  }, [appendAll, auth.loggedIn, detail, isLikedList, isOwn, playAll, reload, toggleSubscribe, tracks.length])

  if (!detail) {
    return (
      <div className="page">
        {loading ? (
          <DetailSkeleton />
        ) : (
          <div className="page__error">
            <div>{error ?? '没有找到这个歌单'}</div>
            <button type="button" className="button detail-status__action" onClick={reload}>
              重试
            </button>
          </div>
        )}
      </div>
    )
  }

  const description = detail.description?.trim()

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
          {coverUrl(detail.coverURL, 512) ? (
            <img src={coverUrl(detail.coverURL, 512)} alt="" />
          ) : (
            <span className="card__placeholder">
              <IconMusic size={26} />
            </span>
          )}
        </div>

        <div className="hero__body">
          <div className="detail-kicker">{kicker}</div>
          <h1 className="hero__title">{isLikedList ? '我喜欢的音乐' : detail.name}</h1>

          <div className="hero__meta">
            {detail.creator && !isLikedList ? (
              <div className="detail-creator">
                {detail.creator.avatarUrl ? (
                  <img src={detail.creator.avatarUrl} alt="" />
                ) : (
                  <span className="detail-creator__fallback">
                    <IconUser size={14} />
                  </span>
                )}
                <span>{detail.creator.nickname}</span>
              </div>
            ) : null}
            <div>
              {detail.trackCount} 首 · {formatPlayCount(detail.playCount)} 次播放
              {detail.subscribedCount > 0 ? ` · ${formatPlayCount(detail.subscribedCount)} 人收藏` : ''}
              {detail.updateTime ? ` · 更新于 ${formatDate(detail.updateTime)}` : ''}
            </div>
          </div>

          {description ? (
            <button type="button" className="detail-desc" title="查看完整简介" onClick={() => setDescOpen(true)}>
              <span className="detail-desc__text">{description.replace(/\n+/g, ' ')}</span>
              <span className="detail-desc__more">展开</span>
            </button>
          ) : null}

          <div className="hero__actions">
            <button
              type="button"
              className="button button--primary detail-btn"
              disabled={tracks.length === 0}
              onClick={playAll}
            >
              <IconPlay size={16} />
              播放全部{tracks.length > 0 ? ` (${tracks.length})` : ''}
            </button>
            {!isLikedList && auth.loggedIn ? (
              <button
                type="button"
                className="button detail-btn"
                onClick={() => void toggleSubscribe()}
              >
                {detail.subscribed ? <IconCheck size={16} /> : <IconPlus size={16} />}
                {detail.subscribed ? '已收藏' : '收藏'}
              </button>
            ) : null}
            {isOwn ? (
              <button type="button" className="button detail-btn" onClick={() => setAddOpen(true)}>
                <IconPlus size={16} />
                添加歌曲
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
          <h2 className="section__title">歌曲列表</h2>
          <span className="section__more">{tracks.length} 首</span>
        </div>

        {tracks.length === 0 ? (
          <div className="page__empty">
            {isOwn ? '这个歌单还没有歌曲，点上面的「添加歌曲」挑几首吧' : '这个歌单还没有歌曲'}
          </div>
        ) : (
          <SongList
            tracks={tracks}
            onPlay={(index) => void player.playTracks(tracks, index)}
            currentTrackID={player.current?.id}
            likedTrackIDs={likedIDs}
            onToggleLike={auth.loggedIn ? (track) => void toggleLike(track) : undefined}
            rowAction={rowAction}
            emptyMessage="这个歌单还没有歌曲"
          />
        )}
      </section>

      <Dialog
        title="歌单简介"
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

      <Dialog
        title="删除歌单"
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        footer={
          <>
            <button type="button" className="button" onClick={() => setDeleteOpen(false)}>
              取消
            </button>
            <button type="button" className="button button--primary" onClick={() => void deletePlaylist()}>
              删除
            </button>
          </>
        }
      >
        <div className="detail-dialog-text">
          确定要删除歌单「{detail.name}」吗？删除后无法恢复。
        </div>
      </Dialog>

      {addOpen ? (
        <AddTracksDialog
          playlistID={detail.id}
          existingIDs={existingIDs}
          onClose={() => setAddOpen(false)}
          onNotify={notify}
          onAdded={(count) => {
            notify(`已添加 ${count} 首到歌单`, 'success')
            reload()
          }}
        />
      ) : null}

      {menuAt ? (
        <ContextMenu x={menuAt.x} y={menuAt.y} items={menuItems} onClose={() => setMenuAt(undefined)} />
      ) : null}

      {toastNode}
    </div>
  )
}

/**
 * 「添加歌曲」对话框：站内搜索、勾选，最后写入 playlist:manipulateTracks。
 * 自己新建的歌单常常是空的，没有这个入口就只能去别处找歌。
 */
function AddTracksDialog({
  playlistID,
  existingIDs,
  onClose,
  onAdded,
  onNotify
}: {
  playlistID: number
  existingIDs: Set<number>
  onClose: () => void
  onAdded: (count: number) => void
  onNotify: (message: string, kind?: ToastKind) => void
}): JSX.Element {
  const [keywords, setKeywords] = useState('')
  const debounced = useDebounced(keywords, 320)
  const [results, setResults] = useState<TrackDTO[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<number[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const text = debounced.trim()
    if (!text) {
      setResults([])
      setSearching(false)
      return
    }
    // 输入变化时旧请求的结果必须丢掉，否则慢请求会覆盖新关键词的结果。
    let cancelled = false
    setSearching(true)
    call('search:query', { keywords: text, type: 'songs', limit: 30 })
      .then((result) => {
        if (!cancelled) setResults(result.songs ?? [])
      })
      .catch((cause) => {
        if (cancelled) return
        setResults([])
        onNotify(errorText(cause), 'error')
      })
      .finally(() => {
        if (!cancelled) setSearching(false)
      })
    return () => {
      cancelled = true
    }
  }, [debounced, onNotify])

  const toggle = (track: TrackDTO): void => {
    setSelected((current) =>
      current.includes(track.id) ? current.filter((value) => value !== track.id) : [...current, track.id]
    )
  }

  const submit = async (): Promise<void> => {
    if (selected.length === 0) return
    setSaving(true)
    try {
      await call('playlist:manipulateTracks', { op: 'add', playlistID, trackIDs: selected })
      onAdded(selected.length)
      onClose()
    } catch (cause) {
      onNotify(errorText(cause), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      title="添加歌曲"
      open
      width={560}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={selected.length === 0 || saving}
            onClick={() => void submit()}
          >
            {saving ? '添加中' : `添加 ${selected.length} 首`}
          </button>
        </>
      }
    >
      <input
        className="text-input detail-pick__input"
        placeholder="搜索歌名、歌手或专辑"
        aria-label="搜索要添加的歌曲"
        value={keywords}
        autoFocus
        onChange={(event) => setKeywords(event.target.value)}
      />
      <div className="detail-pick">
        {searching ? <div className="detail-pick__hint">搜索中</div> : null}
        {!searching && !keywords.trim() ? (
          <div className="detail-pick__hint">输入关键词开始搜索</div>
        ) : null}
        {!searching && keywords.trim() && results.length === 0 ? (
          <div className="detail-pick__hint">没有找到匹配的歌曲</div>
        ) : null}
        {results.map((track) => {
          const already = existingIDs.has(track.id)
          const checked = selected.includes(track.id)
          return (
            <button
              key={track.id}
              type="button"
              className={`detail-pick__row${checked ? ' is-selected' : ''}`}
              disabled={already}
              title={already ? '已在歌单中' : track.name}
              onClick={() => toggle(track)}
            >
              <span className={`detail-pick__box${checked || already ? ' is-on' : ''}`} aria-hidden="true">
                {checked || already ? <IconCheck size={13} /> : null}
              </span>
              <span className="detail-pick__name">
                {track.name}
                <span className="song-row__sub"> {artistLine(track)}</span>
              </span>
              <span className="detail-pick__meta">
                {already ? '已在歌单' : formatDuration(track.durationMS / 1000)}
              </span>
            </button>
          )
        })}
      </div>
    </Dialog>
  )
}

/** 加载骨架：hero 与列表都按最终布局占位，加载完成时页面不会整体跳动。 */
function DetailSkeleton(): JSX.Element {
  return (
    <>
      <div className="hero">
        <div className="hero__art skeleton" />
        <div className="hero__body detail-skeleton">
          <div className="skeleton" style={{ width: 64, height: 12 }} />
          <div className="skeleton" style={{ width: 240, height: 26 }} />
          <div className="skeleton" style={{ width: 180, height: 12 }} />
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

/** IPC 抛出的错误已经带有面向用户的中文消息，这里只兜底非 Error 的情况。 */
function errorText(cause: unknown): string {
  if (cause instanceof IPCError && cause.needsLogin) return '需要登录后才能操作'
  return cause instanceof Error ? cause.message : String(cause)
}
