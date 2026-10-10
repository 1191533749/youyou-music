/**
 * 诊断日志落盘（悠悠音乐客户端异常/崩溃收集，零依赖）。
 *
 * 客户端把收集到的异常（未捕获异常、Promise 拒绝、渲染进程崩溃、子进程崩溃、
 * mpv/IPC 错误）批量 POST 到 /logs，这里按 category 分类、按月分文件落盘为 JSONL。
 *
 * 数据目录：data/logs/<category>/<YYYY-MM>.jsonl
 * 每条：{ at, ip, category, message, stack?, appVersion, platform, osVersion, arch, hostname }
 * 客户端 IP 由服务器从连接取（X-Forwarded-For 优先，其次 X-Real-IP，最后 socket 地址），
 * 客户端无需也不能伪造自己的 IP 字段。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
export const logsDir = path.join(root, 'data', 'logs')

/** 分类白名单（与客户端一致，非法值归入 other）。 */
const VALID_CATEGORIES = new Set([
  'uncaught',
  'unhandled',
  'render-gone',
  'child-gone',
  'mpv',
  'ipc',
  'error',
  'other'
])

const MAX_PER_BATCH = 200
const MAX_MESSAGE = 4000
const MAX_STACK = 8000
const MAX_FIELD = 128

mkdirSync(logsDir, { recursive: true })

function normCategory(category) {
  return typeof category === 'string' && VALID_CATEGORIES.has(category) ? category : 'other'
}

function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/** 校验并裁剪一条日志；返回 null 表示该条整体非法（丢弃）。 */
function sanitiseEntry(entry, ip) {
  if (!entry || typeof entry !== 'object') return null
  const message = str(entry.message, MAX_MESSAGE)
  if (!message) return null
  const out = {
    at: str(entry.at, 40) || new Date().toISOString(),
    ip: str(ip, MAX_FIELD),
    category: normCategory(entry.category),
    message,
    appVersion: str(entry.appVersion, 32),
    platform: str(entry.platform, 32),
    osVersion: str(entry.osVersion, MAX_FIELD),
    arch: str(entry.arch, 16),
    hostname: str(entry.hostname, MAX_FIELD)
  }
  const stack = str(entry.stack, MAX_STACK)
  if (stack) out.stack = stack
  return out
}

/** 校验并裁剪日志数组；返回 null 表示整体非法。 */
export function sanitiseLogs(logs) {
  if (!Array.isArray(logs) || logs.length === 0) return null
  return logs.slice(0, MAX_PER_BATCH)
}

/** 把一批日志按 category 分类、按月追加落盘，返回成功条数。 */
export function saveLogs(logs, ip) {
  const buckets = new Map()
  for (const raw of logs) {
    const entry = sanitiseEntry(raw, ip)
    if (!entry) continue
    const lines = buckets.get(entry.category) ?? []
    lines.push(JSON.stringify(entry))
    buckets.set(entry.category, lines)
  }
  let stored = 0
  const month = new Date().toISOString().slice(0, 7) // YYYY-MM
  for (const [category, lines] of buckets) {
    const dir = path.join(logsDir, category)
    mkdirSync(dir, { recursive: true })
    appendFileSync(path.join(dir, `${month}.jsonl`), lines.map((line) => line + '\n').join(''), 'utf8')
    stored += lines.length
  }
  return stored
}

/** 取客户端 IP：反代会带 X-Forwarded-For / X-Real-IP，直连则用 socket 地址。 */
export function clientIp(request) {
  const forwarded = request.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim()
  }
  const real = request.headers['x-real-ip']
  if (typeof real === 'string' && real.length > 0) {
    return real.trim()
  }
  return request.socket?.remoteAddress ?? ''
}
