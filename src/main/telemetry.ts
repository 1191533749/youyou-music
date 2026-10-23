import { app } from 'electron'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

/**
 * 匿名设备统计。
 *
 * 只做统计，不做封禁：上报一个「设备指纹哈希 + 本次安装 id」以及版本/系统/时区，
 * 供开发者在自己的后台看有多少设备在用、什么版本、哪个地区。
 * 不含网易云账号、不含歌单、不含任何个人信息；客户端界面里没有任何入口。
 *
 * 设备指纹 = SHA256(MachineGuid + C盘卷序列号 + CPU 型号) 的前 16 位。
 * 重装客户端不变，系统重装才变；Wi-Fi 随机的 MAC 不参与。
 */

const ENDPOINT = 'https://yy.ytw.asia/player-api/telemetry'
const APP_KEY = 'b9ae8468c1c32ab0e1aa0223807791ef'
const HEARTBEAT_MS = 24 * 60 * 60 * 1000
const RETRY_CHECK_MS = 6 * 60 * 60 * 1000
const START_DELAY_MS = 10_000

interface TelemetryState {
  deviceId?: string
  installId?: string
  lastReportAt?: number
}

function stateFile(): string {
  return path.join(app.getPath('userData'), 'telemetry.json')
}

function readState(): TelemetryState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as TelemetryState
  } catch {
    return {}
  }
}

function writeState(state: TelemetryState): void {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(state), 'utf8')
  } catch {
    // 统计失败不影响使用。
  }
}

function execText(file: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (error, stdout) => {
      resolve(error ? '' : String(stdout))
    })
  })
}

async function machineGuid(): Promise<string> {
  const out = await execText('reg', [
    'query',
    'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
    '/v',
    'MachineGuid'
  ])
  const match = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/.exec(out)
  return match ? match[1] : ''
}

async function volumeSerial(): Promise<string> {
  const out = await execText('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "(Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\").VolumeSerialNumber"
  ])
  return out.trim()
}

async function computeDeviceId(): Promise<string> {
  const [guid, serial] = await Promise.all([machineGuid(), volumeSerial()])
  const cpu = os.cpus()[0]?.model ?? ''
  // 三项都拿不到时退化为「未知设备」，仍可用安装 id 区分本次安装。
  const seed = `${guid}|${serial}|${cpu}`
  return createHash('sha256').update(seed).digest('hex').slice(0, 16)
}

function post(payload: Record<string, unknown>): Promise<boolean> {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  return new Promise((resolve) => {
    const request = https.request(
      ENDPOINT,
      {
        method: 'POST',
        timeout: 8000,
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          'x-yy-app': APP_KEY,
          'user-agent': `YouyouMusic/${app.getVersion()}`
        }
      },
      (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode === 200))
      }
    )
    request.on('timeout', () => {
      request.destroy()
      resolve(false)
    })
    request.on('error', () => resolve(false))
    request.end(body)
  })
}

async function report(): Promise<void> {
  const state = readState()
  if (!state.deviceId) {
    state.deviceId = await computeDeviceId()
  }
  if (!state.installId) {
    state.installId = randomUUID().slice(0, 8)
  }
  const event = state.lastReportAt ? 'heartbeat' : 'install'
  const ok = await post({
    device: state.deviceId,
    install: state.installId,
    event,
    v: app.getVersion(),
    os: `Windows ${os.release()}`,
    arch: process.arch,
    mem: Math.round(os.totalmem() / 1024 ** 3),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    lang: app.getLocale() || ''
  })
  if (ok) state.lastReportAt = Date.now()
  writeState(state)
}

let started = false

export function startTelemetry(): void {
  if (started || process.platform !== 'win32') return
  started = true
  const tick = (): void => {
    const state = readState()
    const due = !state.lastReportAt || Date.now() - state.lastReportAt >= HEARTBEAT_MS
    if (due) void report()
  }
  setTimeout(tick, START_DELAY_MS)
  setInterval(tick, RETRY_CHECK_MS).unref()
}
