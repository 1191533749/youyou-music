/**
 * Desktop lyrics window.
 *
 * A frameless, transparent, always-on-top strip that follows playback: the same
 * feature the macOS client calls 桌面歌词. It renders the current line and its
 * translation, and drags the window with `-webkit-app-region` so no IPC is
 * needed for movement.
 *
 * 窗口职责：
 *   1. 只罩住内容 —— ResizeObserver 量内容高度（当前行 + 翻译），防抖后上报
 *      lyrics:desktopResize，主进程据此收紧窗口，透明区域不再盖住桌面。
 *   2. 点击穿透 —— 鼠标不在歌词/按钮上时上报 lyrics:desktopClickThrough(true)，
 *      主进程用 setIgnoreMouseEvents(forward: true) 既穿透又保留 mousemove。
 *   3. 悬停歌词时浮出两个小按钮：锁定/解锁与切换特效，两者都写进 settings 持久化。
 *   4. 锁定态由 settings.desktopLyricsLocked 驱动，只关掉拖动（CSS 的 app-region），
 *      命中测试与穿透逻辑不受影响。
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
  DESKTOP_LYRICS_EFFECTS,
  type DesktopLyricsEffect,
  type LyricsDTO,
  type PlayerStateDTO,
  type SettingsDTO
} from '@shared/types'
import { activeIndexOf } from '../lib/lyricsUtils'
import { applyLyricFont } from '../lib/fonts'
import { IconLayers } from '../components/Icons'
import './desktop-lyrics.css'

/** 窗口里真正用到的四个设置项，避免把整份 SettingsDTO 塞进 state。 */
interface LyricPreferences {
  fontSize: number
  opacity: number
  effect: DesktopLyricsEffect
  /** 锁定后整条歌词不能再拖动（点击穿透的判定不受影响）。 */
  locked: boolean
}

/** settings:changed 与 settings:get 走同一套映射，两处不会走样。 */
function toPreferences(settings: SettingsDTO): LyricPreferences {
  return {
    fontSize: settings.desktopLyricsFontSize,
    opacity: settings.desktopLyricsOpacity,
    effect: settings.desktopLyricsEffect,
    locked: settings.desktopLyricsLocked
  }
}

const EFFECT_LABELS: Record<DesktopLyricsEffect, string> = {
  classic: '经典',
  gradient: '渐变',
  neon: '霓虹',
  karaoke: '逐字'
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

/**
 * 锁形图标：Icons.tsx 里没有锁，按同一套描边风格在本文件里自绘
 * （Icons.tsx 不在本任务的写权限内）。
 */
function LockGlyph({ open }: { open: boolean }): JSX.Element {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* 几何按「整体包围盒中心 = viewBox 中心 (12,12)」算过：锁体 y 11–20，
          锁梁弦在 7.5、半圆顶点 4，合起来 y 4–20 → 中心正好 12；
          x 方向 5–19 → 中心 12。开锁状态只是少了右侧竖边，包围盒不变。 */}
      <rect x="5" y="11" width="14" height="9" rx="2.5" />
      <path d={open ? 'M8.5 11V7.5a3.5 3.5 0 0 1 7 0' : 'M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11'} />
    </svg>
  )
}

/** 内容变化到上报窗口尺寸之间的防抖；换行时高度会连跳几次，攒一下再发。 */
const RESIZE_DEBOUNCE_MS = 80
/** 命中测试的节流；50ms 足以跟手，又不会让 mousemove 变成 IPC 洪流。 */
const HIT_TEST_THROTTLE_MS = 50

/** 元素（或其祖先）是否匹配某个选择器；null 目标一律不匹配。 */
function matches(target: Element | null, selector: string): boolean {
  return target !== null && target.closest(selector) !== null
}

