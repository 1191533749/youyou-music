/** 临时调试：什么都不点，看 warmFMPool 是否会把主进程搞崩。 */
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9379
const userData = path.join(os.tmpdir(), 'youyou-fm-debug2')

fs.rmSync(userData, { recursive: true, force: true })
fs.mkdirSync(userData, { recursive: true })
const env = { ...process.env, YOYOU_USER_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, '--enable-logging'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env,
  cwd: root
})
let out = ''
const tail = (chunk) => {
  out += chunk.toString()
}
child.stdout.on('data', tail)
child.stderr.on('data', tail)
const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  await Promise.race([
    exited.then((code) => {
      console.log('=== MAIN EXITED code=', code, 'after ~90s window')
      console.log('--- last 6000 chars ---')
      console.log(out.slice(-6000))
      process.exit(0)
    }),
    wait(90_000).then(() => {
      console.log('=== 90 秒内主进程存活（warmFMPool 没崩）')
      console.log('--- last 3000 chars ---')
      console.log(out.slice(-3000))
    })
  ])
} finally {
  try {
    spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
  } catch { /* 忽略 */ }
  setTimeout(() => process.exit(0), 2000)
}
