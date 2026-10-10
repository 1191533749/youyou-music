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
import { call, onEvent } from '../lib/ipc'
import { clearLikeOverride, isLiked, markLike } from '../lib/likes'
import { useFullscreenIdle } from '../lib/fullscreenIdle'
import { artistLine, coverUrl, formatDuration } from '../lib/format'
import { useImageReady } from './FishAvatar'
import {
  IconDisc,
  IconHeart,
  IconHeartFilled,
  IconLyrics,
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

  /**
   * 真全屏空闲时收起控件挂在播放条上：它是应用外壳里唯一常驻的组件，
   * 这样不用改 App.tsx 的结构就能一直盯着全屏状态（详见 lib/fullscreenIdle.ts）。
   */
  useFullscreenIdle()

  // 专辑封面缺席时退回歌手头像；图没加载完不渲染 <img>，因此既没有破图也没有半成品闪烁。
  const artURL = coverUrl(current?.album.picUrl, 120) ?? coverUrl(current?.artists[0]?.picUrl, 120)
  const artReady = useImageReady(artURL)

  /**
   * 播放/暂停要立刻有反应：主进程广播有往返延迟，先本地翻转图标与文案，
   * 广播回来（最多 1.5 秒兜底）再交还权威状态，否则按下去像没反应。
   */
  const [playIntent, setPlayIntent] = useState<boolean | undefined>(undefined)
  const intentTimer = useRef<number | undefined>(undefined)
  useEffect(() => {
    setPlayIntent(undefined)
    window.clearTimeout(intentTimer.current)
  }, [state.playing])
  useEffect(() => () => window.clearTimeout(intentTimer.current), [])
  const shownPlaying = playIntent ?? state.playing
  const togglePlayback = (): void => {
    setPlayIntent(!shownPlaying)
    window.clearTimeout(intentTimer.current)
    intentTimer.current = window.setTimeout(() => setPlayIntent(undefined), 1500)
    void player.toggle()
  }

  /**
   * 桌面歌词的显示状态归主进程设置管，播放条只镜像一份用来点亮按钮：
   * settings:get 取初值，settings:changed 保证在播放页或设置页改完两边同步。
   */
  const [desktopLyrics, setDesktopLyrics] = useState(false)
  useEffect(() => {
    void call('settings:get')
      .then((next) => setDesktopLyrics(next.showDesktopLyrics))
      .catch(() => undefined)
    return onEvent('settings:changed', (next) => setDesktopLyrics(next.showDesktopLyrics))
  }, [])

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
        // 本地覆盖优先：刚点的喜欢/取消不会被还没更新的服务器列表盖回去。
        if (!cancelled) setLiked(isLiked(trackId, overview.likedTrackIDs))
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
    markLike(current.id, next)
    try {
      await call('library:likeTrack', { id: current.id, like: next })
    } catch {
      clearLikeOverride(current.id)
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
          {artURL && artReady ? (
            <img src={artURL} alt="" />
          ) : (
            <span className="player-bar__art-placeholder" aria-hidden="true">
              <IconMusic size={20} />
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
            title={shownPlaying ? '暂停' : '播放'}
            aria-label={shownPlaying ? '暂停' : '播放'}
            aria-pressed={shownPlaying}
            aria-busy={state.loading}
            onClick={togglePlayback}
          >
            {state.loading ? (
              <IconDisc size={18} className="spin" />
            ) : shownPlaying ? (
              <IconPause size={18} />
            ) : (
              <IconPlay size={18} />
            )}
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
          className={`icon-button${desktopLyrics ? ' is-active' : ''}`}
          title={desktopLyrics ? '隐藏桌面歌词' : '显示桌面歌词'}
          aria-label={desktopLyrics ? '隐藏桌面歌词' : '显示桌面歌词'}
          aria-pressed={desktopLyrics}
          onClick={() => void call('lyrics:desktopToggle', { visible: !desktopLyrics })}
        >
          <IconLyrics size={18} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="播放队列"
          aria-label="播放队列"
          // 打开播放页并直接展开队列抽屉：以前只跳页面，用户看不到队列。
          onClick={() => navigation.push({ name: 'nowPlaying', openQueue: true })}
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
  // 站外曲目（汽水/酷狗/酷我 搜索来的歌）没有「首选音质」这一说：不允许切换，
  // 只如实显示音源给到的档位。
  const external = typeof state.track?.id === 'number' && state.track.id < 0
  /*
   * 显示规则（用户要求）：**设置里的首选音质达不到时，这里直接显示真实音质**。
   * servedQuality 是主进程解析出的实际档位（例如设置选母带、音源只给到无损，
   * 这里就显示「无损」）。
   * 换源播放（servedFrom 有值）时接口没声明档位，主进程会读 mpv 的真实码率补上；
   * 万一还没读到，就先保守显示「标准」，绝不上抬成用户的「母带」这类首选值。
   */
  const served = state.servedQuality
  const display = (served ?? (state.servedFrom ? 'standard' : state.quality)) as keyof typeof QUALITY_LABELS

  if (external) {
    return (
      <label className="quality-select" title="站外曲目，音质以音源提供为准">
        <select value={display} disabled aria-label="实际音质">
          <option value={display}>{QUALITY_LABELS[display] ?? '标准'}</option>
        </select>
      </label>
    )
  }

  const belowPreference = served !== undefined && served !== state.quality
  return (
    <label
      className="quality-select"
      title={
        belowPreference
          ? `实际音质：${QUALITY_LABELS[display] ?? display}（首选 ${QUALITY_LABELS[state.quality] ?? state.quality}，音源给不到自动降档）`
          : '首选音质；达不到时自动降至可播放的最高音质并如实显示'
      }
    >
      <select
        value={display}
        aria-label="音质"
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
