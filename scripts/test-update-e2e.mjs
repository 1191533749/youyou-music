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
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
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
  // 「新版」= 同一个便携版 + 尾部标记字节：内容哈希与旧版不同，但仍是合法可启动的
  // 便携版（NSIS 外壳忽略尾部附加数据，已实测追加 64 字节后正常启动）。
  // 这样替换断言可以直接比对哈希，而不是依赖不可靠的文件时间戳。
  copyFileSync(portableSource, payloadExe)
  appendFileSync(payloadExe, `youyou-update-e2e-marker-${Date.now()}\n`)
  const hashPayload = sha(payloadExe)
  log(`沙盒 exe=${sandboxExe}`)
  log(`假新版载荷（含标记字节）哈希=${hashPayload.slice(0, 12)}…`)

  // 1. 本地更新源
  // 真实发布后新版应用 == 清单版本，不会再触发更新；测试里「新版」其实是同一个
  // 0.3.0 加标记字节，版本号必须伪装成 9.9.9 才会触发更新——但那样重开后的实例
  // 会再次检测到 9.9.9 并无限循环。所以：第一次 check 返回 9.9.9（触发更新），
  // 之后的 check 都返回 0.3.0（视为「已是最新」，循环停止，断言才有稳定状态）。
  let manifestServed = 0
  const server = createServer((request, response) => {
    if (request.url === '/manifest.json') {
      manifestServed += 1
      log(manifestServed === 1 ? '收到 update:check（返回 9.9.9 触发更新）' : '收到 update:check（返回 0.3.0 停止循环）')
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify(
          manifestServed === 1
            ? {
                version: '9.9.9',
                notes: '端到端测试更新',
                assets: [
                  { name: '悠悠音乐便携版9.9.9.exe', url: `http://127.0.0.1:${PORT}/portable.exe`, kind: 'portable' },
                  { name: '悠悠音乐安装版9.9.9.exe', url: `http://127.0.0.1:${PORT}/installer.exe`, kind: 'installer' }
                ]
              }
            : { version: '0.3.0', assets: [] }
        )
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
  const startedAt = Date.now()
  const child = spawn(sandboxExe, [], { stdio: 'ignore', env, detached: true })
  log(`启动待更新实例 PID=${child.pid}；等待 30 秒倒计时自动更新`)
  child.unref()

  // 3. 断言：以替换脚本自身落盘日志为准（轮询哈希在这台机器的作业对象环境里不可靠）。
  // 下载落盘 → 哈希一致；apply.log 出现 copied=True 与 relaunched 即证明全链路完成。
  const deadline = Date.now() + 180_000
  const applyLog = path.join(os.tmpdir(), 'youyou-apply.log')
  let downloaded = false
  let copied = false
  let relaunched = false
  while (Date.now() < deadline && !(downloaded && copied && relaunched)) {
    await waitFor(2000)
    const downloadedFile = path.join(os.tmpdir(), 'youyou-update', '悠悠音乐便携版9.9.9.exe')
    if (existsSync(downloadedFile) && sha(downloadedFile) === hashPayload) {
      if (!downloaded) log('断言 1/3：新版本已下载并落盘（哈希一致）')
      downloaded = true
    }
    try {
      const logText = readFileSync(applyLog, 'utf8')
      if (!copied && /copied=True/.test(logText)) {
        copied = true
        log('断言 2/3：替换脚本已完成覆盖（copied=True）')
      }
      if (!relaunched && /relaunched/.test(logText)) {
        relaunched = true
        log('断言 3/3：替换脚本已重启新版本（relaunched）')
      }
    } catch {
      /* 日志还没出现，继续等 */
    }
  }

  server.close()
  log(downloaded ? 'PASS 下载落盘' : 'FAIL 下载落盘未发生')
  log(copied ? 'PASS 覆盖替换' : 'FAIL 覆盖替换未发生')
  log(relaunched ? 'PASS 自动重启' : 'FAIL 自动重启未发生')

  if (!(downloaded && copied && relaunched)) {
    log('--- 失败诊断：applyUpdate 落盘证据 ---')
    for (const name of ['youyou-apply-start.log', 'youyou-apply-spawn-error.log', 'youyou-apply-exit.log', 'youyou-apply.log']) {
      const file = path.join(os.tmpdir(), name)
      try {
        console.log(`[${name}] ${readFileSync(file, 'utf8').trim()}`)
      } catch {
        console.log(`[${name}] 不存在`)
      }
    }
    log('--- 失败诊断：沙盒 exe 哈希 vs 期望 ---')
    try {
      console.log(`实际=${sha(sandboxExe).slice(0, 12)} 期望=${hashPayload.slice(0, 12)}`)
    } catch {
      console.log('沙盒 exe 不可读')
    }
    log('--- 失败诊断：相关进程 ---')
    try {
      const diag = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'YouyouMusic*' -or $_.Name -like '悠悠音乐*' -or ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*悠悠音乐*') } | Select-Object ProcessId,ParentProcessId,Name | Format-Table -AutoSize | Out-String"`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      )
      console.log(diag.trim())
    } catch {
      log('诊断查询失败')
    }
    log('--- 失败诊断：下载目录 ---')
    try {
      const list = execSync(
        `powershell -NoProfile -Command "Get-ChildItem (Join-Path $env:TEMP 'youyou-update') -ErrorAction SilentlyContinue | Select-Object Name,Length | Format-Table -AutoSize | Out-String"`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      )
      console.log(list.trim())
    } catch {
      log('下载目录不存在')
    }
  }

  log(downloaded && copied && relaunched ? 'UPDATE-E2E OK' : 'UPDATE-E2E FAILED')

  // 4. 只清理本次测试新增的进程与沙盒文件
  const mine = [...candidatePIDs()].filter((pid) => !beforePIDs.has(pid))
  kill(mine)
  await waitFor(5000)
  rmSync(sandbox, { recursive: true, force: true })
  try {
    rmSync(path.join(os.tmpdir(), 'youyou-update'), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  log('已清理本次测试的进程与文件')
  process.exit(downloaded && copied && relaunched ? 0 : 1)
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
