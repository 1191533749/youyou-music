/**
 * 验证：除搜索页外，任何页面都不显示搜索框；侧边栏有「搜索」入口；
 * 搜索页只有一个输入框且可正常搜索。
 *
 * 用法：npx electron-vite build 之后 node scripts/test-top-search.mjs
 */
import { spawn, execSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9344
const userData = path.join(os.tmpdir(), 'youyou-topsearch-test')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[topsearch] ${message}`)

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

const clickNav = (label) =>
  cdp(`(() => {
    const link = [...document.querySelectorAll('.sidebar__link')].find((item) => item.textContent.includes(${JSON.stringify(label)}))
    if (!link) return false
    link.click()
    return true
  })()`)

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
    await wait(2500)

    // 1) 每个侧栏页面都不显示搜索框
    for (const label of ['首页', '发现', '我的音乐', '每日推荐', '私人漫游', '一起听', '云盘']) {
      await clickNav(label)
      await wait(1200)
      const visible = await cdp(`(() => {
        const box = document.querySelector('.top-search')
        if (!box) return 'none'
        return getComputedStyle(box).display === 'none' || box.closest('.top-row') === null ? 'hidden' : 'visible'
      })()`)
      record(`「${label}」不显示搜索框`, visible !== 'visible', `top-search=${visible}`)
    }

    // 2) 侧边栏有「搜索」入口
    const hasSearchEntry = await cdp(`[...document.querySelectorAll('.sidebar__link')].some((item) => item.textContent.includes('搜索'))`)
    record('侧边栏有「搜索」入口', hasSearchEntry === true)

    // 3) 点「搜索」进搜索页：只有一个输入框，且自动聚焦
    await clickNav('搜索')
    await wait(1500)
    const onSearch = await cdp(`(() => {
      const inputs = [...document.querySelectorAll('input')].filter((el) => el.type === 'text' || el.type === 'search')
      const visibleInputs = inputs.filter((el) => el.offsetParent !== null)
      return {
        total: inputs.length,
        visible: visibleInputs.length,
        focused: document.activeElement?.className === 'top-search__input'
      }
    })()`)
    record('搜索页只有一个输入框', onSearch?.visible === 1, `可见=${onSearch?.visible} 总数=${onSearch?.total}`)
    record('进入搜索页输入框自动聚焦', onSearch?.focused === true)

    // 4) 输入回车能出结果
    await cdp(`(() => {
      const input = document.querySelector('.top-search__input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '孤勇者')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)
    let rows = 0
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(800)
      rows = Number(await cdp(`document.querySelectorAll('.song-row').length`)) || 0
      if (rows > 0) break
    }
    record('搜索「孤勇者」出结果', rows > 0, `${rows} 行`)

    // 5) 离开搜索页后其他页面依然没有搜索框
    await clickNav('首页')
    await wait(1200)
    const backHome = await cdp(`document.querySelector('.top-search') === null`)
    record('离开搜索页后首页仍无搜索框', backHome === true)
  } catch (cause) {
    record('测试执行异常', false, String(cause).slice(0, 160))
  } finally {
    try {
      execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*youyou-topsearch-test*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'ignore' }
      )
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((item) => !item.ok)
  log(failed.length === 0 ? 'TOP-SEARCH OK' : `TOP-SEARCH FAILED (${failed.length}/${results.length})`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((cause) => {
  console.error(`[topsearch] 失败: ${cause}`)
  process.exit(1)
})
