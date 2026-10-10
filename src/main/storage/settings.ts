/**
 * Settings and small persisted state.
 *
 * The macOS client keeps `SettingsManager` in `UserDefaults`; on Windows the
 * equivalent is a JSON file under the app's userData directory.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import { DEFAULT_SETTINGS, DESKTOP_LYRICS_EFFECTS, LYRIC_FONTS, type SettingsDTO } from '@shared/types'

type Listener = (settings: SettingsDTO) => void

export class SettingsStore extends EventEmitter {
  private settings: SettingsDTO = { ...DEFAULT_SETTINGS }
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly directory: string) {
    super()
  }

  private get file(): string {
    return path.join(this.directory, 'settings.json')
  }

  async load(): Promise<SettingsDTO> {
    if (this.loaded) return this.settings
    this.loaded = true
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<SettingsDTO>
      // Unknown keys from a newer build are dropped, missing keys keep their
      // default, so a downgrade never produces an unusable config.
      this.settings = { ...DEFAULT_SETTINGS, ...sanitise(parsed) }
    } catch {
      this.settings = { ...DEFAULT_SETTINGS }
    }
    return this.settings
  }

  get current(): SettingsDTO {
    return { ...this.settings }
  }

  async update(patch: Partial<SettingsDTO>): Promise<SettingsDTO> {
    await this.load()
    this.settings = { ...this.settings, ...sanitise(patch) }
    const snapshot = this.settings
    this.writeQueue = this.writeQueue.then(() => this.persist(snapshot)).catch(() => undefined)
    for (const listener of this.listeners('change') as Listener[]) {
      try {
        listener({ ...snapshot })
      } catch (cause) {
        // 单个监听器异常（典型：桌面歌词窗口已被销毁仍被调用 showInactive）
        // 绝不允许把 settings:update 打崩——否则设置页整体失灵。
        console.error('[settings] change 监听器异常:', cause)
      }
    }
    return { ...snapshot }
  }

  private async persist(settings: SettingsDTO): Promise<void> {
    try {
      await fs.mkdir(this.directory, { recursive: true })
      await fs.writeFile(this.file, JSON.stringify(settings, null, 2), 'utf8')
    } catch {
      // A failed write only costs the user this preference change.
    }
  }
}

/** 取值来自 @shared/types，避免主进程与渲染进程各维护一份枚举。 */
const VALID_DESKTOP_LYRICS_EFFECTS = new Set<string>(DESKTOP_LYRICS_EFFECTS)
const VALID_LYRIC_FONTS = new Set<string>(LYRIC_FONTS)

const VALID_QUALITIES = new Set([
  'standard',
  'higher',
  'exhigh',
  'lossless',
  'hires',
  'jyeffect',
  'sky',
  'jymaster'
])

/** Drops values of the wrong shape or range so a hand-edited file cannot break the app. */
function sanitise(input: Partial<SettingsDTO>): Partial<SettingsDTO> {
  const out: Partial<SettingsDTO> = {}
  for (const [key, value] of Object.entries(input) as Array<[keyof SettingsDTO, unknown]>) {
    if (value === undefined || value === null) continue
    switch (key) {
      case 'quality':
        if (typeof value === 'string' && VALID_QUALITIES.has(value)) {
          out.quality = value as SettingsDTO['quality']
        }
        break
      case 'volume':
        if (typeof value === 'number' && Number.isFinite(value)) {
          out.volume = Math.min(150, Math.max(0, Math.round(value)))
        }
        break
      case 'desktopLyricsFontSize':
        if (typeof value === 'number' && Number.isFinite(value)) {
          out.desktopLyricsFontSize = Math.min(96, Math.max(12, Math.round(value)))
        }
        break
      case 'desktopLyricsOpacity':
        if (typeof value === 'number' && Number.isFinite(value)) {
          out.desktopLyricsOpacity = Math.min(1, Math.max(0.2, value))
        }
        break
      case 'desktopLyricsEffect':
        // 只接受已知特效；手改配置写成别的字符串时保留默认值。
        if (typeof value === 'string' && VALID_DESKTOP_LYRICS_EFFECTS.has(value)) {
          out.desktopLyricsEffect = value as SettingsDTO['desktopLyricsEffect']
        }
        break
      case 'desktopLyricsLocked':
        if (typeof value === 'boolean') out.desktopLyricsLocked = value
        break
      case 'lyricFont':
        if (typeof value === 'string' && VALID_LYRIC_FONTS.has(value)) {
          out.lyricFont = value as SettingsDTO['lyricFont']
        }
        break
      case 'cacheLimitMB':
        if (typeof value === 'number' && Number.isFinite(value)) {
          out.cacheLimitMB = Math.max(0, Math.round(value))
        }
        break
      case 'theme':
        if (value === 'system' || value === 'light' || value === 'dark') out.theme = value
        break
      case 'wallpaperSet':
        if (typeof value === 'boolean') out.wallpaperSet = value
        break
      case 'wallpaperVersion':
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          out.wallpaperVersion = Math.floor(value)
        }
        break
      case 'language':
        if (value === 'system' || value === 'zh-Hans' || value === 'en') out.language = value
        break
      case 'desktopLyricsPosition': {
        const position = value as { x?: unknown; y?: unknown }
        if (typeof position?.x === 'number' && typeof position?.y === 'number') {
          out.desktopLyricsPosition = { x: position.x, y: position.y }
        }
        break
      }
      case 'unblockSources': {
        // 只接受已知音源，且去重；顺序保留用户配置（即优先级）。
        // 'pyncmd' 是上一版音源，已被「汽水音乐」取代，老配置里的它按汽水迁移过来。
        const known = new Set(['qishui', 'kugou', 'kuwo', 'qq'])
        const legacy: Record<string, string> = { pyncmd: 'qishui' }
        if (Array.isArray(value)) {
          const list: Array<'qishui' | 'kugou' | 'kuwo' | 'qq'> = []
          for (const raw of value) {
            if (typeof raw !== 'string') continue
            const item = legacy[raw] ?? raw
            if (known.has(item) && !list.includes(item as never)) {
              list.push(item as 'qishui' | 'kugou' | 'kuwo' | 'qq')
            }
          }
          // 老配置里全是已被移除的音源时，不能落成「一个都不启用」。
          out.unblockSources = list.length > 0 ? list : [...DEFAULT_SETTINGS.unblockSources]
        }
        break
      }
      case 'cacheDirectory':
      case 'audioDevice':
        if (typeof value === 'string') out[key] = value
        break
      default:
        if (typeof value === 'boolean') {
          ;(out as Record<string, unknown>)[key] = value
        }
        break
    }
  }
  return out
}
