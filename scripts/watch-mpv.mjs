/**
 * 只读观察一个正在运行的 mpv 实例（通过它的 JSON IPC 命名管道）。
 * 绝不发送写命令——只 get_property，用于在不打扰用户播放的前提下取证：
 * 「还是卡顿」到底是 mpv 在等缓存（paused-for-cache）还是别的。
 *
 * 用法：
 *   node scripts/watch-mpv.mjs <pipeName> once        # 采样一次，打印 JSON 后退出
 *   node scripts/watch-mpv.mjs <pipeName> 240 out.txt # 每 1s 采样，跑 240s，追加写文件
 */
import * as net from 'node:net'
import * as fs from 'node:fs'

const pipeName = process.argv[2]
const mode = process.argv[3] ?? 'once'
const seconds = Number(process.argv[4] ?? 120)
const outFile = process.argv[5]

if (!pipeName) {
  console.error('用法: node scripts/watch-mpv.mjs <pipeName> [once|<秒数>] [out.txt]')
  process.exit(2)
}

const PIPE = `\\\\.\\pipe\\${pipeName}`
const PROPS = [
  'media-title',
  'path',
  'time-pos',
  'duration',
  'paused',
  'paused-for-cache',
  'cache-buffering-state',
  'demuxer-cache-duration',
  'demuxer-cache-idle',
  'eof-reached',
  'audio-bitrate'
]

let sock
let rid = 0
const pending = new Map()
let buffer = ''

function send(command, id) {
  sock.write(`${JSON.stringify({ command, request_id: id })}\n`)
}

function onLine(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (typeof msg.request_id === 'number' && pending.has(msg.request_id)) {
    const resolve = pending.get(msg.request_id)
    pending.delete(msg.request_id)
    resolve(msg.data ?? null)
  }
}

function connect() {
  return new Promise((resolve, reject) => {
    sock = net.connect(PIPE)
    sock.setEncoding('utf8')
    sock.once('error', reject)
    sock.once('connect', () => {
      sock.removeAllListeners('error')
      sock.on('error', () => {})
      sock.on('data', (chunk) => {
        buffer += chunk
        let nl = buffer.indexOf('\n')
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (line) onLine(line)
          nl = buffer.indexOf('\n')
        }
      })
      resolve()
    })
  })
}

function get(prop, timeoutMS = 1500) {
  return new Promise((resolve) => {
    const id = ++rid
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(null)
    }, timeoutMS)
    pending.set(id, (v) => {
      clearTimeout(timer)
      resolve(v)
    })
    send(['get_property', prop], id)
  })
}

async function sample() {
  const out = { at: new Date().toISOString() }
  for (const prop of PROPS) {
    out[prop] = await get(prop)
  }
  out.position = out['time-pos']
  return out
}

const fmt = (s) => {
  const pos = s.position ?? 0
  const dur = s.duration ?? 0
  const cache = s['cache-buffering-state']
  const buffered = s['demuxer-cache-duration']
  const pfk = s['paused-for-cache']
  const idle = s['demuxer-cache-idle']
  return (
    `${s.at.slice(11, 23)} pos=${Number(pos).toFixed(1)}/${Number(dur).toFixed(1)} ` +
    `pause=${s.paused ? 1 : 0} 等缓存=${pfk ? 1 : 0} 缓冲${typeof cache === 'number' ? cache + '%' : '?'} ` +
    `已缓存${typeof buffered === 'number' ? Number(buffered).toFixed(1) + 's' : '?'} ` +
    `idle=${idle ? 1 : 0} bitrate=${s['audio-bitrate'] ?? '?'} ${s['media-title'] ?? ''}`
  )
}

async function main() {
  await connect()
  if (mode === 'once') {
    console.log(JSON.stringify(await sample(), null, 2))
    sock.destroy()
    return
  }
  const deadline = Date.now() + seconds * 1000
  let prev = null
  let stalls = 0
  const line = (s) => {
    console.log(s)
    if (outFile) fs.appendFileSync(outFile, s + '\n')
  }
  line(`# 开始观察 pipe=${pipeName} 时长=${seconds}s`)
  while (Date.now() < deadline) {
    const s = await sample()
    line(fmt(s))
    if (prev) {
      const moved = (s.position ?? 0) - (prev.position ?? 0)
      const wall = (new Date(s.at) - new Date(prev.at)) / 1000
      const stalled = !s.paused && s['paused-for-cache']
      if (stalled) stalls += 1
      if (moved <= 0 && !s.paused && !s['paused-for-cache'] && s.duration > 0 && s.position < s.duration - 0.5) {
        line(`  ⚠ 疑似停顿：wall=${wall.toFixed(1)}s 但 position 没动（未暂停、未等缓存）`)
      }
    }
    prev = s
    await new Promise((r) => setTimeout(r, 1000))
  }
  line(`# 结束。paused-for-cache 命中次数=${stalls}`)
  sock.destroy()
}

main().catch((cause) => {
  console.error('失败:', cause.message)
  try {
    sock?.destroy()
  } catch {}
  process.exit(1)
})
