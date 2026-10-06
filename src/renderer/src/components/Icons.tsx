/**
 * 线性 SVG 图标集。
 *
 * 界面里不再使用 emoji：emoji 在不同 Windows 版本上字形差异很大、无法跟随主题色，
 * 而且在深色玻璃背景上会显得脏。这里用 `currentColor` 描边的线性图标替代，
 * 尺寸随字号缩放，颜色由 CSS 决定。
 *
 * 全部图标共用 24×24 视图框与 1.7 的线宽，保证并排时视觉重量一致。
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

export function IconHome(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M4 10.5 12 4l8 6.5" />
      <path d="M6 9.5V20h12V9.5" />
      <path d="M10 20v-5h4v5" />
    </Base>
  )
}

export function IconCompass(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m15.2 8.8-2 4.4-4.4 2 2-4.4z" />
    </Base>
  )
}

export function IconLibrary(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M5 4h2.5v16H5z" />
      <path d="M10 4h2.5v16H10z" />
      <path d="m15.2 5.2 2.4-.7 4 15.2-2.4.7z" />
    </Base>
  )
}

export function IconSearch(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </Base>
  )
}

export function IconCalendar(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <rect x="4" y="5.5" width="16" height="14" rx="2.5" />
      <path d="M4 10h16M9 4v3M15 4v3" />
    </Base>
  )
}

export function IconRadio(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="2.6" />
      <path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6" />
      <path d="M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8" />
    </Base>
  )
}

export function IconCloud(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M7.5 18.5h9a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 6.6 10.6 4 4 0 0 0 7.5 18.5Z" />
    </Base>
  )
}

export function IconSettings(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="2.8" />
      <path d="M12 3.5v2.2M12 18.3v2.2M4.9 7.8l1.9 1.1M17.2 15.1l1.9 1.1M4.9 16.2l1.9-1.1M17.2 8.9l1.9-1.1" />
    </Base>
  )
}

export function IconUser(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5" />
    </Base>
  )
}

export function IconPlay(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M8 5.5 18.5 12 8 18.5z" fill="currentColor" stroke="none" />
    </Base>
  )
}

export function IconPause(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M9 5.5h2.2v13H9zM12.8 5.5H15v13h-2.2z" fill="currentColor" stroke="none" />
    </Base>
  )
}

export function IconNext(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M6 6.5 14 12l-8 5.5z" fill="currentColor" stroke="none" />
      <path d="M16.2 6h1.8v12h-1.8z" fill="currentColor" stroke="none" />
    </Base>
  )
}

export function IconPrevious(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M18 6.5 10 12l8 5.5z" fill="currentColor" stroke="none" />
      <path d="M6 6h1.8v12H6z" fill="currentColor" stroke="none" />
    </Base>
  )
}

export function IconRepeat(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M6.5 9.5A4 4 0 0 1 10.4 7H17" />
      <path d="m14.8 4.8 2.4 2.2-2.4 2.2" />
      <path d="M17.5 14.5A4 4 0 0 1 13.6 17H7" />
      <path d="m9.2 19.2-2.4-2.2 2.4-2.2" />
    </Base>
  )
}

export function IconRepeatOne(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M6.5 9.5A4 4 0 0 1 10.4 7H17" />
      <path d="m14.8 4.8 2.4 2.2-2.4 2.2" />
      <path d="M17.5 14.5A4 4 0 0 1 13.6 17H7" />
      <path d="m9.2 19.2-2.4-2.2 2.4-2.2" />
      <path d="M11.4 10.2 12.6 9.4v5.2" />
    </Base>
  )
}

export function IconShuffle(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M4 7h3.2l3 3.4M20 7h-4.4l-7.4 10H4" />
      <path d="m17.6 4.6 2.4 2.4-2.4 2.4M17.6 14.6 20 17l-2.4 2.4" />
    </Base>
  )
}

export function IconQueue(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M4 7h11M4 12h11M4 17h7" />
      <path d="M18.5 10.5v8" />
      <circle cx="17" cy="18.5" r="1.5" />
    </Base>
  )
}

export function IconVolume(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M5 9.5h3L12 6v12l-4-3.5H5z" />
      <path d="M15.5 9.5a3.6 3.6 0 0 1 0 5M18 7.4a7 7 0 0 1 0 9.2" />
    </Base>
  )
}

export function IconVolumeMute(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M5 9.5h3L12 6v12l-4-3.5H5z" />
      <path d="m16 10 4 4M20 10l-4 4" />
    </Base>
  )
}

export function IconHeart(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M12 19s-6.5-4-6.5-8.3A3.7 3.7 0 0 1 12 8.2a3.7 3.7 0 0 1 6.5 2.5C18.5 15 12 19 12 19Z" />
    </Base>
  )
}

export function IconHeartFilled(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path
        d="M12 19s-6.5-4-6.5-8.3A3.7 3.7 0 0 1 12 8.2a3.7 3.7 0 0 1 6.5 2.5C18.5 15 12 19 12 19Z"
        fill="currentColor"
      />
    </Base>
  )
}

export function IconTrash(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M5.5 7.5h13M10 7.5V5.5h4v2M8 7.5 8.8 19h6.4L16 7.5" />
      <path d="M11 11v5M13 11v5" />
    </Base>
  )
}

export function IconPlus(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M12 5.5v13M5.5 12h13" />
    </Base>
  )
}

export function IconCheck(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="m5.5 12.5 4.2 4.2 8.8-9.4" />
    </Base>
  )
}

export function IconClose(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
    </Base>
  )
}

export function IconMore(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </Base>
  )
}

export function IconBack(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M14.5 5.5 8 12l6.5 6.5" />
    </Base>
  )
}

/** 精品/甄选标记：菱形，用于「精品歌单」等需要一点高级感的入口。 */
export function IconDiamond(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M7.5 4.5h9l4 4.5-8.5 10.5L3.5 9z" />
      <path d="M3.5 9h17M12 19.5 8.5 9 12 4.5 15.5 9z" />
    </Base>
  )
}

