/**
 * 每日推荐的本地历史快照。
 *
 * 网易云已下线 `/history/recommend/songs` 与 `/history/recommend/songs/detail`
 * 两个历史接口（weapi 空响应、eapi/明文一律 404），「昨天的日推」只能靠本地记录：
 * 每次取到今日日推就按日期落盘一份，次日点昨天就能读回当天列表。
 *
 * 文件按天存放：`<userData>/daily-history/<YYYY-MM-DD>.json`，内容是渲染层可直接
 * 使用的 TrackDTO 数组（与 home:dailySongs 的返回同构）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import type { TrackDTO } from '@shared/types'

const DAY_MS = 24 * 60 * 60 * 1000

/** 本地时区的 YYYY-MM-DD；offsetDays 为 0 是今天，正数是过去。 */
export function localDateKey(offsetDays = 0): string {
  const date = new Date(Date.now() - offsetDays * DAY_MS)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export class DailyHistoryStore {
  constructor(private readonly directory: string) {}

  private filePath(date: string): string {
    return path.join(this.directory, `${date}.json`)
  }

  save(date: string, tracks: TrackDTO[]): void {
    try {
      mkdirSync(this.directory, { recursive: true })
      writeFileSync(this.filePath(date), JSON.stringify({ date, tracks }), 'utf8')
    } catch {
      // 本地写失败只影响历史回看，不影响当日播放；静默即可。
    }
  }

  load(date: string): TrackDTO[] {
    try {
      if (!existsSync(this.filePath(date))) return []
      const parsed = JSON.parse(readFileSync(this.filePath(date), 'utf8')) as {
        tracks?: unknown
      }
      return Array.isArray(parsed.tracks) ? (parsed.tracks as TrackDTO[]) : []
    } catch {
      return []
    }
  }
}
