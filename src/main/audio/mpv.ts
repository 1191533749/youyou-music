/**
 * mpv audio backend.
 *
 * mpv plays the audio itself (WASAPI out, gapless, no resampling surprises);
 * this process only drives it over the JSON IPC channel and mirrors its state
 * back to the UI. That is the same division of labour the macOS client has
 * between the playlist logic and the audio backend, with libmpv in that role's
 * seat.
 *
 * On Windows the IPC endpoint is a named pipe (`\\.\pipe\youyou-mpv-<pid>`),
 * which `net.connect` speaks directly — no extra native dependency, whereas
 * `mpv --input-ipc-server` accepts a pipe name as happily as a socket path.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as net from 'node:net'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'

export interface MpvTrackInfo {
  /** Seconds; 0 when nothing is loaded. */
  duration: number
  /** Bytes, when known. */
  fileSize?: number
  /** mpv's detected audio format parameters, e.g. `flac`. */
  audioCodec?: string
  audioChannels?: number
  audioSampleRate?: number
  /** Bitrate in bits per second, when mpv reports one. */
  audioBitrate?: number
}

export interface MpvState {
  running: boolean
  paused: boolean
  /** Playback position in seconds. */
  position: number
  duration: number
  volume: number
  muted: boolean
  /** True while mpv is fetching/buffering, or before playback really starts. */
  loading: boolean
  idle: boolean
  /** Empty string when no file is loaded. */
  path: string
}

export interface MpvControllerOptions {
  /** Absolute path to `mpv.exe`. */
  binary: string
  /** Extra CLI arguments (audio device, cache sizing, …). */
  extraArgs?: string[]
  /** Explicit audio output device, e.g. `wasapi/{...}`; omitted means system default. */
  audioDevice?: string
  onState?: (state: MpvState) => void
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
  onTrackEnd?: () => void
}

const OBSERVED_PROPERTIES = [
  'time-pos',
  'duration',
  'pause',
  'volume',
  'mute',
  'idle-active',
  'core-idle',
  'path',
  'paused-for-cache',
  'eof-reached'
] as const

export class MpvController extends EventEmitter {
  private process?: ChildProcess
  private socket?: net.Socket
  private requestId = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private buffer = ''
  private readonly options: MpvControllerOptions
  private state: MpvState = {
    running: false,
    paused: true,
    position: 0,
    duration: 0,
    volume: 100,
    muted: false,
    loading: false,
    idle: true,
    path: ''
  }
  private endEmitted = false
  private readonly pipeName: string

  constructor(options: MpvControllerOptions) {
    super()
    this.options = options
    this.pipeName = `youyou-mpv-${process.pid}-${Math.floor(Math.random() * 1e6)}`
  }

  get currentState(): MpvState {
    return { ...this.state }
  }

  // MARK: - Lifecycle

  async start(): Promise<void> {
    if (this.process) return
    const args = [
      `--input-ipc-server=\\\\.\\pipe\\${this.pipeName}`,
      '--idle=yes',
      '--no-video',
      '--no-terminal',
      '--gapless-audio=yes',
      '--audio-display=no',
      '--keep-open=no',
      '--really-quiet',
      '--volume-max=150',
      '--cache=yes',
      '--demuxer-max-bytes=64MiB',
      '--demuxer-readahead-secs=30',
      // NetEase serves FLAC/MP3 over https; let mpv verify but not block on
      // slow CDNs for too long.
      '--network-timeout=15',
      '--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=5',
      ...(this.options.audioDevice ? [`--audio-device=${this.options.audioDevice}`] : []),
      ...(this.options.extraArgs ?? [])
    ]
    this.process = spawn(this.options.binary, args, { stdio: 'ignore', windowsHide: true })
    this.process.on('error', (error) => {
      this.options.onLog?.('error', `mpv 启动失败: ${error.message}`)
      this.emit('error', error)
    })
    this.process.on('exit', (code, signal) => {
      this.options.onLog?.('warn', `mpv 退出 (code=${code} signal=${signal})`)
      this.process = undefined
      this.socket?.destroy()
      this.socket = undefined
      this.state.running = false
      this.emitState()
      this.emit('exit')
    })

    await this.connect()
    await this.observeProperties()
  }