/** 星星：用于收藏/推荐等强调性标记。 */
export function IconSparkles(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M12 4.5c.6 3.8 2.7 5.9 6.5 6.5-3.8.6-5.9 2.7-6.5 6.5-.6-3.8-2.7-5.9-6.5-6.5 3.8-.6 5.9-2.7 6.5-6.5Z" />
      <path d="M18.5 15.5c.3 1.8 1.2 2.7 3 3-1.8.3-2.7 1.2-3 3-.3-1.8-1.2-2.7-3-3 1.8-.3 2.7-1.2 3-3Z" />
    </Base>
  )
}

/** 歌词：音符 + 三行文字，用于「桌面歌词」入口。 */
export function IconLyrics(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M9 6.5v8.1a3 3 0 1 1-1.5-2.6V8.2l10-2v7.4a3 3 0 1 1-1.5-2.6V4.7z" />
      <path d="M7.5 13.2v1M16.5 12.1v1" />
    </Base>
  )
}

/** 展开/全屏：四个角向外，用于播放页「真全屏」开关。 */
export function IconExpand(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M4.5 9.5v-5h5M19.5 9.5v-5h-5M4.5 14.5v5h5M19.5 14.5v5h-5" />
    </Base>
  )
}

export function IconDisc(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.4" />
    </Base>
  )
}

export function IconMic(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <rect x="9.5" y="4" width="5" height="9" rx="2.5" />
      <path d="M7 11.5a5 5 0 0 0 10 0M12 16.5V20M9.5 20h5" />
    </Base>
  )
}

export function IconClock(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </Base>
  )
}

export function IconMusic(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M9 17.5V6.2l9-1.7v10.6" />
      <circle cx="6.8" cy="17.5" r="2.2" />
      <circle cx="15.8" cy="15.1" r="2.2" />
    </Base>
  )
}

export function IconPencil(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="M15.5 5.5 18.5 8.5 9 18H6v-3z" />
      <path d="m13.8 7.2 3 3" />
    </Base>
  )
}

export function IconLayers(props: IconProps): JSX.Element {
  return (
    <Base {...props}>
      <path d="m12 4 8 4-8 4-8-4z" />
      <path d="m4 12.5 8 4 8-4" />
    </Base>
  )
}

/**
 * 应用标识：与桌面图标同一只小鱼（橙红渐变身体 + 白色音波）。
 * 用 currentColor 之外的自有渐变，是为了让品牌色在任何主题下都保持一致。
 */
export function LogoMark({ size = 40, ...rest }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <defs>
        <linearGradient id="kumone-logo-body" x1="10" y1="8" x2="40" y2="42" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFB03A" />
          <stop offset="0.55" stopColor="#FF5A1F" />
          <stop offset="1" stopColor="#FF2D55" />
        </linearGradient>
      </defs>
      {/* 身体 */}
      <ellipse cx="26" cy="24" rx="13.5" ry="12" fill="url(#kumone-logo-body)" />
      {/* 尾鳍 */}
      <path
        d="M13.5 24c-3.4-3.4-6.6-4.6-8.6-3.9-1.6.6-1.9 3-1.9 3.9 0 .9.3 3.3 1.9 3.9 2 .7 5.2-.5 8.6-3.9Z"
        fill="url(#kumone-logo-body)"
        opacity="0.85"
      />
      {/* 背鳍与腹鳍 */}
      <path d="M24 12.5c1.6-2.6 3.6-4 5.6-3.5 1.5.4 2.2 2.2 2.2 3.5Z" fill="url(#kumone-logo-body)" opacity="0.9" />
      <path d="M24 35.5c1.6 2.6 3.6 4 5.6 3.5 1.5-.4 2.2-2.2 2.2-3.5Z" fill="url(#kumone-logo-body)" opacity="0.9" />
      {/* 音波 */}
      <rect x="21.5" y="21" width="1.8" height="6" rx="0.9" fill="#fff" />
      <rect x="25" y="18.5" width="1.8" height="11" rx="0.9" fill="#fff" />
      <rect x="28.5" y="20" width="1.8" height="8" rx="0.9" fill="#fff" />
      <circle cx="33.6" cy="24" r="2.4" fill="#fff" />
    </svg>
  )
}
