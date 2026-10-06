/**
 * 播放条：玻璃底 + 线性图标。
 *
 * 布局沿用 macOS 版底部条的分工：左侧是封面与曲目信息（点封面进播放页），
 * 中间是传输控件与进度，右侧是音质、队列与音量。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  usePlayerStore,
  cyclePlayMode,
  currentPlayMode,
  playModeLabel
} from '../store/player'
import { useNavigation } from '../store/navigation'
import { useAuthStore } from '../store/auth'
import { call } from '../lib/ipc'
import { artistLine, coverUrl, formatDuration } from '../lib/format'
import {
  IconHeart,
  IconHeartFilled,
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

/** 四种播放模式各自的图标（用户只看到一个按钮，图标随模式变化）。 */
function modeIcon(mode: ReturnType<typeof currentPlayMode>): JSX.Element {
  switch (mode) {
    case 'shuffle':
      return <IconShuffle size={15} />
    case 'repeatOne':
      return <IconRepeatOne size={15} />
    default:
      return <IconRepeat size={15} />
  }
}

export default function PlayerBar(): JSX.Element {
  const player = usePlayerStore()
  const navigation = useNavigation()
  const auth = useAuthStore()
  const { state, current } = player

  const [liked, setLiked] = useState(false)
  const likePending = useRef(false)
  const trackId = current?.id

  useEffect(() => {
    if (!auth.loggedIn || trackId === undefined) {
      setLiked(false)
      return
    }
    let cancelled = false
    void call('library:overview')
      .then((overview) => {
        if (!cancelled) setLiked(overview.likedTrackIDs.includes(trackId))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [auth.loggedIn, trackId])

  const toggleLike = async (): Promise<void> => {
    if (!auth.loggedIn || !current) {
      navigation.push({ name: 'library' })
      return
    }
    // 连点保护：请求在途时忽略后续点击。之前没有这层保护，快速连点会出现
    // 「点了没反应、要反复点几次」——多个写入互相覆盖/回滚。
    if (likePending.current) return
    likePending.current = true
    const next = !liked
    setLiked(next)
    try {
      await call('library:likeTrack', { id: current.id, like: next })
    } catch {
      setLiked(!next)
    } finally {
      likePending.current = false
    }
  }

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
        <button
          type="button"
          className={`player-bar__like${liked ? ' is-active' : ''}`}
          title={liked ? '取消喜欢' : '喜欢'}
          aria-label={liked ? '取消喜欢' : '喜欢'}
          onClick={() => void toggleLike()}
        >
          {liked ? <IconHeartFilled size={18} /> : <IconHeart size={18} />}
        </button>
      </div>

      <div className="player-bar__center">
        <div className="player-bar__controls">
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
          {/* 播放模式：只有一个按钮，点击在 4 种模式间循环。 */}
          <button
            type="button"
            className="player-bar__mode-toggle"
            title={`播放模式：${playModeLabel(state.shuffle, state.repeat)}（点击切换）`}
            aria-label={`播放模式：${playModeLabel(state.shuffle, state.repeat)}，点击切换`}
            onClick={() => void cyclePlayMode(player, state.shuffle, state.repeat)}
          >
            {modeIcon(currentPlayMode(state.shuffle, state.repeat))}
            {playModeLabel(state.shuffle, state.repeat)}
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
