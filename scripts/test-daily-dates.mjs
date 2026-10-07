/**
 * 每日推荐日期条「无阴影」验证：读取真实计算样式，确认没有阴影/毛玻璃灰晕。
 *
 * 用法：npx electron-vite build 之后 node scripts/test-daily-dates.mjs
 */
import { spawn, execSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9341
const userData = path.join(os.tmpdir(), 'youyou-daily-dates-test')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[daily-dates] ${message}`)

async function cdp(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error('未找到页面 target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', reject)
  })
  const value = await new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e9)
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id === id) {
        ws.removeEventListener('message', onMessage)
        resolve(message.result?.result?.value)
      }
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
  })
  ws.close()
  return value
}

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
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
  log(`dev 实例 PID=${child.pid}`)

  try {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await wait(1500)
      try {
        if (await cdp(`Boolean(document.querySelector('.sidebar__link'))`)) break
      } catch {
        /* 还没起来 */
      }
    }
    // 进入每日推荐
    await cdp(`(() => {
      const link = [...document.querySelectorAll('.sidebar__link')].find((item) => item.textContent.includes('每日推荐'))
      if (link) link.click()
      return Boolean(link)
    })()`)
    await wait(4000)

    const styles = await cdp(`(() => {
      const days = [...document.querySelectorAll('.daily-dates__day')]
      return days.slice(0, 8).map((day) => {
        const computed = getComputedStyle(day)
        return {
          text: day.textContent.trim(),
          boxShadow: computed.boxShadow,
          backdrop: computed.backdropFilter || computed.webkitBackdropFilter,
          filter: computed.filter,
          background: computed.backgroundColor
        }
      })
    })()`)

    if (!Array.isArray(styles) || styles.length === 0) {
      record('找到日期条', false, '页面上没有 .daily-dates__day')
    } else {
      record('找到日期条', true, `${styles.length} 个：${styles.map((item) => item.text).join(' ')}`)
      const shadowed = styles.filter((item) => item.boxShadow && item.boxShadow !== 'none')
      record('日期条没有阴影', shadowed.length === 0, shadowed.length === 0 ? '全部 box-shadow = none' : JSON.stringify(shadowed.slice(0, 2)))
      const blurred = styles.filter((item) => item.backdrop && item.backdrop !== 'none')
      record(
        '日期条没有毛玻璃模糊（避免灰晕）',
        blurred.length === 0,
        blurred.length === 0 ? '全部 backdrop-filter = none' : JSON.stringify(blurred.slice(0, 2))
      )
    }
  } catch (cause) {
    record('测试执行异常', false, String(cause).slice(0, 160))
  } finally {
    try {
      execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*youyou-daily-dates-test*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'ignore' }
      )
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((item) => !item.ok)
  log(failed.length === 0 ? 'DAILY-DATES OK' : `DAILY-DATES FAILED (${failed.length}/${results.length})`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((cause) => {
  console.error(`[daily-dates] 失败: ${cause}`)
  process.exit(1)
})
