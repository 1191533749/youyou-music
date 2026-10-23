/**
 * 外观（自定义壁纸 + 毛玻璃模糊度）。
 *
 * 两件事都在渲染层落地：
 *   - 模糊度写根节点的 --glass-blur（global.css 里 --blur / --blur-strong 从它推导，
 *     于是全应用的玻璃一起变），选择记在 localStorage `youyou-glass-blur`；
 *   - 壁纸的图片放在主进程的 userData 里，通过 youyou-wallpaper:// 协议读；渲染层
 *     只写 html[data-wallpaper] 与根节点的 --wallpaper，真正的记录（是否设置、版本号）
 *     在主进程设置里，所以启动时要问一次 settings:get。
 *
 * 壁纸是可选功能：这里每个入口都不会抛错，失败最多是「没有壁纸」，不该影响设置页。
 */
import { call, tryCall } from './contract'

/**
 * 模糊度的存储：`youyou-glass-blur` 存的是**滑杆档位**（0–100，不是像素），
 * `youyou-glass-blur-scheme='level'` 是版本标记 —— 旧版本存的是 0–40 的像素值，
 * 读到没有标记的旧值时按像素换算一次，用户原来的观感不会丢。
 */
export const BLUR_STORAGE_KEY = 'youyou-glass-blur'
const BLUR_SCHEME_KEY = 'youyou-glass-blur-scheme'
/** 滑杆档位：0 = 只剩 5% 基线（背景几乎全透明、原图清晰），100 = 最糊。 */
export const BLUR_MIN = 0
export const BLUR_MAX = 100
export const BLUR_DEFAULT = 65
/** 100 档对应的模糊半径（px）；65 档 ≈ 26.7px，约等于升级前的默认 26px。 */
const BLUR_MAX_PX = 40
/**
 * 用户要求的底线：0 档也保留 5% 的极轻微雾化，剩下 95% 全部交给滑杆。
 * 于是档位 0 → 2px、100 → 40px，中间线性。
 */
const BLUR_FLOOR = 0.05

function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return BLUR_DEFAULT
  return Math.min(BLUR_MAX, Math.max(BLUR_MIN, Math.round(value)))
}

/** 档位 → 实际模糊半径（px）。 */
export function blurPxOf(level: number): number {
  return BLUR_MAX_PX * (BLUR_FLOOR + (1 - BLUR_FLOOR) * (clampLevel(level) / BLUR_MAX))
}

/** 读取档位；没有记录就回默认，旧版像素值迁移一次。 */
export function readGlassBlur(): number {
  try {
    const stored = window.localStorage.getItem(BLUR_STORAGE_KEY)
    if (stored === null) return BLUR_DEFAULT
    const value = Number(stored)
    if (!Number.isFinite(value)) return BLUR_DEFAULT
    if (window.localStorage.getItem(BLUR_SCHEME_KEY) === 'level') return clampLevel(value)
    // 旧版：0–40 是像素，换算成等效档位（26px ≈ 65 档）。
    return clampLevel((value / BLUR_MAX_PX) * BLUR_MAX)
  } catch {
    return BLUR_DEFAULT
  }
}

/**
 * 应用档位：写 --glass-blur（像素）与 --wallpaper-clear（0–1，壁纸上的光斑/噪点
 * 按它淡出，0 档时壁纸原图不受任何叠加影响），并记住选择。返回实际生效的档位。
 */
export function applyGlassBlur(level: number): number {
  const value = clampLevel(level)
  const root = document.documentElement
  // 保留两位小数：0.95 * 0.4 这类浮点乘法会算出 17.200000000000003，
  // 直接写进 CSS 变量又长又难看，保留两位对 blur() 没有任何可见差别。
  root.style.setProperty('--glass-blur', `${Math.round(blurPxOf(value) * 100) / 100}px`)
  root.style.setProperty('--wallpaper-clear', String(value / BLUR_MAX))
  try {
    window.localStorage.setItem(BLUR_STORAGE_KEY, String(value))
    window.localStorage.setItem(BLUR_SCHEME_KEY, 'level')
  } catch {
    // 记不住只是下次打开回到默认，不影响本次调整。
  }
  return value
}

