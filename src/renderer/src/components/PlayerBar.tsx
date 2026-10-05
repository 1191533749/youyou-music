/**
 * 播放条：玻璃底 + 线性图标。
 *
 * 布局沿用 macOS 版底部条的分工：左侧是封面与曲目信息（点封面进播放页），
 * 中间是传输控件与进度，右侧是音质、队列与音量。
 */
import { useMemo } from 'react'
import { usePlayerStore, repeatLabel } from '../store/player'
import { useNavigation } from '../store/navigation'
import { artistLine, coverUrl, formatDuration } from '../lib/format'
import {
  IconMore,
  IconMusic,
  IconNext,
  IconPause,
  IconPlay,
  IconPrevious,
  IconQueue,
  IconRepeat,
  IconRepeatOne,
  IconShuffle,
  IconVolume,
  IconVolumeMute
} from './Icons'
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

  const max = Math.max(1, Math.floor(state.duration))

  return (
    <footer className="player-bar" data-testid="player-bar">
      <div className="player-bar__now">
        <button
          type="button"
          className="player-bar__art"
          title="打开播放页"
          onClick={() => navigation.push({ name: 'nowPlaying' })}
        >
          {coverUrl(current?.album.picUrl, 120) ? (
            <img src={coverUrl(current?.album.picUrl, 120)} alt="" />
          ) : (
            <span className="player-bar__art-placeholder">
              <IconMusic size={22} />
            </span>
          )}
        </button>
        <div className="player-bar__meta">
          <div className="player-bar__title" title={current?.name}>
            {current?.name ?? '未在播放'}
          </div>
          <div className="player-bar__artist">
            {current ? artistLine(current) : '选择一首歌开始'}
          </div>
        </div>
      </div>

      <div className="player-bar__center">
        <div className="player-bar__controls">
          <button
            type="button"
            className={`icon-button${state.repeat !== 'off' ? ' is-active' : ''}`}
            title={repeatLabel(state.repeat)}
            aria-label={repeatLabel(state.repeat)}
            onClick={() => void player.cycleRepeat()}
          >
            {state.repeat === 'one' ? <IconRepeatOne size={18} /> : <IconRepeat size={18} />}
          </button>
          <button
            type="button"
            className="icon-button"
            title="上一首"
            aria-label="上一首"
            onClick={() => void player.previous()}
          >
            <IconPrevious size={18} />
          </button>
          <button
            type="button"
            className="icon-button icon-button--primary"
            title={state.playing ? '暂停' : '播放'}
            aria-label={state.playing ? '暂停' : '播放'}
            onClick={() => void player.toggle()}
          >
            {state.loading ? <IconMore size={18} /> : state.playing ? <IconPause size={18} /> : <IconPlay size={18} />}
          </button>
          <button
            type="button"
            className="icon-button"
            title="下一首"
            aria-label="下一首"
            onClick={() => void player.next()}
          >
            <IconNext size={18} />
          </button>
          <button
            type="button"
            className={`icon-button${state.shuffle ? ' is-active' : ''}`}
            title={state.shuffle ? '随机播放：开' : '随机播放：关'}
            aria-label="随机播放"
            onClick={() => void player.setShuffle(!state.shuffle)}
          >
            <IconShuffle size={18} />
          </button>
        </div>
        <div className="player-bar__progress">
          <span className="player-bar__time">{formatDuration(state.position)}</span>
          <input
            type="range"
            className="slider"
            min={0}
            max={max}
            value={Math.min(state.position, max)}
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
        <button
          type="button"
          className="icon-button"
          title="播放队列"
          aria-label="播放队列"
          onClick={() => navigation.push({ name: 'nowPlaying' })}
        >
          <IconQueue size={18} />
        </button>
        <button
          type="button"
          className="icon-button"
          title={state.muted ? '取消静音' : '静音'}
          aria-label={state.muted ? '取消静音' : '静音'}
          onClick={() => void player.setMuted(!state.muted)}
        >
          {state.muted ? <IconVolumeMute size={18} /> : <IconVolume size={18} />}
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
  // 音质策略：达不到所选音质时自动降档（主进程保证），
  // 界面不提示、不虚报、不说来源——只保留用户的首选档位控件。
  return (
    <label className="quality-select" title="首选音质；达不到时自动降至可播放的最高音质">
      <select
        value={state.quality}
        aria-label="首选音质"
        onChange={(event) => void player.setQuality(event.target.value)}
      >
        {Object.entries(QUALITY_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  )
}
