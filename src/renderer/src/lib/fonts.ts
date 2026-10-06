/**
 * 歌词字体的应用工具（播放页与桌面歌词窗口共用）。
 *
 * 做法：把字体族写进 CSS 变量 `--lyric-font`，并在根元素上打 `data-lyric-font`
 * 标记（细体/楷体这类字体不支持粗体，需要按字体下调字重）。
 */
import { LYRIC_FONT_STACKS, type LyricFont } from '@shared/types'

export function applyLyricFont(font: LyricFont | undefined): void {
  const key = font && LYRIC_FONT_STACKS[font] ? font : 'default'
  const root = document.documentElement
  root.style.setProperty('--lyric-font', LYRIC_FONT_STACKS[key])
  root.dataset.lyricFont = key
}
