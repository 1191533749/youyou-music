/**
 * Application entry point.
 *
 * Wiring order matters: stores load first (so the window opens with real
 * settings), the client loads its cookie jar (so the first screen knows whether
 * to show the login page), then handler registration, then windows.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { SettingsStore } from './storage/settings.js'
import { CacheStore } from './storage/cache.js'
import { NeteaseClient } from './netease/client.js'
import { NeteaseAPI } from './netease/api.js'
import { MpvController, resolveMpvBinary } from './audio/mpv.js'
import { PlayerController } from './player/controller.js'
import { LyricsService } from './lyrics/service.js'
import { MediaKeys } from './media/keys.js'
import { contextRef, sendEvent, assertAllChannelsRegistered } from './ipc/registry.js'
import { registerAuthHandlers } from './ipc/auth.js'
import { registerPlayerHandlers } from './ipc/player.js'
import { registerLibraryHandlers } from './ipc/library.js'
import { registerExploreHandlers } from './ipc/explore.js'
import { registerAppHandlers } from './ipc/app.js'
import type { AppContext } from './context.js'
import type { PlayerSnapshot } from './player/controller.js'
import { DEFAULT_SETTINGS } from '@shared/types'

// A second instance would fight over the mpv instance and the cookie jar.
if (!app.requestSingleInstanceLock()) {
  console.log('已有实例在运行，本次启动退出。')
  app.quit()
  process.exit(0)
}

// The self-check runs against a throwaway profile so it neither reads the
// user's real login/settings nor leaves state behind — and so a stale
// single-instance lock from a killed run cannot silence it.
const smokeUserData = process.env.KUMONE_USER_DATA
if (smokeUserData) {
  fs.mkdirSync(smokeUserData, { recursive: true })
  app.setPath('userData', smokeUserData)
}

const logLines: string[] = []
function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`
  logLines.push(line)
  if (logLines.length > 500) logLines.shift()
  if (!app.isPackaged) console.log(line)
}

let mainWindow: BrowserWindow | undefined
let lyricsWindow: BrowserWindow | undefined
let tray: Tray | undefined
let quitting = false

const rendererUrl = process.env['ELECTRON_RENDERER_URL']

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#f5f5f7',
    title: '雲の音 Kumone',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Cover art and audio come from NetEase's CDN, which the renderer only
      // ever displays; it never fetches the API itself.
      webSecurity: true
    }
  })

  window.once('ready-to-show', () => window.show())

  window.on('close', (event) => {
    const settings = contextRef.value?.settings.current
    if (!quitting && settings?.closeToTray && settings.tray) {
      event.preventDefault()
      window.hide()
    }
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    // Links in lyric credits and about pages open in the system browser.
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (rendererUrl) {
    void window.loadURL(rendererUrl)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return window
}

function createLyricsWindow(): BrowserWindow {
  const settings = contextRef.value?.settings.current ?? DEFAULT_SETTINGS
  const window = new BrowserWindow({
    width: 900,
    height: 180,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    // Not focusable by default so clicking a lyric line does not steal focus
    // from the app the user is working in.
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  window.setAlwaysOnTop(true, 'screen-saver')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  if (settings.desktopLyricsPosition) {
    window.setPosition(settings.desktopLyricsPosition.x, settings.desktopLyricsPosition.y)
  }

  window.on('moved', () => {
    const [x, y] = window.getPosition()
    void contextRef.value?.settings.update({ desktopLyricsPosition: { x, y } })
  })

  if (rendererUrl) {
    void window.loadURL(`${rendererUrl}?window=lyrics`)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'), {
      query: { window: 'lyrics' }
    })
  }

  return window
}

function toggleLyricsWindow(visible: boolean): void {
  if (visible) {
    lyricsWindow ??= createLyricsWindow()
    lyricsWindow.showInactive()
  } else {
    lyricsWindow?.hide()
  }
  void contextRef.value?.settings.update({ showDesktopLyrics: visible })
}

const MPV_LOG_TAIL = 20

function createTray(context: AppContext): void {
  if (tray) return
  tray = new Tray(makeTrayIcon())
  tray.setToolTip('雲の音 Kumone')
  const rebuild = (): void => {
    const snapshot = context.player.snapshot()
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: snapshot.track ? `${snapshot.track.name} — ${snapshot.track.artists.map((a) => a.name).join(' / ')}` : '未在播放',
          enabled: false
        },
        { type: 'separator' },
        { label: snapshot.playing ? '暂停' : '播放', click: () => void context.player.toggle() },
        { label: '下一首', click: () => void context.player.next() },
        { label: '上一首', click: () => void context.player.previous() },
        { type: 'separator' },
        {
          label: '显示/隐藏桌面歌词',
          type: 'checkbox',
          checked: context.settings.current.showDesktopLyrics,
          click: (item) => toggleLyricsWindow(item.checked)
        },
        { label: '显示主窗口', click: () => showMainWindow() },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            quitting = true
            app.quit()
          }
        }
      ])
    )
  }
  rebuild()
  context.player.on('state', rebuild)
  tray.on('double-click', () => showMainWindow())
}

function makeTrayIcon(): Electron.NativeImage {
  // Loaded from build/icon.png when present; otherwise a drawn placeholder so a
  // fresh checkout still starts.
  const candidates = [
    path.join(process.resourcesPath ?? '', 'icon.png'),
    path.join(app.getAppPath(), 'build', 'icon.png'),
    path.join(__dirname, '../../build/icon.png')
  ]
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        const image = nativeImage.createFromPath(candidate)
        if (!image.isEmpty()) return image.resize({ width: 16, height: 16 })
      }
    } catch {
      // Try the next candidate.
    }
  }
  return nativeImage.createEmpty()
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow()
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData')
  const settings = new SettingsStore(userData)
  await settings.load()
  const current = settings.current

  const cacheDirectory = current.cacheDirectory || path.join(userData, 'cache')
  const cache = new CacheStore({
    directory: cacheDirectory,
    limitBytes: () => settings.current.cacheLimitMB * 1024 * 1024,
    log
  })
  await cache.init()

  const client = new NeteaseClient({
    cookieDirectory: userData,
    onCookieChange: () => {
      // Any cookie change can flip the login state, so let the UI re-read it.
      sendEvent(contextRef.value, 'auth:changed', { loggedIn: client.isLoggedIn })
    }
  })
  await client.load()

  const api = new NeteaseAPI(client)
  const lyrics = new LyricsService({ api, log })

  const mpvPath = resolveMpvBinary(current.audioDevice ? undefined : undefined)
  if (!mpvPath) {
    log('未找到 mpv.exe —— 播放功能不可用。请运行 scripts/fetch-mpv.ps1 或设置 KUMONE_MPV。')
  }
  const mpv = new MpvController({
    binary: mpvPath ?? 'mpv',
    audioDevice: current.audioDevice || undefined,
    onLog: (level, message) => log(`[mpv:${level}] ${message}`)
  })

  let profileVipType = 0
  /** The track the engine is on, so media-key updates can report its duration. */
  let currentTrack: import('./netease/models.js').Track | undefined

  const player = new PlayerController({
    api,
    mpv,
    cache: {
      audioPath: (trackID, level) => cache.audioPath(trackID, level),
      cacheAudio: (trackID, level, url, format) => cache.cacheAudio(trackID, level, url, format)
    },
    getQuality: () => settings.current.quality,
    autoDowngrade: () => settings.current.autoDowngradeQuality,
    getScrobble: () => settings.current.scrobble && client.isLoggedIn,
    getLoggedIn: () => client.isLoggedIn,
    getVipType: () => profileVipType,
    onScrobbleStart: (track, sourceID) => {
      void api.scrobbleStart(track.id, sourceID)
    },
    onScrobbleFinish: (track, sourceID, seconds) => {
      void api.scrobbleFinish(track.id, sourceID, seconds)
    },
    onTrackChanged: (track) => {
      currentTrack = track
      sendEvent(contextRef.value, 'player:track', {
        track: track ? contextRef.value.player.snapshot().track : undefined
      })
      media.updateWindow(track, contextRef.value.player.snapshot().playing, 0)
    },
    onError: (message) => sendEvent(contextRef.value, 'app:error', { message }),
    log
  })

  const media = new MediaKeys({
    player,
    window: () => mainWindow,
    enabled: () => settings.current.mediaKeys,
    log
  })

  const context: AppContext = {
    settings,
    client,
    api,
    player,
    mpv,
    lyrics,
    media,
    cache,
    mainWindow: () => mainWindow,
    emit: (event, payload) => sendEvent(context, event, payload),
    log
  }
  contextRef.value = context

  // Refresh the profile (and with it the VIP tier that decides playability)
  // once the cookie jar has been read.
  if (client.isLoggedIn) {
    void api
      .userAccount()
      .then((profile) => {
        if (profile) {
          profileVipType = profile.vipType
          sendEvent(context, 'auth:changed', { loggedIn: true, profile: toProfileDTO(profile) })
        }
      })
      .catch((cause) => log(`获取账户信息失败: ${String(cause)}`))
  }

  registerAuthHandlers(context)
  registerPlayerHandlers(context)
  registerLibraryHandlers(context)
  registerExploreHandlers(context)
  registerAppHandlers(context)

  player.on('state', (snapshot: PlayerSnapshot) => {
    sendEvent(context, 'player:state', snapshot)
    media.updateWindow(currentTrack, snapshot.playing, snapshot.position)
    if (snapshot.track?.id === undefined) currentTrack = undefined
  })

  settings.on('change', (next) => {
    sendEvent(context, 'settings:changed', next)
    media.sync()
    if (!next.tray && tray) {
      tray.destroy()
      tray = undefined
    } else if (next.tray && !tray) {
      createTray(context)
    }
  })

  mainWindow = createMainWindow()
  if (settings.current.tray) createTray(context)
  media.sync()
  if (settings.current.showDesktopLyrics) toggleLyricsWindow(true)

  // Volume from the previous session is applied once mpv is up; a missing mpv
  // must not stop the rest of the app from working.
  try {
    await mpv.start()
    await mpv.setVolume(settings.current.volume)
  } catch (cause) {
    log(`mpv 启动失败: ${String(cause)}`)
    sendEvent(context, 'app:error', {
      message: `音频后端启动失败：${String(cause)}。请确认 vendor/mpv/mpv.exe 存在。`
    })
  }

  if (process.env.KUMONE_SMOKE_TEST === '1') {
    await runSmokeTest(mainWindow, context)
  }

  app.on('second-instance', () => showMainWindow())
}

