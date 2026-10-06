/**
 * 点赞状态的乐观覆盖层。
 *
 * 背景（用户反馈的 BUG）：点了喜欢之后，只要页面又拉了一次「我喜欢的音乐」
 * 列表（悬停触发的重渲染、路由切换、定时刷新都可能触发），旧数据就会把刚点的
 * 状态盖回去，看起来像「鼠标放上去就自动取消了喜欢」。
 *
 * 做法：本地记录最近一次点击的结果，在 TTL 内**以本地为准**；TTL 之后交回服务器
 * 数据（此时服务端一般已经生效）。请求失败时调用 `clearLikeOverride` 立刻放弃覆盖。
 */
const TTL_MS = 20_000

interface Override {
  liked: boolean
  at: number
}

const overrides = new Map<number, Override>()

/** 记录一次点击结果（乐观更新）。 */
export function markLike(id: number, liked: boolean): void {
  overrides.set(id, { liked, at: Date.now() })
}

/** 请求失败时撤销覆盖，回到服务器数据。 */
export function clearLikeOverride(id: number): void {
  overrides.delete(id)
}

function activeOverride(id: number): Override | undefined {
  const entry = overrides.get(id)
  if (!entry) return undefined
  if (Date.now() - entry.at > TTL_MS) {
    overrides.delete(id)
    return undefined
  }
  return entry
}

/** 单个 id 的点赞状态：本地覆盖优先。 */
export function isLiked(id: number, serverIDs: Iterable<number>): boolean {
  const override = activeOverride(id)
  if (override) return override.liked
  for (const value of serverIDs) {
    if (value === id) return true
  }
  return false
}

/** 把服务器列表整体套用本地覆盖，得到用于渲染的集合。 */
export function applyLikeOverrides(serverIDs: Iterable<number>): Set<number> {
  const result = new Set<number>(serverIDs)
  for (const [id, entry] of overrides) {
    if (Date.now() - entry.at > TTL_MS) {
      overrides.delete(id)
      continue
    }
    if (entry.liked) result.add(id)
    else result.delete(id)
  }
  return result
}
