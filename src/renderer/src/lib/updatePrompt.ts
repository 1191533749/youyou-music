/**
 * 更新提示的共享状态：把「启动时自动检测」与「设置里手动检测」接到同一个弹窗。
 *
 * 模块级 pub/sub（一个进程只有一个主窗口），App 挂载唯一弹窗并订阅这里，
 * 设置页按钮调用 checkForUpdateInteractive() 拿到结果用于按钮旁的文字反馈。
 */
import { call } from './ipc'

export interface UpdatePromptState {
  version: string
  notes?: string
}

export type UpdateCheckOutcome = 'update' | 'latest' | 'error'

let current: UpdatePromptState | undefined
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function snapshotUpdatePrompt(): UpdatePromptState | undefined {
  return current
}

export function subscribeUpdatePrompt(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 关闭弹窗（稍后更新）；不触发安装。 */
export function dismissUpdatePrompt(): void {
  if (!current) return
  current = undefined
  notify()
}

/**
 * 检查更新：
 *  - 有新版本 → 弹窗出现（30 秒倒计时），返回 'update'；
 *  - 已是最新 → 返回 'latest'；
 *  - 网络/解析失败 → 返回 'error'（不弹窗）。
 * 启动时的静默检测与设置里的手动检测都走这里，行为一致。
 */
export async function checkForUpdateInteractive(): Promise<UpdateCheckOutcome> {
  try {
    const result = await call('update:check')
    if (result.version) {
      current = { version: result.version, notes: result.notes }
      notify()
      return 'update'
    }
    return 'latest'
  } catch {
    return 'error'
  }
}

/** 弹窗里「立即更新」：触发下载并排定替换/安装，应用会自己退出重开。 */
export async function installUpdateNow(): Promise<void> {
  const wasShowing = current !== undefined
  current = undefined
  notify()
  try {
    await call('update:install')
  } catch {
    // 下载/安装失败：恢复弹窗状态说明不了什么，直接静默（主进程会留日志）。
    void wasShowing
  }
}
