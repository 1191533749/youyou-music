/**
 * App-level IPC: info, settings, cache, lyrics delivery and desktop-lyric
 * window control.
 */
import { app, dialog, shell } from 'electron'
import { execFile } from 'node:child_process'
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
      name: '雲の音 Kumone',
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      mpv,
      mpvPath,
      upstream: 'https://github.com/missuo/kumone'
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
   * Renders a login URL into a QR module matrix. The encoder runs here so the
   * renderer only draws squares, and so the login URL never has to be turned
   * into a QR code by code that also has DOM access.
   */
  defineHandler('app:qrMatrix', ({ url }) => {
    if (!/^https:\/\/music\.163\.com\//.test(url)) {
      throw new Error('只允许为网易云登录地址生成二维码')
    }
    return encodeQR(url)
  })

  // --- lyrics ---

  defineHandler('lyrics:get', async ({ trackID }) => {
    const parsed = await context.lyrics.get(trackID)
    return toLyricsDTO(trackID, parsed)
  })

  defineHandler('lyrics:desktopToggle', async ({ visible }) => {
    await context.settings.update({ showDesktopLyrics: visible })
  })

  defineHandler('lyrics:desktopMove', async ({ x, y }) => {
    await context.settings.update({ desktopLyricsPosition: { x, y } })
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