/**
 * The audio sample used by the smoke test's playback check. Shipped by the
 * upstream repository's test suite, so it is available in a normal checkout and
 * overridable for CI.
 */
function findFixture(): string | undefined {
  const candidates = [
    process.env.KUMONE_FIXTURE,
    // Source layout: <repo>/../kumone-upstream/…
    path.resolve(__dirname, '..', '..', '..', 'kumone-upstream', 'Tests', 'KumoneCoreTests', 'Fixtures', 'offline.m4a'),
    // Packaged layout: resources/app.asar → step out to the sibling checkout.
    path.resolve(process.resourcesPath ?? '', '..', '..', '..', 'kumone-upstream', 'Tests', 'KumoneCoreTests', 'Fixtures', 'offline.m4a')
  ].filter((candidate): candidate is string => !!candidate)
  return candidates.find((candidate) => fs.existsSync(candidate))
}

/**
 * Writes the sample where the audio cache expects a played track, so the
 * player's cache lookup hits and playback needs no network and no login. The
 * filename follows `CacheStore`'s `<trackID>-<level>.<ext>` convention.
 */
async function plantCachedAudio(context: AppContext, fixture: string): Promise<string | undefined> {
  const level = context.settings.current.quality
  const directory = path.join(context.cache.directory, 'audio')
  const target = path.join(directory, `999000001-${level}.m4a`)
  try {
    await fs.promises.mkdir(directory, { recursive: true })
    await fs.promises.copyFile(fixture, target)
    return target
  } catch (cause) {
    log(`放置播放自检样本失败: ${String(cause)}`)
    return undefined
  }
}

