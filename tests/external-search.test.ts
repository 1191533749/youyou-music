/**
 * 站外音源搜索的解析测试（离线，用真实抓取的响应样本）。
 *
 * 样本来源：scripts 抓取后放在 tests/fixtures/external/，保证解析字段与线上一致。
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  normalizeKuwoJSON,
  parseKugouSearch,
  parseKuwoSearch,
  parseQishuiSearch,
  qishuiCover,
  toSyntheticTrack
} from '../src/main/external/search.js'

const fixtures = path.join(process.cwd(), 'tests', 'fixtures', 'external')
const readJSON = (file: string): any => JSON.parse(readFileSync(path.join(fixtures, file), 'utf8'))

describe('汽水音乐搜索解析', () => {
  it('从真实响应里取出曲目（名称/歌手/时长/封面）', () => {
    const items = parseQishuiSearch(readJSON('qishui-search.json'), 5)
    expect(items.length).toBeGreaterThan(0)
    const first = items[0]!
    expect(first.source).toBe('qishui')
    expect(first.name.length).toBeGreaterThan(0)
    expect(first.artists.length).toBeGreaterThan(0)
    expect(first.durationMS).toBeGreaterThan(60_000)
    expect(first.sourceId).toMatch(/^\d+$/)
    expect(first.coverUrl ?? '').toContain('douyinpic.com')
    console.log('[解析] 汽水首条:', first.name, '/', first.artists, '/', (first.durationMS / 1000).toFixed(0) + 's')
  })

  it('limit 生效', () => {
    expect(parseQishuiSearch(readJSON('qishui-search.json'), 1)).toHaveLength(1)
  })

  it('封面模板拼接正确', () => {
    expect(
      qishuiCover({ urls: ['https://p3.douyinpic.com/img/'], uri: 'abc/def', template_prefix: 'tplv-x' })
    ).toBe('https://p3.douyinpic.com/img/abc/def~tplv-x.image')
    expect(qishuiCover(undefined)).toBeUndefined()
  })
})

describe('酷狗搜索解析', () => {
  it('从真实响应里取出曲目', () => {
    const items = parseKugouSearch(readJSON('kugou-search.json'), 5)
    expect(items.length).toBeGreaterThan(0)
    const first = items[0]!
    expect(first.source).toBe('kugou')
    expect(first.name).toBe('爱如火')
    expect(first.artists).toContain('那艺娜')
    expect(first.durationMS).toBeGreaterThan(60_000)
    expect(first.coverUrl ?? '').toContain('kugou.com')
    console.log('[解析] 酷狗首条:', first.name, '/', first.artists, '/', (first.durationMS / 1000).toFixed(0) + 's')
  })
})

describe('酷我搜索解析', () => {
  it('单引号 JSON 能规范化并取出曲目', () => {
    const raw = readFileSync(path.join(fixtures, 'kuwo-search.txt'), 'utf8')
    const items = parseKuwoSearch(normalizeKuwoJSON(raw), 5)
    expect(items.length).toBeGreaterThan(0)
    const first = items[0]!
    expect(first.source).toBe('kuwo')
    expect(first.name.length).toBeGreaterThan(0)
    expect(first.sourceId).toMatch(/^\d+$/)
    console.log('[解析] 酷我首条:', first.name, '/', first.artists, '/', (first.durationMS / 1000).toFixed(0) + 's')
  })
})

describe('站外曲目转严格匹配用的 Track', () => {
  it('歌名/歌手/时长/封面都带过去，ID 用负数避免与网易云冲突', () => {
    const track = toSyntheticTrack({
      source: 'qishui',
      sourceId: '1',
      name: '爱如火',
      artists: '那艺娜 / 某某',
      album: '爱如火',
      durationMS: 204_771,
      coverUrl: 'https://example.com/a.jpg'
    }) as any
    expect(track.name).toBe('爱如火')
    expect(track.artists.map((artist: any) => artist.name)).toEqual(['那艺娜', '某某'])
    expect(track.durationMS).toBe(204_771)
    expect(track.album.picUrl).toBe('https://example.com/a.jpg')
    expect(track.id).toBeLessThan(0)
  })
})
