/**
 * Lyrics parsing: LRC, NetEase verbatim `yrc`, translations and romaji.
 *
 * 逐字歌词用 yrc 词时间轴；翻译/罗马音按「时间最近且相差 0.3 秒以内」合并到主行，
 * 纯音乐标记与制作人署名行在解析阶段剔除。
 */

export interface LyricWord {
  text: string
  start: number
  duration: number
}

export interface RubySegment {
  text: string
  ruby?: string
}

export interface LyricLine {
  id: number
  time: number
  text: string
  translation?: string
  romaji?: string
  /** Base text split so each reading sits over the kanji it belongs to. */
  furigana?: RubySegment[]
  /** Per-word timings for karaoke highlighting; absent when only line-level timing exists. */
  words?: LyricWord[]
}

export interface ParsedLyrics {
  lines: LyricLine[]
  isInstrumental: boolean
  contributor?: string
  translationContributor?: string
}

export interface LyricResponseShape {
  lrc?: { lyric?: string }
  tlyric?: { lyric?: string }
  romalrc?: { lyric?: string }
  yrc?: { lyric?: string }
  ytlrc?: { lyric?: string }
  yromalrc?: { lyric?: string }
  lyricUser?: { nickname?: string }
  transUser?: { nickname?: string }
}

const TIME_TAG = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g
const YRC_LINE_TAG = /^\[(\d+),(\d+)\]/
const YRC_WORD_TAG = /\((\d+),(\d+),\d+\)([^(]*)/g
const CREDIT_NO_LYRIC = /^作(词|曲)\s*[:：]\s*无$/
const CREDIT_PREFIX = /^作(词|曲)\s*[:：]/

/**
 * Parses an LRC body into (time, text) pairs. Handles multiple timestamps per
 * line and both `.` / `:` millisecond separators.
 */
export function parseLRC(lrc: string): Array<{ time: number; text: string }> {
  const result: Array<{ time: number; text: string }> = []
  for (const rawLine of lrc.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const times: number[] = []
    let lastEnd = 0
    TIME_TAG.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = TIME_TAG.exec(line)) !== null) {
      const min = Number(m[1]) || 0
      const sec = Number(m[2]) || 0
      let frac = 0
      if (m[3] !== undefined) {
        const digits = m[3]
        frac = (Number(digits) || 0) / Math.pow(10, digits.length)
      }
      times.push(min * 60 + sec + frac)
      lastEnd = m.index + m[0].length
    }
    if (times.length === 0) continue
    const content = line.slice(lastEnd).trim()
    for (const time of times) result.push({ time, text: content })
  }
  return result.sort((a, b) => a.time - b.time)
}

/**
 * Parses NetEase verbatim `yrc` lyrics: each content line is
 * `[lineStartMs,lineDurMs](wStartMs,wDurMs,0)word(...)word…`. JSON metadata
 * (credits) lines at the top don't match the `[num,num]` head and are skipped.
 */
export function parseYRC(yrc: string): LyricLine[] {
  const lines: LyricLine[] = []
  let idx = 0
  for (const raw of yrc.split(/\r?\n/)) {
    const line = raw.trim()
    const head = YRC_LINE_TAG.exec(line)
    if (!head) continue
    const lineStart = (Number(head[1]) || 0) / 1000
    const words: LyricWord[] = []
    let text = ''
    YRC_WORD_TAG.lastIndex = head[0].length
    let w: RegExpExecArray | null
    while ((w = YRC_WORD_TAG.exec(line)) !== null) {
      const start = (Number(w[1]) || 0) / 1000
      const duration = (Number(w[2]) || 0) / 1000
      const piece = w[3]
      words.push({ text: piece, start, duration })
      text += piece
    }
    const trimmed = text.trim()
    if (!trimmed || words.length === 0) continue
    lines.push({ id: idx, time: lineStart, text: trimmed, words })
    idx += 1
  }
  return lines
}

const INSTRUMENTAL_MARKER = '纯音乐，请欣赏'

export function parseLyrics(response: LyricResponseShape | undefined): ParsedLyrics {
  const out: ParsedLyrics = { lines: [], isInstrumental: false }
  if (!response) return out
  out.contributor = response.lyricUser?.nickname
  out.translationContributor = response.transUser?.nickname

  const raw = response.lrc?.lyric
  const yrcRaw = response.yrc?.lyric
  // 有些歌只回逐字（yrc）而没有普通 lrc：以前这里直接 return out，
  // 结果整首歌在「逐字卡拉OK」下变成空歌词。现在两者任一存在都继续解析。
  if (!raw && !yrcRaw) return out

  let main = raw ? parseLRC(raw) : []

  // 纯音乐标记处理：整行只有「纯音乐，请欣赏」时视为伴奏。
  if (raw && main.length <= 10 && main.some((l) => l.text.includes(INSTRUMENTAL_MARKER))) {
    out.isInstrumental = true
    main = main.filter(
      (l) => !l.text.includes(INSTRUMENTAL_MARKER) && !CREDIT_PREFIX.test(l.text)
    )
    if (main.length === 0 && !yrcRaw) return out
  }
  main = main.filter((l) => !CREDIT_NO_LYRIC.test(l.text))

  let lines: LyricLine[] = main.map((pair, idx) => ({ id: idx, time: pair.time, text: pair.text }))

  // Prefer verbatim (word-by-word) lines when the song has them.
  if (yrcRaw) {
    const yrcLines = parseYRC(yrcRaw)
    if (yrcLines.length > 0) lines = yrcLines
  }
  if (lines.length === 0) return out

  const merge = (body: string | undefined, key: 'translation' | 'romaji'): void => {
    if (!body) return
    const secondary = parseLRC(body).filter((s) => s.text.length > 0)
    if (secondary.length === 0) return
    for (const line of lines) {
      // Nearest secondary line within 0.3s: verbatim (yrc) line times can
      // differ from the lrc-based translation/romaji by a few ms.
      let bestDelta = Number.POSITIVE_INFINITY
      let bestText: string | undefined
      for (const s of secondary) {
        const delta = Math.abs(s.time - line.time)
        if (delta < bestDelta) {
          bestDelta = delta
          bestText = s.text
        }
      }
      if (bestText !== undefined && bestDelta < 0.3) line[key] = bestText
    }
  }

  merge(response.ytlrc?.lyric ?? response.tlyric?.lyric, 'translation')
  merge(response.yromalrc?.lyric ?? response.romalrc?.lyric, 'romaji')

  out.lines = lines
  return out
}

/**
 * Index of the active line for a playback position, or -1 when nothing has
 * started yet. Binary search over line start times, same as the reference behaviour
 * `activeIndex(at:)`.
 */
export function activeIndex(lines: LyricLine[], time: number): number {
  if (lines.length === 0) return -1
  let low = 0
  let high = lines.length - 1
  let result = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (lines[mid].time <= time) {
      result = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return result
}

/** Index of the word being sung inside a verbatim line, or -1. */
export function activeWordIndex(words: LyricWord[] | undefined, time: number): number {
  if (!words || words.length === 0) return -1
  let result = -1
  for (let i = 0; i < words.length; i += 1) {
    if (words[i].start <= time) result = i
    else break
  }
  return result
}
