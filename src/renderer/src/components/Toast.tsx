/**
 * 轻提示（右下角堆叠，3 秒自动消失）。
 *
 * 用法 —— 调用 useToast() 拿到 show() 与 node：
 *
 *   const toast = useToast()
 *   <button onClick={() => toast.show('已收藏', 'success')}>收藏</button>
 *   return <div className="page">{content}{toast.node}</div>
 *
 * 两条渲染路径：
 *   - App 里挂了一个 <AppToastStack />，它订阅模块级总线，所以常规情况下提示会被投递到
 *     应用级容器里 —— 页面在提示消失前被切走，提示不会跟着一起消失。
 *   - 若应用级容器不存在（例如把这个组件单独拿去用），bus 上没有订阅者，
 *     提示退回 `node` 渲染的页面级容器，行为与从前一致。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type ToastKind = 'info' | 'success' | 'error'

export interface ToastApi {
  /** 弹出一条提示；`message` 为空时忽略。 */
  show: (message: string, kind?: ToastKind) => void
  /** 渲染到 body 的提示层，放在页面 JSX 任意位置均可。 */
  node: ReactNode
}

interface ToastItem {
  id: number
  message: string
  kind: ToastKind
}

const DURATION_MS = 3000
/** 同时最多显示几条；再多的挤掉最旧的，避免刷屏遮住播放条。 */
const MAX_VISIBLE = 4

const ICONS: Record<ToastKind, string> = {
  info: 'ℹ',
  success: '✓',
  error: '!'
}

/** 应用级提示总线：App 挂载的容器订阅它，页面只负责发。 */
type ToastListener = (item: ToastItem) => void
const listeners = new Set<ToastListener>()
let nextId = 1

function publish(message: string, kind: ToastKind): boolean {
  if (listeners.size === 0) return false
  const item: ToastItem = { id: nextId++, message, kind }
  for (const listener of listeners) listener(item)
  return true
}

/** 挂在 App 里即可让全应用共用一层提示。 */
export function AppToastStack(): JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([])
  const timers = useRef(new Map<number, number>())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timers.current.delete(id)
    }
    setItems((current) => current.filter((item) => item.id !== id))
  }, [])

  useEffect(() => {
    const listener: ToastListener = (item) => {
      setItems((current) => [...current.slice(-(MAX_VISIBLE - 1)), item])
      timers.current.set(
        item.id,
        window.setTimeout(() => dismiss(item.id), DURATION_MS)
      )
    }
    listeners.add(listener)
    const pending = timers.current
    return () => {
      listeners.delete(listener)
      pending.forEach((timer) => window.clearTimeout(timer))
      pending.clear()
    }
  }, [dismiss])

  return createPortal(
    <div className="toast-stack" role="status" aria-live="polite">
      {items.map((item) => (
        <div
          key={item.id}
          className={`toast toast--${item.kind}`}
          title="点击关闭"
          onClick={() => dismiss(item.id)}
        >
          <span className="toast__icon">{ICONS[item.kind]}</span>
          <span className="toast__message">{item.message}</span>
        </div>
      ))}
    </div>,
    document.body
  )
}

export function useToast(): ToastApi {
  const [items, setItems] = useState<ToastItem[]>([])
  const localId = useRef(1)
  const timers = useRef(new Map<number, number>())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timers.current.delete(id)
    }
    setItems((current) => current.filter((item) => item.id !== id))
  }, [])

  const show = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      if (!message) return
      // 应用级容器接管时不再落地到本页，避免同一条提示出现两次。
      if (publish(message, kind)) return
      const id = localId.current++
      setItems((current) => [...current.slice(-(MAX_VISIBLE - 1)), { id, message, kind }])
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), DURATION_MS)
      )
    },
    [dismiss]
  )

  // 页面卸载时把定时器全部收掉，否则会对已卸载的组件 setState。
  useEffect(() => {
    const pending = timers.current
    return () => {
      pending.forEach((timer) => window.clearTimeout(timer))
      pending.clear()
    }
  }, [])

  const node = useMemo(
    () =>
      createPortal(
        <div className="toast-stack" role="status" aria-live="polite">
          {items.map((item) => (
            <div
              key={item.id}
              className={`toast toast--${item.kind}`}
              title="点击关闭"
              onClick={() => dismiss(item.id)}
            >
              <span className="toast__icon">{ICONS[item.kind]}</span>
              <span className="toast__message">{item.message}</span>
            </div>
          ))}
        </div>,
        document.body
      ),
    [items, dismiss]
  )

  return useMemo(() => ({ show, node }), [show, node])
}
