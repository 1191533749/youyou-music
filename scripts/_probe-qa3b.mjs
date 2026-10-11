/**
 * 验证 qa-frontend 第 3 批修复 ②③：
 *  A. 搜索页 keep-alive：输入词 → 切到别的页 → 切回搜索 → 输入框内容保留（不重挂载）。
 *  B. 站外曲播放不再对 artist id=-1 发起 artist/-1 请求（主进程 stdout 交给外层重定向后 grep）。
 * 用法：node scripts/_probe-qa3b.mjs （先 npx electron-vite build；端口 9435）
 */
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`[qa3b] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const port = 9435
const userData = path.join(process.env.TEMP ?? os.tmpdir(), 'youyou-qa3b')
fs.rmSync(userData, { recursive: true, force: true })
fs.mkdirSync(userData, { recursive: true })
const env = { ...process.env, YOYOU_USER_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['.', `--remote-debugging-port=${port}`], {
  stdio: 'inherit',
  env,
  cwd: root,
  detached: true
})
child.unref()

let cdpPageWs = null
async function cdpEval(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error('未找到页面 target')
  if (!cdpPageWs || cdpPageWs.url !== page.webSocketDebuggerUrl) {
    if (cdpPageWs) cdpPageWs.close()
    cdpPageWs = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      cdpPageWs.addEventListener('open', () => resolve())
      cdpPageWs.addEventListener('error', reject)
    })
  }
  const value = await new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e9)
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      cdpPageWs.removeEventListener('message', onMessage)
      const result = message.result
      if (result?.exceptionDetails) {
        resolve({ __exception: result.exceptionDetails.text })
        return
      }
      resolve(result?.result?.value)
    }
    cdpPageWs.addEventListener('message', onMessage)
    cdpPageWs.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
  return value
}

const waitFor = async (expression, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await cdpEval(expression)
    if (last === true) return true
    await wait(500)
  }
  console.log(`[qa3b] 等待超时: ${label} 最后取值=${JSON.stringify(last)?.slice(0, 200)}`)
  return false
}

async function killInstance() {
  const ps = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json().catch(() => [])
  // 按端口找到主进程树并结束：命令行不含 userData，直接按调试端口查 PID
  const { execFileSync } = await import('node:child_process')
  try {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Get-CimInstance Win32_Process -Filter "ProcessId = $($c.OwningProcess)" | ForEach-Object { $p = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $c.OwningProcess }; $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue } }`
    ], { stdio: 'ignore' })
  } catch { /* ignore */ }
}

try {
  let ready = false
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await wait(1500)
    try {
      if (await cdpEval(`Boolean(window.youyou)`)) { ready = true; break }
    } catch { /* 还没起来 */ }
  }
  record('实例启动并连上 CDP', ready)

  // 进搜索页
  const nav = await cdpEval(
    `(() => {
      const link = [...document.querySelectorAll('.sidebar__link')].find((node) => (node.textContent ?? '').trim() === '搜索')
      if (!link) return false
      link.click()
      return true
    })()`
  )
  record('侧栏进入搜索页', nav)

  const inputReady = await waitFor(
    `Boolean(document.querySelector('.search-hero__input, .search-bar__input'))`,
    15_000, '搜索页输入框出现'
  )
  record('搜索页输入框出现', inputReady)

  // 输入关键词（不回车，纯输入状态保留测试）
  const typed = await cdpEval(
    `(() => {
      const input = document.querySelector('.search-hero__input, .search-bar__input')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '晴天')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return input.value
    })()`
  )
  record('输入关键词', typed === '晴天')

  // 切到首页再切回搜索
  const away = await cdpEval(
    `(() => {
      const link = [...document.querySelectorAll('.sidebar__link')].find((node) => (node.textContent ?? '').trim() === '首页')
      if (!link) return false
      link.click()
      return true
    })()`
  )
  await wait(1200)
  const back = await cdpEval(
    `(() => {
      const link = [...document.querySelectorAll('.sidebar__link')].find((node) => (node.textContent ?? '').trim() === '搜索')
      if (!link) return false
      link.click()
      return true
    })()`
  )
  const preserved = await waitFor(
    `(() => {
      const input = document.querySelector('.search-hero__input, .search-bar__input')
      return input ? input.value === '晴天' : false
    })()`,
    8_000, '切回搜索后输入词保留'
  )
  record('搜索页 keep-alive：切走再切回输入词保留', away && back && preserved)

  // B. 站外音源播放 + artist/-1 请求检查（汽水，与网易云限流无关）
  const searched = await cdpEval(
    `window.youyou.invoke('search:external', { source: 'qishui', keywords: '晴天', limit: 10 }).then((r) => ({ count: Array.isArray(r?.data) ? r.data.length : -1 })).catch((e) => ({ err: String(e?.message ?? e) }))`
  )
  if (searched?.count > 0) {
    const played = await cdpEval(
      `window.youyou.invoke('search:external', { source: 'qishui', keywords: '晴天', limit: 10 }).then(async (r) => window.youyou.invoke('player:playExternal', { item: r.data[0] })).then(() => true).catch((e) => 'err:' + String(e?.message ?? e))`
    )
    record('playExternal 发起', played === true, played === true ? '' : String(played))
    const playing = await waitFor(
      `window.youyou.invoke('player:state').then((s) => s?.data?.playing === true)`,
      30_000, '外部曲目出声'
    )
    record('外部曲目出声', playing)
    if (playing) await wait(4000) // 留时间让 artistPic 预取逻辑（若误发）出现在日志里
  } else {
    record('search:external 汽水搜索', false, JSON.stringify(searched))
  }
} finally {
  await killInstance()
  cdpPageWs?.close()
  const passed = results.filter((r) => r.ok).length
  console.log(`[qa3b] 汇总 ${passed}/${results.length}`)
  process.exit(passed === results.length ? 0 : 1)
}
