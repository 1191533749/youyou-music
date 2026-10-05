/**
 * `invoke` handler registration.
 *
 * `defineHandler` wraps every handler so the renderer always receives an
 * `IPCResult` envelope: a thrown `NeteaseAPIError` becomes `{ok:false, kind}`
 * with its message, which is what lets the UI say 需要登录 instead of showing a
 * generic failure. Unhandled channels resolve to a clear error rather than
 * hanging the renderer.
 */
import { ipcMain } from 'electron'
import type { AppContext } from '../context.js'
import { NeteaseAPIError } from '../netease/client.js'
import type { IPCChannel, IPCRequest, IPCResponse } from '@shared/ipc'
import { IPC_INVOKE_CHANNELS, IPC_EVENT_NAMES } from '@shared/ipc'
import type { IPCResult } from '@shared/types'

const INVOKE_PREFIX = 'kumone:invoke:'
const EVENT_PREFIX = 'kumone:event:'
const registered = new Set<string>()

export type Handler<C extends IPCChannel> = (
  request: IPCRequest<C>
) => Promise<IPCResponse<C>> | IPCResponse<C>

/** Registers one handler. The context is closed over at the call site. */
export function defineHandler<C extends IPCChannel>(channel: C, handler: Handler<C>): void {
  if (registered.has(channel)) {
    throw new Error(`重复注册的 IPC 通道: ${channel}`)
  }
  registered.add(channel)
  ipcMain.handle(INVOKE_PREFIX + channel, async (_event, request: unknown): Promise<IPCResult<unknown>> => {
    try {
      const data = await handler(request as IPCRequest<C>)
      return { ok: true, data }
    } catch (cause) {
      if (cause instanceof NeteaseAPIError) {
        return { ok: false, error: cause.message, kind: cause.kind }
      }
      const message = cause instanceof Error ? cause.message : String(cause)
      contextRef.value?.log(`IPC ${channel} 失败: ${message}`)
      return { ok: false, error: message, kind: 'internal' }
    }
  })
}

/**
 * The context is created after the stores load, while the handlers are
 * registered before the window opens. A single-slot holder bridges the two
 * without threading the context through every registration call.
 */
export const contextRef: { value: AppContext } = { value: undefined as unknown as AppContext }

export function sendEvent(context: AppContext, event: string, payload: unknown): void {
  // 广播给所有窗口：桌面歌词窗口是独立的 BrowserWindow，
  // 它靠 player:state / settings:changed 才知道该显示哪一句歌词。
  for (const window of context.windows()) {
    if (window.isDestroyed()) continue
    window.webContents.send(EVENT_PREFIX + event, payload)
  }
}

/** Fails fast when a channel in the contract has no implementation. */
export function assertAllChannelsRegistered(): string[] {
  return IPC_INVOKE_CHANNELS.filter((channel) => !registered.has(channel))
}

export { EVENT_PREFIX, IPC_EVENT_NAMES }
