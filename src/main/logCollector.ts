/**
 * 日志收集器：只收集本程序自己的异常，先本地落盘，再批量上传服务器分类存放。
 *
 * 覆盖：未捕获异常、未处理的 Promise 拒绝、渲染进程崩溃、子进程崩溃，
 * 以及 mpv/IPC 等主动上报的错误。绝不读取其它进程、绝不扫描系统。
 *
 * 由设置项 collectLogs 控制：关闭后既不收集也不上传。上传走主进程 fetch
 * （与每日推荐同步同一个服务器入口），不经过渲染层、不受 CSP 限制。
 *
 * 本地队列：<userData>/diagnostics/pending.jsonl（JSONL，每行一条）。
 * 上传成功即清空已传条目；失败保留，下次启动或下一条异常时再试。
 */
import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { REMOTE_DAILY_BASE, REMOTE_DAILY_TOKEN } from './storage/remoteDaily'

interface LogEntry {
  at: string
  category: string
  message: string
  stack?: string
  appVersion: string
  platform: string
  osVersion: string
  arch: string
  hostname: string
}

const UPLOAD_URL = `${REMOTE_DAILY_BASE}/logs?token=${encodeURIComponent(REMOTE_DAILY_TOKEN)}`
const UPLOAD_TIMEOUT_MS = 8000
const MAX_PENDING = 500
const MAX_BATCH = 100
const FLUSH_DELAY_MS = 10_000

/** 分类白名单（与服务器端一致，非法值归入 other）。 */
const CATEGORIES = new Set(['uncaught', 'unhandled', 'render-gone', 'child-gone', 'mpv', 'ipc', 'error', 'other'])

let enabled = false
let pendingFile = ''
let flushTimer: NodeJS.Timeout | undefined
let flushing = false

/** 在 bootstrap 里、settings.load 之后调用一次；enabled 由 collectLogs 决定。 */
export function initLogCollector(opts: { userData: string; enabled: boolean }): void {
  enabled = opts.enabled
  pendingFile = path.join(opts.userData, 'diagnostics', 'pending.jsonl')
  if (!enabled) return
  installHandlers()
  void flush() // 启动时补传上次没传掉的
}

/** 设置项切换时调用：打开后立即补传本地积压。 */
export function setLogCollectorEnabled(next: boolean): void {
  if (next === enabled) return
  enabled = next
  if (next) void flush()
}

/** 记录一条异常；供 mpv / IPC 等各处主动上报。关闭时是零开销空转。 */
export function recordLog(category: string, message: string, stack?: string): void {
  if (!enabled) return
  try {
    const entry: LogEntry = {
      at: new Date().toISOString(),
      category: CATEGORIES.has(category) ? category : 'other',
      message: String(message).slice(0, 4000),
      appVersion: app.getVersion(),
      platform: process.platform,
      osVersion: `${os.type()} ${os.release()}`,
      arch: process.arch,
      hostname: os.hostname()
    }
    if (stack) entry.stack = String(stack).slice(0, 8000)
    mkdirSync(path.dirname(pendingFile), { recursive: true })
    appendFileSync(pendingFile, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // 收集器自身绝不能制造二次异常。
  }
  scheduleFlush()
}

function installHandlers(): void {
  process.on('uncaughtException', (error) => {
    recordLog('uncaught', String(error?.message ?? error), error?.stack)
  })
  process.on('unhandledRejection', (reason) => {
    recordLog('unhandled', String(reason), reason instanceof Error ? reason.stack : undefined)
  })
  app.on('render-process-gone', (_event, _webContents, details) => {
    recordLog('render-gone', `渲染进程异常退出：${details.reason}`)
  })
  app.on('child-process-gone', (_event, details) => {
    recordLog('child-gone', `子进程异常退出：${details.type} ${details.reason}`)
  })
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    void flush()
  }, FLUSH_DELAY_MS)
}

/** 把本地待传队列批量上传；成功清空已传条目，失败保留等下次再试。 */
async function flush(): Promise<void> {
  if (flushing || !enabled) return
  flushing = true
  try {
    const lines = readPending()
    if (lines.length === 0) return
    const batch = lines.slice(0, MAX_BATCH)
    const response = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-token': REMOTE_DAILY_TOKEN
      },
      body: JSON.stringify({ logs: batch }),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
    })
    if (!response.ok) return
    const payload = (await response.json()) as { ok?: boolean }
    if (payload?.ok !== true) return
    writePending(lines.slice(batch.length))
  } catch {
    // 离线/服务器异常静默，下次启动或下一条异常再试。
  } finally {
    flushing = false
  }
}

function readPending(): LogEntry[] {
  try {
    if (!existsSync(pendingFile)) return []
    const text = readFileSync(pendingFile, 'utf8')
    const out: LogEntry[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed && typeof parsed === 'object') out.push(parsed as LogEntry)
      } catch {
        // 跳过损坏行。
      }
    }
    return out.slice(-MAX_PENDING)
  } catch {
    return []
  }
}

function writePending(entries: LogEntry[]): void {
  try {
    if (entries.length === 0) {
      rmSync(pendingFile, { force: true })
      return
    }
    mkdirSync(path.dirname(pendingFile), { recursive: true })
    writeFileSync(pendingFile, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
  } catch {
    // 写回失败下次再读原文件重试。
  }
}
