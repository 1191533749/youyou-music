/**
 * Desktop lyrics window.
 *
 * A frameless, transparent, always-on-top strip that follows playback: the same
 * feature the macOS client calls 桌面歌词. It renders the current line and its
 * translation, and drags the window with `-webkit-app-region` so no IPC is
 * needed for movement.
 *
 * 本轮两件事：
 *   1. 窗口只罩住内容 —— ResizeObserver 量内容高度（当前行 + 翻译），防抖后上报
 *      lyrics:desktopResize，主进程据此收紧窗口，透明区域不再盖住桌面。
 *   2. 点击穿透 —— 鼠标不在歌词上时上报 lyrics:desktopClickThrough(through: true)，
 *      主进程用 setIgnoreMouseEvents(forward: true) 既穿透又能继续收到 mousemove。
 *
 * 特效由设置页选择（settings.desktopLyricsEffect），本窗口只负责渲染，不再提供切换按钮。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { call, onEvent } from '../lib/ipc'
import {
  type DesktopLyricsEffect,
  type LyricsDTO,
  type PlayerStateDTO,
  type SettingsDTO
} from '@shared/types'
import { activeIndexOf } from '../lib/lyricsUtils'
import './desktop-lyrics.css'

/** 窗口里真正用到的三个设置项，避免把整份 SettingsDTO 塞进 state。 */
interface LyricPreferences {
  fontSize: number
  opacity: number
  effect: DesktopLyricsEffect
}

/** settings:changed 与 settings:get 走同一套映射，两处不会走样。 */
function toPreferences(settings: SettingsDTO): LyricPreferences {
  return {
    fontSize: settings.desktopLyricsFontSize,
    opacity: settings.desktopLyricsOpacity,
    effect: settings.desktopLyricsEffect
  }
}

/**
 * 单个词的演唱进度 0–1：未唱到为 0，唱完为 1，正在唱按时间线性插值。
 * 比整行插值更贴近逐字卡拉OK（整行进度会平均掉词与词之间的停顿）。
 */
function wordFill(word: { start: number; duration: number }, position: number): number {
  if (word.duration <= 0) return position >= word.start ? 1 : 0
  if (position <= word.start) return 0
  return Math.min(1, (position - word.start) / word.duration)
}

/** 内容变化到上报窗口尺寸之间的防抖；换行时高度会连跳几次，攒一下再发。 */
const RESIZE_DEBOUNCE_MS = 80
/** 命中测试的节流；50ms 足以跟手，又不会让 mousemove 变成 IPC 洪流。 */
const HIT_TEST_THROTTLE_MS = 50

