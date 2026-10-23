/**
 * App-level IPC: info, settings, cache, lyrics delivery and desktop-lyric
 * window control.
 */
import { app, dialog, screen, shell } from 'electron'
import type { OpenDialogOptions, Rectangle } from 'electron'
import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { defineHandler } from './registry.js'
import { toLyricsDTO } from '../lyrics/service.js'
import { resolveMpvBinary } from '../audio/mpv.js'
import { isPortableBuild } from '../update/service.js'
import { SearchType } from '../netease/api.js'
import { encodeQR } from '../qrcode.js'
import { setLogCollectorEnabled } from '../logCollector.js'
import { QUALITY_OPTIONS, type SettingsDTO } from '@shared/types'
import type { AppContext } from '../context.js'

/** 站外曲目（负 ID）的「同名同歌手」网易云歌词 ID 缓存：歌不变就不用反复搜。 */
const externalLyricCache = new Map<number, number | null>()

/** 可作为背景视频的扩展名（其余按图片处理）。 */
const VIDEO_WALLPAPER_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v'])

/** 精简模式（悬浮播放条）的窗口尺寸：面板 58 + 凸起唱片探出 14 = 72，窗口里不留空带。 */
const COMPACT_SIZE = { width: 420, height: 72 }

/** 进精简模式前的窗口位置与大小，退出时恢复。 */
let compactRestoreBounds: Rectangle | undefined

/** 精简模式状态与「精简队列」面板展开后的窗口高度。 */
let compactMode = false
const COMPACT_QUEUE_HEIGHT = 420

/** 标题/歌手名归一：去括号注释、小写、只留字母数字，比较用。 */
function lyricNorm(text: string): string {
  return text
    .toLowerCase()
    .replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]|【[^】]*】/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 站外曲目兜底：按「歌名 + 歌手」在网易云搜一次，严格命中才返回它的歌曲 ID。 */
async function findLyricTrack(
  context: AppContext,
  name: string,
  artist?: string
): Promise<number | undefined> {
  try {
    const result = await context.api.search(name, SearchType.songs, 12)
    const wanted = lyricNorm(name)
    if (!wanted) return undefined
    const wantedArtist = artist ? lyricNorm(artist) : ''
    let best: number | undefined
    let bestScore = 0
    for (const song of result.songs ?? []) {
      const title = lyricNorm(song.name)
      if (!title) continue
      let score = 0
      if (title === wanted) score += 10
      else if (title.includes(wanted) || wanted.includes(title)) score += 4
      if (!score) continue
      if (wantedArtist) {
        const artists = song.artists.map((entry) => lyricNorm(entry.name)).join(' ')
        if (artists.includes(wantedArtist) || wantedArtist.includes(artists)) score += 8
        else score -= 6
      }
      if (score > bestScore) {
        bestScore = score
        best = song.id
      }
    }
    // 只有「标题完全一致」（10 分）才认，宁缺毋滥。
    return bestScore >= 10 ? best : undefined
  } catch {
    return undefined
  }
}

