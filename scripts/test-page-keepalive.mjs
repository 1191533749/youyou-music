/**
 * 页面常驻（keep-alive）验证：切走再切回时，页面内容与 DOM 节点都还在、不重新加载。
 *
 * 用法：node scripts/test-page-keepalive.mjs
 */
import { spawn, execSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9338
const userData = path.join(os.tmpdir(), 'youyou-keepalive-test')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[keepalive] ${message}`)

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

const snapshot = (label) =>
  cdp(`(() => {
    const slots = [...document.querySelectorAll('.page-slot')]
    const visible = slots.filter((slot) => !slot.hasAttribute('hidden'))
    return {
      label: ${JSON.stringify(label)},
      slots: slots.length,
      visibleSlots: visible.length,
      visibleFirstText: (visible[0]?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 40),
      visibleRows: visible[0]?.querySelectorAll('.song-row, .card, .listener, .home-date').length ?? 0,
      hasPlaceholder: Boolean(visible[0]?.querySelector('.placeholder, .page__empty'))
    }
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
    // 等应用起来
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await wait(1500)
      try {
        if (await cdp(`Boolean(document.querySelector('.sidebar__link'))`)) break
      } catch {
        /* 还没起来 */
      }
    }

    // 在首页拿到一个可标记的 DOM 节点，用来判断是否被重新挂载
    await wait(3000)
    await cdp(`(() => {
      const first = document.querySelector('.page-slot')
      if (first) first.dataset.probe = 'home-node-1'
      return true
    })()`)

    // 切到发现（会挂第二个 slot），再切回首页
    await clickNav('发现')
    await wait(2500)
    const atExplore = await snapshot('发现')
    record('切到「发现」后有内容', Number(atExplore?.visibleRows) > 0 || String(atExplore?.visibleFirstText).length > 0, `${atExplore?.visibleFirstText}`)

    await clickNav('首页')
    await wait(300)
    const backHomeFast = await snapshot('首页(切回 300ms 后)')
    record(
      '切回「首页」300ms 内已有内容（无骨架/空白）',
      Number(backHomeFast?.visibleRows) > 0 && backHomeFast?.hasPlaceholder === false,
      `可见行 ${backHomeFast?.visibleRows} · 首行文本「${backHomeFast?.visibleFirstText}」`
    )

    const keptNode = await cdp(`Boolean(document.querySelector('.page-slot[data-probe="home-node-1"]'))`)
    record('首页 DOM 节点被保留（未重新挂载）', keptNode === true)

    const slots = await cdp(`document.querySelectorAll('.page-slot').length`)
    record('常驻槽位按访问顺序累积', Number(slots) >= 2, `slot 数=${slots}`)

    // 逐个切一遍侧栏页面，确认都能正常显示（不会因为常驻而白屏）
    for (const label of ['我的音乐', '每日推荐', '私人漫游', '云盘', '设置']) {
      await clickNav(label)
      await wait(1800)
      const state = await snapshot(label)
      record(`切到「${label}」可见内容`, Number(state?.visibleSlots) === 1 && String(state?.visibleFirstText).length > 0, state?.visibleFirstText)
    }
  } catch (cause) {
    record('测试执行异常', false, String(cause).slice(0, 160))
  } finally {
    try {
      execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*youyou-keepalive-test*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'ignore' }
      )
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((item) => !item.ok)
  log(failed.length === 0 ? 'KEEPALIVE-UI OK' : `KEEPALIVE-UI FAILED (${failed.length}/${results.length})`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((cause) => {
  console.error(`[keepalive] 失败: ${cause}`)
  process.exit(1)
})
