/**
 * Typed IPC client for the renderer.
 *
 * `call` unwraps the `IPCResult` envelope and throws on failure, so call sites
 * can use try/catch and surface `error.kind === 'needLogin'` as a login prompt
 * rather than a generic error.
 */
import type { IPCChannel, IPCRequest, IPCResponse } from '@shared/ipc'
import type { IPCResult } from '@shared/types'

export class IPCError extends Error {
  readonly kind: NonNullable<IPCResult<unknown>['kind']>

  constructor(message: string, kind: NonNullable<IPCResult<unknown>['kind']>) {
    super(message)
    this.name = 'IPCError'
    this.kind = kind
  }

  get needsLogin(): boolean {
    return this.kind === 'needLogin'
  }
}

export async function call<C extends IPCChannel>(
  channel: C,
  request?: IPCRequest<C>
): Promise<IPCResponse<C>> {
  const bridge = window.kumone
  if (!bridge) {
    throw new IPCError('预加载桥接未就绪，请重启应用', 'internal')
  }
  const result = await bridge.invoke(channel, request)
  if (!result.ok) {
    throw new IPCError(result.error ?? '未知错误', result.kind ?? 'internal')
  }
  return result.data as IPCResponse<C>
}

/** Resolves with `undefined` instead of throwing — for optional/best-effort reads. */
export async function tryCall<C extends IPCChannel>(
  channel: C,
  request?: IPCRequest<C>
): Promise<IPCResponse<C> | undefined> {
  try {
    return await call(channel, request)
  } catch {
    return undefined
  }
}

export function onEvent<E extends keyof import('@shared/ipc').IPCEvents>(
  event: E,
  listener: (payload: import('@shared/ipc').IPCEvents[E]) => void
): () => void {
  return window.kumone.on(event, listener)
}
