/**
 * App-level IPC: info, settings, cache, lyrics delivery and desktop-lyric
 * window control.
 */
import { app, dialog, shell } from 'electron'
import type { OpenDialogOptions } from 'electron'
import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { defineHandler } from './registry.js'
import { toLyricsDTO } from '../lyrics/service.js'
import { resolveMpvBinary } from '../audio/mpv.js'
import { encodeQR } from '../qrcode.js'
import { QUALITY_OPTIONS, type SettingsDTO } from '@shared/types'
import type { AppContext } from '../context.js'

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
      mpv,
      mpvPath
    }
  })

  defineHandler('settings:get', async () => {
    await context.settings.load()
    return context.settings.current
  })

  defineHandler('settings:update', async (patch: Partial<SettingsDTO>) => {
    const next = await context.settings.update(patch)
    if (patch.volume !== undefined) await context.player.setVolume(next.volume)
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
      title: '选择壁纸图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
      properties: ['openFile']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const current = context.settings.current
    if (result.canceled || result.filePaths.length === 0) {
      return { set: current.wallpaperSet, version: current.wallpaperVersion }
    }
    const source = result.filePaths[0]
    const stat = await fsp.stat(source)
    if (stat.size > 16 * 1024 * 1024) throw new Error('壁纸图片太大（最大 16MB）')
    const dir = path.join(app.getPath('userData'), 'wallpaper')
    await fsp.mkdir(dir, { recursive: true })
    // 清掉旧的 wallpaper.*，只保留最新一张，协议处理器按文件名前缀找。
    for (const entry of await fsp.readdir(dir).catch(() => [] as string[])) {
      if (entry.startsWith('wallpaper.')) await fsp.unlink(path.join(dir, entry)).catch(() => undefined)
    }
    const ext = path.extname(source).toLowerCase() || '.png'
    const target = path.join(dir, `wallpaper${ext}`)
    await fsp.copyFile(source, target)
    const next = await context.settings.update({
      wallpaperSet: true,
      wallpaperVersion: (current.wallpaperVersion ?? 0) + 1
    })
    return { set: next.wallpaperSet, version: next.wallpaperVersion }
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

  defineHandler('lyrics:get', async ({ trackID }) => {
    // 站外曲目用负数 ID（汽水/酷狗/酷我 搜索来的歌）：网易云没有它们的歌词，
    // 直接返回空结果，不去打接口、也不刷日志。
    if (trackID <= 0) {
      return { trackID, lines: [], isInstrumental: false, empty: true }
    }
    const parsed = await context.lyrics.get(trackID)
    return toLyricsDTO(trackID, parsed)
  })

  defineHandler('lyrics:desktopToggle', async ({ visible }) => {
    await context.settings.update({ showDesktopLyrics: visible })
  })

  defineHandler('lyrics:desktopMove', async ({ x, y }) => {
    await context.settings.update({ desktopLyricsPosition: { x, y } })
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