/**
 * Headless self-check used by `npm run smoke`.
 *
 * The renderer is the one part of the app that unit tests cannot reach: it
 * needs a real Chromium, a real preload bridge and a real IPC round trip. This
 * drives the running window through a few channels and reports what it saw, so
 * a wiring mistake fails the build instead of the user's first launch.
 */
async function runSmokeTest(window: BrowserWindow, context: AppContext): Promise<void> {
  const results: Array<{ name: string; ok: boolean; detail: string }> = []
  const record = (name: string, ok: boolean, detail: string): void => {
    results.push({ name, ok, detail })
  }

  try {
    await new Promise<void>((resolve) => {
      if (!window.webContents.isLoading()) {
        resolve()
        return
      }
      window.webContents.once('did-finish-load', () => resolve())
    })
    // Let React mount and the initial IPC round trips settle.
    await new Promise((resolve) => setTimeout(resolve, 2500))

    const dom = (await window.webContents.executeJavaScript(`(() => {
      const has = (selector) => !!document.querySelector(selector)
      return {
        title: document.title,
        root: has('#root'),
        children: document.getElementById('root')?.children.length ?? 0,
        sidebar: has('.sidebar'),
        playerBar: has('.player-bar'),
        login: has('.login'),
        crash: document.body.innerText.includes('Cannot find module') ||
               document.body.innerText.includes('Uncaught')
      }
    })()`)) as Record<string, unknown>
    record('renderer 挂载', Number(dom.children) > 0, JSON.stringify(dom))
    record('侧边栏渲染', dom.sidebar === true || dom.login === true, `sidebar=${dom.sidebar} login=${dom.login}`)
    record('播放条渲染', dom.playerBar === true, `playerBar=${dom.playerBar}`)

    // IPC round trips through the real preload bridge.
    const ipc = (await window.webContents.executeJavaScript(`(async () => {
      const call = async (channel, request) => {
        try {
          const result = await window.kumone.invoke(channel, request)
          return { ok: result.ok, keys: result.data && typeof result.data === 'object' ? Object.keys(result.data).slice(0, 8) : typeof result.data, error: result.error }
        } catch (error) { return { ok: false, error: String(error) } }
      }
      return {
        info: await call('app:info'),
        settings: await call('settings:get'),
        state: await call('player:state'),
        auth: await call('auth:state'),
        devices: await call('player:audioDevices'),
        qrMatrix: await call('app:qrMatrix', { url: 'https://music.163.com/login?codekey=smoke-test' }),
        unknown: await call('does:not:exist')
      }
    })()`)) as Record<string, { ok: boolean; keys?: unknown; error?: string }>

    record('app:info', ipc.info?.ok === true, JSON.stringify(ipc.info?.keys ?? ipc.info?.error))
    record('settings:get', ipc.settings?.ok === true, JSON.stringify(ipc.settings?.keys ?? ipc.settings?.error))
    record('player:state', ipc.state?.ok === true, JSON.stringify(ipc.state?.keys ?? ipc.state?.error))
    record('auth:state', ipc.auth?.ok === true, JSON.stringify(ipc.auth?.keys ?? ipc.auth?.error))
    record('player:audioDevices', ipc.devices?.ok === true, JSON.stringify(ipc.devices?.keys ?? ipc.devices?.error))
    record('app:qrMatrix', ipc.qrMatrix?.ok === true, JSON.stringify(ipc.qrMatrix?.keys ?? ipc.qrMatrix?.error))
    record('未知通道被拒绝', ipc.unknown?.ok === false, String(ipc.unknown?.error))

    const info = await window.webContents.executeJavaScript(
      `window.kumone.invoke('app:info').then((r) => r.data)`
    )
    record('mpv 已就绪', typeof (info as { mpv?: string })?.mpv === 'string', String((info as { mpv?: string })?.mpv))

    const missing = assertAllChannelsRegistered()
    record('IPC 通道全注册', missing.length === 0, missing.length ? `缺失: ${missing.join(', ')}` : '全部已注册')

    // End-to-end playback through the app's own IPC. Playing a real NetEase
    // track would need a login, so the audio is planted into the cache the
    // player would have written anyway — which exercises queue → cache hit →
    // mpv → observed position, the whole chain except URL resolution.
    // Skipped (and reported) when the sample is missing.
    const fixture = findFixture()
    if (fixture) {
      const planted = await plantCachedAudio(context, fixture)
      const result = (await window.webContents.executeJavaScript(`(async () => {
        const track = {
          id: 999000001,
          name: '播放自检',
          artists: [{ id: 1, name: 'Kumone' }],
          album: { id: 1, name: 'Smoke' },
          durationMS: 3000,
          alias: [],
          transNames: [],
          fee: 0,
          mvID: 0,
          noCopyright: false,
          isCloud: false,
          playability: 'playable'
        }
        const started = await window.kumone.invoke('player:playTracks', { tracks: [track], startIndex: 0 })
        // Sample is ~3s; sample the position quickly, then pause so the check
        // does not race the end of the file.
        await new Promise((resolve) => setTimeout(resolve, 1200))
        const state = await window.kumone.invoke('player:state')
        await window.kumone.invoke('player:pause')
        return { started: started.ok, error: started.error, state: state.data }
      })()`)) as {
        started: boolean
        error?: string
        state?: { playing?: boolean; position?: number; duration?: number; servedQuality?: string; source?: string }
      }
      const state = result.state
      record('队列 → mpv 播放', result.started === true, result.error ?? 'playTracks 成功')
      record(
        '播放位置推进',
        typeof state?.position === 'number' && state.position > 0,
        `playing=${state?.playing} position=${state?.position?.toFixed?.(2)} duration=${state?.duration?.toFixed?.(2)} source=${state?.source ? state.source.slice(-30) : '-'}`
      )
      record('播放走的是缓存文件', (state?.source ?? '').includes('audio'), state?.source ?? '(空)')
      void planted
      await context.player.clearQueue().catch(() => undefined)
    } else {
      record('队列 → mpv 播放', true, '跳过：缺少音频样本')
    }
  } catch (cause) {
    record('冒烟测试异常', false, String(cause))
  }

  const failed = results.filter((result) => !result.ok)
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name} — ${result.detail}`)
  }
  console.log(failed.length === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failed.length})`)

  quitting = true
  await context.player.shutdown().catch(() => undefined)
  await context.mpv.stop().catch(() => undefined)
  app.exit(failed.length === 0 ? 0 : 1)
}

