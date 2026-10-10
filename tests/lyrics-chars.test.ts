/**
 * 逐字卡拉OK 时间轴的离线单测（lib/lyricsUtils.ts 是纯函数，不需要 Electron）。
 *
 * 关键背景：歌词接口给的是行级 LRC 时间戳，没有「这个字什么时候唱」的数据。
 * 所以逐字点亮必须自己造时间轴：拿这一行和下一行的间距当总时长，再按可见字数
 * 均分；服务端偶尔给了逐字时间轴（words）时优先用它。
 */
import { describe, expect, it } from 'vitest'
import type { LyricLineDTO } from '@shared/types'
import {
  charFillRatio,
  lineFillRatio,
  lyricCharTimeline,
  lyricLineWindow
} from '../src/renderer/src/lib/lyricsUtils'

/** 造一行歌词；id 只是给 React 用的键，这里用时间戳当唯一 id。 */
function line(time: number, text: string, words?: LyricLineDTO['words']): LyricLineDTO {
  return { id: time, time, text, words }
}

/** 第一个字在「每个字一秒」的窗口里点亮了多少。 */
function ratioAt(text: string, time: number, position: number): number {
  const cells = lyricCharTimeline(line(time, text), time + text.length)
  return charFillRatio(cells[0], position)
}

describe('lyricLineWindow：这一行占多长时间', () => {
  it('有下一行时用两行的间距', () => {
    expect(lyricLineWindow(line(10, '你好世界'), 13, 0)).toEqual({ start: 10, end: 13 })
  })

  it('间距过长时封顶 8 秒，字不会爬得没完', () => {
    expect(lyricLineWindow(line(10, '你好世界'), 70, 0)).toEqual({ start: 10, end: 18 })
  })

  it('最后一行按字数估，短句保底 2.4 秒', () => {
    expect(lyricLineWindow(line(10, '好'), undefined, 0).end).toBeCloseTo(12.4, 5)
  })

  it('最后一行按字数估：可见字越多铺得越久', () => {
    // 6 个可见字 × 0.34 = 2.04，仍不足保底，取 2.4。
    expect(lyricLineWindow(line(10, '今天天气不错'), undefined, 0).end).toBeCloseTo(12.4, 5)
    // 20 个可见字 × 0.34 = 6.8。
    expect(lyricLineWindow(line(0, '一二三四五六七八九十一二三四五六七八九十'), undefined, 0).end).toBeCloseTo(6.8, 5)
  })

  it('不超过整首歌剩下的时长', () => {
    expect(lyricLineWindow(line(100, '你好世界'), undefined, 101.5).end).toBeCloseTo(101.5, 5)
  })

  it('下一行贴得太近时也留 0.6 秒，避免一闪而过', () => {
    expect(lyricLineWindow(line(10, '你好'), 10.1, 0).end).toBeCloseTo(10.6, 5)
  })
})

describe('lyricCharTimeline：把行时长按字数均分', () => {
  it('四个字均分两秒，每格 0.5 秒且首尾相接', () => {
    const cells = lyricCharTimeline(line(10, '你好世界'), 12)
    expect(cells.map((cell) => cell.ch)).toEqual(['你', '好', '世', '界'])
    expect(cells.map((cell) => [cell.start, cell.end])).toEqual([
      [10, 10.5],
      [10.5, 11],
      [11, 11.5],
      [11.5, 12]
    ])
  })

  it('空白不占时长：空格跟着上一个可见字一起亮', () => {
    const cells = lyricCharTimeline(line(10, '你 好'), 12)
    expect(cells.map((cell) => [cell.ch, cell.start, cell.end])).toEqual([
      ['你', 10, 11],
      [' ', 10, 11],
      ['好', 11, 12]
    ])
  })

  it('有逐字时间轴时按词分配，词内再按字数均分', () => {
    const cells = lyricCharTimeline(
      line(10, '你好世界', [
        { text: '你好', start: 10, duration: 1 },
        { text: '世界', start: 11, duration: 2 }
      ]),
      12
    )
    expect(cells.map((cell) => [cell.ch, cell.start, cell.end])).toEqual([
      ['你', 10, 10.5],
      ['好', 10.5, 11],
      ['世', 11, 12],
      ['界', 12, 13]
    ])
  })

  it('逐字时间轴和整行文字对不上时退回均分', () => {
    const cells = lyricCharTimeline(line(10, '你好', [{ text: '别的词', start: 10, duration: 4 }]), 12)
    expect(cells.map((cell) => [cell.ch, cell.start, cell.end])).toEqual([
      ['你', 10, 11],
      ['好', 11, 12]
    ])
  })

  it('空行不产生时间推进', () => {
    expect(lyricCharTimeline(line(10, ''), 14)).toEqual([])
  })

  it('时间轴单调、无缝、覆盖整行', () => {
    const cells = lyricCharTimeline(line(5, '第一句歌词'), 9)
    expect(cells[0].start).toBe(5)
    expect(cells[cells.length - 1].end).toBeCloseTo(9, 5)
    for (let i = 1; i < cells.length; i += 1) {
      expect(cells[i].start).toBeCloseTo(cells[i - 1].end, 5)
    }
  })
})

describe('charFillRatio / lineFillRatio：这一刻唱到哪', () => {
  it('未到、正在唱、唱完三种状态', () => {
    expect(ratioAt('你好', 10, 10)).toBe(0)
    expect(ratioAt('你好', 10, 10.5)).toBeCloseTo(0.5, 5)
    expect(ratioAt('你好', 10, 11)).toBe(1)
    expect(ratioAt('你好', 10, 99)).toBe(1)
  })

  it('时长为零的格子不会除零：起点算未唱，过了起点立刻算唱完', () => {
    expect(charFillRatio({ ch: '你', start: 10, end: 10 }, 10)).toBe(0)
    expect(charFillRatio({ ch: '你', start: 10, end: 10 }, 10.01)).toBe(1)
  })

  it('整行进度按可见字数加权：空白的空格不拉低进度', () => {
    const cells = lyricCharTimeline(line(10, '你 好'), 12)
    expect(lineFillRatio(cells, 11)).toBeCloseTo(0.5, 5)
    expect(lineFillRatio(cells, 12)).toBe(1)
    expect(lineFillRatio(cells, 9)).toBe(0)
  })

  it('推进过程单调不回退（逐字点亮只会往右走）', () => {
    const cells = lyricCharTimeline(line(10, '一二三四'), 12)
    let previous = 0
    for (let position = 10; position <= 12.0001; position += 0.05) {
      const ratio = lineFillRatio(cells, position)
      expect(ratio).toBeGreaterThanOrEqual(previous)
      previous = ratio
    }
  })
})
