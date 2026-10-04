/**
 * The preload bridge.
 *
 * The renderer gets exactly two primitives — `invoke` and `on` — plus the list
 * of channel names. No Node API, no `remote`, no filesystem: every privileged
 * operation is a named channel that the main process implements and validates.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_EVENT_NAMES, IPC_INVOKE_CHANNELS } from '@shared/ipc'
import type { IPCChannel, IPCEventName, IPCEvents } from '@shared/ipc'
import type { IPCResult } from '@shared/types'

const INVOKE_PREFIX = 'kumone:invoke:'
const EVENT_PREFIX = 'kumone:event:'

export interface KumoneBridge {
  invoke<C extends IPCChannel>(
    channel: C,
    request?: unknown
  ): Promise<IPCResult<unknown>>
  on<E extends IPCEventName>(event: E, listener: (payload: IPCEvents[E]) => void): () => void
  channels: { invoke: readonly string[]; events: readonly string[] }
  platform: NodeJS.Platform
  versions: { electron: string; chrome: string; node: string }
}

const bridge: KumoneBridge = {
  invoke: (channel, request) => {
    if (!IPC_INVOKE_CHANNELS.includes(channel)) {
      return Promise.resolve({
        ok: false,
        error: `未知的 IPC 通道: ${channel}`,
        kind: 'internal'
      })
    }
    return ipcRenderer.invoke(INVOKE_PREFIX + channel, request)
  },
  on: (event, listener) => {
    if (!IPC_EVENT_NAMES.includes(event)) return () => undefined
    const handler = (_event: unknown, payload: unknown): void => {
      listener(payload as IPCEvents[typeof event])
    }
    ipcRenderer.on(EVENT_PREFIX + event, handler)
    return () => ipcRenderer.off(EVENT_PREFIX + event, handler)
  },
  channels: { invoke: IPC_INVOKE_CHANNELS, events: IPC_EVENT_NAMES },
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }
}

contextBridge.exposeInMainWorld('kumone', bridge)
