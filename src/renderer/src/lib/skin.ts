/**
 * 皮肤（装扮）。
 *
 * 皮肤 = 一整套观感参数，全部定义在 global.css 的 `[data-skin='…']` 块与
 * 「皮肤氛围」一节里（主色组 + 玻璃色调 + 底纹 + 标题色）；这里只负责
 * 「选中的是哪个」以及把它写到根节点上。CSS 变量一换值，所有已挂载的页面
 * 当场重绘，所以切换是即时生效的，不需要刷新，也不需要重挂载任何组件。
 *
 * 与「主题（浅色 / 深色）」正交：主题管背景明暗与玻璃原色，皮肤管主色与氛围。
 * 选择记在 localStorage 就够，不必进主进程设置存储。
 */
export const SKINS = [
  { id: 'default', name: '悠悠暖橙红' },
  { id: 'netease', name: '网易云红' },
  { id: 'qqmusic', name: 'QQ音乐绿' },
  { id: 'kuwo', name: '酷我黄橙' },
  { id: 'kugou', name: '酷狗蓝' }
] as const

export type SkinId = (typeof SKINS)[number]['id']

/** 键名沿用 NowPlaying 的 youyou- 前缀习惯。 */
const STORAGE_KEY = 'youyou-skin'

const FALLBACK: SkinId = 'default'

function isSkinId(value: string | null): value is SkinId {
  return value !== null && SKINS.some((skin) => skin.id === value)
}

/** 读取记住的皮肤；隐私模式等场景读不到就回默认，不影响任何功能。 */
export function readSkin(): SkinId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return isSkinId(stored) ? stored : FALLBACK
  } catch {
    return FALLBACK
  }
}

/**
 * 切换皮肤：属性落到根节点上 + 记住选择，返回实际生效的皮肤 id。
 * 界面无刷新感地跟着变，就是这一行 dataset 的功劳（CSS 变量整体换值）。
 */
export function applySkin(id: SkinId): SkinId {
  document.documentElement.dataset.skin = id
  try {
    window.localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // 记不住选择只是下次打开回到默认，不该影响本次切换。
  }
  return id
}

/** 启动时调用：让上次选的皮肤在第一帧就生效；只读不写。 */
export function initSkin(): SkinId {
  const id = readSkin()
  document.documentElement.dataset.skin = id
  return id
}
