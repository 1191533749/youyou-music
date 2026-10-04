/**
 * The player bar.
 *
 * Layout follows the macOS client's bottom bar: artwork and title on the left
 * (clicking the artwork opens the immersive now-playing page), transport in the
 * centre with an inline lyric line, and volume / queue / quality on the right.
 */
import { useMemo } from 'react'
import { usePlayerStore, repeatLabel } from '../store/player'
import { useNavigation } from '../store/navigation'
import { artistLine, coverUrl, formatDuration } from '../lib/format'
import type { PlayerStore } from '../store/player'

const QUALITY_LABELS: Record<string, string> = {
  standard: '标准',
  higher: '较高',
  exhigh: '极高',
  lossless: '无损',
  hires: 'Hi-Res',
  jyeffect: '沉浸环绕',
  sky: '全景声',
  jymaster: '母带'
}

export default function PlayerBar(): JSX.Element {
  const player = usePlayerStore()
  const navigation = useNavigation()
  const { state, current } = player

  const progress = useMemo(() => {
    if (state.duration <= 0) return 0
    return Math.min(100, (state.position / state.duration) * 100)
  }, [state.position, state.duration])

  const unavailable = current ? current.playability !== 'playable' : false

  return (
    <footer className="player-bar" data-testid="player-bar">
      <div className="player-bar__now">
        <button
          type="button"
          className="player-bar__art"
          title="打开播放页"
          onClick={() => navigation.push({ name: 'nowPlaying' })}
        >
          {coverUrl(current?.album.picUrl, 96) ? (
            <img src={coverUrl(current?.album.picUrl, 96)} alt="" />
          ) : (
            <span className="player-bar__art-placeholder">雲</span>
          )}
        </button>
        <div className="player-bar__meta">
          <div className="player-bar__title" title={current?.name}>
            {current?.name ?? '未在播放'}
          </div>
          <div className="player-bar__artist">
            {current ? artistLine(current) : '选择一首歌开始'}
            {unavailable && current?.playabilityReason ? (
              <span className="badge badge--warn">{current.playabilityReason}</span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="player-bar__center">
        <div className="player-bar__controls">
          <button type="button" className="icon-button" title={repeatLabel(state.repeat)} onClick={() => void player.cycleRepeat()}>
            {state.repeat === 'one' ? '🔂' : state.repeat === 'all' ? '🔁' : '➡️'}
          </button>
          <button type="button" className="icon-button" title="上一首" onClick={() => void player.previous()}>
            ⏮
          </button>
          <button
            type="button"
            className="icon-button icon-button--primary"
            title={state.playing ? '暂停' : '播放'}
            onClick={() => void player.toggle()}
          >
            {state.loading ? '⏳' : state.playing ? '⏸' : '▶'}
          </button>
          <button type="button" className="icon-button" title="下一首" onClick={() => void player.next()}>
            ⏭
          </button>
          <button
            type="button"
            className={`icon-button${state.shuffle ? ' is-active' : ''}`}
            title={state.shuffle ? '随机播放：开' : '随机播放：关'}
            onClick={() => void player.setShuffle(!state.shuffle)}
          >
            🔀
          </button>
        </div>
        <div className="player-bar__progress">
          <span className="player-bar__time">{formatDuration(state.position)}</span>
          <input
            type="range"
            className="slider"
            min={0}
            max={Math.max(1, Math.floor(state.duration))}
            value={Math.min(state.position, Math.max(1, Math.floor(state.duration)))}
            onChange={(event) => void player.seek(Number(event.target.value))}
            aria-label="播放进度"
          />
          <span className="player-bar__time">{formatDuration(state.duration)}</span>
          <span className="player-bar__percent" hidden>
            {progress}
          </span>
        </div>
        {state.error ? <div className="player-bar__error">{state.error}</div> : null}
      </div>

      <div className="player-bar__right">
        <QualityMenu player={player} />
        <button type="button" className="icon-button" title="播放队列" onClick={() => navigation.push({ name: 'nowPlaying' })}>
          ☰
        </button>
        <button
          type="button"
          className="icon-button"
          title={state.muted ? '取消静音' : '静音'}
          onClick={() => void player.setMuted(!state.muted)}
        >
          {state.muted ? '🔇' : '🔊'}
        </button>
        <input
          type="range"
          className="slider slider--volume"
          min={0}
          max={150}
          value={state.muted ? 0 : state.volume}
          onChange={(event) => void player.setVolume(Number(event.target.value))}
          aria-label="音量"
        />
      </div>
    </footer>
  )
}

function QualityMenu({ player }: { player: PlayerStore }): JSX.Element {
  const { state } = player
  const served = state.servedQuality && state.servedQuality !== state.quality ? state.servedQuality : undefined
  return (
    <label className="quality-select" title={served ? `实际播放音质：${QUALITY_LABELS[served]}` : '播放音质'}>
      <select value={state.quality} onChange={(event) => void player.setQuality(event.target.value)}>
        {Object.entries(QUALITY_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      {served ? <span className="quality-select__hint">实际 {QUALITY_LABELS[served]}</span> : null}
    </label>
  )
}
