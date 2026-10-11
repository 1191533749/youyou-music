/**
 * 聚合音源（按歌曲 ID 直取直链）的两个关键契约（离线用例：假 fetch，不碰网络）：
 *   1. 只有站内曲目（id > 0）才走聚合接口，站外曲目的负 ID 绝不会拿错歌；
 *   2. 某一档「起播失败」后，再解析同一首歌要换一档重新要直链——
 *      实测有 1/12 的歌会卡在 0:00，换档（更小的文件）是最后一层救援。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { noteGdstudioUnplayable, resolveGdstudio } from '../src/main/unblock/providers.js'
import type { Track } from '../src/main/netease/models.js'

const originalFetch = globalThis.fetch

/** 假 fetch：记录每次请求的 URL，并按 br 参数回一条假直链。 */
function stubFetch(): { urls: string[] } {
  const state = { urls: [] as string[] }
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input)
    state.urls.push(url)
    const br = Number(new URL(url).searchParams.get('br') ?? 0)
    return new Response(
      JSON.stringify({ url: `https://m801.music.126.net/test/${br}.mp3`, br, size: 5_000_000 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }) as typeof fetch
  return state
}

function track(id: number): Track {
  return {
    id,
    name: `曲目${id}`,
    artists: [{ id: 0, name: '测试歌手' }],
    album: { id: 0, name: '测试专辑' },
    durationMS: 200_000,
    alias: [],
    transNames: [],
    fee: 1,
    mvID: 0,
    trackNo: 1,
    noCopyright: false,
    isCloud: false
  }
}

beforeEach(() => {
  globalThis.fetch = originalFetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('聚合音源直链解析', () => {
  it('站外曲目（假 ID 为负）从不请求聚合接口', async () => {
    const { urls } = stubFetch()
    // src/main/external/search.ts 的 externalTrackID 生成的就是这种负 ID。
    expect(await resolveGdstudio(track(-12345))).toBeNull()
    expect(urls).toEqual([])
  })

  it('默认按 exhigh（320）要直链，并如实回报接口给的实际码率', async () => {
    const { urls } = stubFetch()
    const source = await resolveGdstudio(track(347230))
    expect(urls[0]).toContain('id=347230')
    expect(urls[0]).toContain('br=320')
    expect(source?.url.startsWith('https://')).toBe(true)
    expect(source?.bitrate).toBe(320)
    expect(source?.displayName).toBe('聚合音源')
  })

  it('这一档刚起播失败过：同一首歌再解析就换 128k 重新要一次（换档救援）', async () => {
    const { urls } = stubFetch()
    noteGdstudioUnplayable(347240, 320)
    await resolveGdstudio(track(347240))
    expect(urls[0]).toContain('br=128')

    // 只影响那一首歌：别的歌仍然按用户选的档位要。
    await resolveGdstudio(track(347241))
    expect(urls[1]).toContain('br=320')
  })

  it('选无损（999）时若该档失败过，也换 128k 而不是继续要同一个大文件', async () => {
    const { urls } = stubFetch()
    noteGdstudioUnplayable(1985221664, 999)
    await resolveGdstudio(track(1985221664), 'lossless')
    expect(urls[0]).toContain('br=128')
  })
})
