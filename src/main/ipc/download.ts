/**
 * 歌曲下载：主进程负责解析音源（复用播放解析链）→ 让用户选保存位置 → 流式写盘，
 * 进度通过 `download:progress` 事件推给渲染层（key 区分并发下载）。
 *
 * 设置里选了「转 MP3」时：先按原格式落盘到临时文件，再用随包分发的精简 ffmpeg
 * 转成 320kbps MP3，成功删临时文件；本来就是 mp3 则跳过转换。
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { copyFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dialog } from 'electron'

import type { ExternalTrackDTO, TrackDTO } from '@shared/types'
import type { Track } from '../netease/models.js'
import type { AppContext } from '../context.js'
import { defineHandler } from './registry.js'

/** Windows 文件名非法字符 → 全角（保留可读性）。 */
function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/** 详情接口拿不到时的最小可用 Track（列表 DTO 已够解析）。 */
function trackFromDTO(dto: TrackDTO): Track {
  return {
    id: dto.id,
    name: dto.name,
    artists: dto.artists.map((artist) => ({ id: artist.id, name: artist.name })),
    album: { id: dto.album.id, name: dto.album.name, picUrl: dto.album.picUrl },
    durationMS: dto.durationMS,
    alias: dto.alias,
    transNames: dto.transNames,
    fee: dto.fee,
    mvID: dto.mvID,
    trackNo: 0,
    noCopyright: dto.noCopyright,
    isCloud: dto.isCloud
  }
}

/** 找随包分发的精简 ffmpeg：resourcesPath/ffmpeg → 仓库 vendor → PATH。 */
export function resolveFfmpegBinary(explicit?: string): string | undefined {
  const candidates: string[] = []
  if (explicit) candidates.push(explicit)
  if (process.env.YOYOU_FFMPEG) candidates.push(process.env.YOYOU_FFMPEG)
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'))
    candidates.push(path.join(process.resourcesPath, 'ffmpeg.exe'))
  }
  candidates.push(path.join(process.cwd(), 'vendor', 'ffmpeg', 'ffmpeg.exe'))
  return candidates.find((candidate) => {
    try {
      return existsSync(candidate)
    } catch {
      return false
    }
  })
}

/** 把非 mp3 文件转成 320kbps MP3；成功返回 true，失败抛错。 */
async function convertToMp3(ffmpegPath: string, sourcePath: string, targetPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      ['-y', '-loglevel', 'error', '-i', sourcePath, '-vn', '-codec:a', 'libmp3lame', '-b:a', '320k', targetPath],
      { windowsHide: true }
    )
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('转换超时（10 分钟）'))
    }, 10 * 60_000)
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
      if (stderr.length > 2000) stderr = stderr.slice(-2000)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`转码失败（退出码 ${code}）：${stderr.trim().split('\n').pop() ?? ''}`))
    })
  })
}

export function registerDownloadHandlers(context: AppContext): void {
  defineHandler('download:track', async ({ track, external }) => {
    // 1. 补全曲目详情（网易云曲目尽量拿官方完整模型）。
    let full: Track
    if (!external && track.id > 0) {
      const detail = await context.api.songDetails([track.id]).catch(() => undefined)
      full = detail?.songs?.[0] ?? trackFromDTO(track)
    } else {
      full = trackFromDTO(track)
    }

    // 2. 解析可下载地址（复用播放解析链：缓存 → 网易云 → 第三方音源）。
    const resolved = await context.player.resolveDownloadURL(full, external)

    // 3. 选保存格式：设置「转 MP3」且原格式不是 mp3 时，下载到临时文件后转码。
    const wantMp3 = context.settings.current.downloadFormat === 'mp3' && resolved.ext !== 'mp3'
    const saveExt = wantMp3 ? 'mp3' : resolved.ext

    const artist = external
      ? external.artists
      : track.artists.map((item) => item.name).join('、')
    const defaultName = `${sanitizeFileName(track.name)} - ${sanitizeFileName(artist || '未知歌手')}.${saveExt}`
    const window = context.mainWindow()
    const options = {
      title: '保存歌曲',
      defaultPath: defaultName,
      filters: [{ name: wantMp3 ? 'MP3 音频' : '音频文件', extensions: [saveExt] }]
    }
    const save = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    if (save.canceled || !save.filePath) return { ok: false, canceled: true as const, path: '' }
    const filePath = save.filePath
    // 转码时：先下到「filePath + .orig.ext」临时文件，转出的 mp3 才落进 filePath。
    const originPath = wantMp3 ? `${filePath}.orig.${resolved.ext}` : filePath

    const key = `dl:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
    try {
      if (resolved.cached && !/^https?:\/\//i.test(resolved.url)) {
        // 本地缓存直接复制（秒级，也发一条进度让界面能收起状态）。
        const size = (await stat(resolved.url).catch(() => undefined))?.size ?? 0
        await copyFile(resolved.url, originPath)
        if (!wantMp3) {
          context.emit('download:progress', { key, received: size, total: size, done: true, path: filePath })
          context.log(`下载完成（本地缓存）：${path.basename(filePath)}`)
          return { ok: true, path: filePath }
        }
      } else {
        // 4. 流式下载 + 计数（250ms 节流发进度）。
        const response = await fetch(resolved.url, {
          redirect: 'follow',
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) youyou-music' }
        })
        if (!response.ok || !response.body) {
          throw new Error(`下载源返回 ${response.status}`)
        }
        const total = Number(response.headers.get('content-length')) || 0
        let received = 0
        let lastSent = 0
        const stream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
        stream.on('data', (chunk: Buffer) => {
          received += chunk.length
          const now = Date.now()
          if (now - lastSent >= 250) {
            lastSent = now
            context.emit('download:progress', { key, received, total })
          }
        })
        await pipeline(stream, createWriteStream(originPath))
        if (!wantMp3) {
          context.emit('download:progress', { key, received, total, done: true, path: filePath })
          context.log(`下载完成：${path.basename(filePath)}（${received} 字节）`)
          return { ok: true, path: filePath }
        }
      }

      // 5. 转 MP3（ffmpeg 随包分发；找不到时如实报错，不假装成功）。
      const ffmpeg = resolveFfmpegBinary()
      if (!ffmpeg) {
        await rm(originPath, { force: true }).catch(() => undefined)
        throw new Error('转换组件缺失（ffmpeg），请重新安装客户端')
      }
      context.emit('download:progress', { key, received: 0, total: 0, converting: true })
      context.log(`开始转 MP3：${path.basename(originPath)}`)
      await convertToMp3(ffmpeg, originPath, filePath)
      await rm(originPath, { force: true }).catch(() => undefined)
      context.emit('download:progress', { key, received: 0, total: 0, done: true, path: filePath })
      context.log(`下载完成（已转 MP3）：${path.basename(filePath)}`)
      return { ok: true, path: filePath }
    } catch (cause) {
      context.emit('download:progress', { key, received: 0, total: 0, error: String(cause) })
      await rm(originPath, { force: true }).catch(() => undefined)
      await rm(filePath, { force: true }).catch(() => undefined)
      throw new Error(`下载失败：${String(cause)}`)
    }
  })
}
