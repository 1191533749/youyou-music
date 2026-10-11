/**
 * 站外曲目行列表（搜索兜底、并进单曲列表的汽水曲目、歌手页热门歌）。
 *
 * 搜索页与歌手页共用：`offset` 让并进列表的行号接着网易云的序号往下排。
 * 主进程已确认彻底失败（所有音源都取不到完整音频）的曲目不再展示——
 * 对应「放不出来的歌为什么还显示着」这条反馈。
 */
import { useEffect, useState } from 'react'
import type { ExternalTrackDTO } from '@shared/types'
import { formatDuration } from '../lib/format'
import { useFailedExternalKeys } from '../store/player'
import { IconDisc, IconMusic, IconPlay } from './Icons'

const EXTERNAL_COLUMNS = '34px 40px minmax(0, 1fr) minmax(110px, 200px) minmax(120px, 220px) 60px'

export default function ExternalRows(props: {
  items: ExternalTrackDTO[]
  offset?: number
  playingKey?: string
  currentName?: string
  onPlay: (item: ExternalTrackDTO) => void
}): JSX.Element {
  const { items, offset = 0, playingKey, currentName, onPlay } = props
  const failedKeys = useFailedExternalKeys()
  const visible = items.filter((item) => !failedKeys.has(`${item.source}:${item.sourceId}`))
  if (visible.length === 0) return <></>
  return (
    <div className="song-list">
      {visible.map((item, index) => {
        const key = `${item.source}:${item.sourceId}`
        // 主进程播放的是由站外曲目合成的曲目，歌名保持一致，用它来标当前行。
        const current = !!currentName && currentName === item.name
        const busy = playingKey === key
        return (
          <div
            key={key}
            className={`song-row song-row--external${current ? ' is-current' : ''}`}
            style={{ gridTemplateColumns: EXTERNAL_COLUMNS }}
            onDoubleClick={() => onPlay(item)}
            title={`${item.name} — ${item.artists}`}
          >
            <div className="song-row__index">{offset + index + 1}</div>
            <div className="ext-row__cover">
              <ExternalCover url={item.coverUrl} />
            </div>
            <div className="song-row__title">
              <button
                type="button"
                className="song-row__play"
                disabled={busy}
                onClick={() => onPlay(item)}
                title={busy ? '正在匹配完整音源' : '播放'}
                aria-label={busy ? '正在匹配完整音源' : `播放 ${item.name}`}
              >
                {busy ? <IconDisc size={14} className="spin" /> : <IconPlay size={14} />}
              </button>
              <div style={{ minWidth: 0 }}>
                <div className="song-row__name">{item.name}</div>
                <div className="song-row__sub">{item.artists}</div>
              </div>
            </div>
            <div className="song-row__artist">{item.artists}</div>
            <div className="song-row__album">{item.album ?? '—'}</div>
            <div className="song-row__duration">{formatDuration(item.durationMS / 1000)}</div>
          </div>
        )
      })}
    </div>
  )
}

/** 站外封面：第三方 CDN 加载失败或没有封面时退回线性音符图标。 */
function ExternalCover({ url }: { url?: string }): JSX.Element {
  const [broken, setBroken] = useState(false)
  // 换关键词后列表会复用行，这里按 URL 重置破图标记，重新尝试加载。
  useEffect(() => setBroken(false), [url])
  const src = url?.replace(/^http:\/\//, 'https://')
  if (!src || broken) {
    return (
      <span className="ext-row__cover-fallback">
        <IconMusic size={18} />
      </span>
    )
  }
  return <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} />
}
