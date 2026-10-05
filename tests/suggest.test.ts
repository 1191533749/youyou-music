import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { NeteaseClient } from '../src/main/netease/client.js'
import { NeteaseAPI } from '../src/main/netease/api.js'
import { stripEmoji } from '../src/main/ipc/explore.js'

it('searchSuggest survives the throttled weapi transport', async () => {
  const client = new NeteaseClient({ cookieDirectory: mkdtempSync(join(tmpdir(), 'kumone-sg-')) })
  await client.load()
  const api = new NeteaseAPI(client)
  const suggest = await api.searchSuggest('周杰伦')
  expect(suggest).toBeDefined()
  // 联想至少带回一类结果（歌曲/歌手/专辑/歌单之一）。
  const count = [suggest?.songs?.length, suggest?.artists?.length, suggest?.albums?.length, suggest?.playlists?.length]
  expect(count.some((n) => (n ?? 0) > 0)).toBe(true)
}, 60_000)

it('stripEmoji cleans operator copy without touching user content', () => {
  expect(stripEmoji('🔥茶汤 最近很火哦')).toBe('茶汤 最近很火哦')
  expect(stripEmoji('深夜🌙电台')).toBe('深夜电台')
  // 歌名里的中文与日文内容必须原样保留。
  expect(stripEmoji('晴天 / 青空')).toBe('晴天 / 青空')
  expect(stripEmoji('ひまわりの約束')).toBe('ひまわりの約束')
})
