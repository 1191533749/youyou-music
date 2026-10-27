/**
 * 封面地址归一。
 *
 * 三种历史数据都会让渲染层的 <img> 加载失败：
 *  1) 网易云接口给的是 `http://` —— 渲染层 CSP 只放行 https，直接被拦；
 *  2) 网易云的 p3 分片在部分网络下会一直卡住（见 lib/format.ts）；
 *  3) 我们自己接口给的相对地址 `/player-api/cover?id=…` 需要 App 密钥，
 *     <img> 发不了自定义头，只能把 `k=` 拼进查询串。
 */
import { coverUrl } from './format'

/** 与主进程 / iOS 端一致的 App 密钥（本来就在客户端里，不是机密）。 */
const APP_KEY = 'b9ae8468c1c32ab0e1aa0223807791ef'
const API_ORIGIN = 'https://yy.ytw.asia'

export function absoluteCover(url: string | undefined, size = 120): string | undefined {
  if (!url) return undefined
  if (url.includes('/player-api/cover')) {
    const absolute = url.startsWith('/')
      ? `${API_ORIGIN}${url}`
      : url.replace(/^http:\/\//i, 'https://')
    if (/[?&]k=/.test(absolute)) return absolute
    return `${absolute}${absolute.includes('?') ? '&' : '?'}k=${APP_KEY}`
  }
  const secure = url.replace(/^http:\/\//i, 'https://')
  return /music\.126\.net/.test(secure) ? coverUrl(secure, size) : secure
}
