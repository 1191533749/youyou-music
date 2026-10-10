/**
 * 高频只读采样一个正在运行的 mpv（JSON IPC 命名管道），专抓「播放中途卡一下」：
 *  - paused-for-cache 变 true/变 false 的起止时间（真正的「等缓存」停顿）
 *  - cache-buffering-state < 100（缓冲不满）
 *  - buffered-ahead 掉到危险区（< 8s）
 *  - position 卡住不动但未暂停（音频输出层卡顿，非网络）
 *
 * 用法：node scripts/live-stutter.mjs <pipeName> [秒数=300] [out.txt]
 * 只读，绝不发写命令，不影响播放。
 */
import * as net from 'node:net'
import * as fs from 'node:fs'

const pipeName = process.argv[2]
const seconds = Number(process.argv[3] ?? 300)
const outFile = process.argv[4]
if (!pipeName) {
  console.error('用法: node scripts/live-stutter.mjs <pipeName> [秒数] [out.txt]')
  process.exit(2)
}
const PIPE = `\\\\.\\pipe\\${pipeName}`
const INTERVAL_MS = 200

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
function get(prop, timeoutMS = 1200) {
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

const PROPS = ['media-title', 'path', 'time-pos', 'duration', 'paused', 'paused-for-cache', 'cache-buffering-state', 'demuxer-cache-duration', 'eof-reached']
async function sample() {
  const out = { at: Date.now() }
  for (const prop of PROPS) out[prop] = await get(prop)
  out.position = out['time-pos']
  return out
}

function title(s) {
  const t = s['media-title'] ?? ''
  if (t.length > 40) return t.slice(-40)
  return t
}
function srcHost(s) {
  try {
    const u = new URL(s.path)
    return u.host
  } catch {
    return '?'
  }
}

const log = (line) => {
  console.log(line)
  if (outFile) fs.appendFileSync(outFile, line + '\n')
}

async function main() {
  await connect()
  log(`# live-stutter pipe=${pipeName} 时长=${seconds}s 间隔=${INTERVAL_MS}ms 开始=${new Date().toISOString()}`)
  const deadline = Date.now() + seconds * 1000
  let prev = null
  let wasPfk = false
  let pfkStart = 0
  let underruns = 0
  let lastProgress = Date.now()
  let currentSrc = null

  while (Date.now() < deadline) {
    const s = await sample()
    const pfk = s['paused-for-cache'] === true
    const cbs = s['cache-buffering-state']
    const ahead = s['demuxer-cache-duration']
    const pos = s.position ?? 0
    const dur = s.duration ?? 0
    const host = srcHost(s)

    if (host !== currentSrc) {
      currentSrc = host
      log(`  ↪ 音源切换 → ${host}  《${title(s)}》`)
    }

    // paused-for-cache 起止
    if (pfk && !wasPfk) {
      pfkStart = Date.now()
      underruns += 1
      log(`  ✋ 【等缓存开始】 ${new Date(s.at).toISOString().slice(11, 23)} pos=${pos.toFixed(1)}/${dur.toFixed(1)} 已缓存前方=${typeof ahead === 'number' ? ahead.toFixed(1) + 's' : '?'} 源=${host}`)
    } else if (!pfk && wasPfk) {
      log(`  ▶ 【等缓存结束】 ${new Date(s.at).toISOString().slice(11, 23)} 持续 ${((Date.now() - pfkStart) / 1000).toFixed(2)}s pos=${pos.toFixed(1)}/${dur.toFixed(1)}`)
    }
    wasPfk = pfk

    // 缓冲不满
    if (typeof cbs === 'number' && cbs < 100) {
      log(`  ⚠ 缓冲不满 ${cbs}%  已缓存前方=${typeof ahead === 'number' ? ahead.toFixed(1) + 's' : '?'} pos=${pos.toFixed(1)}/${dur.toFixed(1)}`)
    }

    // 前方缓存掉到危险区（快耗尽）
    if (typeof ahead === 'number' && ahead < 8 && dur > 0 && pos < dur - 1 && !pfk) {
      log(`  ⚠ 前方缓存见底 ${ahead.toFixed(1)}s  pos=${pos.toFixed(1)}/${dur.toFixed(1)} 源=${host}`)
    }

    // position 卡住（非暂停、非等缓存）——音频输出/其它层卡顿
    if (prev) {
      const moved = (pos ?? 0) - (prev.position ?? 0)
      const wall = (s.at - prev.at) / 1000
      if (moved <= 0 && !s.paused && !pfk && dur > 0 && pos < dur - 0.5) {
        const stallMs = Date.now() - lastProgress
        if (stallMs >= 800) {
          log(`  🧊 position 卡住 ${(stallMs / 1000).toFixed(2)}s（未暂停/未等缓存）pos=${pos.toFixed(2)} 源=${host}`)
        }
      } else {
        lastProgress = Date.now()
      }
    }
    prev = s
    await new Promise((r) => setTimeout(r, INTERVAL_MS))
  }
  log(`# 结束。等缓存 underrun 次数=${underruns}`)
  sock.destroy()
}

main().catch((cause) => {
  console.error('失败:', cause.message)
  try {
    sock?.destroy()
  } catch {}
  process.exit(1)
})