  private async connect(): Promise<void> {
    const deadline = Date.now() + 10_000
    // mpv creates the pipe slightly after spawn; retry until it answers.
    for (;;) {
      try {
        await this.connectOnce()
        this.state.running = true
        this.emitState()
        return
      } catch (error) {
        if (Date.now() > deadline) {
          throw new Error(`无法连接 mpv IPC: ${(error as Error).message}`)
        }
        await delay(120)
      }
    }
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(`\\\\.\\pipe\\${this.pipeName}`)
      const onError = (error: Error): void => {
        socket.destroy()
        reject(error)
      }
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.off('error', onError)
        socket.on('error', (error) => this.options.onLog?.('error', `mpv IPC 错误: ${error.message}`))
        socket.setEncoding('utf8')
        socket.on('data', (chunk: string) => this.onData(chunk))
        this.socket = socket
        resolve()
      })
    })
  }

  /** Terminates the mpv process and closes the IPC channel. */
  async stop(): Promise<void> {
    if (!this.process) return
    try {
      await this.command(['quit'])
    } catch {
      // The process is going away regardless.
    }
    this.socket?.destroy()
    this.socket = undefined
    const child = this.process
    this.process = undefined
    if (child && child.exitCode === null) {
      // Give mpv a moment to exit cleanly, then make sure it does.
      await Promise.race([once(child, 'exit'), delay(1500)])
      if (child.exitCode === null) child.kill()
    }
  }

  // MARK: - IPC framing

  private onData(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.handleLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    let message: any
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (typeof message.request_id === 'number' && message.error !== 'success') {
      const pending = this.pending.get(message.request_id)
      if (pending) {
        this.pending.delete(message.request_id)
        pending.reject(new Error(`mpv: ${message.error}`))
      }
      return
    }
    if (message.event) {
      this.handleEvent(message)
      return
    }
    if (typeof message.request_id === 'number') {
      const pending = this.pending.get(message.request_id)
      if (pending) {
        this.pending.delete(message.request_id)
        pending.resolve(message.data)
      }
    }
  }

  private handleEvent(event: any): void {
    switch (event.event) {
      case 'property-change':
        this.applyProperty(event.name, event.data)
        break
      case 'file-loaded':
        this.endEmitted = false
        this.state.loading = false
        this.emitState()
        break
      case 'start-file':
        this.endEmitted = false
        this.state.loading = true
        this.state.position = 0
        this.emitState()
        break
      case 'end-file':
        this.state.loading = false
        if (event.reason === 'eof' || event.reason === 'error') {
          this.emitTrackEnd()
        }
        this.emitState()
        break
      case 'idle':
        this.state.idle = true
        this.state.path = ''
        this.state.position = 0
        this.emitState()
        break
      default:
        break
    }
  }

  private applyProperty(name: string, value: unknown): void {
    switch (name) {
      case 'time-pos':
        if (typeof value === 'number') this.state.position = value
        break
      case 'duration':
        if (typeof value === 'number') this.state.duration = value
        break
      case 'pause':
        if (typeof value === 'boolean') this.state.paused = value
        break
      case 'volume':
        if (typeof value === 'number') this.state.volume = value
        break
      case 'mute':
        if (typeof value === 'boolean') this.state.muted = value
        break
      case 'idle-active':
        if (typeof value === 'boolean') this.state.idle = value
        break
      case 'paused-for-cache':
        if (typeof value === 'boolean') this.state.loading = value
        break
      case 'path':
        this.state.path = typeof value === 'string' ? value : ''
        break
      default:
        return
    }
    this.emitState()
  }

  private emitTrackEnd(): void {
    if (this.endEmitted) return
    this.endEmitted = true
    this.options.onTrackEnd?.()
    this.emit('track-end')
  }

  private emitState(): void {
    this.options.onState?.(this.currentState)
    this.emit('state', this.currentState)
  }

  /** Sends a command array and resolves with its `data` field. */
  private command(command: unknown[]): Promise<any> {
    const socket = this.socket
    if (!socket || socket.destroyed) return Promise.reject(new Error('mpv 未运行'))
    const id = ++this.requestId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`mpv 命令超时: ${JSON.stringify(command)}`))
      }, 10_000)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      socket.write(`${JSON.stringify({ command, request_id: id })}\n`)
    })
  }

  private async observeProperties(): Promise<void> {
    for (const property of OBSERVED_PROPERTIES) {
      try {
        await this.command(['observe_property', hashName(property), property])
      } catch {
        // A property mpv does not know (older build) is not fatal.
      }
    }
    // Seed the initial state from the live values.
    try {
      const [pause, volume, mute, idle] = await Promise.all([
        this.command(['get_property', 'pause']).catch(() => undefined),
        this.command(['get_property', 'volume']).catch(() => undefined),
        this.command(['get_property', 'mute']).catch(() => undefined),
        this.command(['get_property', 'idle-active']).catch(() => undefined)
      ])
      if (typeof pause === 'boolean') this.state.paused = pause
      if (typeof volume === 'number') this.state.volume = volume
      if (typeof mute === 'boolean') this.state.muted = mute
      if (typeof idle === 'boolean') this.state.idle = idle
      this.emitState()
    } catch {
      // Defaults are fine.
    }
  }

  // MARK: - Playback API

  /** Loads a URL or local file and starts playback from `start` seconds. */
  async play(url: string, start = 0): Promise<void> {
    this.state.loading = true
    this.emitState()
    await this.command(['loadfile', url, 'replace'])
    if (start > 0) await this.seek(start)
    await this.setPaused(false)
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.command(['set_property', 'pause', paused])
  }

  async togglePause(): Promise<void> {
    await this.setPaused(!this.state.paused)
  }

  /**
   * Seeks to an absolute position in seconds.
   *
   * `absolute+keyframes` rather than `+exact`: exact seeking makes mpv decode
   * from the start of the stream on containers where it cannot seek precisely,
   * which on a remote FLAC means a visible stall. A keyframe-accurate landing is
   * what every other streaming player does.
   */
  async seek(seconds: number): Promise<void> {
    await this.command(['seek', Math.max(0, seconds), 'absolute+keyframes'])
  }

  async setVolume(volume: number): Promise<void> {
    await this.command(['set_property', 'volume', clamp(volume, 0, 150)])
  }

  async setMuted(muted: boolean): Promise<void> {
    await this.command(['set_property', 'mute', muted])
  }

  /** Re-applies the audio device after the user picks a different output. */
  async setAudioDevice(device: string): Promise<void> {
    await this.command(['set_property', 'audio-device', device])
    this.options.audioDevice = device
  }

  async setPlaybackRate(rate: number): Promise<void> {
    await this.command(['set_property', 'speed', clamp(rate, 0.25, 4)])
  }

  /** Drains the current file without tearing mpv down, e.g. when skipping. */
  async unload(): Promise<void> {
    this.state.path = ''
    this.state.duration = 0
    this.state.position = 0
    await this.command(['stop'])
  }

  /** 已载入文件的时长（秒）；文件还没载入完时为 undefined。 */
  async duration(): Promise<number | undefined> {
    const raw = await this.command(['get_property', 'duration']).catch(() => undefined)
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined
  }

  /** Audio parameters of the loaded file (used by the now-playing info line). */
  async trackInfo(): Promise<MpvTrackInfo> {    const properties = ['duration', 'file-size', 'audio-codec', 'audio-params/channel-count', 'audio-params/samplerate', 'audio-bitrate']
    const values = await Promise.all(
      properties.map((property) => this.command(['get_property', property]).catch(() => undefined))
    )
    return {
      duration: typeof values[0] === 'number' ? values[0] : 0,
      fileSize: typeof values[1] === 'number' ? values[1] : undefined,
      audioCodec: typeof values[2] === 'string' ? values[2] : undefined,
      audioChannels: typeof values[3] === 'number' ? values[3] : undefined,
      audioSampleRate: typeof values[4] === 'number' ? values[4] : undefined,
      audioBitrate: typeof values[5] === 'number' ? values[5] : undefined
    }
  }

  /**
   * 当前音频的真实码率（kbps）。
   *
   * 用途：第三方音源（换源播放）拿不到接口声明的档位，界面就会退回去显示用户的
   * 首选音质（例如「母带」），这属于虚报。mpv 的 track-list 里有
   * `demux-bitrate`（bit/s），用它换算真实档位才诚实。
   */
  async audioBitrate(): Promise<number | undefined> {
    const tracks = await this.command(['get_property', 'track-list'])
    if (!Array.isArray(tracks)) return undefined
    const audio = tracks.find((entry: any) => entry?.type === 'audio')
    const raw = Number(audio?.['demux-bitrate'] ?? 0)
    if (!Number.isFinite(raw) || raw <= 0) return undefined
    return Math.round(raw / 1000)
  }

  /**
   * The audio devices mpv will accept, as `wasapi/{...}` specifiers. The first
   * entry mpv reports as `auto` is the system default.
   *
   * 显示名用 `description`（例如「扬声器 (Realtek(R) Audio)」）而不是 `name`：
   * mpv 的 name 是 `wasapi/{guid}` 这种内部键，直接展示就像乱码。
   */
  async listAudioDevices(): Promise<Array<{ id: string; label: string }>> {
    const raw = await this.command(['get_property', 'audio-device-list'])
    if (!Array.isArray(raw)) return [{ id: 'auto', label: 'auto' }]
    const devices: Array<{ id: string; label: string }> = []
    for (const entry of raw) {
      const id = typeof entry?.name === 'string' ? entry.name : undefined
      if (!id) continue
      const description = typeof entry?.description === 'string' ? entry.description : ''
      devices.push({ id, label: description || id })
    }
    return devices
  }
}

