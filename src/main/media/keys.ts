/**
 * Electron window-taskbar integration: media keys, the thumbnail toolbar and
 * the taskbar progress bar.
 *
 * This is the Windows stand-in for the macOS client's MediaPlayer/Control
 * Center integration (`system integration — media keys / Control Center` in the
 * README): the same keys, the same "now playing" affordances, different API.
 */
import { globalShortcut, type BrowserWindow } from 'electron'
import type { PlayerController } from '../player/controller.js'
import type { Track } from '../netease/models.js'
import { resizedImageURL, trackDuration } from '../netease/models.js'

export interface MediaKeysDeps {
  player: PlayerController
  window: () => BrowserWindow | undefined
  enabled: () => boolean
  log?: (message: string) => void
}

const MEDIA_KEYS: Array<[string, string]> = [
  ['MediaPlayPause', 'playPause'],
  ['MediaNextTrack', 'next'],
  ['MediaPreviousTrack', 'previous'],
  ['MediaStop', 'stop']
]

export class MediaKeys {
  private registered = false
  private lastToolbarSignature = ''

  constructor(private readonly deps: MediaKeysDeps) {}

  /** (Re-)binds the media keys according to the current setting. */
  sync(): void {
    const wanted = this.deps.enabled()
    if (wanted === this.registered) return
    if (wanted) this.register()
    else this.unregister()
  }

  private register(): void {
    for (const [accelerator, action] of MEDIA_KEYS) {
      try {
        const ok = globalShortcut.register(accelerator, () => this.dispatch(action))
        if (!ok) this.deps.log?.(`媒体键 ${accelerator} 注册失败（可能已被其他程序占用）`)
      } catch (cause) {
        this.deps.log?.(`媒体键 ${accelerator} 注册异常: ${describe(cause)}`)
      }
    }
    this.registered = true
  }

  private unregister(): void {
    for (const [accelerator] of MEDIA_KEYS) {
      try {
        globalShortcut.unregister(accelerator)
      } catch {
        // Nothing to do; the key was not held.
      }
    }
    this.registered = false
  }

  private dispatch(action: string): void {
    const player = this.deps.player
    switch (action) {
      case 'playPause':
        void player.toggle()
        break
      case 'next':
        void player.next()
        break
      case 'previous':
        void player.previous()
        break
      case 'stop':
        void player.pause()
        break
      default:
        break
    }
  }

  /** Updates the thumbnail toolbar and progress bar for the current track. */
  updateWindow(track: Track | undefined, playing: boolean, position: number): void {
    const window = this.deps.window()
    if (!window || window.isDestroyed()) return

    // The thumbnail toolbar is rebuilt only when something it displays changed,
    // because rebuilding it resets the hover state under the cursor.
    const signature = `${track?.id ?? 0}:${playing ? 1 : 0}`
    if (signature !== this.lastToolbarSignature) {
      this.lastToolbarSignature = signature
      try {
        window.setThumbarButtons([
          {
            tooltip: '上一首',
            icon: iconFor('previous'),
            click: () => void this.deps.player.previous()
          },
          {
            tooltip: playing ? '暂停' : '播放',
            icon: iconFor(playing ? 'pause' : 'play'),
            click: () => void this.deps.player.toggle()
          },
          {
            tooltip: '下一首',
            icon: iconFor('next'),
            click: () => void this.deps.player.next()
          }
        ])
      } catch (cause) {
        this.deps.log?.(`设置任务栏按钮失败: ${describe(cause)}`)
      }
    }

    const duration = track ? trackDuration(track) : 0
    if (duration > 0 && position > 0) {
      window.setProgressBar(Math.min(1, position / duration), { mode: 'normal' })
    } else {
      window.setProgressBar(-1)
    }
  }

  dispose(): void {
    this.unregister()
  }
}

/**
 * Thumbnail-toolbar glyphs, rasterised here into 16x16 BGRA buffers that
 * `nativeImage.createFromBitmap` accepts. Drawing them in code avoids shipping
 * (and version-controlling) four tiny binary assets for a cosmetic feature.
 */
const ICON_SIZE = 16

function iconFor(kind: 'play' | 'pause' | 'next' | 'previous'): Electron.NativeImage {
  // Lazy require keeps `electron` out of the module graph during unit tests.
  const { nativeImage } = require('electron') as typeof import('electron')
  const bitmap = Buffer.alloc(ICON_SIZE * ICON_SIZE * 4)
  const set = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= ICON_SIZE || y >= ICON_SIZE) return
    const offset = (y * ICON_SIZE + x) * 4
    // BGRA, opaque white so Windows can recolour it for the current theme.
    bitmap[offset] = 0xff
    bitmap[offset + 1] = 0xff
    bitmap[offset + 2] = 0xff
    bitmap[offset + 3] = 0xff
  }

  const triangle = (fromX: number, toX: number, apexLeft: boolean): void => {
    const height = ICON_SIZE - 4
    for (let row = 0; row < height; row += 1) {
      // Width tapers to a point at the vertical centre of the glyph.
      const distanceFromCentre = Math.abs(row - (height - 1) / 2)
      const width = Math.max(1, Math.round(((height / 2 - distanceFromCentre) / (height / 2)) * (toX - fromX)))
      for (let col = 0; col < width; col += 1) {
        set(apexLeft ? toX - col : fromX + col, row + 2)
      }
    }
  }

  switch (kind) {
    case 'play':
      triangle(4, 12, false)
      break
    case 'pause':
      for (let row = 2; row < ICON_SIZE - 2; row += 1) {
        for (let col = 0; col < 3; col += 1) {
          set(4 + col, row)
          set(9 + col, row)
        }
      }
      break
    case 'next':
      triangle(3, 11, false)
      for (let row = 2; row < ICON_SIZE - 2; row += 1) {
        for (let col = 0; col < 2; col += 1) set(12 + col, row)
      }
      break
    case 'previous':
      triangle(5, 13, true)
      for (let row = 2; row < ICON_SIZE - 2; row += 1) {
        for (let col = 0; col < 2; col += 1) set(2 + col, row)
      }
      break
  }

  return nativeImage.createFromBitmap(bitmap, { width: ICON_SIZE, height: ICON_SIZE })
}

export { resizedImageURL }

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
