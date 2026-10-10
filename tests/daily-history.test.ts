/**
 * 每日推荐本地历史快照的读写。
 *
 * 网易云的历史日推接口已下线，历史回看全靠本地落盘（见
 * src/main/storage/dailyHistory.ts）。这里覆盖落盘/读取/损坏文件/缺文件。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TrackDTO } from '../src/shared/types.js'
import { DailyHistoryStore, localDateKey } from '../src/main/storage/dailyHistory.js'

function makeTrack(id: number, name: string, durationMS: number): TrackDTO {
  return {
    id,
    name,
    artists: [{ id: 6452, name: '周杰伦' }],
    album: { id: 34720827, name: '叶惠美', picUrl: 'https://example.com/cover.jpg' },
    durationMS,
    alias: [],
    transNames: [],
    fee: 0,
    mvID: 0,
    noCopyright: false,
    isCloud: false,
    playability: 'playable'
  }
}

const SAMPLE: TrackDTO[] = [
  makeTrack(186016, '晴天', 269000),
  makeTrack(186017, '东风破', 313000)
]

describe('每日推荐本地历史', () => {
  it('落盘后能按日期读回', () => {
    const directory = mkdtempSync(join(tmpdir(), 'youyou-daily-'))
    const store = new DailyHistoryStore(directory)
    const date = '2026-10-09'

    store.save(date, SAMPLE)
    expect(store.load(date)).toEqual(SAMPLE)
    // 文件确实按 YYYY-MM-DD.json 命名
    expect(readFileSync(join(directory, `${date}.json`), 'utf8')).toContain('"date":"2026-10-09"')
  })

  it('没有记录的日期返回空数组', () => {
    const directory = mkdtempSync(join(tmpdir(), 'youyou-daily-'))
    const store = new DailyHistoryStore(directory)
    expect(store.load('2026-10-01')).toEqual([])
  })

  it('损坏的文件不抛异常，按空处理', () => {
    const directory = mkdtempSync(join(tmpdir(), 'youyou-daily-'))
    writeFileSync(join(directory, '2026-10-02.json'), '{ 不是 JSON', 'utf8')
    const store = new DailyHistoryStore(directory)
    expect(store.load('2026-10-02')).toEqual([])
  })

  it('localDateKey 输出本地时区的 YYYY-MM-DD', () => {
    const key = localDateKey(0)
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(key).toBe(describeToday())
  })
})

function describeToday(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