function hashName(property: string): number {
  let hash = 0
  for (let i = 0; i < property.length; i += 1) {
    hash = (hash * 31 + property.charCodeAt(i)) | 0
  }
  // observe_property ids must be positive.
  return Math.abs(hash) || 1
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function once(child: ChildProcess, event: string): Promise<void> {
  return new Promise((resolve) => child.once(event, () => resolve()))
}

/**
 * Locates `mpv.exe`: an explicit override, then the copy bundled next to the
 * app resources, then `resources/mpv`, then PATH.
 */
export function resolveMpvBinary(explicit?: string): string | undefined {
  const candidates: string[] = []
  if (explicit) candidates.push(explicit)
  if (process.env.YOYOU_MPV) candidates.push(process.env.YOYOU_MPV)
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'mpv', 'mpv.exe'))
    candidates.push(path.join(process.resourcesPath, 'mpv.exe'))
  }
  candidates.push(path.join(process.cwd(), 'resources', 'mpv', 'mpv.exe'))
  candidates.push(path.join(process.cwd(), 'vendor', 'mpv', 'mpv.exe'))
  const fromPath = findOnPath('mpv.exe')
  if (fromPath) candidates.push(fromPath)
  return candidates.find((candidate) => existsSyncSafe(candidate))
}

function existsSyncSafe(target: string): boolean {
  try {
    // Lazily required so this module stays importable in unit tests.
    const fs = require('node:fs') as typeof import('node:fs')
    return fs.existsSync(target)
  } catch {
    return false
  }
}

function findOnPath(executable: string): string | undefined {
  const pathValue = process.env.PATH ?? ''
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, executable)
    if (existsSyncSafe(candidate)) return candidate
  }
  return undefined
}
