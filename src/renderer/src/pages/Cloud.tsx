/**
 * 音乐云盘 —— 分页列表、播放与删除。
 *
 * 只有能解析出 simpleSong 的条目（track 存在）才可播放；解析不出来的仍然列
 * 出来但置灰：让用户看得见自己上传过什么，比直接隐藏更有用。
 */
import { useCallback, useState, type MouseEvent } from 'react'
import { artistLine, call, formatBytes, formatDuration, usePlayerStore } from '../lib/contract'
import { usePaged } from '../lib/hooks'
import ContextMenu, { type ContextMenuItem } from '../components/ContextMenu'
import Dialog from '../components/Dialog'
import { IconPause, IconPlay, IconRepeat, IconTrash } from '../components/Icons'
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
  const [pendingPlay, setPendingPlay] = useState<number | undefined>()
  const [queuingAll, setQueuingAll] = useState(false)
  const [deleting, setDeleting] = useState<number | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [pendingDelete, setPendingDelete] = useState<CloudSongDTO | undefined>()
  const [menu, setMenu] = useState<MenuState | undefined>()

  const loadPage = useCallback(async (offset: number, limit: number) => {
    const page = await call('library:cloud', { limit, offset })
    return { items: page.songs, more: page.hasMore ?? page.songs.length >= limit }
  }, [])

  const paged = usePaged<CloudSongDTO>(loadPage, [], PAGE_SIZE)

  const playableTracks: TrackDTO[] = paged.items.flatMap((item) => (item.track ? [item.track] : []))

  /**
   * 播放键要立刻有反应：已经是当前这首时直接在本地切播放/暂停，不惊动主进程；
   * 换歌时才交给主进程解析播放地址，期间按钮进入 busy 态并拒掉重复点击。
   * 于是「按下去马上就有变化」，不会出现点了几次都没动静的感觉。
   */
  const play = (item: CloudSongDTO): void => {
    const track = item.track
    if (!track || pendingPlay !== undefined) return
    if (player.state.track?.id === track.id) {
      void player.toggle()
      return
    }
    const index = playableTracks.findIndex((entry) => entry.id === track.id)
    setPendingPlay(track.id)
    void player
      .playTracks(playableTracks, index < 0 ? 0 : index)
      .catch(() => undefined)
      .finally(() => setPendingPlay(undefined))
  }

  /**
   * 整表播放：让主进程随机起播（点具体某一行仍按那一行开始）。
   * store 的 playTracks 还没暴露 randomStart，这里直接走通道；状态变化由
   * player:state 广播回 store。
   */
  const playAll = (): void => {
    if (playableTracks.length === 0 || queuingAll) return
    setQueuingAll(true)
    void call('player:playTracks', { tracks: playableTracks, startIndex: 0, randomStart: true })
      .catch(() => undefined)
      .finally(() => setQueuingAll(false))
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

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">音乐云盘</h1>
        <div className="cloud__actions">
          <button
            type="button"
            className="button icon-label glass-btn"
            disabled={paged.loading || paged.loadingMore}
            onClick={paged.reset}
          >
            <IconRepeat size={15} />
            刷新
          </button>
          <button
            type="button"
            className={`button button--primary icon-label glass-btn${queuingAll ? ' is-busy' : ''}`}
            disabled={playableTracks.length === 0 || queuingAll}
            onClick={playAll}
          >
            <IconPlay size={14} />
            播放全部
          </button>
        </div>
      </div>

      {error ? <div className="page__error">{error}</div> : null}

      {paged.loading ? (
        <div className="placeholder">正在读取云盘</div>
      ) : paged.error ? (
        <div className="placeholder">
          <div className="placeholder__title">云盘加载失败</div>
          <div>{paged.error}</div>
          <button type="button" className="button glass-btn" onClick={paged.reset}>
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
              const busy = track !== undefined && pendingPlay === track.id
              const playTitle = !track
                ? '不可播放'
                : current
                  ? player.state.playing
                    ? '暂停'
                    : '继续播放'
                  : busy
                    ? '正在准备播放'
                    : '播放'
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
                      className={`song-row__play glass-btn${busy ? ' is-busy' : ''}`}
                      title={playTitle}
                      aria-label={playTitle}
                      disabled={!track || busy}
                      onClick={(event) => {
                        // 行本身双击=播放：按钮自己处理掉，别让一次点击被算成两次。
                        event.stopPropagation()
                        play(item)
                      }}
                    >
                      {current ? <IconPause size={14} /> : <IconPlay size={14} />}
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
                      className={`icon-button glass-btn${deleting === item.songId ? ' is-busy' : ''}`}
                      title="从云盘删除"
                      aria-label="从云盘删除"
                      disabled={deleting === item.songId}
                      onClick={(event) => {
                        event.stopPropagation()
                        setPendingDelete(item)
                      }}
                    >
                      <IconTrash size={16} />
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
                className="button glass-btn"
                disabled={paged.loadingMore}
                onClick={paged.loadMore}
              >
                {paged.loadingMore ? '加载中' : '加载更多'}
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
            <button type="button" className="button glass-btn" onClick={() => setPendingDelete(undefined)}>
              取消
            </button>
            <button
              type="button"
              className="button button--primary glass-btn"
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