export function registerAppHandlers(context: AppContext): void {
  defineHandler('app:info', async () => {
    let mpv: string | undefined
    let mpvPath: string | undefined
    try {
      mpvPath = resolveMpvPath()
      mpv = await processVersion(mpvPath)
    } catch (cause) {
      context.log(`读取 mpv 版本失败: ${String(cause)}`)
    }
    return {
      name: '悠悠音乐',
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      portable: isPortableBuild(),
      mpv,
      mpvPath
    }
  })

  defineHandler('settings:get', async () => {
    await context.settings.load()
    return context.settings.current
  })

  defineHandler('settings:update', async (patch: Partial<SettingsDTO>) => {
    const previousQuality = context.settings.current.quality
    const next = await context.settings.update(patch)
    if (patch.volume !== undefined) await context.player.setVolume(next.volume)
    /*
     * 改「默认音质」要立刻作用到正在播的那首歌：用户要的是「设置里改成标准，
     * 底下这首也马上切过来，状态栏文字一起变」，而不是等下一首才生效。
     */
    if (patch.quality !== undefined && next.quality !== previousQuality) {
      await context.player.reloadCurrentTrack()
    }
    if (patch.collectLogs !== undefined) setLogCollectorEnabled(next.collectLogs)
    if (patch.audioDevice !== undefined) {
      await context.mpv.setAudioDevice(patch.audioDevice || 'auto').catch((cause) => {
        context.log(`切换音频设备失败: ${String(cause)}`)
      })
    }
    if (patch.showDesktopLyrics !== undefined) {
      context.emit('settings:changed', next)
    }
    return next
  })

  defineHandler('app:cacheUsage', () => context.cache.usage())

  defineHandler('app:clearCache', async ({ what }) => {
    const usage = await context.cache.clear(what)
    context.log(`已清理缓存: ${what}`)
    return usage
  })

  defineHandler('app:openExternal', async ({ url }) => {
    if (!/^https?:\/\//.test(url)) throw new Error('只允许打开 http(s) 链接')
    await shell.openExternal(url)
  })

  defineHandler('app:chooseCacheDirectory', async () => {
    const window = context.mainWindow()
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: '选择缓存目录',
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return undefined
    return result.filePaths[0]
  })

  // --- 自定义壁纸（渲染层用 youyou-wallpaper://current?v=N 显示） ---

  defineHandler('settings:pickWallpaper', async () => {
    const window = context.mainWindow()
    const options: OpenDialogOptions = {
      title: '选择背景图片或视频',
      filters: [
        {
          name: '图片或视频',
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'mp4', 'webm', 'mov', 'm4v']
        }
      ],
      properties: ['openFile']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const current = context.settings.current
    if (result.canceled || result.filePaths.length === 0) {
      return {
        set: current.wallpaperSet,
        version: current.wallpaperVersion,
        kind: current.wallpaperKind
      }
    }
    const source = result.filePaths[0]
    const ext = path.extname(source).toLowerCase() || '.png'
    const kind = VIDEO_WALLPAPER_EXTENSIONS.has(ext) ? 'video' : 'image'
    const stat = await fsp.stat(source)
    // 视频要循环播放，体积上限放宽；图片仍然是 16MB。
    const limit = kind === 'video' ? 512 * 1024 * 1024 : 16 * 1024 * 1024
    if (stat.size > limit) {
      throw new Error(kind === 'video' ? '背景视频太大（最大 512MB）' : '背景图片太大（最大 16MB）')
    }
    const dir = path.join(app.getPath('userData'), 'wallpaper')
    await fsp.mkdir(dir, { recursive: true })
    // 清掉旧的 wallpaper.*，只保留最新一个，协议处理器按文件名前缀找。
    for (const entry of await fsp.readdir(dir).catch(() => [] as string[])) {
      if (entry.startsWith('wallpaper.')) await fsp.unlink(path.join(dir, entry)).catch(() => undefined)
    }
    const target = path.join(dir, `wallpaper${ext}`)
    await fsp.copyFile(source, target)
    const next = await context.settings.update({
      wallpaperSet: true,
      wallpaperVersion: (current.wallpaperVersion ?? 0) + 1,
      wallpaperKind: kind
    })
    return { set: next.wallpaperSet, version: next.wallpaperVersion, kind: next.wallpaperKind }
  })

  defineHandler('settings:clearWallpaper', async () => {
    const dir = path.join(app.getPath('userData'), 'wallpaper')
    for (const entry of await fsp.readdir(dir).catch(() => [] as string[])) {
      if (entry.startsWith('wallpaper.')) await fsp.unlink(path.join(dir, entry)).catch(() => undefined)
    }
    const next = await context.settings.update({
      wallpaperSet: false,
      wallpaperVersion: (context.settings.current.wallpaperVersion ?? 0) + 1
    })
    return { set: false, version: next.wallpaperVersion }
  })

  defineHandler('app:entitlements', async () => {
    // Which tiers the account can actually request. Without a login only the
    // free tiers are offerable; a VIP account unlocks the rest.
    let vipType = 0
    if (context.client.isLoggedIn) {
      try {
        const profile = await context.api.userAccount()
        vipType = profile?.vipType ?? 0
      } catch {
        vipType = 0
      }
    }
    return {
      vipType,
      available: QUALITY_OPTIONS.filter((option) => !option.vip || vipType > 0).map((o) => o.level)
    }
  })

  defineHandler('app:log', ({ level, message }) => {
    context.log(`[renderer:${level}] ${message}`)
  })

  /**
   * Renders a URL into a QR module matrix. The encoder runs here so the
   * renderer only draws squares.
   *
   * 只接受白名单来源：网易云登录地址、以及「一起听」充值用的支付宝收款码。
   * 白名单而不是任意 URL，避免被利用来渲染钓鱼二维码。
   */
  defineHandler('app:qrMatrix', ({ url }) => {
    const allowed = /^https:\/\/music\.163\.com\//.test(url) || /^https:\/\/qr\.alipay\.com\//.test(url)
    if (!allowed) {
      throw new Error('只允许为网易云登录地址或支付宝收款码生成二维码')
    }
    return encodeQR(url)
  })

  /**
   * QQ 群二维码：随包分发的图片，读成 data URL 给渲染进程展示
   * （渲染进程的 CSP 只允许 img-src 'self' data: https:）。
   */
  defineHandler('app:qqGroupImage', async () => {
    const candidates = [
      path.join(process.resourcesPath ?? '', 'qq-group.png'),
      path.join(app.getAppPath(), 'resources', 'qq-group.png'),
      path.join(app.getAppPath(), '..', 'resources', 'qq-group.png')
    ]
    for (const candidate of candidates) {
      try {
        const data = await fsp.readFile(candidate)
        return `data:image/png;base64,${data.toString('base64')}`
      } catch {
        // 试下一个候选路径
      }
    }
    return undefined
  })

  // --- lyrics ---

  defineHandler('lyrics:get', async ({ trackID, name, artist }) => {
    // 站外曲目用负数 ID（汽水/酷狗/酷我 搜索来的歌）：网易云没有它们的歌词，
    // 但同名同歌手的歌网易云通常有——按歌名+歌手搜一次，严格命中才取它的歌词；
    // 搜不到 / 不匹配才给空结果（歌词给错了比没有更糟）。
    if (trackID <= 0) {
      if (externalLyricCache.has(trackID)) {
        const hit = externalLyricCache.get(trackID)
        if (hit == null) {
          return { trackID, lines: [], isInstrumental: false, empty: true }
        }
        const parsed = await context.lyrics.get(hit)
        return toLyricsDTO(trackID, parsed)
      }
      const matchID = name ? await findLyricTrack(context, name, artist) : undefined
      externalLyricCache.set(trackID, matchID ?? null)
      if (externalLyricCache.size > 200) externalLyricCache.clear()
      if (matchID === undefined) {
        return { trackID, lines: [], isInstrumental: false, empty: true }
      }
      const parsed = await context.lyrics.get(matchID)
      return toLyricsDTO(trackID, parsed)
    }
    const parsed = await context.lyrics.get(trackID)
    return toLyricsDTO(trackID, parsed)
  })

  defineHandler('lyrics:desktopToggle', async ({ visible }) => {
    await context.settings.update({ showDesktopLyrics: visible })
  })

  defineHandler('lyrics:desktopMove', async ({ x, y }) => {
    // 桌面歌词窗口可以被拖到显示器外（或值被写成天文数字）后就再也找不回来：
    // 钳制到所有显示器并集的可见范围内，保证下次启动还能看到它。
    const displays = screen.getAllDisplays()
    const left = Math.min(...displays.map((d) => d.bounds.x))
    const top = Math.min(...displays.map((d) => d.bounds.y))
    const right = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width))
    const bottom = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height))
    const safeX = Math.max(left - 200, Math.min(Math.round(Number(x) || 0), right - 40))
    const safeY = Math.max(top - 200, Math.min(Math.round(Number(y) || 0), bottom - 40))
    await context.settings.update({ desktopLyricsPosition: { x: safeX, y: safeY } })
  })

  defineHandler('lyrics:desktopResize', async ({ height, width }) => {
    const window = context.lyricsWindow()
    if (!window || window.isDestroyed()) return
    const bounds = window.getBounds()
    const targetWidth = Math.max(140, Math.min(Math.round(width ?? bounds.width), 1200))
    const targetHeight = Math.max(30, Math.min(Math.round(height), 320))
    window.setBounds({ x: bounds.x, y: bounds.y, width: targetWidth, height: targetHeight }, false)
  })

  defineHandler('lyrics:desktopClickThrough', async ({ through }) => {
    const window = context.lyricsWindow()
    if (!window || window.isDestroyed()) return
    // forward: true —— 点击穿透给桌面，但鼠标移动仍会送到页面，
    // 渲染进程据此判断「鼠标悬在歌词上」时再切回可交互。
    window.setIgnoreMouseEvents(through, { forward: true })
  })

  // --- window ---

  defineHandler('window:toggleFullScreen', async () => {
    const window = context.mainWindow()
    if (!window || window.isDestroyed()) return false
    window.setFullScreen(!window.isFullScreen())
    return window.isFullScreen()
  })

  defineHandler('window:setFullScreen', async ({ fullscreen }) => {
    const window = context.mainWindow()
    if (!window || window.isDestroyed()) return false
    window.setFullScreen(fullscreen)
    return window.isFullScreen()
  })

  defineHandler('window:minimize', async () => {
    context.mainWindow()?.minimize()
  })

  /**
   * 精简模式：主窗口缩成一条悬浮播放条（置顶、不可调整大小），再切回来恢复
   * 之前的窗口位置与大小。渲染层负责画精简条本身。
   */
  defineHandler('window:setCompact', async ({ compact }) => {
    const window = context.mainWindow()
    if (!window || window.isDestroyed()) return false
    if (compact) {
      if (!window.isMaximized() && !window.isFullScreen()) {
        compactRestoreBounds = window.getBounds()
      }
      if (window.isMaximized()) window.unmaximize()
      if (window.isFullScreen()) window.setFullScreen(false)
      window.setResizable(false)
      window.setMinimumSize(COMPACT_SIZE.width, COMPACT_SIZE.height)
      window.setAlwaysOnTop(true, 'floating')
      // 主窗口本身是 transparent 的：这里只保证底色全透明，圆角/唱片之外直接露桌面。
      window.setBackgroundColor('#00000000')
      const base = window.getBounds()
      window.setBounds({
        x: base.x,
        y: base.y,
        width: COMPACT_SIZE.width,
        height: COMPACT_SIZE.height
      })
      compactMode = true
      return true
    }
    compactMode = false
    window.setResizable(true)
    window.setMinimumSize(960, 620)
    window.setAlwaysOnTop(false)
    // 透明窗口底色始终透明；普通界面由 body 自己铺满浅色底。
    window.setBackgroundColor('#00000000')
    if (compactRestoreBounds) {
      window.setBounds(compactRestoreBounds)
      compactRestoreBounds = undefined
    }
    return false
  })

  // 精简模式自己的播放队列：展开时把窗口往上长高（底边保持不动），列表画在条上方。
  defineHandler('window:setCompactQueue', async ({ open }) => {
    const window = context.mainWindow()
    if (!window || window.isDestroyed() || !compactMode) return false
    const bounds = window.getBounds()
    const height = open ? COMPACT_QUEUE_HEIGHT : COMPACT_SIZE.height
    if (bounds.height === height) return true
    window.setBounds({
      x: bounds.x,
      y: Math.max(0, bounds.y + bounds.height - height),
      width: COMPACT_SIZE.width,
      height
    })
    return true
  })

  defineHandler('window:toggleMaximize', async () => {
    const window = context.mainWindow()
    if (!window || window.isDestroyed()) return false
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized()
  })

  defineHandler('window:isMaximized', async () => {
    const window = context.mainWindow()
    return !!window && !window.isDestroyed() && window.isMaximized()
  })

  // 真全屏的最终裁判：渲染层在收起控件前先问一次，避免状态不同步时误收。
  defineHandler('window:isFullScreen', async () => {
    const window = context.mainWindow()
    return !!window && !window.isDestroyed() && window.isFullScreen()
  })

  defineHandler('window:close', async () => {
    context.mainWindow()?.close()
  })
}

function resolveMpvPath(): string | undefined {
  // Re-use the resolver the audio backend uses so both agree on the binary.
  return resolveMpvBinary()
}

async function processVersion(binary: string | undefined): Promise<string | undefined> {
  if (!binary) return undefined
  return new Promise((resolve) => {
    execFile(binary, ['--version'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(undefined)
        return
      }
      resolve(stdout.split(/\r?\n/)[0])
    })
  })
}
