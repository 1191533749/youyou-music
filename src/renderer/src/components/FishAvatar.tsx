/**
 * 小鱼占位头像（悠悠音乐的吉祥物）。
 *
 * 用途：封面 / 头像还在加载、或者压根没取到（URL 为空、CDN 出错）时顶一会儿，
 * **图片一到就立刻让位**给真实图片，不留破图图标、也不留占位闪烁。
 *
 * 线条风格：细描边 + `currentColor`（由 CSS 给成 --accent），圆底用 --accent-soft，
 * 尺寸随容器（高度撑满、aspect-ratio 保持正方，非方形容器里居中不拉伸）。
 */
import { useEffect, useState } from 'react'

export interface FishAvatarProps {
  className?: string
  /** 无障碍名称；默认「头像加载中」，图标本身 aria-hidden。 */
  label?: string
}

export default function FishAvatar({ className, label = '封面加载中' }: FishAvatarProps): JSX.Element {
  return (
    <span className={className ? `fish-avatar ${className}` : 'fish-avatar'} role="img" aria-label={label}>
      <svg
        viewBox="0 0 64 64"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {/* 鱼身 */}
        <path d="M45.5 33c0 8.5-7.3 15-16.2 15S13 41.5 13 33s7.4-15 16.3-15 16.2 6.5 16.2 15Z" />
        {/* 鱼尾 */}
        <path d="M13.4 33 4.8 25.6v14.8L13.4 33Z" />
        {/* 背鳍 */}
        <path d="M24.6 18.8c1.7-4.4 5.3-7 9.4-6.5" />
        {/* 鳃线 */}
        <path d="M31.4 24.6c-2.6 4.6-2.6 12.2 0 16.8" />
        {/* 眼睛 */}
        <circle cx="38.6" cy="28.8" r="1.9" fill="currentColor" stroke="none" />
        {/* 气泡 */}
        <circle cx="22.4" cy="11.8" r="2.1" />
        <circle cx="29.6" cy="6.6" r="1.4" />
      </svg>
    </span>
  )
}

/**
 * 预加载一张图片，返回它是否已经就绪。
 *
 * 用 `new Image()` 在后台预热，而不是把 `<img>` 挂在页面上：加载中和失败都不会
 * 露出浏览器破图图标；等它返回 true 再渲染真实 `<img>` 时图片已在缓存里，
 * 因此是「一下就换成真图」，不会先闪一张半成品。
 */
export function useImageReady(src: string | undefined): boolean {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!src) {
      setReady(false)
      return
    }
    let cancelled = false
    setReady(false)
    const image = new Image()
    image.onload = () => {
      if (!cancelled) setReady(true)
    }
    image.onerror = () => {
      if (!cancelled) setReady(false)
    }
    image.src = src
    return () => {
      cancelled = true
    }
  }, [src])

  return ready
}
