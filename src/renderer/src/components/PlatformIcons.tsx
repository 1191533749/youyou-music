/**
 * 登录页的平台图标（网易云 / 酷狗 / QQ音乐）。
 *
 * 与 `Icons.tsx` 同样的画法：24×24 视图框、1.7 线宽、`currentColor` 描边，
 * 颜色与尺寸交给 CSS，跟随主题色变化。
 */
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Base({ size = 20, children, ...rest }: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** 网易云音乐：云朵里一个音符。 */
export function IconPlatformNetease(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M7 18.4h9.3a3.3 3.3 0 0 0 .4-6.6 4.7 4.7 0 0 0-8.9-1.2A3.4 3.4 0 0 0 7 18.4Z" />
      <path d="M11.9 15.2v-4.1l2.4-.7" />
      <circle cx="10.8" cy="15.3" r="1.2" />
    </Base>
  )
}

/** 酷狗音乐：爪印。 */
export function IconPlatformKugou(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <ellipse cx="7" cy="9.4" rx="1.5" ry="2" />
      <ellipse cx="11" cy="7.2" rx="1.5" ry="2.1" />
      <ellipse cx="15.3" cy="8.6" rx="1.5" ry="2" />
      <path d="M11.2 19c-2.8 0-4.3-1.4-4.3-3 0-1.5 1.7-3.3 4.3-3.3s4.3 1.8 4.3 3.3c0 1.6-1.5 3-4.3 3Z" />
    </Base>
  )
}

/** QQ音乐：连梁双音符。 */
export function IconPlatformQq(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <circle cx="8.4" cy="16.8" r="2.7" />
      <path d="M11.1 16.8V5.6l7.3 2.1v2.8" />
      <circle cx="15.7" cy="13.7" r="2.7" />
    </Base>
  )
}
