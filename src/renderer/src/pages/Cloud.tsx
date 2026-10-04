/**
 * 音乐云盘 —— 容量占用、分页列表、删除。
 *
 * 只有能解析出 simpleSong 的条目（track 存在）才可播放；解析不出来的仍然列
 * 出来但置灰：让用户看得见自己上传过什么，比直接隐藏更有用。
 */
import { useCallback, useState, type MouseEvent } from 'react'
import { artistLine, call, formatBytes, formatDuration, usePlayerStore } from '../lib/contract'
import { usePaged } from '../lib/hooks'
import ContextMenu, { type ContextMenuItem } from '../components/ContextMenu'
import Dialog from '../components/Dialog'
import { useToast } from '../components/Toast'
import type { CloudSongDTO } from '@shared/ipc'
import type { TrackDTO } from '@shared/types'

const PAGE_SIZE = 200

interface MenuState {
  x: number
  y: number
  items: ContextMenuItem[]
}

export default function Cloud(): JSX.Element {
  const player = usePlayerStore()
  const toast = useToast()
  const [quota, setQuota] = useState<{ used?: number; capacity?: number }>({})
  const [deleting, setDeleting] = useState<number | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [pendingDelete, setPendingDelete] = useState<CloudSongDTO | undefined>()
  const [menu, setMenu] = useState<MenuState | undefined>()

  const loadPage = useCallback(async (offset: number, limit: number) => {
    const page = await call('library:cloud', { limit, offset })
    // 容量只随第一页返回；翻页时不要拿它覆盖已有值（可能是 undefined）。
    if (offset === 0) setQuota({ used: page.used, capacity: page.capacity })
    return { items: page.songs, more: page.hasMore ?? page.songs.length >= limit }
  }, [])

  const paged = usePaged<CloudSongDTO>(loadPage, [], PAGE_SIZE)

  const playableTracks: TrackDTO[] = paged.items.flatMap((item) => (item.track ? [item.track] : []))

  const play = (item: CloudSongDTO): void => {
    if (!item.track) return
    const index = playableTracks.findIndex((track) => track.id === item.track?.id)
    void player.playTracks(playableTracks, index < 0 ? 0 : index)
  }

  const labelOf = (item: CloudSongDTO): string =>
    item.track?.name ?? item.songName ?? `#${item.songId}`

  const remove = async (item: CloudSongDTO): Promise<void> => {
    if (deleting !== undefined) return
    setDeleting(item.songId)
    setError(undefined)
    try {
      await call('library:cloudDelete', { id: item.songId })
      paged.setItems((current) => current.filter((entry) => entry.songId !== item.songId))
      toast.show(`已从云盘删除「${labelOf(item)}」`, 'success')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDeleting(undefined)
    }
  }

  const rowMenu = (event: MouseEvent<HTMLElement>, item: CloudSongDTO): void => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { label: '播放', disabled: !item.track, onSelect: () => play(item) },
        {
          label: '从云盘删除',
          danger: true,
          onSelect: () => setPendingDelete(item)
        }
      ]
    })
  }

  const used = quota.used ?? 0
  const capacity = quota.capacity ?? 0
  const percent = capacity > 0 ? Math.min(100, (used / capacity) * 100) : 0

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">音乐云盘</h1>
        <span className="page__subtitle">
          {capacity > 0 ? `已使用 ${formatBytes(used)} / ${formatBytes(capacity)}` : '容量信息暂不可用'}
        </span>
        <div className="cloud__actions">
          <button
            type="button"
            className="button"
            disabled={paged.loading || paged.loadingMore}
            onClick={paged.reset}
          >
            ⟳ 刷新
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={playableTracks.length === 0}
            onClick={() => void player.playTracks(playableTracks, 0)}
          >
            ▶ 播放全部
          </button>
        </div>
      </div>

      {capacity > 0 ? (
        <div className="cloud__quota">
          <div className="cloud__bar">
            <div className="cloud__bar-fill" style={{ width: `${percent}%` }} />
          </div>
          <span className="cloud__hint">
            已列出 {paged.items.length} 首 · 占用 {percent.toFixed(1)}%
            {paged.more ? '（还有更多）' : ''}
          </span>
        </div>
      ) : null}

      {error ? <div className="page__error">{error}</div> : null}

      {paged.loading ? (
        <div className="placeholder">正在读取云盘…</div>
      ) : paged.error ? (
        <div className="placeholder">
          <div className="placeholder__title">云盘加载失败</div>
          <div>{paged.error}</div>
          <button type="button" className="button" onClick={paged.reset}>
            重试
          </button>
        </div>
      ) : paged.items.length === 0 ? (
        <div className="placeholder">
          <div className="placeholder__title">云盘还没有歌曲</div>
          <div>在网易云音乐客户端上传的歌曲会出现在这里</div>
        </div>
      ) : (
        <>
          <div className="cloud__list">
            {paged.items.map((item, index) => {
              const track = item.track
              const name = labelOf(item)
              const artist = track ? artistLine(track) : item.artist
              const current = track !== undefined && player.state.track?.id === track.id
              return (
                <div
                  key={item.songId}
                  className={`cloud__row${track ? '' : ' is-disabled'}${current ? ' is-current' : ''}`}
                  onDoubleClick={() => play(item)}
                  onContextMenu={(event) => rowMenu(event, item)}
                  title={track ? `${name} — ${artistLine(track)}` : '这条云盘记录解析不出歌曲信息，不能播放'}
                >
                  <div className="cloud__index">{index + 1}</div>
                  <div className="cloud__title">
                    <button
                      type="button"
                      className="song-row__play"
                      title={track ? '播放' : '不可播放'}
                      disabled={!track}
                      onClick={() => play(item)}
                    >
                      {current ? '♪' : '▶'}
                    </button>
                    <div style={{ minWidth: 0 }}>
                      <div className="song-row__name">{name}</div>
                      {!track ? <div className="song-row__sub">信息不完整，仅显示文件记录</div> : null}
                    </div>
                  </div>
                  <div className="cloud__artist">{artist ?? '未知歌手'}</div>
                  <div className="cloud__size">{formatBytes(item.fileSize)}</div>
                  <div className="song-row__duration">
                    {track ? formatDuration(track.durationMS / 1000) : '—'}
                  </div>
                  <div className="cloud__cell">
                    <button
                      type="button"
                      className="icon-button"
                      title="从云盘删除"
                      disabled={deleting === item.songId}
                      onClick={() => setPendingDelete(item)}
                    >
                      {deleting === item.songId ? '…' : '🗑'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="cloud__foot">
            {paged.more ? (
              <button
                type="button"
                className="button"
                disabled={paged.loadingMore}
                onClick={paged.loadMore}
              >
                {paged.loadingMore ? '正在加载…' : '加载更多'}
              </button>
            ) : (
              <span className="cloud__hint">已经到底了</span>
            )}
          </div>
        </>
      )}

      {menu ? (
        <ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(undefined)} />
      ) : null}

      <Dialog
        title="从云盘删除"
        open={pendingDelete !== undefined}
        onClose={() => setPendingDelete(undefined)}
        width={380}
        footer={
          <>
            <button type="button" className="button" onClick={() => setPendingDelete(undefined)}>
              取消
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => {
                const item = pendingDelete
                setPendingDelete(undefined)
                if (item) void remove(item)
              }}
            >
              删除
            </button>
          </>
        }
      >
        <p className="cloud__dialog-text">
          确定从云盘删除「{pendingDelete ? labelOf(pendingDelete) : ''}」吗？文件会从云端移除，本地副本不受影响。
        </p>
      </Dialog>

      {toast.node}
    </div>
  )
}
