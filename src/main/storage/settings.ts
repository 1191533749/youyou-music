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
      this.migrateSources(parsed)
    } catch {
      this.settings = { ...DEFAULT_SETTINGS }
    }
    return this.settings
  }

  /**
   * 音源是分批上线的：老配置里不可能人为关掉当时还不存在的音源，所以读到没有
   * `unblockSourcesMigrated` 标记的配置时，把后来新增的音源补到最前并落盘标记。
   * 有标记才让「用户自己关掉」在重启后依然生效，否则设置页会「关不掉」。
   */
  private migrateSources(raw: Partial<SettingsDTO>): void {
    if (raw.unblockSourcesMigrated === true) return
    const list = this.settings.unblockSources
    const added = SOURCES_ADDED_AFTER_RELEASE.filter((id) => !list.includes(id))
    this.settings = {
      ...this.settings,
      unblockSources: [...added, ...list],
      unblockSourcesMigrated: true
    }
    const snapshot = { ...this.settings }
    // 立刻排进写队列：迁移结果要落盘，不然用户关掉某音源后重启又会被补回来。
    this.writeQueue = this.writeQueue.then(() => this.persist(snapshot)).catch(() => undefined)
  }

  get current(): SettingsDTO {
    return { ...this.settings }
  }

  /** 等待已排队的落盘完成（退出前 / 测试里确认文件内容时用）。 */
  async flush(): Promise<void> {
    await this.writeQueue
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

/**
 * 在「第三方音源」功能上线之后才加入的音源。老配置（不带 unblockSourcesMigrated 标记）
 * 读到时会自动补上这些，用户不必进设置页手动打开。
 */
const SOURCES_ADDED_AFTER_RELEASE: Array<'gdstudio'> = ['gdstudio']

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
      case 'wallpaperKind':
        if (value === 'image' || value === 'video') out.wallpaperKind = value
        break
      case 'backgroundOpacity':
        if (typeof value === 'number' && Number.isFinite(value)) {
          out.backgroundOpacity = Math.min(100, Math.max(0, Math.round(value)))
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
        // 'pyncmd' 是「聚合音源」的旧名字，老配置里的它按聚合音源迁移过来。
        const known = new Set(['gdstudio', 'qishui', 'kugou', 'kuwo', 'qq'])
        const legacy: Record<string, string> = { pyncmd: 'gdstudio' }
        if (Array.isArray(value)) {
          const list: Array<'gdstudio' | 'qishui' | 'kugou' | 'kuwo' | 'qq'> = []
          for (const raw of value) {
            if (typeof raw !== 'string') continue
            const item = legacy[raw] ?? raw
            if (known.has(item) && !list.includes(item as never)) {
              list.push(item as 'gdstudio' | 'qishui' | 'kugou' | 'kuwo' | 'qq')
            }
          }
          // 音源是分批上线的：老配置里不可能人为关掉当时还不存在的音源，
          // 所以升级后由 load() 把新增音源补到最前（见 SOURCES_ADDED_AFTER_RELEASE）。
          // 这里只做「认识的名字 + 去重」，不改用户的选择——否则用户刚关掉又被打开。
          // 老配置里全是已被移除的音源时，不能落成「一个都不启用」。
          out.unblockSources = list.length > 0 ? list : [...DEFAULT_SETTINGS.unblockSources]
        }
        break
      }
      case 'cacheDirectory':
      case 'audioDevice':
        // 字符串要有长度上限，防止手改配置文件塞进超长路径打爆各处拼接。
        if (typeof value === 'string' && value.length <= 512) out[key] = value
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
