/**
 * 播放页：沉浸式封面、逐行歌词（含逐字高亮）、播放队列。
 *
 * 数据只有两个来源：播放状态来自 player store（主进程是权威），歌词来自
 * `lyrics:get`。封面主色由渲染进程自己从封面图采样 —— 主进程不该为了一个视觉
 * 效果去解码图片；采样失败（CDN 不带 CORS 头）时退回 CSS 里的默认强调色，
 * 页面不会因此缺一块。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
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
import type { LyricLineDTO, LyricsDTO, SettingsDTO } from '@shared/types'

interface Word {
  text: string
  start: number
  duration: number
}

export default function NowPlaying(): JSX.Element {
  const navigation = useNavigation()
  const player = usePlayerStore()
  const { state, current } = player

  const [settings, setSettings] = useState<SettingsDTO | undefined>()
  const [lyrics, setLyrics] = useState<LyricsDTO | undefined>()
  const [lyricsLoading, setLyricsLoading] = useState(false)
  const [lyricsError, setLyricsError] = useState<string | undefined>()
  const [lyricsNonce, setLyricsNonce] = useState(0)
  const [follow, setFollow] = useState(true)

  const trackID = current?.id

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
  const activeLineRef = useRef<HTMLLIElement | null>(null)
  const resumeTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!follow || activeIndex < 0) return
    const container = listRef.current
    const element = activeLineRef.current
    if (!container || !element) return
    // 自己算 scrollTop 而不是 scrollIntoView：后者会把外层 .content 一起滚走。
    container.scrollTo({
      top: element.offsetTop - container.clientHeight / 2 + element.clientHeight / 2,
      behavior: 'smooth'
    })
  }, [activeIndex, follow, lyrics])

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

  return (
    <div className="page now-playing" style={style}>
      <div className="np-backdrop" aria-hidden="true">
        {cover ? <img className="np-backdrop__art" src={cover} alt="" /> : null}
        <div className="np-backdrop__scrim" />
      </div>

      <header className="np-header">
        <button
          type="button"
          className="button np-header__back"
          onClick={() => (navigation.canGoBack ? navigation.back() : navigation.push({ name: 'home' }))}
        >
          ← 返回
        </button>
        <div className="np-header__title">
          <span className="section__title">正在播放</span>
          {current ? <span className="page__subtitle">{current.album.name}</span> : null}
        </div>
        <div className="np-header__actions">
          <span className="np-header__hint">
            {state.playing ? '播放中' : current ? '已暂停' : '未在播放'} · {repeatLabel(state.repeat)}
            {state.shuffle ? ' · 随机' : ''}
          </span>
          <button
            type="button"
            className={`chip${desktopLyricsOn ? ' is-active' : ''}`}
            title="在桌面上显示歌词"
            onClick={() => void call('lyrics:desktopToggle', { visible: !desktopLyricsOn })}
          >
            桌面歌词
          </button>
        </div>
      </header>

      {!current ? (
        <div className="placeholder np-empty">
          <div className="placeholder__title">还没有正在播放的歌曲</div>
          <div>去首页挑一首，或者在搜索里找找想听的歌。</div>
          <button type="button" className="button button--primary" onClick={() => navigation.push({ name: 'home' })}>
            回到首页
          </button>
        </div>
      ) : (
        <div className="np-body">
          <section className="np-cover">
            <div className={`np-cover__art${state.playing ? ' is-playing' : ''}`}>
              {cover ? (
                <img src={cover} alt={`${current.album.name} 封面`} />
              ) : (
                <span className="card__placeholder">♪</span>
              )}
            </div>
            <h1 className="np-cover__title" title={current.name}>
              {current.name}
            </h1>
            <div className="np-cover__artist">{artistLine(current)}</div>
            <div className="np-cover__album">{current.album.name}</div>
            <div className="np-cover__badges">
              {current.playability !== 'playable' && current.playabilityReason ? (
                <span className="badge badge--warn">{current.playabilityReason}</span>
              ) : null}
              {current.isCloud ? <span className="badge">云盘</span> : null}
              <span className="badge">
                {formatDuration(state.position)} / {formatDuration(state.duration)}
              </span>
            </div>
          </section>

          <section className="np-lyrics">
            <div className="section__header np-lyrics__header">
              <h2 className="section__title">歌词</h2>
              {lyrics?.contributor ? <span className="section__more">贡献者：{lyrics.contributor}</span> : null}
            </div>

            {lyricsLoading ? (
              <div className="placeholder np-lyrics__state">
                <div className="placeholder__title">正在加载歌词…</div>
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
                <div className="placeholder__title">
                  {lyrics?.isInstrumental ? '纯音乐，请欣赏' : '这首歌暂时没有歌词'}
                </div>
              </div>
            ) : (
              <div
                className="np-lyrics__list"
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
                      onSeek={() => void player.seek(line.time)}
                      lineRef={index === activeIndex ? activeLineRef : undefined}
                    />
                  ))}
                </ol>
                <div className="np-lyrics__footer">
                  {lyrics.translationContributor ? `翻译贡献者：${lyrics.translationContributor}` : ''}
                </div>
              </div>
            )}
          </section>

          <aside className="np-queue">
            <div className="section__header np-queue__header">
              <h2 className="section__title">播放队列</h2>
              <span className="section__more">{state.queue.length} 首</span>
              {state.queue.length > 0 ? (
                <button type="button" className="icon-button" title="清空队列" onClick={() => void player.clearQueue()}>
                  ⌫
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
                      // 契约里没有「跳到第 N 首」的通道，重排同一份队列并指定起始
                      // 下标是等价的做法，队列内容不会因此改变。
                      onClick={() => void player.playTracks(state.queue, index)}
                    >
                      <span className="np-queue__index">{index === state.index ? '♪' : index + 1}</span>
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
                      onClick={() => void player.removeAt([index])}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </aside>
        </div>
      )}
    </div>
  )
}

/**
 * 一行歌词。
 *
 * 有逐字时间戳时按词切片高亮（卡拉 OK），否则整行一起变色 —— 上游客户端也是
 * 这两种表现。`wordProgress` 给的是整行进度，用来画行下方那条进度线。
 */
function LyricRow({
  line,
  active,
  position,
  onSeek,
  lineRef
}: {
  line: LyricLineDTO
  active: boolean
  position: number
  onSeek: () => void
  lineRef?: RefObject<HTMLLIElement>
}): JSX.Element {
  const progress = active ? wordProgress(line, position) : 0
  const words: Word[] = line.words ?? []

  return (
    <li className={`np-lyric${active ? ' is-active' : ''}`} ref={lineRef}>
      <button type="button" className="np-lyric__button" onClick={onSeek} title="跳到这一句">
        {words.length > 0 ? (
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
      {active ? (
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
