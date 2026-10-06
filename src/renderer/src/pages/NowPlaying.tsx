/**
 * 全屏播放页。
 *
 * 用 portal 挂到 body 上，再 `position: fixed; inset: 0` 盖住侧栏与播放条 —— 不能只靠
 * fixed：应用外壳的 `.content` 带 backdrop-filter，它会给 fixed 后代重新建立包含块，
 * 那样全屏层只会铺满内容区而不是整个窗口。
 *
 * 数据来源仍然只有两个：播放状态来自 player store（主进程是权威），歌词来自
 * `lyrics:get`。所有的视觉效果（黑胶 / 胶片 / 波形 / 星海）与歌词特效都只是渲染
 * 方式，不参与取数；封面主色采样失败（CDN 无 CORS 头）时退回 CSS 里的强调色。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import {
  activeIndexOf,
  artistLine,
  call,
  coverUrl,
  formatDuration,
  isEmptyLyrics,
  onEvent,
  repeatLabel,
  useNavigation,
  usePlayerStore,
  wordProgress
} from '../lib/contract'
import {
  IconClose,
  IconDisc,
  IconDiamond,
  IconExpand,
  IconHome,
  IconLyrics,
  IconMic,
  IconMusic,
  IconNext,
  IconPause,
  IconPlay,
  IconPrevious,
  IconQueue,
  IconRepeat,
  IconRepeatOne,
  IconShuffle,
  IconSparkles,
  IconTrash,
  IconVolume,
  IconVolumeMute
} from '../components/Icons'
import type { LyricLineDTO, LyricsDTO, SettingsDTO } from '@shared/types'

interface Word {
  text: string
  start: number
  duration: number
}

/** 视觉特效，数组顺序就是切换顺序，默认第一个（黑胶）。 */
const VISUALS = [
  { value: 'vinyl', label: '黑胶' },
  { value: 'film', label: '胶片' },
  { value: 'waves', label: '波形' },
  { value: 'stars', label: '星海' }
] as const

type Visual = (typeof VISUALS)[number]['value']

/** 歌词特效，默认卡拉 OK。 */
const LYRIC_EFFECTS = [
  { value: 'karaoke', label: '卡拉OK' },
  { value: 'zoom', label: '渐变放大' },
  { value: 'fade', label: '淡入淡出' },
  { value: 'neon', label: '霓虹' }
] as const

type LyricEffect = (typeof LYRIC_EFFECTS)[number]['value']

/**
 * 波形条与星点的参数全部由下标算出，不用 Math.random：随机会让每次重渲染
 * 都跳一下，而这里要的是「一直跳但位置不变」。
 */
const WAVE_BARS = Array.from({ length: 28 }, (_, index) => 34 + ((index * 37) % 62))

const STARS = Array.from({ length: 30 }, (_, index) => ({
  x: (index * 37) % 100,
  y: (index * 61) % 100,
  size: 2 + (index % 3),
  delay: (index % 9) * 460,
  duration: 5200 + (index % 5) * 940,
  accent: index % 4 === 0
}))

/** 胶片的划痕：三条固定位置，靠动画错开出现。 */
const SCRATCHES = [
  { left: 18, delay: 0, duration: 5200 },
  { left: 52, delay: 1700, duration: 6800 },
  { left: 79, delay: 3200, duration: 4400 }
]

/** 效果选择的本地记忆：键名带 youyou- 前缀，读不到或值非法就回默认。 */
const VISUAL_KEY = 'youyou-now-playing-visual'
const LYRIC_EFFECT_KEY = 'youyou-now-playing-lyric'

function readStoredChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(key)
    return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
  } catch {
    // 隐私模式等场景下 localStorage 可能不可用 —— 回默认即可，不影响播放。
    return fallback
  }
}

function writeStoredChoice(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // 写不进去只是记不住选择，不该影响任何功能。
  }
}

