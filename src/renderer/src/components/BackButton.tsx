/**
 * 全站统一的返回按钮。
 *
 * 用户反馈：所有返回按钮都做成「圆形软色底 + 只用箭头」这一种。
 * 原先三种形态（顶部玻璃圆钮、全屏文字胶囊、我的音乐列表内文字胶囊）现在都走这里，
 * 样式收敛在 global.css 的 `.back-button`。
 */
import { IconBack } from './Icons'

export function BackButton({
  onClick,
  label = '返回'
}: {
  onClick: () => void
  label?: string
}): JSX.Element {
  return (
    <button type="button" className="back-button" onClick={onClick} aria-label={label} title={label}>
      <IconBack size={16} />
    </button>
  )
}
