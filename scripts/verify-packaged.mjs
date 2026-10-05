/**
 * 打包产物自检。
 *
 * `npm run smoke` 跑的是源码布局（mpv 在 vendor/ 或 PATH 里）；打包后 mpv 位于
 * `resources/mpv/mpv.exe`，装配布局只有在这里才会被验证。用普通 Node 模拟进程
 * 环境，比在 Windows 上抓 Electron GUI 进程的 stdout 可靠。
 *
 * 检查项：
 *   1. release/win-unpacked 的装配布局齐全（exe / app.asar / resources/mpv）
 *   2. app.asar 里确实带上了主进程与渲染进程产物
 *   3. **随包的 mpv 真的能解码并输出音频**（播放上游测试 flac，位置要往前走）
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import process from 'node:process'
import * as net from 'node:net'

const unpacked = path.resolve('release', 'win-unpacked')
const resources = path.join(unpacked, 'resources')
const mpv = path.join(resources, 'mpv', 'mpv.exe')
const asar = path.join(resources, 'app.asar')
const fixture =
  process.env.KUMONE_FIXTURE ??
  path.resolve('..', 'kumone-upstream', 'Tests', 'KumoneCoreTests', 'Fixtures', 'offline.m4a')

// 主可执行文件名跟随 electron-builder 的 productName（当前为 YouyouMusic）。
const appExe = readdirSync(unpacked).find((name) => name.toLowerCase().endsWith('.exe'))
const appExePath = appExe ? path.join(unpacked, appExe) : path.join(unpacked, 'YouyouMusic.exe')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
}

check(`${appExe ?? '主程序'} 存在`, existsSync(appExePath), appExePath)
check('app.asar 存在', existsSync(asar), asar)
check('随包 mpv 存在', existsSync(mpv), mpv)

if (existsSync(asar)) {
  const contents = readFileSync(asar).toString('latin1')
  check(
    'asar 内含主进程入口',
    contents.includes('out') && contents.includes('main'),
    `asar 大小 ${(statSync(asar).size / 1024 / 1024).toFixed(1)} MB`
  )
}

// 随包的 mpv 必须能真的解码播放，而不只是「文件在」。
if (existsSync(mpv) && existsSync(fixture)) {
  const pipe = `kumone-verify-${process.pid}-${Math.floor(Math.random() * 1e6)}`
  const child = spawn(mpv, [`--input-ipc-server=\\\\.\\pipe\\${pipe}`, '--idle=yes', '--no-video', '--no-terminal', '--really-quiet'], {
    stdio: 'ignore',
    windowsHide: true
  })
  try {
    const socket = await connectPipe(pipe, 10_000)
    const send = (command) =>
      new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1e6)
        const timer = setTimeout(() => reject(new Error(`命令超时: ${command[0]}`)), 10_000)
        const onData = (chunk) => {
          for (const line of String(chunk).split('\n')) {
            if (!line.trim()) continue
            const message = JSON.parse(line)
            if (message.request_id !== id) continue
            clearTimeout(timer)
            socket.off('data', onData)
            message.error && message.error !== 'success' ? reject(new Error(message.error)) : resolve(message.data)
          }
        }
        socket.on('data', onData)
        socket.write(`${JSON.stringify({ command, request_id: id })}\n`)
      })

    await send(['loadfile', fixture, 'replace'])
    await send(['set_property', 'pause', false])
    // `duration` and `time-pos` are "property unavailable" until mpv has parsed
    // the container, so poll instead of reading them straight after loadfile.
    const duration = await pollProperty(send, 'duration', (value) => typeof value === 'number' && value > 0)
    const position = await pollProperty(send, 'time-pos', (value) => typeof value === 'number' && value > 0.2)
    const codec = await send(['get_property', 'audio-codec']).catch(() => 'unknown')

    check(
      '随包 mpv 可解码并推进播放位置',
      typeof position === 'number' && position > 0.2,
      `position=${Number(position).toFixed(2)}s duration=${Number(duration).toFixed(2)}s codec=${codec}`
    )
    socket.destroy()
  } catch (error) {
    check('随包 mpv 可解码并推进播放位置', false, String(error))
  } finally {
    child.kill()
  }
} else {
  check('随包 mpv 可解码并推进播放位置', false, `缺少 mpv 或音频样本 (${fixture})`)
}

let failed = 0
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name} — ${result.detail}`)
  if (!result.ok) failed += 1
}
console.log(failed === 0 ? 'PACKAGED OK' : `PACKAGED FAILED (${failed})`)
process.exit(failed === 0 ? 0 : 1)

function connectPipe(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(`\\\\.\\pipe\\${name}`)
      socket.once('connect', () => {
        socket.setEncoding('utf8')
        resolve(socket)
      })
      socket.once('error', (error) => {
        socket.destroy()
        if (Date.now() > deadline) reject(error)
        else setTimeout(attempt, 150)
      })
    }
    attempt()
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * mpv answers "property unavailable" for anything it has not parsed yet, so a
 * single read is not a valid check — this retries until the value satisfies
 * `accept` or the deadline passes.
 */
async function pollProperty(send, property, accept, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await send(['get_property', property])
      if (accept(last)) return last
    } catch (error) {
      last = String(error)
    }
    await delay(200)
  }
  return last
}
