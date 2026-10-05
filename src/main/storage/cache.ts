/**
 * On-disk caches: resolved audio and cover images.
 *
 * Audio is cached under `<cache>/audio/<trackID>-<level>.<ext>` and served from
 * disk on the next play, which is what makes replaying a track instant and lets
 * it keep playing while offline. Eviction follows the configured cap (LRU by
 * last access) and is opportunistic — a failed eviction never breaks playback.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { CacheUsageDTO, QualityLevel } from '@shared/types'

export interface CacheStoreDeps {
  directory: string
  limitBytes: () => number
  log?: (message: string) => void
}

interface AudioEntry {
  file: string
  bytes: number
  accessedAt: number
}

export class CacheStore {
  private readonly audioDirectory: string
  private readonly imageDirectory: string
  private audioIndex = new Map<string, AudioEntry>()
  private scanned = false

  constructor(private readonly deps: CacheStoreDeps) {
    this.audioDirectory = path.join(deps.directory, 'audio')
    this.imageDirectory = path.join(deps.directory, 'images')
  }

  get directory(): string {
    return this.deps.directory
  }

  async init(): Promise<void> {
    await fs.mkdir(this.audioDirectory, { recursive: true })
    await fs.mkdir(this.imageDirectory, { recursive: true })
  }

  // MARK: - Audio

  /**
   * 缓存键：`<trackID>-<level>`（官方音源）或 `<trackID>-<level>-<音源>`（换源）。
   *
   * 换源文件必须与官方文件分开存：否则用户关掉「灰色歌曲解锁」后，
   * 播放器仍会命中那个第三方缓存文件继续播放。
   */
  private key(trackID: number, level: QualityLevel, variant = 'netease'): string {
    return variant === 'netease' ? `${trackID}-${level}` : `${trackID}-${level}-${variant}`
  }

  /** Returns the cached file for a track, refreshing its access time. */
  async audioPath(
    trackID: number,
    level: QualityLevel,
    variant = 'netease'
  ): Promise<string | undefined> {
    await this.scanOnce()
    const key = this.key(trackID, level, variant)
    const entry = this.audioIndex.get(key)
    if (!entry) return undefined
    try {
      const stat = await fs.stat(entry.file)
      if (stat.size === 0) {
        await this.forget(key)
        return undefined
      }
      entry.accessedAt = Date.now()
      entry.bytes = stat.size
      return entry.file
    } catch {
      await this.forget(key)
      return undefined
    }
  }

  /**
   * Downloads `url` into the cache. Resolves with the file path, or `undefined`
   * when caching failed (in which case playback continues from the URL).
   */
  async cacheAudio(
    trackID: number,
    level: QualityLevel,
    url: string,
    extensionHint?: string,
    variant = 'netease'
  ): Promise<string | undefined> {
    await this.scanOnce()
    const key = this.key(trackID, level, variant)
    const existing = await this.audioPath(trackID, level, variant)
    if (existing) return existing

    const extension = normaliseExtension(extensionHint)
    const target = path.join(this.audioDirectory, `${key}${extension}`)
    const temporary = `${target}.part`
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.byteLength === 0) throw new Error('空响应')
      await fs.writeFile(temporary, buffer)
      await fs.rename(temporary, target)
      this.audioIndex.set(key, { file: target, bytes: buffer.byteLength, accessedAt: Date.now() })
      void this.evictIfNeeded()
      return target
    } catch (cause) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      this.deps.log?.(`缓存音频失败 (${trackID}): ${describe(cause)}`)
      return undefined
    }
  }

  private async forget(key: string): Promise<void> {
    this.audioIndex.delete(key)
  }

  private async scanOnce(): Promise<void> {
    if (this.scanned) return
    this.scanned = true
    try {
      const files = await fs.readdir(this.audioDirectory)
      for (const name of files) {
        if (name.endsWith('.part')) {
          await fs.rm(path.join(this.audioDirectory, name), { force: true }).catch(() => undefined)
          continue
        }
        const file = path.join(this.audioDirectory, name)
        try {
          const stat = await fs.stat(file)
          this.audioIndex.set(name.replace(/\.[^.]+$/, ''), {
            file,
            bytes: stat.size,
            accessedAt: stat.mtimeMs
          })
        } catch {
          // Skip unreadable entries.
        }
      }
    } catch {
      // An absent directory just means an empty cache.
    }
  }

  /** Drops least-recently-used audio until the configured cap is met. */
  private async evictIfNeeded(): Promise<void> {
    const limit = this.deps.limitBytes()
    if (limit <= 0) return
    let total = [...this.audioIndex.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    if (total <= limit) return

    const oldestFirst = [...this.audioIndex.entries()].sort((a, b) => a[1].accessedAt - b[1].accessedAt)
    for (const [key, entry] of oldestFirst) {
      if (total <= limit) break
      try {
        await fs.rm(entry.file, { force: true })
      } catch {
        // Keep going; the file may already be gone.
      }
      this.audioIndex.delete(key)
      total -= entry.bytes
    }
  }

  // MARK: - Usage

  async usage(): Promise<CacheUsageDTO> {
    await this.scanOnce()
    let audioBytes = 0
    for (const entry of this.audioIndex.values()) audioBytes += entry.bytes
    const imageBytes = await directorySize(this.imageDirectory)
    return {
      audioBytes,
      imageBytes,
      trackCount: this.audioIndex.size,
      limitBytes: this.deps.limitBytes(),
      directory: this.deps.directory
    }
  }

  async clear(what: 'audio' | 'images' | 'all'): Promise<CacheUsageDTO> {
    if (what === 'audio' || what === 'all') {
      this.audioIndex.clear()
      await fs.rm(this.audioDirectory, { recursive: true, force: true }).catch(() => undefined)
      await fs.mkdir(this.audioDirectory, { recursive: true })
    }
    if (what === 'images' || what === 'all') {
      await fs.rm(this.imageDirectory, { recursive: true, force: true }).catch(() => undefined)
      await fs.mkdir(this.imageDirectory, { recursive: true })
    }
    return this.usage()
  }
}

async function directorySize(directory: string): Promise<number> {
  try {
    const files = await fs.readdir(directory)
    let total = 0
    for (const name of files) {
      try {
        const stat = await fs.stat(path.join(directory, name))
        total += stat.size
      } catch {
        // Skip entries that vanished under us.
      }
    }
    return total
  } catch {
    return 0
  }
}

function normaliseExtension(hint?: string): string {
  if (!hint) return '.mp3'
  const cleaned = hint.toLowerCase().replace(/[^.a-z0-9]/g, '')
  if (cleaned === 'flac' || cleaned === 'mp3' || cleaned === 'm4a' || cleaned === 'aac') {
    return `.${cleaned}`
  }
  return '.mp3'
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
