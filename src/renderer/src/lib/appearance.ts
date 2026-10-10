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

/** 壁纸图片地址。带版本号：换图后 URL 变了，不会被 Chromium 的图片缓存挡住。 */
export function wallpaperUrl(version: number): string {
  return `youyou-wallpaper://current?v=${version}`
}

/** 有壁纸：根节点打上 data-wallpaper，并把地址交给 CSS 的 --wallpaper。 */
export function applyWallpaper(version: number): void {
  const root = document.documentElement
  root.setAttribute('data-wallpaper', '1')
  root.style.setProperty('--wallpaper', `url('${wallpaperUrl(version)}')`)
}

/** 清除壁纸：去掉标记与变量，背景回退成皮肤色晕。 */
export function clearWallpaper(): void {
  const root = document.documentElement
  root.removeAttribute('data-wallpaper')
  root.style.removeProperty('--wallpaper')
}

/**
 * 启动时恢复壁纸。壁纸记录在主进程设置里，所以问一次 settings:get；
 * 拿不到（桥接未就绪、设置读取失败）就当作没有壁纸，静默返回。
 */
export async function initWallpaper(): Promise<void> {
  const settings = await tryCall('settings:get')
  if (!settings) return
  if (settings.wallpaperSet) applyWallpaper(settings.wallpaperVersion)
  else clearWallpaper()
}

/** 设置页「选择图片」：弹系统文件框，成功后立刻换背景。 */
export async function pickWallpaper(): Promise<{ set: boolean; version: number }> {
  const result = await call('settings:pickWallpaper')
  if (result.set) applyWallpaper(result.version)
  return result
}

/** 设置页「清除壁纸」：主进程删掉图片记录，渲染层同时撤掉背景。 */
export async function removeWallpaper(): Promise<void> {
  await call('settings:clearWallpaper')
  clearWallpaper()
}
