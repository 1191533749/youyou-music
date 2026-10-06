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
