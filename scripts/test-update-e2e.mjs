/**
 * 更新链路端到端实测（不需要 GitHub，本地假更新源）。
 *
 * 走**倒计时自动更新**主路径：
 *  1. 本地 HTTP 服务：/manifest.json 声称版本 9.9.9，资产给 0.3.0 便携版拷贝；
 *  2. 把 0.3.0 便携版拷到沙盒目录，带 KUMONE_UPDATE_URL + 隔离 userData 启动；
 *  3. 等弹窗 30 秒倒计时走完自动触发 update:install；
 *  4. 断言：沙盒 exe 被替换为「新版」文件（哈希一致）→ 新实例自动启动
 *     （以「测试启动后新增且持续存活的相关进程」判定，避免误伤用户正常实例）。
 *
 * 用法：node scripts/test-update-e2e.mjs
 */
import { createServer } from 'node:http'
import { copyFileSync, createReadStream, existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn, execSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import process from 'node:process'

const root = process.cwd()
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
const portableSource = path.join(root, 'release', `悠悠音乐便携版${version}.exe`)
if (!existsSync(portableSource)) {
  console.error('缺少便携版产物，先跑 node scripts/package.mjs')
  process.exit(1)
}

const sandbox = path.join(os.tmpdir(), `youyou-update-e2e-${Date.now()}`)
const sandboxExe = path.join(sandbox, `悠悠音乐便携版${version}.exe`)
const payloadExe = path.join(sandbox, 'payload', '悠悠音乐便携版9.9.9.exe')
const userData = path.join(sandbox, 'user-data')
const PORT = 18765

function sha(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function log(message) {
  console.log(`[e2e] ${message}`)
}

async function waitFor(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/** 全部「悠悠音乐相关」进程 PID（内层 YouyouMusic.exe + 便携版外壳）。 */
function candidatePIDs() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'YouyouMusic*' -or $_.Name -like '悠悠音乐*' } | ForEach-Object { $_.ProcessId }"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    return new Set(out.split(/\s+/).map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0))
  } catch {
    return new Set()
  }
}

function kill(pidSet) {
  for (const pid of pidSet) {
    try {
      process.kill(pid)
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  // 沙盒目录每次运行都换新名（时间戳），旧目录即使被残留进程锁住也不影响本轮；
  // 顺手清一次旧目录（best-effort，锁住的跳过）。
  killSandboxProcesses()
  await waitFor(3000)
  cleanupOldSandboxes()

  const beforePIDs = candidatePIDs()
  mkdirSync(path.join(sandbox, 'payload'), { recursive: true })
  copyFileSync(portableSource, sandboxExe)
  copyFileSync(portableSource, payloadExe)
  const hashPayload = sha(payloadExe)
  log(`沙盒 exe=${sandboxExe}`)
  log(`假新版载荷哈希=${hashPayload.slice(0, 12)}…`)

  // 1. 本地更新源
  const server = createServer((request, response) => {
    if (request.url === '/manifest.json') {
      log('收到 update:check')
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          version: '9.9.9',
          notes: '端到端测试更新',
          assets: [
            { name: '悠悠音乐便携版9.9.9.exe', url: `http://127.0.0.1:${PORT}/portable.exe`, kind: 'portable' },
            { name: '悠悠音乐安装版9.9.9.exe', url: `http://127.0.0.1:${PORT}/installer.exe`, kind: 'installer' }
          ]
        })
      )
      return
    }
    if (request.url === '/portable.exe' || request.url === '/installer.exe') {
      log(`收到下载: ${request.url}`)
      const stream = createReadStream(payloadExe)
      stream.pipe(response)
      stream.on('error', () => response.destroy())
      return
    }
    response.statusCode = 404
    response.end()
  })
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))
  log(`本地更新源 http://127.0.0.1:${PORT}`)

  // 2. 启动待更新的便携版（隔离 userData；弹窗 30 秒倒计时会自动触发安装）
  const env = { ...process.env, KUMONE_UPDATE_URL: `http://127.0.0.1:${PORT}/manifest.json`, KUMONE_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(sandboxExe, [], { stdio: 'ignore', env, detached: true })
  log(`启动待更新实例 PID=${child.pid}；等待 30 秒倒计时自动更新`)
  child.unref()

  // 3. 断言：替换 + 自动重启（最迟 180 秒）
  const deadline = Date.now() + 180_000
  let replaced = false
  let relaunched = false
  while (Date.now() < deadline && !(replaced && relaunched)) {
    await waitFor(2000)
    if (existsSync(sandboxExe) && sha(sandboxExe) === hashPayload) {
      if (!replaced) log('断言 1/2：沙盒 exe 已被替换为「新版」文件')
      replaced = true
    }
    const fresh = [...candidatePIDs()].filter((pid) => !beforePIDs.has(pid))
    if (fresh.length > 0 && replaced) {
      // 连续两次采样都在，才算「存活」而不是启动瞬间的闪退
      await waitFor(2000)
      const stillAlive = [...candidatePIDs()].filter((pid) => !beforePIDs.has(pid))
      if (stillAlive.length > 0) {
        if (!relaunched) log(`断言 2/2：新实例已自动启动（新增进程 ${stillAlive.join(',')} 持续存活）`)
        relaunched = true
      }
    }
  }

  server.close()
  log(replaced ? 'PASS 覆盖替换' : 'FAIL 覆盖替换未发生')
  log(relaunched ? 'PASS 自动重启' : 'FAIL 自动重启未发生')
  log(replaced && relaunched ? 'UPDATE-E2E OK' : 'UPDATE-E2E FAILED')

  // 4. 只清理本次测试新增的进程与沙盒文件
  const mine = [...candidatePIDs()].filter((pid) => !beforePIDs.has(pid))
  kill(mine)
  await waitFor(5000)
  rmSync(sandbox, { recursive: true, force: true })
  log('已清理本次测试的进程与文件')
  process.exit(replaced && relaunched ? 0 : 1)
}

function cleanupOldSandboxes() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-ChildItem $env:TEMP -Directory -Filter 'youyou-update-e2e*' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    for (const dir of out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      if (dir === sandbox) continue
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 被锁住的旧目录留着无妨 */
      }
    }
  } catch {
    /* ignore */
  }
}

function killSandboxProcesses() {
  // 杀光所有与沙盒目录相关的进程（外壳 exe 路径、内层命令行、内层解压目录都可能引用）。
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.CommandLine -like '*youyou-update-e2e*' -or $_.ExecutablePath -like '*youyou-update-e2e*') -and $_.ProcessId -ne $PID } | ForEach-Object { $_.ProcessId }"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const stale = out.split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0)
    for (const pid of stale) {
      try {
        process.kill(pid)
      } catch {
        /* already gone */
      }
    }
    if (stale.length > 0) log(`清理遗留沙盒进程: ${stale.join(',')}`)
  } catch {
    /* ignore */
  }
}

main().catch((cause) => {
  console.error(`[e2e] 失败: ${cause}`)
  process.exit(1)
})
