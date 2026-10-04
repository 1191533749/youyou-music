/**
 * Headless smoke test.
 *
 * Boots the built app with `KUMONE_SMOKE_TEST=1`, which makes `src/main/index.ts`
 * drive the real window through its own IPC channels and exit non-zero on the
 * first wiring mistake. Electron has to run from a script rather than a shell
 * one-liner so the environment variable is set the same way on every platform
 * (and so the exit code survives the pipe).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

/**
 * The `electron` npm package's main entry is a CommonJS shim that reports the
 * binary path; importing it from ESM trips on its `process.exports` handling.
 * Reading the path file directly is what that shim does internally.
 */
function electronBinary() {
  const directory = path.join(process.cwd(), 'node_modules', 'electron')
  const candidates = [
    path.join(directory, 'dist', 'electron.exe'),
    path.join(directory, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    path.join(directory, 'dist', 'electron')
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error(`找不到 Electron 二进制，请先运行 npm install（查找目录: ${directory}）`)
  }
  return found
}

const env = { ...process.env, KUMONE_SMOKE_TEST: '1', ELECTRON_ENABLE_LOGGING: '1' }
// A leftover ELECTRON_RUN_AS_NODE (easy to leave behind while probing electron
// with plain Node) makes Electron run as Node, where `require('electron')`
// resolves to a path string and the app dies on `app.requestSingleInstanceLock`.
delete env.ELECTRON_RUN_AS_NODE
// Isolated profile: the check must not touch the real login, and a stale
// single-instance lock left by a killed run must not make it exit silently.
env.KUMONE_USER_DATA = mkdtempSync(path.join(tmpdir(), 'kumone-smoke-'))

const child = spawn(electronBinary(), ['.'], {
  stdio: 'inherit',
  env,
  windowsHide: true
})

child.on('exit', (code) => {
  process.exit(code ?? 1)
})

child.on('error', (error) => {
  console.error('无法启动 Electron:', error.message)
  process.exit(1)
})
