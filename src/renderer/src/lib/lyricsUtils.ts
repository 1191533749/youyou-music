/**
 * Lyric lookups shared by the in-app lyrics panel and the desktop window.
 *
 * Parsing happens in the main process (once per track); the renderer only ever
 * finds the active line, which is a binary search over line start times — the
 * same approach as the active-line lookup.
 */
import type { LyricsDTO, LyricLineDTO } from '@shared/types'

export function activeIndexOf(lyrics: LyricsDTO, position: number): number {
  const lines = lyrics.lines
  if (lines.length === 0) return -1
  let low = 0
  let high = lines.length - 1
  let result = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (lines[mid].time <= position) {
      result = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return result
}

/** Progress through a verbatim line, for karaoke highlighting. */
export function wordProgress(line: LyricLineDTO, position: number): number {
  if (!line.words || line.words.length === 0) return 0
  const total = line.words.reduce((sum, word) => sum + word.duration, 0)
  if (total <= 0) return 0
  let elapsed = 0
  for (const word of line.words) {
    if (position >= word.start + word.duration) {
      elapsed += word.duration
      continue
    }
    if (position > word.start) elapsed += position - word.start
    break
  }
  return Math.min(1, elapsed / total)
}

export function isEmptyLyrics(lyrics: LyricsDTO | undefined): boolean {
  return !lyrics || lyrics.empty || lyrics.lines.length === 0
}

/**
 * 逐字卡拉OK 用的一格字：一个字符及其在整行里的起止秒数。
 *
 * LRC 只有行级时间戳，所以「每个字什么时候亮」必须自己造：先定出这一行占用的
 * 时间段（下一行的起点就是本行的终点），再把时长按可见字数均分。服务端偶尔会
 * 给出逐字（yrc）时间轴，那就优先用它；两种来源在这里统一成同一种格子，
 * 上层的画法不必区分。
 */
export interface LyricChar {
  ch: string
  /** 该格的起点（秒）。空白格与上一个可见字共用同一段时间，跟着一起点亮。 */
  start: number
  /** 该格的终点（秒）。 */
  end: number
}

/** 没有下一行时按字数估出的每字时长（秒）。 */
const CHAR_SECONDS = 0.34
/** 最后一行（或估不出时长时）至少铺这么久，免得一个字一闪而过。 */
const MIN_LINE_SECONDS = 2.4
/**
 * 一行最多铺这么久（秒）。
 * 间奏很长时下一行可能在几十秒之后，按真实间隔均分会让字爬得极慢、一行唱不完，
 * 所以给个上限：超过就提前铺满，整行亮着等下一句。
 */
const MAX_LINE_SECONDS = 8

/** 可见字数：空白不占用时长。 */
function visibleCount(text: string): number {
  let count = 0
  for (const ch of text) {
    if (ch.trim().length > 0) count += 1
  }
  return count
}

/**
 * 本行的高亮时间窗。
 *
 * `nextTime` 是下一行的起点（最后一行没有），`trackDuration` 是整首歌时长（未知传 0）。
 */
export function lyricLineWindow(
  line: LyricLineDTO,
  nextTime: number | undefined,
  trackDuration: number
): { start: number; end: number } {
  const start = line.time
  const estimate = Math.max(MIN_LINE_SECONDS, visibleCount(line.text) * CHAR_SECONDS)
  const span =
    typeof nextTime === 'number' && nextTime > start + 0.05
      ? Math.min(nextTime - start, MAX_LINE_SECONDS)
      : estimate
  const bounded = trackDuration > start ? Math.min(span, trackDuration - start) : span
  return { start, end: start + Math.max(bounded, 0.6) }
}

/**
 * 造一行的逐字时间轴。
 *
 * 有逐字时间轴（`line.words`）且能对上整行文字时按词分配：每个词自己的时长再按
 * 词内可见字数均分；否则整行均分。两种来源都不做取整，字与字的交界处可以直接
 * 比较，逐字推进是连续的。
 */
export function lyricCharTimeline(line: LyricLineDTO, end: number): LyricChar[] {
  const chars = Array.from(line.text)
  const total = visibleCount(line.text)
  if (total === 0) return chars.map((ch) => ({ ch, start: line.time, end }))

  const words = line.words ?? []
  // 只有词的文字拼起来正好等于整行时才敢按词分配：否则对不上位，均分更稳。
  if (words.length > 0 && words.map((word) => word.text).join('') === line.text) {
    const cells: LyricChar[] = []
    for (const word of words) {
      const wordChars = Array.from(word.text)
      const visible = visibleCount(word.text)
      const unit = visible > 0 ? Math.max(word.duration, 0) / visible : 0
      let index = 0
      let lastStart = word.start
      let lastEnd = word.start + unit
      for (const ch of wordChars) {
        if (ch.trim().length === 0) {
          cells.push({ ch, start: lastStart, end: lastEnd })
          continue
        }
        const cellStart = word.start + index * unit
        cells.push({ ch, start: cellStart, end: cellStart + unit })
        lastStart = cellStart
        lastEnd = cellStart + unit
        index += 1
      }
    }
    return cells
  }

  const step = Math.max(end - line.time, 0.2) / total
  const cells: LyricChar[] = []
  let index = 0
  let lastStart = line.time
  let lastEnd = line.time + step
  for (const ch of chars) {
    if (ch.trim().length === 0) {
      cells.push({ ch, start: lastStart, end: lastEnd })
      continue
    }
    const cellStart = line.time + index * step
    cells.push({ ch, start: cellStart, end: cellStart + step })
    lastStart = cellStart
    lastEnd = cellStart + step
    index += 1
  }
  return cells
}

/** 一格字的点亮比例：0 未唱，1 唱完，中间就是正在唱的这个字。 */
export function charFillRatio(cell: LyricChar, position: number): number {
  if (position <= cell.start) return 0
  const span = cell.end - cell.start
  if (span <= 0) return 1
  return Math.min(1, (position - cell.start) / span)
}

/** 整行的点亮比例（按可见字数加权），给行内进度条用。 */
export function lineFillRatio(cells: LyricChar[], position: number): number {
  let done = 0
  let total = 0
  for (const cell of cells) {
    if (cell.ch.trim().length === 0) continue
    total += 1
    done += charFillRatio(cell, position)
  }
  return total === 0 ? 0 : Math.min(1, done / total)
}
