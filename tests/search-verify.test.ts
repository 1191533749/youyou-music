/**
 * 搜索结果的「返回前实测」过滤：用户要求放不出来的歌根本不要出现在搜索结果里。
 * 这里用替身 AppContext 直接验证过滤逻辑本身（并发、超预算保留、整批失败复验、绝不放行）。
 */
import { describe, expect, it } from 'vitest'
import { rightsAllowUnblock, verifyExternalTracks, verifySearchTracks } from '../src/main/ipc/explore.js'
import type { AppContext } from '../src/main/context.js'
import type { Track } from '../src/main/netease/models.js'
import type { ExternalTrackDTO } from '@shared/types'

function track(id: number): Track {
  return {
    id,
    name: `曲目${id}`,
    artists: [{ id: 0, name: '测试歌手' }],
    album: { id: 0, name: '测试专辑' },
    durationMS: 200_000,
    alias: [],
    transNames: [],
    fee: 0,
    mvID: 0,
    trackNo: id,
    noCopyright: false,
    isCloud: false
  }
}

function external(sourceId: string): ExternalTrackDTO {
  return {
    source: 'kugou',
    sourceId,
    name: `站外${sourceId}`,
    artists: '测试歌手',
    durationMS: 200_000
  }
}

/** 替身上下文：按 id 决定「可播」，并记录并发峰值与调用次数。 */
function fakeContext(playable: (song: Track) => boolean, delayMS = 1) {
  const calls: number[] = []
  const logs: string[] = []
  let inflight = 0
  let peak = 0
  const context = {
    log: (message: string) => logs.push(message),
    player: {
      verifyPlayable: async (song: Track) => {
        calls.push(song.id)
        inflight += 1
        peak = Math.max(peak, inflight)
        await new Promise((resolve) => setTimeout(resolve, delayMS))
        inflight -= 1
        return playable(song)
      },
      verifyPlayableExternal: async (item: ExternalTrackDTO) => {
        calls.push(Number(item.sourceId))
        inflight += 1
        peak = Math.max(peak, inflight)
        await new Promise((resolve) => setTimeout(resolve, delayMS))
        inflight -= 1
        return playable({ id: Number(item.sourceId) } as Track)
      }
    }
  } as unknown as AppContext
  return { context, calls: () => calls, logs, peak: () => peak }
}

describe('搜索单曲的返回前实测过滤', () => {
  it('播不了的整条剔除，可播的按原顺序保留', async () => {
    const dead = new Set([3, 7])
    const songs = Array.from({ length: 10 }, (_, i) => track(i + 1))
    const { context, calls, peak } = fakeContext((song) => !dead.has(song.id))
    const kept = await verifySearchTracks(context, songs)
    expect(kept.map((song) => song.id)).toEqual([1, 2, 4, 5, 6, 8, 9, 10])
    // 每首至少校验一次；失败的那些会被补验第二轮（结果够少时），最多两次。
    expect(Array.from(new Set(calls())).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(calls().length).toBeLessThanOrEqual(20)
    expect(peak()).toBeLessThanOrEqual(8)
  })

  it('失败率很高时也只剔掉失败的那些，不再整批放过（用户要求：放不了就别展示）', async () => {
    const songs = Array.from({ length: 10 }, (_, i) => track(i + 1))
    // 只有 1 首可播 = 90% 失败，但「有一首成功」就说明不是全链路抽风，照常过滤。
    const { context, logs } = fakeContext((song) => song.id === 1)
    const kept = await verifySearchTracks(context, songs)
    expect(kept.map((song) => song.id)).toEqual([1])
    expect(logs.join()).not.toContain('本次不过滤')
  })

  it('全部失败会先复验一次；复验仍然全败就返回空列表（宁可空，也不放行没验过的）', async () => {
    const songs = Array.from({ length: 6 }, (_, i) => track(i + 1))
    const calls: number[] = []
    const logs: string[] = []
    const context = {
      log: (message: string) => logs.push(message),
      player: {
        verifyPlayable: async (song: Track) => {
          calls.push(song.id)
          return false
        }
      }
    } as unknown as AppContext
    const kept = await verifySearchTracks(context, songs)
    expect(kept).toHaveLength(0)
    expect(logs.join()).toContain('已剔除 6 首播不了的')
    // 第一轮 6 次 + 复验 6 次：确认「整批失败」确实给了第二次机会。
    expect(calls).toHaveLength(12)
  })

  it('空列表直接返回，不打任何音源', async () => {
    const { context, calls } = fakeContext(() => true)
    expect(await verifySearchTracks(context, [])).toEqual([])
    expect(calls()).toEqual([])
  })

  it(
    '单首超过校验上限按「没验出来」处理、不展示（宁可少一行，也不要用户点到播不了的歌）',
    async () => {
      const songs = [track(1), track(2), track(3)]
      const context = {
        log: () => undefined,
        player: {
          verifyPlayable: async (song: Track) => {
            // 第三首卡住：超过 SEARCH_VERIFY_SONG_TIMEOUT_MS（4.5s）也没给出结论。
            if (song.id === 3) await new Promise<boolean>(() => undefined)
            return true
          }
        }
      } as unknown as AppContext
      const kept = await verifySearchTracks(context, songs)
      expect(kept.map((song) => song.id)).toEqual([1, 2])
    },
    30_000
  )
})

describe('结果进入实测前的权限预筛', () => {
  it('VIP 专属 / 付费专辑要留下（第三方音源能换到完整版），只有下架与无版权才预筛掉', () => {
    // 这条是「搜原唱只剩翻唱」的回归测试：以前非 playable 一律预筛掉，
    // 于是「孤勇者 陈奕迅」只剩翻唱，原唱（VIP）根本不进实测。
    expect(rightsAllowUnblock('playable')).toBe(true)
    expect(rightsAllowUnblock('vipOnly')).toBe(true)
    expect(rightsAllowUnblock('paidAlbum')).toBe(true)
    expect(rightsAllowUnblock('noCopyright')).toBe(false)
    expect(rightsAllowUnblock('delisted')).toBe(false)
  })
})

describe('站外条目的返回前实测过滤', () => {
  it('拿不到直链的条目不进列表（按 source:sourceId 保序）', async () => {
    const items = ['11', '12', '13', '14'].map(external)
    const { context, peak } = fakeContext((song) => song.id !== 12 && song.id !== 14)
    const kept = await verifyExternalTracks(context, items)
    expect(kept.map((item) => item.sourceId)).toEqual(['11', '13'])
    expect(peak()).toBeLessThanOrEqual(4)
  })

  it('全部失败时返回空列表（站外条目也不放行没验过的）', async () => {
    const items = ['21', '22', '23'].map(external)
    const { context, logs } = fakeContext(() => false)
    expect(await verifyExternalTracks(context, items)).toHaveLength(0)
    expect(logs.join()).toContain('已剔除 3 条播不了的')
  })
})