export default function NowPlaying(): JSX.Element {
  const navigation = useNavigation()
  const player = usePlayerStore()
  const { state, current } = player

  const [visual, setVisual] = useState<Visual>(() =>
    readStoredChoice(
      VISUAL_KEY,
      VISUALS.map((item) => item.value),
      'vinyl'
    )
  )
  const [lyricEffect, setLyricEffect] = useState<LyricEffect>(() =>
    readStoredChoice(
      LYRIC_EFFECT_KEY,
      LYRIC_EFFECTS.map((item) => item.value),
      'karaoke'
    )
  )
  const [queueOpen, setQueueOpen] = useState(false)
  const [settings, setSettings] = useState<SettingsDTO | undefined>()
  const [lyrics, setLyrics] = useState<LyricsDTO | undefined>()
  const [lyricsLoading, setLyricsLoading] = useState(false)
  const [lyricsError, setLyricsError] = useState<string | undefined>()
  const [lyricsNonce, setLyricsNonce] = useState(0)
  const [follow, setFollow] = useState(true)
  // 系统级全屏（任务栏也盖住），由 window:* 通道切换。
  const [systemFullScreen, setSystemFullScreen] = useState(false)
  // 拖动中的进度/音量先存在本地，松手才发给主进程 —— 否则每一个像素都会变成一次 IPC。
  const [dragPosition, setDragPosition] = useState<number | undefined>(undefined)
  const [dragVolume, setDragVolume] = useState<number | undefined>(undefined)

  const trackID = current?.id

  /** 退出全屏就是回到进入前的路由；没有上一页（直接打开播放页）时回首页。 */
  const exit = useCallback((): void => {
    if (navigation.canGoBack) navigation.back()
    else navigation.push({ name: 'home' })
  }, [navigation])

  // 卸载时用 ref 判断，避免没进过系统全屏也白发一次 IPC。
  const systemFullScreenRef = useRef(false)
  useEffect(() => {
    systemFullScreenRef.current = systemFullScreen
  }, [systemFullScreen])

  /** 离开播放页时若还在系统全屏，顺手退出，免得回主界面还是全屏。 */
  useEffect(
    () => () => {
      if (systemFullScreenRef.current) void call('window:setFullScreen', { fullscreen: false }).catch(() => undefined)
    },
    []
  )

  /** 真全屏开关：返回值就是切换后的状态，直接拿来做按钮态。 */
  const toggleSystemFullScreen = useCallback((): void => {
    void call('window:toggleFullScreen')
      .then((value) => setSystemFullScreen(value === true))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // 由外到内逐层退出：先退系统全屏，再收队列抽屉，最后才退播放页全屏层。
      if (systemFullScreen) {
        setSystemFullScreen(false)
        void call('window:setFullScreen', { fullscreen: false }).catch(() => undefined)
        return
      }
      if (queueOpen) {
        setQueueOpen(false)
        return
      }
      exit()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [exit, queueOpen, systemFullScreen])

  // 桌面歌词开关放在播放页，因为「看歌词」是这里的动作；设置页改同一个值时
  // settings:changed 会把按钮状态同步回来（主进程是唯一数据源）。
  useEffect(() => {
    void call('settings:get')
      .then(setSettings)
      .catch(() => undefined)
    return onEvent('settings:changed', setSettings)
  }, [])

  /**
   * store 已经镜像了播放状态，这里再订阅一次 player:state 只为感知「快照到达」
   * 这个瞬间：换歌时把歌词自动跟随打开，用户在上一首手动滚动留下的暂停状态就
   * 不会带到下一首。
   */
  const lastTrackID = useRef<number | undefined>(undefined)
  useEffect(
    () =>
      onEvent('player:state', (next) => {
        if (next.track?.id === lastTrackID.current) return
        lastTrackID.current = next.track?.id
        setFollow(true)
      }),
    []
  )

  useEffect(() => {
    if (!trackID) {
      setLyrics(undefined)
      setLyricsError(undefined)
      setLyricsLoading(false)
      return
    }
    let cancelled = false
    setLyricsLoading(true)
    setLyricsError(undefined)
    setLyrics(undefined)
    void call('lyrics:get', { trackID })
      .then((value) => {
        if (!cancelled) setLyrics(value)
      })
      .catch((cause) => {
        if (!cancelled) setLyricsError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (!cancelled) setLyricsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [trackID, lyricsNonce])

  const activeIndex = useMemo(() => {
    if (!lyrics || isEmptyLyrics(lyrics)) return -1
    return activeIndexOf(lyrics, state.position)
  }, [lyrics, state.position])

  const accent = useArtworkAccent(current?.album.picUrl)

  // --- 歌词自动滚动 ------------------------------------------------------

  const listRef = useRef<HTMLDivElement | null>(null)
  const resumeTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!follow || activeIndex < 0) return
    const container = listRef.current
    if (!container) return
    /*
     * 当前行直接查 DOM，不用 ref 记元素：
     * 一个 ref 在同一次提交里可能先 attach 新的再 detach 旧的（React 按树序处理
     * ref），反向跳转时最后落地的是 detach，ref.current 会变成 null，滚动就被
     * 静默跳过了。而 `.is-active` 是 React 刚渲染出来的事实，永远指向正确的那一行。
     */
    const element = container.querySelector<HTMLLIElement>('.np-lyric.is-active')
    if (!element) return
    /*
     * 用两个 rect 相减求出「这一行相对滚动容器」的位置。
     * 不能用 element.offsetTop：offsetTop 是相对最近的**定位**祖先的，全屏层是
     * position: fixed，于是这个值里混进了顶栏与信息区的高度，算出来的 scrollTop
     * 会偏出一大截 —— 表现就是当前行跑到视野外，用户得自己往下拽。
     */
    const offset =
      element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
    const top = Math.max(0, offset - container.clientHeight / 2 + element.clientHeight / 2)
    const distance = Math.abs(container.scrollTop - top)
    // 已经在中央附近就不动，免得 4Hz 的播放位置更新把滚动条一直拽来拽去。
    if (distance < 4) return
    // 跨行跳转（换歌、拖动进度、切特效导致行高变化）直接定位：长距离的平滑动画
    // 既慢，又会被随后的重渲染打断，最后停在中途 —— 那正是「看不到当前行」的来源。
    // 只有相邻行的微调才用平滑滚动。
    container.scrollTo({
      top,
      behavior: distance > container.clientHeight * 1.5 ? 'auto' : 'smooth'
    })
    // lyricEffect 也在依赖里：切特效会改变行的排版（例如卡拉OK 多出一条进度条），
    // 切完立刻重新居中一次。
  }, [activeIndex, follow, lyrics, lyricEffect])

  useEffect(() => () => window.clearTimeout(resumeTimer.current), [])

  /** 用户主动滚动时暂停跟随，停手几秒后再跟上，避免和用户抢滚动条。 */
  const pauseFollow = (): void => {
    setFollow(false)
    window.clearTimeout(resumeTimer.current)
    resumeTimer.current = window.setTimeout(() => setFollow(true), 3500)
  }

  const desktopLyricsOn = settings?.showDesktopLyrics ?? false
  const lyricsFontSize = settings?.desktopLyricsFontSize ?? 28
  const style = accent
    ? ({ '--np-accent': accent.color, '--np-accent-deep': accent.deep } as CSSProperties)
    : undefined
  const cover = coverUrl(current?.album.picUrl, 640)

  const visualLabel = VISUALS.find((item) => item.value === visual)?.label ?? ''
  const lyricLabel = LYRIC_EFFECTS.find((item) => item.value === lyricEffect)?.label ?? ''

  /** 只切视觉，不碰播放：setState 不触发任何 player 命令。 */
  const cycleVisual = (): void => {
    setVisual((currentValue) => {
      const index = VISUALS.findIndex((item) => item.value === currentValue)
      return VISUALS[(index + 1) % VISUALS.length].value
    })
  }

  const cycleLyricEffect = (): void => {
    setLyricEffect((currentValue) => {
      const index = LYRIC_EFFECTS.findIndex((item) => item.value === currentValue)
      return LYRIC_EFFECTS[(index + 1) % LYRIC_EFFECTS.length].value
    })
  }

  // 记住上次选的效果；写失败也只是记不住，不影响播放。
  useEffect(() => writeStoredChoice(VISUAL_KEY, visual), [visual])
  useEffect(() => writeStoredChoice(LYRIC_EFFECT_KEY, lyricEffect), [lyricEffect])

  // --- 进度与音量 --------------------------------------------------------

  const durationMax = Math.max(1, Math.floor(state.duration))
  const shownPosition = Math.min(dragPosition ?? state.position, durationMax)
  const shownVolume = dragVolume ?? (state.muted ? 0 : state.volume)

  /** 拖动时只更新本地显示；松手（或键盘操作结束）才真正 seek 一次。 */
  const commitSeek = (): void => {
    if (dragPosition === undefined) return
    const target = dragPosition
    void player.seek(target).finally(() => setDragPosition(undefined))
  }

  const commitVolume = (): void => {
    if (dragVolume === undefined) return
    const target = dragVolume
    void player.setVolume(target).finally(() => setDragVolume(undefined))
  }

  return createPortal(
    <div className="np-fullscreen" style={style} role="dialog" aria-modal="true" aria-label="正在播放">
      <div className="np-fs__bg" aria-hidden="true">
        {cover ? <img className="np-fs__bg-art" src={cover} alt="" /> : null}
        <div className="np-fs__bg-scrim" />
      </div>

      <header className="np-fs__bar">
        {/* 全屏层的返回入口：按需求只留文字，不带箭头符号。 */}
        <button type="button" className="np-fs__back" onClick={exit}>
          返回
        </button>
        <div className="np-fs__heading">
          <span className="np-fs__heading-title">正在播放</span>
          {current ? <span className="np-fs__heading-sub">{current.album.name}</span> : null}
        </div>
        <div className="np-fs__bar-actions">
          <span className="np-header__hint">
            {state.playing ? <IconPause size={14} /> : <IconPlay size={14} />}
            {state.playing ? '播放中' : current ? '已暂停' : '未在播放'}
          </span>
          {/* 顺序/随机：单个点击切换按钮，图标是随机箭头，文案在「顺序播放 / 随机播放」之间切。 */}
          <button
            type="button"
            className={`np-fs__tool${state.shuffle ? ' is-active' : ''}`}
            title={state.shuffle ? '随机播放' : '顺序播放'}
            aria-label={state.shuffle ? '随机播放' : '顺序播放'}
            aria-pressed={state.shuffle}
            onClick={() => void player.setShuffle(!state.shuffle)}
          >
            <IconShuffle size={15} />
            {state.shuffle ? '随机播放' : '顺序播放'}
          </button>
          {/* 循环模式是另一个按钮，文案用 store 的 repeatLabel（不循环 / 循环全部 / 单曲循环），
              与随机按钮靠图标和文字双重区分，避免出现两个都写「顺序播放」的按钮。 */}
          <button
            type="button"
            className={`np-fs__tool${state.repeat !== 'off' ? ' is-active' : ''}`}
            title={repeatLabel(state.repeat)}
            aria-label={repeatLabel(state.repeat)}
            aria-pressed={state.repeat !== 'off'}
            onClick={() => void player.cycleRepeat()}
          >
            {state.repeat === 'one' ? <IconRepeatOne size={15} /> : <IconRepeat size={15} />}
            {repeatLabel(state.repeat)}
          </button>
          <button
            type="button"
            className={`np-fs__tool${desktopLyricsOn ? ' is-active' : ''}`}
            title="在桌面上显示歌词"
            aria-label={desktopLyricsOn ? '关闭桌面歌词' : '打开桌面歌词'}
            aria-pressed={desktopLyricsOn}
            onClick={() => void call('lyrics:desktopToggle', { visible: !desktopLyricsOn })}
          >
            <IconLyrics size={15} />
            桌面歌词
          </button>
          <button
            type="button"
            className={`np-fs__tool${systemFullScreen ? ' is-active' : ''}`}
            title={systemFullScreen ? '退出系统全屏' : '真全屏（覆盖任务栏）'}
            aria-label={systemFullScreen ? '退出系统全屏' : '进入系统全屏'}
            aria-pressed={systemFullScreen}
            onClick={toggleSystemFullScreen}
          >
            <IconExpand size={15} />
            真全屏
          </button>
          <button
            type="button"
            className={`np-fs__tool${queueOpen ? ' is-active' : ''}`}
            title="播放队列"
            aria-label="播放队列"
            aria-pressed={queueOpen}
            onClick={() => setQueueOpen((value) => !value)}
          >
            <IconQueue size={15} />
            队列
          </button>
        </div>
      </header>

      {!current ? (
        <div className="placeholder np-empty">
          <div className="placeholder__title">还没有正在播放的歌曲</div>
          <div>去首页挑一首，或者在搜索里找找想听的歌。</div>
          <button type="button" className="button button--primary" onClick={() => navigation.push({ name: 'home' })}>
            <IconHome size={16} />
            回到首页
          </button>
        </div>
      ) : (
        <div className="np-fs__main">
          <section className="np-fs__stage">
            <VisualStage visual={visual} cover={cover} playing={state.playing} title={current.name} />
          </section>

          <section className="np-fs__side">
            <div className="np-fs__meta">
              <h1 className="np-fs__title" title={current.name}>
                {current.name}
              </h1>
              <div className="np-fs__artist">{artistLine(current)}</div>
              <div className="np-fs__album">{current.album.name}</div>
              <div className="np-cover__badges">
                {current.isCloud ? <span className="badge">云盘</span> : null}
              </div>
              <div className="np-cover__controls">
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
                  {state.playing ? <IconPause size={18} /> : <IconPlay size={18} />}
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
              </div>

              {/* 细进度条 + 音量：拖动时只更新本地显示，松手才发一次 IPC。 */}
              <div className="np-fs__transport">
                <div className="np-fs__progress">
                  <span className="np-fs__time">{formatDuration(shownPosition)}</span>
                  <input
                    type="range"
                    className="slider np-fs__range"
                    min={0}
                    max={durationMax}
                    value={Math.floor(shownPosition)}
                    aria-label="播放进度"
                    onChange={(event) => setDragPosition(Number(event.target.value))}
                    onPointerUp={commitSeek}
                    onKeyUp={commitSeek}
                    onBlur={commitSeek}
                  />
                  <span className="np-fs__time">{formatDuration(state.duration)}</span>
                </div>
                <div className="np-fs__volume">
                  <button
                    type="button"
                    className="icon-button"
                    title={state.muted ? '取消静音' : '静音'}
                    aria-label={state.muted ? '取消静音' : '静音'}
                    aria-pressed={state.muted}
                    onClick={() => void player.setMuted(!state.muted)}
                  >
                    {state.muted ? <IconVolumeMute size={16} /> : <IconVolume size={16} />}
                  </button>
                  <input
                    type="range"
                    className="slider np-fs__range np-fs__range--volume"
                    min={0}
                    max={150}
                    value={shownVolume}
                    aria-label="音量"
                    onChange={(event) => setDragVolume(Number(event.target.value))}
                    onPointerUp={commitVolume}
                    onKeyUp={commitVolume}
                    onBlur={commitVolume}
                  />
                  <span className="np-fs__time">{Math.round(shownVolume)}%</span>
                </div>
              </div>
            </div>

            <div className="np-lyrics np-fs__lyrics">
              <div className="section__header np-lyrics__header">
                <h2 className="section__title">
                  <IconMusic size={16} className="section__icon" />
                  歌词
                </h2>
                {lyrics?.contributor ? <span className="section__more">贡献者：{lyrics.contributor}</span> : null}
              </div>

              {lyricsLoading ? (
                <div className="placeholder np-lyrics__state">
                  <div className="loading-state">
                    <IconDisc size={18} className="spin" />
                    <span>正在加载歌词…</span>
                  </div>
                </div>
              ) : lyricsError ? (
                <div className="placeholder np-lyrics__state">
                  <div className="placeholder__title">歌词加载失败</div>
                  <div>{lyricsError}</div>
                  <button type="button" className="button" onClick={() => setLyricsNonce((value) => value + 1)}>
                    重试
                  </button>
                </div>
              ) : !lyrics || isEmptyLyrics(lyrics) ? (
                <div className="placeholder np-lyrics__state">
                  {lyrics?.isInstrumental ? <IconMic size={26} className="np-lyrics__note" /> : null}
                  <div className="placeholder__title">
                    {lyrics?.isInstrumental ? '纯音乐，请欣赏' : '这首歌暂时没有歌词'}
                  </div>
                </div>
              ) : (
                <div
                  className={`np-lyrics__list np-lyrics__list--${lyricEffect}`}
                  ref={listRef}
                  onWheel={pauseFollow}
                  onTouchMove={pauseFollow}
                  style={{ fontSize: lyricsFontSize }}
                >
                  <ol className="np-lyrics__lines">
                    {lyrics.lines.map((line, index) => (
                      <LyricRow
                        key={`${line.id}-${index}`}
                        line={line}
                        active={index === activeIndex}
                        position={state.position}
                        effect={lyricEffect}
                        onSeek={() => void player.seek(line.time)}
                      />
                    ))}
                  </ol>
                  <div className="np-lyrics__footer">
                    {lyrics.translationContributor ? `翻译贡献者：${lyrics.translationContributor}` : ''}
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {/* 右下角：视觉效果与歌词特效各一个循环切换按钮，只改渲染方式。 */}
      <div className="np-fs__tools">
        <button type="button" className="np-fs__tool" onClick={cycleVisual} title="切换视觉效果" aria-label={`切换视觉效果，当前：${visualLabel}`}>
          <IconSparkles size={15} />
          {visualLabel}
        </button>
        <button
          type="button"
          className="np-fs__tool"
          onClick={cycleLyricEffect}
          title="切换歌词特效"
          aria-label={`切换歌词特效，当前：${lyricLabel}`}
        >
          <IconDiamond size={15} />
          {lyricLabel}
        </button>
      </div>

      <div
        className={`np-drawer__scrim${queueOpen ? ' is-open' : ''}`}
        onClick={() => setQueueOpen(false)}
        aria-hidden="true"
      />
      <aside className={`np-drawer${queueOpen ? ' is-open' : ''}`} aria-hidden={!queueOpen} aria-label="播放队列">
        <div className="section__header np-queue__header">
          <h2 className="section__title">
            <IconQueue size={16} className="section__icon" />
            播放队列
          </h2>
          <span className="section__more">{state.queue.length} 首</span>
          <button
            type="button"
            className="icon-button"
            title="收起队列"
            aria-label="收起队列"
            onClick={() => setQueueOpen(false)}
          >
            <IconClose size={15} />
          </button>
          {state.queue.length > 0 ? (
            <button
              type="button"
              className="icon-button"
              title="清空队列"
              aria-label="清空队列"
              onClick={() => void player.clearQueue()}
            >
              <IconTrash size={16} />
            </button>
          ) : null}
        </div>

        {state.queue.length === 0 ? (
          <div className="page__empty">队列是空的</div>
        ) : (
          <ol className="np-queue__list">
            {state.queue.map((track, index) => (
              <li
                key={`${track.id}-${index}`}
                className={`np-queue__item${index === state.index ? ' is-current' : ''}`}
              >
                <button
                  type="button"
                  className="np-queue__play"
                  title="播放这首"
                  aria-label={`播放 ${track.name}`}
                  // 契约里没有「跳到第 N 首」的通道，重排同一份队列并指定起始
                  // 下标是等价的做法，队列内容不会因此改变。
                  onClick={() => void player.playTracks(state.queue, index)}
                >
                  <span className="np-queue__index">
                    {index === state.index ? <IconPlay size={11} /> : index + 1}
                  </span>
                  <span className="np-queue__meta">
                    <span className="np-queue__name">{track.name}</span>
                    <span className="np-queue__artist">{artistLine(track)}</span>
                  </span>
                  <span className="np-queue__duration">{formatDuration(track.durationMS / 1000)}</span>
                </button>
                <button
                  type="button"
                  className="icon-button np-queue__remove"
                  title="从队列移除"
                  aria-label={`从队列移除 ${track.name}`}
                  onClick={() => void player.removeAt([index])}
                >
                  <IconClose size={14} />
                </button>
              </li>
            ))}
          </ol>
        )}
      </aside>
    </div>,
    document.body
  )
}

/** 封面舞台：四种视觉共用同一个封面 URL，各自换一种呈现方式。 */
function VisualStage({
  visual,
  cover,
  playing,
  title
}: {
  visual: Visual
  cover?: string
  playing: boolean
  title: string
}): JSX.Element {
  const art = cover ? (
    <img src={cover} alt={`${title} 封面`} />
  ) : (
    <span className="card__placeholder">
      <IconMusic size={34} />
    </span>
  )
  // 播放中才转/才跳：暂停时同样保留静态画面，不闪不空。
  const motion = playing ? ' is-playing' : ''

  if (visual === 'film') {
    return (
      <div className={`np-film${motion}`}>
        <div className="np-film__frame">
          <span className="np-film__perfs" aria-hidden="true" />
          <div className="np-film__window">
            {art}
            <span className="np-film__grain" aria-hidden="true" />
            {SCRATCHES.map((scratch, index) => (
              <span
                key={index}
                className="np-film__scratch"
                aria-hidden="true"
                style={{
                  left: `${scratch.left}%`,
                  animationDelay: `${scratch.delay}ms`,
                  animationDuration: `${scratch.duration}ms`
                }}
              />
            ))}
          </div>
          <span className="np-film__perfs" aria-hidden="true" />
        </div>
      </div>
    )
  }

  if (visual === 'waves') {
    return (
      <div className={`np-waves${motion}`}>
        <div className="np-waves__art">{art}</div>
        <div className="np-waves__bars" aria-hidden="true">
          {WAVE_BARS.map((height, index) => (
            <span
              key={index}
              className="np-waves__bar"
              style={{
                height: `${height}%`,
                animationDelay: `${index * 80}ms`,
                animationDuration: `${900 + (index % 5) * 140}ms`
              }}
            />
          ))}
        </div>
      </div>
    )
  }

  if (visual === 'stars') {
    return (
      <div className={`np-stars${motion}`}>
        <div className="np-stars__field" aria-hidden="true">
          {STARS.map((star, index) => (
            <span
              key={index}
              className={`np-stars__dot${star.accent ? ' np-stars__dot--accent' : ''}`}
              style={{
                left: `${star.x}%`,
                top: `${star.y}%`,
                width: star.size,
                height: star.size,
                animationDelay: `${star.delay}ms`,
                animationDuration: `${star.duration}ms`
              }}
            />
          ))}
        </div>
        <div className="np-stars__art">{art}</div>
      </div>
    )
  }

  return (
    <div className={`np-vinyl${motion}`}>
      <div className="np-vinyl__disc">
        <span className="np-vinyl__sheen" aria-hidden="true" />
        <div className="np-vinyl__label">{art}</div>
        <span className="np-vinyl__hole" aria-hidden="true" />
      </div>
    </div>
  )
}

/**
 * 一行歌词。
 *
 * 四种特效只是同一份数据的不同画法：卡拉 OK 用逐字时间戳切片点亮（words 存在
 * 时），其余三种按整行处理。`activeIndexOf` / `wordProgress` 的算法原样保留，
 * 这里只决定怎么把结果画出来。
 */
function LyricRow({
  line,
  active,
  position,
  effect,
  onSeek
}: {
  line: LyricLineDTO
  active: boolean
  position: number
  effect: LyricEffect
  onSeek: () => void
}): JSX.Element {
  const words: Word[] = line.words ?? []
  const karaoke = effect === 'karaoke' && words.length > 0
  const progress = active && karaoke ? wordProgress(line, position) : 0

  return (
    <li className={`np-lyric np-lyric--${effect}${active ? ' is-active' : ''}`}>
      <button type="button" className="np-lyric__button" onClick={onSeek} title="跳到这一句">
        {karaoke ? (
          <span className="np-lyric__text">
            {words.map((word, index) => {
              const ratio = wordRatio(word, position) * 100
              return (
                <span
                  key={`${word.start}-${index}`}
                  className="np-lyric__word"
                  style={{
                    // 已唱部分用强调色、未唱部分用次级文字色，两段拼成一条渐变。
                    backgroundImage: `linear-gradient(90deg, var(--np-accent) ${ratio}%, var(--np-lyric-dim) ${ratio}%)`
                  }}
                >
                  {word.text}
                </span>
              )
            })}
          </span>
        ) : (
          <span className="np-lyric__text">{line.text}</span>
        )}
        {line.romaji ? <span className="np-lyric__romaji">{line.romaji}</span> : null}
        {line.translation ? <span className="np-lyric__translation">{line.translation}</span> : null}
      </button>
      {active && karaoke ? (
        <span className="np-lyric__bar">
          <span className="np-lyric__bar-fill" style={{ width: `${progress * 100}%` }} />
        </span>
      ) : null}
    </li>
  )
}

function wordRatio(word: Word, position: number): number {
  if (position <= word.start) return 0
  if (word.duration <= 0 || position >= word.start + word.duration) return 1
  return (position - word.start) / word.duration
}

/**
 * 从封面取一个主色，用作页面强调色。
 *
 * 图片必须带 crossOrigin 才能读像素：CDN 不给 CORS 头时 onerror 直接触发，
 * 这里静默退回 undefined，由 CSS 里的 `--np-accent` 兜底；封面本身走另一个
 * 普通 <img>，显示不受影响。
 */
function useArtworkAccent(picUrl: string | undefined): { color: string; deep: string } | undefined {
  const [accent, setAccent] = useState<{ color: string; deep: string } | undefined>()

  useEffect(() => {
    const url = coverUrl(picUrl, 96)
    if (!url) {
      setAccent(undefined)
      return
    }
    let cancelled = false
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      if (cancelled) return
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 8
        canvas.height = 8
        const context = canvas.getContext('2d')
        if (!context) return
        context.drawImage(image, 0, 0, 8, 8)
        setAccent(sampleAccent(context.getImageData(0, 0, 8, 8).data))
      } catch {
        // 画布被跨域图片污染 —— 不影响播放，只是没有主色可用。
        setAccent(undefined)
      }
    }
    image.onerror = () => {
      if (!cancelled) setAccent(undefined)
    }
    image.src = url
    return () => {
      cancelled = true
      image.onload = null
      image.onerror = null
    }
  }, [picUrl])

  return accent
}

/** 8×8 缩略图的加权平均：越鲜艳、越不透明的像素权重越高。 */
function sampleAccent(pixels: Uint8ClampedArray): { color: string; deep: string } | undefined {
  let red = 0
  let green = 0
  let blue = 0
  let weight = 0
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3] / 255
    const max = Math.max(pixels[index], pixels[index + 1], pixels[index + 2])
    const min = Math.min(pixels[index], pixels[index + 1], pixels[index + 2])
    const saturation = max === 0 ? 0 : (max - min) / max
    const current = alpha * (0.25 + saturation)
    red += pixels[index] * current
    green += pixels[index + 1] * current
    blue += pixels[index + 2] * current
    weight += current
  }
  if (weight <= 0) return undefined
  const r = red / weight
  const g = green / weight
  const b = blue / weight
  // 太亮或太暗的主色会让逐字高亮读不出来（浅色封面在浅色主题上尤其明显），
  // 这种情况宁可退回设计令牌里的强调色。
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  if (luminance > 190 || luminance < 22) return undefined
  return { color: toHex(r, g, b), deep: toHex(r * 0.62, g * 0.62, b * 0.62) }
}

function toHex(red: number, green: number, blue: number): string {
  const channel = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0')
  return `#${channel(red)}${channel(green)}${channel(blue)}`
}
