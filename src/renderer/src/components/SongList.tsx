/**
 * The track list.
 *
 * Every page that shows tracks uses this — home rails, playlist detail, album
 * detail, search results, the daily recommendation — so the double-click-to-play
 * behaviour, the greyed-out markers and the hover actions are identical
 * everywhere. It is deliberately presentational: the caller supplies the play
 * handler, so queueing rules stay with the page.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TrackDTO } from '@shared/types'
import { artistLine, coverUrl, formatDuration } from '../lib/format'
import { IconHeart, IconHeartFilled, IconMore, IconMusic, IconPause, IconPlay } from './Icons'

export interface SongListProps {
  tracks: TrackDTO[]
  /** Called with the row index when the user asks to play. */
  onPlay: (index: number) => void
  /** Currently playing track id, for the highlight. */
  currentTrackID?: number
  /** Show the album column (off in album detail, where it is redundant). */
  showAlbum?: boolean
  /** Show the index column; off for compact rails. */
  showIndex?: boolean
  /** Extra per-row action, e.g. "从歌单删除". */
  rowAction?: { label: string; onSelect: (track: TrackDTO, index: number) => void }
  /** Called when the heart is clicked. Omit to hide the heart. */
  onToggleLike?: (track: TrackDTO) => void
  likedTrackIDs?: Set<number>
  /** Notifies the caller when rows scroll into view, for infinite lists. */
  onReachEnd?: () => void
  emptyMessage?: string
}

export default function SongList({
  tracks,
  onPlay,
  currentTrackID,
  showAlbum = true,
  showIndex = true,
  rowAction,
  onToggleLike,
  likedTrackIDs,
  onReachEnd,
  emptyMessage = '这里还没有歌曲'
}: SongListProps): JSX.Element {
  const [menuFor, setMenuFor] = useState<number | undefined>()
  const sentinel = useRef<HTMLDivElement | null>(null)
  // Notifying on scroll is unreliable here: the list itself does not scroll,
  // its ancestor (.content) does, so a scroll listener on the list never fires.
  // An observer on a sentinel row works regardless of which ancestor scrolls.
  const reachEnd = useRef(onReachEnd)
  reachEnd.current = onReachEnd

  useEffect(() => {
    const node = sentinel.current
    if (!node || !onReachEnd) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) reachEnd.current?.()
      },
      { rootMargin: '240px 0px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
    // Re-observing is unnecessary while the callback identity changes; the ref
    // above keeps the latest one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks.length > 0])

  const columns = useMemo(() => {
    const parts = []
    if (showIndex) parts.push('34px')
    parts.push('1fr')
    parts.push('minmax(110px, 200px)')
    if (showAlbum) parts.push('minmax(120px, 220px)')
    parts.push('60px', '66px')
    return parts.join(' ')
  }, [showAlbum, showIndex])

  if (tracks.length === 0) {
    return <div className="placeholder">{emptyMessage}</div>
  }

  return (
    <div className="song-list">
      {tracks.map((track, index) => {
        const disabled = track.playability !== 'playable'
        const liked = likedTrackIDs?.has(track.id) ?? false
        return (
          <div
            key={`${track.id}-${index}`}
            className={`song-row${currentTrackID === track.id ? ' is-current' : ''}${disabled ? ' is-disabled' : ''}`}
            style={{ gridTemplateColumns: columns }}
            onDoubleClick={() => onPlay(index)}
            title={`${track.name} — ${artistLine(track)}`}
          >
            {showIndex ? <div className="song-row__index">{index + 1}</div> : null}

            <div className="song-row__title">
              <button
                type="button"
                className="song-row__play"
                onClick={() => onPlay(index)}
                title={currentTrackID === track.id ? '正在播放' : '播放'}
                aria-label={currentTrackID === track.id ? '正在播放' : '播放'}
              >
                {currentTrackID === track.id ? <IconPause size={14} /> : <IconPlay size={14} />}
              </button>
              <div style={{ minWidth: 0 }}>
                <div className="song-row__name">
                  {track.name}
                  {track.transNames[0] ? <span className="song-row__sub"> {track.transNames[0]}</span> : null}
                </div>
                {track.alias[0] ? <div className="song-row__sub">{track.alias[0]}</div> : null}
              </div>
              {track.isCloud ? <span className="badge">云盘</span> : null}
            </div>

            <div className="song-row__artist">{artistLine(track)}</div>
            {showAlbum ? <div className="song-row__album">{track.album.name}</div> : null}
            <div className="song-row__duration">{formatDuration(track.durationMS / 1000)}</div>

            <div className="song-row__actions">
              {onToggleLike ? (
                <button
                  type="button"
                  className={`icon-button${liked ? ' is-active' : ''}`}
                  title={liked ? '取消喜欢' : '喜欢'}
                  aria-label={liked ? '取消喜欢' : '喜欢'}
                  onClick={(event) => {
                    event.stopPropagation()
                    onToggleLike(track)
                  }}
                >
                  {liked ? <IconHeartFilled size={16} /> : <IconHeart size={16} />}
                </button>
              ) : null}
              {rowAction ? (
                <button
                  type="button"
                  className="icon-button"
                  title={rowAction.label}
                  aria-label={rowAction.label}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (menuFor === index) {
                      setMenuFor(undefined)
                    } else {
                      setMenuFor(index)
                      rowAction.onSelect(track, index)
                    }
                  }}
                >
                  <IconMore size={16} />
                </button>
              ) : null}
            </div>
          </div>
        )
      })}
      {onReachEnd ? <div ref={sentinel} className="song-list__sentinel" aria-hidden /> : null}
    </div>
  )
}

/** Artwork tile used by every grid of playlists, albums and artists. */
export function ArtCard({
  title,
  subtitle,
  imageUrl,
  badge,
  round,
  onClick
}: {
  title: string
  subtitle?: string
  imageUrl?: string
  badge?: string
  round?: boolean
  onClick?: () => void
}): JSX.Element {
  const [broken, setBroken] = useState(false)
  // 换卡（列表复用同一组件实例）时重置破图标记，重新尝试加载。
  useEffect(() => setBroken(false), [imageUrl])
  const url = imageUrl?.replace(/^http:\/\//, 'https://')
  const showFallback = !url || broken
  return (
    <button type="button" className="card" onClick={onClick} title={title}>
      <div className={`card__art${round ? ' card__art--round' : ''}`}>
        {showFallback ? (
          <span className="card__placeholder">
            <IconMusic size={26} />
          </span>
        ) : (
          <img src={url} alt="" loading="lazy" onError={() => setBroken(true)} />
        )}
        {badge ? <span className="card__badge">{badge}</span> : null}
      </div>
      <div className="card__title">{title}</div>
      {subtitle ? <div className="card__meta">{subtitle}</div> : null}
    </button>
  )
}