/** 启动时调用：让上次的档位在第一帧就生效（顺带把旧版像素值迁移成档位）。 */
export function initGlassBlur(): number {
  return applyGlassBlur(readGlassBlur())
}

/** 壁纸图片/视频地址。带版本号：换图后 URL 变了，不会被 Chromium 的缓存挡住。 */
export function wallpaperUrl(version: number): string {
  return `youyou-wallpaper://current?v=${version}`
}

/** 壁纸类型：图片铺满，视频静音循环。 */
export type WallpaperKind = 'image' | 'video'

/** 当前壁纸状态：由 Backdrop 里的 WallpaperLayer 渲染（图片层或视频层）。 */
export interface WallpaperState {
  set: boolean
  version: number
  kind: WallpaperKind
  /** 0–1：背景不透明度（100% = 完全显示，0 = 只剩玻璃光斑）。 */
  opacity: number
}

let wallpaperState: WallpaperState = { set: false, version: 0, kind: 'image', opacity: 1 }
const wallpaperListeners = new Set<(state: WallpaperState) => void>()

/** WallpaperLayer 订阅壁纸变化（换壁纸、改不透明度都会通知）。 */
export function subscribeWallpaper(listener: (state: WallpaperState) => void): () => void {
  wallpaperListeners.add(listener)
  return () => {
    wallpaperListeners.delete(listener)
  }
}

export function currentWallpaper(): WallpaperState {
  return wallpaperState
}

function publish(next: WallpaperState): void {
  wallpaperState = next
  const root = document.documentElement
  // data-wallpaper 只用于 CSS 里把光斑/噪点压暗；图片/视频本身由 React 层渲染。
  if (next.set) root.setAttribute('data-wallpaper', '1')
  else root.removeAttribute('data-wallpaper')
  for (const listener of wallpaperListeners) listener(next)
}

/** 有壁纸：更新状态，壁纸层立刻换成新图片/视频。 */
export function applyWallpaper(
  version: number,
  kind: WallpaperKind = 'image',
  backgroundOpacity = 100
): void {
  const opacity = Math.min(1, Math.max(0, backgroundOpacity / 100))
  publish({ set: true, version, kind, opacity })
}

/** 清除壁纸：去掉标记，背景回退成皮肤色晕。 */
export function clearWallpaper(): void {
  publish({ set: false, version: 0, kind: 'image', opacity: 1 })
}

/**
 * 调整背景不透明度：先立刻应用（滑杆跟手），再写回主进程设置（重启后保持）。
 * 没设壁纸时也照样记下，等以后选壁纸就用这个值。
 */
export async function applyBackgroundOpacity(percent: number): Promise<void> {
  const clamped = Math.min(100, Math.max(0, Math.round(percent)))
  publish({ ...wallpaperState, opacity: clamped / 100 })
  await call('settings:update', { backgroundOpacity: clamped })
}

/**
 * 启动时恢复壁纸。壁纸记录在主进程设置里，所以问一次 settings:get；
 * 拿不到（桥接未就绪、设置读取失败）就当作没有壁纸，静默返回。
 */
export async function initWallpaper(): Promise<void> {
  const settings = await tryCall('settings:get')
  if (!settings) return
  if (settings.wallpaperSet) {
    applyWallpaper(
      settings.wallpaperVersion,
      settings.wallpaperKind ?? 'image',
      settings.backgroundOpacity ?? 100
    )
  } else {
    clearWallpaper()
  }
}

/** 设置页「选择图片/视频」：弹系统文件框，成功后立刻换背景。 */
export async function pickWallpaper(): Promise<{
  set: boolean
  version: number
  kind?: WallpaperKind
}> {
  const result = await call('settings:pickWallpaper')
  if (result.set) {
    applyWallpaper(result.version, result.kind ?? 'image', wallpaperState.opacity * 100)
  }
  return result
}

/** 设置页「清除壁纸」：主进程删掉图片/视频记录，渲染层同时撤掉背景。 */
export async function removeWallpaper(): Promise<void> {
  await call('settings:clearWallpaper')
  clearWallpaper()
}