export default function DesktopLyrics(): JSX.Element {
  const [player, setPlayer] = useState<PlayerStateDTO | undefined>()
  const [lyrics, setLyrics] = useState<LyricsDTO | undefined>()
  const [preferences, setPreferences] = useState<LyricPreferences>({
    fontSize: 28,
    opacity: 0.92,
    effect: 'classic'
  })

  useEffect(() => {
    void call('player:state').then(setPlayer).catch(() => undefined)
    const offPlayer = onEvent('player:state', setPlayer)
    const offSettings = onEvent('settings:changed', (next) => setPreferences(toPreferences(next)))
    void call('settings:get')
      .then((current) => setPreferences(toPreferences(current)))
      .catch(() => undefined)
    return () => {
      offPlayer()
      offSettings()
    }
  }, [])

  const trackID = player?.track?.id
  useEffect(() => {
    if (!trackID) {
      setLyrics(undefined)
      return
    }
    let cancelled = false
    void call('lyrics:get', { trackID })
      .then((result) => {
        if (!cancelled) setLyrics(result)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [trackID])

  const current = useMemo(() => {
    if (!lyrics || lyrics.empty) return undefined
    const index = activeIndexOf(lyrics, player?.position ?? 0)
    return index >= 0 ? lyrics.lines[index] : lyrics.lines[0]
  }, [lyrics, player?.position])

  const { fontSize, opacity, effect } = preferences

  // --- 窗口只罩住内容 -----------------------------------------------------

  const dragRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = dragRef.current
    if (!element) return
    let timer: number | undefined

    const report = (): void => {
      timer = undefined
      const parent = element.parentElement
      const styles = parent ? window.getComputedStyle(parent) : undefined
      // 外层还有上下内边距（global.css 的 .desktop-lyrics），不加进去字会被裁掉。
      const padding = styles
        ? (Number.parseFloat(styles.paddingTop) || 0) + (Number.parseFloat(styles.paddingBottom) || 0)
        : 0
      const height = Math.ceil(element.getBoundingClientRect().height + padding)
      // 宽度保持主进程当前的 560，不上报。
      if (height > 0) void call('lyrics:desktopResize', { height }).catch(() => undefined)
    }

    // observe() 会立刻回调一次，正好把初始高度发出去。
    const observer = new ResizeObserver(() => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(report, RESIZE_DEBOUNCE_MS)
    })
    observer.observe(element)
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [])

  // --- 点击穿透 -----------------------------------------------------------

  // 主进程默认不忽略鼠标事件；只有确认鼠标离开歌词后才切成穿透。
  const throughRef = useRef(false)
  const lastHitTestRef = useRef(0)
  const trailingHitTestRef = useRef<number | undefined>(undefined)

  const setThrough = useCallback((next: boolean) => {
    if (next === throughRef.current) return
    throughRef.current = next
    void call('lyrics:desktopClickThrough', { through: next }).catch(() => undefined)
  }, [])

  const handleMouseMove = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target
      const interactive = target instanceof Element && target.closest('.desktop-lyrics__drag') !== null
      const now = Date.now()
      if (now - lastHitTestRef.current >= HIT_TEST_THROTTLE_MS) {
        lastHitTestRef.current = now
        setThrough(!interactive)
        return
      }
      // 节流窗口内的最后一次移动仍要生效：否则快速划出文字区会停在「可交互」上，
      // 透明区域继续吃掉点击。
      if (trailingHitTestRef.current !== undefined) window.clearTimeout(trailingHitTestRef.current)
      trailingHitTestRef.current = window.setTimeout(() => {
        trailingHitTestRef.current = undefined
        lastHitTestRef.current = Date.now()
        setThrough(!interactive)
      }, HIT_TEST_THROTTLE_MS)
    },
    [setThrough]
  )

  useEffect(
    () => () => {
      if (trailingHitTestRef.current !== undefined) window.clearTimeout(trailingHitTestRef.current)
    },
    []
  )

  const position = player?.position ?? 0
  // 只有逐字特效才拆词；其余特效（以及没有逐字时间轴的行）都整行显示。
  const words = effect === 'karaoke' ? current?.words : undefined
  const line = current?.text ?? (player?.track ? '正在载入歌词' : '悠悠音乐 桌面歌词')

  return (
    <div
      className={`desktop-lyrics desktop-lyrics--${effect}`}
      style={{ fontSize, opacity }}
      title="拖动可移动 · 右键任务栏图标可关闭"
      onMouseMove={handleMouseMove}
    >
      <div ref={dragRef} className="desktop-lyrics__drag">
        <div className="desktop-lyrics__line">
          {words && words.length > 0
            ? words.map((word, index) => (
                <span
                  key={`${index}-${word.start}`}
                  className="desktop-lyrics__word"
                  // --fill 是 CSS 侧注册过的可动画自定义属性，见 desktop-lyrics.css。
                  style={{ '--fill': `${(wordFill(word, position) * 100).toFixed(1)}%` } as CSSProperties}
                >
                  {word.text}
                </span>
              ))
            : line}
        </div>
        {current?.translation ? (
          <div className="desktop-lyrics__translation" style={{ fontSize: fontSize * 0.62 }}>
            {current.translation}
          </div>
        ) : null}
      </div>
    </div>
  )
}
