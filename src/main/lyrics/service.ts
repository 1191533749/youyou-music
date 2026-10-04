/**
 * Lyrics service: fetch, parse and cache, plus the "current line" stream that
 * both the in-app lyrics panel and the desktop lyric window consume.
 *
 * Mirrors the macOS `LyricsParser` + lyric-fetch pipeline: the network call is
 * made once per track, parsing happens once (not per frame), and the active
 * line index is a binary search over the parsed lines.
 */
import type { NeteaseAPI } from '../netease/api.js'
import { activeIndex, parseLyrics, type LyricLine, type ParsedLyrics } from '../netease/lyrics.js'
import type { LyricsDTO, LyricLineDTO } from '@shared/types'

export interface LyricsServiceDeps {
  api: NeteaseAPI
  log?: (message: string) => void
  /** How many tracks to keep parsed. */
  cacheSize?: number
}

export class LyricsService {
  private cache = new Map<number, ParsedLyrics>()
  private inFlight = new Map<number, Promise<ParsedLyrics>>()

  constructor(private readonly deps: LyricsServiceDeps) {}

  /** Fetches (or reuses) parsed lyrics for a track. */
  async get(trackID: number): Promise<ParsedLyrics> {
    const cached = this.cache.get(trackID)
    if (cached) return cached
    const pending = this.inFlight.get(trackID)
    if (pending) return pending

    const promise = (async (): Promise<ParsedLyrics> => {
      try {
        const response = await this.deps.api.lyric(trackID)
        const parsed = parseLyrics(response)
        this.remember(trackID, parsed)
        return parsed
      } catch (cause) {
        this.deps.log?.(`获取歌词失败 (${trackID}): ${describe(cause)}`)
        const empty: ParsedLyrics = { lines: [], isInstrumental: false }
        this.remember(trackID, empty)
        return empty
      } finally {
        this.inFlight.delete(trackID)
      }
    })()

    this.inFlight.set(trackID, promise)
    return promise
  }

  private remember(trackID: number, parsed: ParsedLyrics): void {
    this.cache.set(trackID, parsed)
    const limit = this.deps.cacheSize ?? 40
    while (this.cache.size > limit) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  /** The line index that should be highlighted at `position` seconds. */
  activeLine(trackID: number, position: number): number {
    const parsed = this.cache.get(trackID)
    if (!parsed) return -1
    return activeIndex(parsed.lines, position)
  }

  clear(): void {
    this.cache.clear()
  }
}

export function toLyricsDTO(trackID: number, parsed: ParsedLyrics): LyricsDTO {
  return {
    trackID,
    lines: parsed.lines.map(toLineDTO),
    isInstrumental: parsed.isInstrumental,
    contributor: parsed.contributor,
    translationContributor: parsed.translationContributor,
    empty: parsed.lines.length === 0
  }
}

function toLineDTO(line: LyricLine): LyricLineDTO {
  return {
    id: line.id,
    time: line.time,
    text: line.text,
    translation: line.translation,
    romaji: line.romaji,
    words: line.words?.map((word) => ({ text: word.text, start: word.start, duration: word.duration }))
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
