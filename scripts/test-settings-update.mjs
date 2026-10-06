/**
 * 设置页「检测更新」按钮的真实 UI 验证（dev 模式 + CDP 驱动点按）。
 *
 * 流程：
 *  1. 用隔离 userData 启动 dev 实例（--remote-debugging-port）；
 *  2. CDP 点击侧栏「设置」，断言出现「检测更新」按钮；
 *  3. 点击「检测更新」，断言出现「已是最新版本」提示（dev 模式 check 被门控为无更新）。
 *
 * 用法：node scripts/test-settings-update.mjs
 */
import { spawn, execSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9335
const userData = path.join(os.tmpdir(), 'youyou-settings-update-test')

function log(message) {
  console.log(`[ui] ${message}`)
}

async function waitFor(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function cdpEvaluate(expression) {
  const { WebSocket } = globalThis
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  const targets = await response.json()
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error('未找到页面 target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  const evaluate = (expr) =>
    new Promise((resolve) => {
      const id = Math.floor(Math.random() * 1e9)
      const onMessage = (event) => {
        const message = JSON.parse(event.data)
        if (message.id === id) {
          ws.removeEventListener('message', onMessage)
          resolve(message.result)
        }
      }
      ws.addEventListener('message', onMessage)
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
    })
  const result = await evaluate(expression)
  ws.close()
  return result?.result?.value
}

async function main() {
  const env = { ...process.env, KUMONE_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    stdio: 'ignore',
    env,
    cwd: root,
    detached: true
  })
  child.unref()
  log(`dev 实例启动 PID=${child.pid}`)

  // 1. 等页面就绪并切到设置页
  let found = false
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await waitFor(1500)
    try {
      const clicked = await cdpEvaluate(`(() => {
        const links = [...document.querySelectorAll('.sidebar__link')]
        const settings = links.find((link) => link.textContent.includes('设置'))
        if (!settings) return { clicked: false, ready: false }
        settings.click()
        return { clicked: true, ready: true }
      })()`)
      if (clicked?.clicked) {
        found = true
        log('已进入设置页')
        break
      }
    } catch {
      /* retry */
    }
  }
  if (!found) throw new Error('始终没有进入设置页')

  // 2. 断言「检测更新」按钮存在
  await waitFor(1200)
  const hasButton = await cdpEvaluate(`document.body.innerText.includes('检测更新')`)
  log(hasButton ? 'PASS 设置页出现「检测更新」按钮' : 'FAIL 设置页没有「检测更新」按钮')

  // 3. 点击并断言「已是最新版本」提示
  await cdpEvaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')]
    const target = buttons.find((button) => button.textContent.trim() === '检测更新')
    if (target) target.click()
    return Boolean(target)
  })()`)
  await waitFor(2500)
  const latest = await cdpEvaluate(`document.body.innerText.includes('已是最新版本')`)
  log(latest ? 'PASS 点击后出现「已是最新版本」提示' : 'FAIL 点击后没有「已是最新版本」提示')

  // 清理
  try {
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*youyou-settings-update-test*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore' }
    )
  } catch {
    /* ignore */
  }
  process.exit(hasButton && latest ? 0 : 1)
}

main().catch((cause) => {
  console.error(`[ui] 失败: ${cause}`)
  process.exit(1)
})
