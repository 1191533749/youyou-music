/**
 * The runtime context handed to every IPC module.
 *
 * Building this once in `main/index.ts` keeps feature modules free of
 * construction order concerns and makes them testable with fakes.
 */
import type { BrowserWindow } from 'electron'
import type { SettingsStore } from './storage/settings.js'
import type { DailyHistoryStore } from './storage/dailyHistory.js'
import type { NeteaseClient } from './netease/client.js'
import type { NeteaseAPI } from './netease/api.js'
import type { PlayerController } from './player/controller.js'
import type { MpvController } from './audio/mpv.js'
import type { LyricsService } from './lyrics/service.js'
import type { MediaKeys } from './media/keys.js'
import type { CacheStore } from './storage/cache.js'

export interface AppContext {
  settings: SettingsStore
  dailyHistory: DailyHistoryStore
  client: NeteaseClient
  api: NeteaseAPI
  player: PlayerController
  mpv: MpvController
  lyrics: LyricsService
  media: MediaKeys
  cache: CacheStore
  /** The main window, once it exists. */
  mainWindow: () => BrowserWindow | undefined
  /** 桌面歌词窗口（可能还没创建）。 */
  lyricsWindow: () => BrowserWindow | undefined
  /**
   * 所有需要接收推送事件的窗口（主窗口 + 桌面歌词窗口等）。
   * `sendEvent` 据此做广播：桌面歌词窗口只有收到 player:state 才知道该显示哪句词。
   */
  windows: () => BrowserWindow[]
  /** Sends a push event to the renderer if it is alive. */
  emit: (event: string, payload: unknown) => void
  log: (message: string) => void
}
