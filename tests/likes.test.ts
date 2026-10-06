/**
 * 点赞乐观覆盖层的离线单测（lib/likes.ts 是纯函数，不需要 Electron / 网络）。
 *
 * 对应线上 BUG：点了喜欢之后，页面又拉了一次「我喜欢的音乐」，旧数据把刚点的
 * 状态盖回去，看起来像「鼠标悬停就把喜欢取消了」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyLikeOverrides, clearLikeOverride, isLiked, markLike } from '../src/renderer/src/lib/likes'

/** TTL 是 20s（lib/likes.ts），这里用可控时钟推着走。 */
const TTL_MS = 20_000

let now = 1_700_000_000_000
/** 每个用例用各自的 id，避免共享的模块级 Map 互相串味。 */
const used: number[] = []

function newID(): number {
  const id = 900_000 + used.length
  used.push(id)
  return id
}

beforeEach(() => {
  now = 1_700_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})

afterEach(() => {
  for (const id of used) clearLikeOverride(id)
  used.length = 0
  vi.restoreAllMocks()
})

describe('likes 乐观覆盖', () => {
  it('点喜欢后，旧的服务器列表不会把它盖回去', () => {
    const id = newID()
    markLike(id, true)
    // 服务器那份还是旧数据（不含这个 id），渲染集合里必须仍然有它。
    expect(applyLikeOverrides([1, 2, 3]).has(id)).toBe(true)
    expect(isLiked(id, [1, 2, 3])).toBe(true)
  })

  it('取消喜欢后，旧的服务器列表里仍有它也显示为未喜欢', () => {
    const id = newID()
    markLike(id, false)
    expect(applyLikeOverrides([id, 1]).has(id)).toBe(false)
    expect(isLiked(id, [id])).toBe(false)
  })

  it('TTL 过期后回到服务器数据', () => {
    const liked = newID()
    const unliked = newID()
    markLike(liked, true)
    markLike(unliked, false)
    expect(applyLikeOverrides([]).has(liked)).toBe(true)
    expect(applyLikeOverrides([unliked]).has(unliked)).toBe(false)

    now += TTL_MS + 1
    // 过期后本地覆盖作废：喜欢的不再凭空出现，取消的也回到服务器的「已喜欢」。
    expect(applyLikeOverrides([]).has(liked)).toBe(false)
    expect(applyLikeOverrides([unliked]).has(unliked)).toBe(true)
    expect(isLiked(liked, [])).toBe(false)
    expect(isLiked(unliked, [unliked])).toBe(true)
  })

  it('TTL 边界内仍然以本地为准', () => {
    const id = newID()
    markLike(id, true)
    now += TTL_MS - 1
    expect(applyLikeOverrides([]).has(id)).toBe(true)
  })

  it('clearLikeOverride 立即回退到服务器数据', () => {
    const id = newID()
    markLike(id, true)
    expect(isLiked(id, [])).toBe(true)
    clearLikeOverride(id)
    expect(isLiked(id, [])).toBe(false)
    expect(applyLikeOverrides([]).has(id)).toBe(false)
  })

  it('反复点击以最后一次为准', () => {
    const id = newID()
    markLike(id, true)
    markLike(id, false)
    expect(isLiked(id, [id])).toBe(false)
    markLike(id, true)
    expect(isLiked(id, [])).toBe(true)
  })

  it('不改动传入的服务器集合', () => {
    const id = newID()
    const server = [1, 2, 3]
    markLike(id, true)
    const rendered = applyLikeOverrides(server)
    expect(server).toEqual([1, 2, 3])
    expect(rendered.has(id)).toBe(true)
    expect(rendered.size).toBe(4)
    // 渲染集合是副本：再次套用不会互相影响。
    expect(applyLikeOverrides(rendered).size).toBe(4)
  })

  it('没有覆盖时严格等于服务器数据', () => {
    expect([...applyLikeOverrides([4, 5, 6])].sort((a, b) => a - b)).toEqual([4, 5, 6])
    expect(isLiked(4, new Set([4]))).toBe(true)
    expect(isLiked(7, new Set([4]))).toBe(false)
  })
})