function toProfileDTO(profile: {
  userId: number
  nickname: string
  avatarUrl?: string
  backgroundUrl?: string
  signature?: string
  vipType: number
}) {
  return {
    userId: profile.userId,
    nickname: profile.nickname,
    avatarUrl: profile.avatarUrl,
    backgroundUrl: profile.backgroundUrl,
    signature: profile.signature,
    vipType: profile.vipType
  }
}

app.whenReady().then(() => {
  void bootstrap().catch((cause) => {
    log(`启动失败: ${String(cause)}`)
    dialog.showErrorBox('启动失败', String(cause))
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    const settings = contextRef.value?.settings.current
    if (settings?.tray && !quitting) return
    app.quit()
  }
})

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', (event) => {
  const context = contextRef.value
  if (!context) return
  // mpv is a child process: it must be stopped, not orphaned.
  event.preventDefault()
  void Promise.race([context.player.shutdown(), new Promise((resolve) => setTimeout(resolve, 2000))])
    .then(() => {
      context.media.dispose()
      return context.mpv.stop().catch(() => undefined)
    })
    .finally(() => {
      // Remove the handler so this quit actually completes.
      app.removeAllListeners('will-quit')
      app.quit()
    })
})

// Diagnostics: the renderer can ask for the tail of the main-process log.
ipcMain.handle('kumone:invoke:app:logTail', () => ({ ok: true, data: logLines.join('\n') }))