export default function DesktopLyrics(): JSX.Element {
  const [player, setPlayer] = useState<PlayerStateDTO | undefined>()
  const [lyrics, setLyrics] = useState<LyricsDTO | undefined>()
  const [preferences, setPreferences] = useState<LyricPreferences>({
    fontSize: 28,
    opacity: 0.92,
    effect: 'classic',
    locked: false
  })
  /** 鼠标是否压在歌词/按钮上，决定两个小按钮的显隐。 */
  const [hovering, setHovering] = useState(false)

  useEffect(() => {
    void call('player:state').then(setPlayer).catch(() => undefined)
    const offPlayer = onEvent('player:state', setPlayer)
    const offSettings = onEvent('settings:changed', (next) => {
      // 字体走 CSS 变量 + 根元素标记，两条 settings 路径都要应用一次。
      applyLyricFont(next.lyricFont)
      setPreferences(toPreferences(next))
    })
    void call('settings:get')
      .then((current) => {
        applyLyricFont(current.lyricFont)
        setPreferences(toPreferences(current))
      })
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

  // next 只用于卡拉OK的整行扫词：没有逐字时间轴时拿下一行的起点当本行的终点。
  const { current, next } = useMemo(() => {
    if (!lyrics || lyrics.empty) return { current: undefined, next: undefined }
    const index = activeIndexOf(lyrics, player?.position ?? 0)
    return {
      current: index >= 0 ? lyrics.lines[index] : lyrics.lines[0],
      next: index >= 0 ? lyrics.lines[index + 1] : lyrics.lines[1]
    }
  }, [lyrics, player?.position])

  const { fontSize, opacity, effect, locked } = preferences

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

  // 初始值未知：渲染进程查不到主进程当前的 setIgnoreMouseEvents 状态，所以第一次
  // 命中测试无论如何都上报一次，避免两端不一致导致「鼠标压在歌词上却仍然穿透」——
  // 那样既点不到按钮、也拖动不了窗口（锁定后再解锁最容易暴露这个问题）。
  const throughRef = useRef<boolean | undefined>(undefined)
  const hoveringRef = useRef(false)
  const lastHitTestRef = useRef(0)
  const trailingHitTestRef = useRef<number | undefined>(undefined)

  const setThrough = useCallback((next: boolean) => {
    if (next === throughRef.current) return
    throughRef.current = next
    void call('lyrics:desktopClickThrough', { through: next }).catch(() => undefined)
  }, [])

  const applyHitTest = useCallback(
    (interactive: boolean) => {
      setThrough(!interactive)
      if (interactive !== hoveringRef.current) {
        hoveringRef.current = interactive
        setHovering(interactive)
      }
    },
    [setThrough]
  )

  const handleMouseMove = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target instanceof Element ? event.target : null
      const overText = matches(target, '.desktop-lyrics__drag')
      // 按钮也要算可交互：否则从歌词移向按钮的一瞬间窗口就穿透了，点不中。
      const interactive = overText || matches(target, '.desktop-lyrics__controls')

      const now = Date.now()
      if (now - lastHitTestRef.current >= HIT_TEST_THROTTLE_MS) {
        lastHitTestRef.current = now
        applyHitTest(interactive)
        return
      }
      // 节流窗口内的最后一次移动仍要生效：否则快速划出文字区会停在「可交互」上，
      // 透明区域继续吃掉点击。
      if (trailingHitTestRef.current !== undefined) window.clearTimeout(trailingHitTestRef.current)
      trailingHitTestRef.current = window.setTimeout(() => {
        trailingHitTestRef.current = undefined
        lastHitTestRef.current = Date.now()
        applyHitTest(interactive)
      }, HIT_TEST_THROTTLE_MS)
    },
    [applyHitTest]
  )

  // 鼠标整体离开窗口：收起按钮并恢复穿透。
  const handleMouseLeave = useCallback(() => {
    setThrough(true)
    if (hoveringRef.current) {
      hoveringRef.current = false
      setHovering(false)
    }
  }, [setThrough])

  useEffect(
    () => () => {
      if (trailingHitTestRef.current !== undefined) window.clearTimeout(trailingHitTestRef.current)
    },
    []
  )

  // 解锁后确认窗口处于可交互状态：即使没有新的 mousemove（例如在设置页解锁），
  // 只要鼠标还在歌词上，拖动就该马上恢复。
  useEffect(() => {
    if (locked || !hoveringRef.current) return
    throughRef.current = false
    void call('lyrics:desktopClickThrough', { through: false }).catch(() => undefined)
  }, [locked])

  // --- 悬停时出现的两个按钮 -----------------------------------------------

  const toggleLock = useCallback(() => {
    const next = !locked
    // 先切本地状态，按钮与拖动限制立刻响应；随后把选择写进 settings。
    setPreferences((view) => ({ ...view, locked: next }))
    void call('settings:update', { desktopLyricsLocked: next })
      .then((saved) => setPreferences(toPreferences(saved)))
      .catch(() => undefined)
  }, [locked])

  const cycleEffect = useCallback(() => {
    const index = DESKTOP_LYRICS_EFFECTS.indexOf(effect)
    const nextEffect = DESKTOP_LYRICS_EFFECTS[(index + 1) % DESKTOP_LYRICS_EFFECTS.length]
    setPreferences((view) => ({ ...view, effect: nextEffect }))
    void call('settings:update', { desktopLyricsEffect: nextEffect })
      .then((saved) => setPreferences(toPreferences(saved)))
      .catch(() => undefined)
  }, [effect])

  const position = player?.position ?? 0
  // 只有逐字特效才拆词；其余特效都整行显示。
  const words = effect === 'karaoke' ? current?.words : undefined
  const line = current?.text ?? (player?.track ? '正在载入歌词' : '悠悠音乐 桌面歌词')
  /**
   * 卡拉OK的兜底：这一行没有逐字时间轴（words 为空，服务端没返回 yrc 时很常见）时，
   * 退化成按「本行时长」整行扫词，否则选了这个特效却什么都不动，看起来就像没生效。
   */
  const sweep = useMemo(() => {
    if (effect !== 'karaoke' || !current) return undefined
    // 判断依据与渲染用的是同一个 words，两条路径互斥：有逐字时间轴就只走逐词。
    if (words && words.length > 0) return undefined
    const start = current.time
    const end = next?.time !== undefined && next.time > start ? next.time : start + 4
    return Math.min(100, Math.max(0, ((position - start) / (end - start)) * 100))
  }, [current, effect, next, position, words])

  return (
    <div
      // locked / unlocked 两个修饰类各自带一条 app-region 规则（见 desktop-lyrics.css）：
      // 拖拽属性始终由样式表显式给出，解锁后不会因为「覆盖被移除」而回不到可拖动。
      className={`desktop-lyrics desktop-lyrics--${effect} desktop-lyrics--${
        locked ? 'locked' : 'unlocked'
      }${hovering ? ' desktop-lyrics--hover' : ''}`}
      style={{ fontSize, opacity }}
      title={locked ? '已锁定 · 悬停歌词可解锁' : '拖动可移动 · 悬停歌词可锁定或换特效'}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <div ref={dragRef} className="desktop-lyrics__drag">
        <div
          className={`desktop-lyrics__line${sweep !== undefined ? ' is-sweep' : ''}`}
          style={sweep !== undefined ? ({ '--fill': `${sweep.toFixed(1)}%` } as CSSProperties) : undefined}
        >
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

      <div className="desktop-lyrics__controls">
        <button
          type="button"
          className={`desktop-lyrics__control${locked ? ' is-active' : ''}`}
          onClick={toggleLock}
          title={locked ? '解锁（可以拖动）' : '锁定（禁止拖动）'}
          aria-label={locked ? '解锁桌面歌词' : '锁定桌面歌词'}
        >
          <LockGlyph open={!locked} />
        </button>
        <button
          type="button"
          className="desktop-lyrics__control"
          onClick={cycleEffect}
          title={`歌词特效：${EFFECT_LABELS[effect]}（点击切换）`}
          aria-label={`歌词特效：${EFFECT_LABELS[effect]}，点击切换下一种`}
        >
          {/* 图层图标的包围盒偏上（y 4–16.5，中心 10.25），加类做 1px 视觉补偿。 */}
          <IconLayers size={14} className="desktop-lyrics__icon-layer" />
        </button>
      </div>
    </div>
  )
}
