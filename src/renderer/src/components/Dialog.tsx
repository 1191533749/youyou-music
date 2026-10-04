/**
 * 轻量模态框。
 *
 * 用法：
 *
 *   const [open, setOpen] = useState(false)
 *   ...
 *   <Dialog
 *     title="歌单简介"
 *     open={open}
 *     onClose={() => setOpen(false)}
 *     footer={<button className="button button--primary" onClick={() => setOpen(false)}>关闭</button>}
 *   >
 *     正文
 *   </Dialog>
 *
 * 说明：内容用 portal 挂到 body 上，这样不会被 .content 的滚动容器裁剪；
 * Esc 与点击遮罩都会触发 onClose，遮罩判定用 mousedown.target === currentTarget，
 * 避免在面板里按下、拖到遮罩上松手时被误判成“点了遮罩”。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface DialogProps {
  title: string
  open: boolean
  onClose: () => void
  children?: ReactNode
  footer?: ReactNode
  /** 面板最大宽度（px），默认 480。 */
  width?: number
}

export default function Dialog({ title, open, onClose, children, footer, width = 480 }: DialogProps): JSX.Element | null {
  const panel = useRef<HTMLDivElement>(null)
  const restoreTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus()
    // 关闭后把焦点还给触发它的按钮，键盘用户不会掉到页面开头。
    return () => restoreTo.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    // 捕获阶段监听：模态框打开时 Esc 应该先关它，而不是被页面的其他快捷键吃掉。
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panel}
        className="dialog"
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="dialog__header">
          <h2 className="dialog__title">{title}</h2>
          <button type="button" className="icon-button" title="关闭" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="dialog__body">{children}</div>
        {footer ? <footer className="dialog__footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body
  )
}
