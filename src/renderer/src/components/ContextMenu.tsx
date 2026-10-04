/**
 * 右键 / 定位弹出的菜单。
 *
 * 用法：
 *
 *   const [menuAt, setMenuAt] = useState<{ x: number; y: number }>()
 *   ...
 *   <div onContextMenu={(event) => { event.preventDefault(); setMenuAt({ x: event.clientX, y: event.clientY }) }}>
 *     ...
 *   </div>
 *   {menuAt ? (
 *     <ContextMenu
 *       x={menuAt.x}
 *       y={menuAt.y}
 *       onClose={() => setMenuAt(undefined)}
 *       items={[
 *         { label: '播放全部', onSelect: playAll },
 *         { label: '删除歌单', danger: true, onSelect: remove }
 *       ]}
 *     />
 *   ) : null}
 *
 * 说明：先用原位渲染、再在 useLayoutEffect 里量尺寸回弹到视口内，
 * 所以贴边右键也不会把菜单顶出屏幕；Esc、点击外部、滚动、缩放都会关闭。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuItem {
  label: string
  /** 危险操作：红色文字（删除、取消收藏等）。 */
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

export interface ContextMenuProps {
  items: ContextMenuItem[]
  x: number
  y: number
  onClose: () => void
}

const MARGIN = 8

export default function ContextMenu({ items, x, y, onClose }: ContextMenuProps): JSX.Element | null {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const element = menu.current
    if (!element) return
    const width = element.offsetWidth
    const height = element.offsetHeight
    setPosition({
      left: Math.max(MARGIN, Math.min(x, window.innerWidth - width - MARGIN)),
      top: Math.max(MARGIN, Math.min(y, window.innerHeight - height - MARGIN))
    })
  }, [x, y, items.length])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    const onPointerDown = (event: MouseEvent): void => {
      if (!menu.current?.contains(event.target as Node)) onClose()
    }
    // 滚动或改变窗口大小时菜单会跟内容脱节，直接收起来最不容易出错。
    const onViewportChange = (): void => onClose()

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [onClose])

  if (items.length === 0) return null

  return createPortal(
    <div ref={menu} className="context-menu" style={{ left: position.left, top: position.top }} role="menu">
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`context-menu__item${item.danger ? ' context-menu__item--danger' : ''}`}
          disabled={item.disabled}
          onClick={() => {
            // 先收菜单再执行：动作里往往要开 Dialog，菜单留着会压在上面。
            onClose()
            item.onSelect()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  )
}
