/**
 * 诊断启动：像 smoke 一样以 inherit 方式跑应用（控制台输出可见），但不进入冒烟模式。
 * 用完即删。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

function electronBinary() {
  const directory = path.join(process.cwd(), 'node_modules', 'electron')
  const candidates = [path.join(directory, 'dist', 'electron.exe')]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error('找不到 Electron')
  return found
}

const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
delete env.ELECTRON_RUN_AS_NODE
delete env.KUMONE_SMOKE_TEST
delete env.KUMONE_USER_DATA

const child = spawn(electronBinary(), ['.'], { stdio: 'inherit', env })
const killer = setTimeout(() => child.kill(), 20_000)
child.on('exit', (code) => {
  clearTimeout(killer)
  console.log(`[diag] electron 退出，code=${code}`)
  process.exit(0)
})
child.on('error', (error) => {
  clearTimeout(killer)
  console.error('[diag] 启动失败:', error.message)
  process.exit(1)
})
