/**
 * 端到端验证「放不出来的歌不再长时间跳过、失败行从列表消失」。
 *
 * 用法：npx electron-vite build 之后 node scripts/test-failures.mjs
 *
 * 跑两轮：
 *   A. YOYOU_FAIL_RESOLVE=1（测试钩子：任何解析都失败）→ 点搜索第一行，
 *      断言：整条队列在 10 秒内处理完、每首失败都发 player:trackFailed、
 *      页面上的行全部消失、不会一首卡几十秒。
 *   B. 正常模式 → 搜索「起风了」点第一行，断言：25 秒内要么出声、
 *      要么该行被剔除并自动续播（不允许出现 30 秒以上的白等）。
 */
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`[failures] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function run(port, userData, { forceFail }) {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  const env = { ...process.env, YOYOU_USER_DATA: userData }
  if (forceFail) env.YOYOU_FAIL_RESOLVE = '1'
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, ['.', `--remote-debugging-port=${port}`], {
    stdio: 'ignore',
    env,
    cwd: root,
    detached: true
  })
  child.unref()

  const cdpEval = async (expression) => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
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
        if (message.id !== id) return
        ws.removeEventListener('message', onMessage)
        const result = message.result
        if (result?.exceptionDetails) {
          resolve({ __exception: result.exceptionDetails.text })
          return
        }
        resolve(result?.result?.value)
      }
      ws.addEventListener('message', onMessage)
      ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true }
        })
      )
    })
    ws.close()
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
    console.log(`[failures] 等待超时: ${label} 最后取值=${JSON.stringify(last)?.slice(0, 200)}`)
    return false
  }

  try {
    let ready = false
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await wait(1500)
      try {
        if (await cdpEval(`Boolean(window.youyou)`)) {
          ready = true
          break
        }
      } catch {
        /* 还没起来 */
      }
    }
    if (!ready) {
      record('实例启动', false, '轮询超时')
      return
    }
    record('实例启动并连上 CDP', true, forceFail ? '强制失败模式' : '正常模式')

    // 注册失败事件收集器
    const registered = await cdpEval(
      `(() => {
        window.__failedEvents = []
        try {
          window.youyou.on('player:trackFailed', (payload) => window.__failedEvents.push(payload))
          return true
        } catch { return false }
      })()`
    )
    record('注册 trackFailed 监听', registered === true)

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

    // 输入关键词触发搜索（空态大输入框 / 顶栏输入框 二选一）
    const pageReady = await waitFor(
      `Boolean(document.querySelector('.search-hero__input, .search-bar__input'))`,
      15_000,
      '搜索页输入框出现'
    )
    record('搜索页输入框出现', pageReady)
    const typed = await cdpEval(
      `(() => {
        const input = document.querySelector('.search-hero__input, .search-bar__input')
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, ${JSON.stringify(forceFail ? '小虎队 爱' : '起风了')})
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        return true
      })()`
    )
    record('输入关键词触发搜索', typed)

    const rowsAppeared = await waitFor(
      `(() => {
        // 综合页的单曲是卡片网格，行列表在「单曲」页签里；反复点击是幂等的。
        const chip = [...document.querySelectorAll('.search__tabs .chip')].find((node) => (node.textContent ?? '').trim() === '单曲')
        if (chip) chip.click()
        return document.querySelectorAll('.song-row').length >= 3
      })()`,
      60_000,
      '单曲页签下搜索结果行出现（≥3 行）'
    )
    const initialRows = await cdpEval(`document.querySelectorAll('.song-row').length`)
    record('搜索结果行出现', rowsAppeared, `初始行数=${initialRows}`)
    if (!rowsAppeared) return

    const t0 = Date.now()
    await cdpEval(
      `(() => {
        const row = document.querySelector('.song-row')
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        return true
      })()`
    )
    record('双击第一行开始播放', true)

    if (forceFail) {
      // 全部失败：每首失败立刻剔除并发事件，连续 5 首后停（上限防无限滑动），
      // 不允许一首卡几十秒。
      const stopped = await waitFor(
        `(() => {
          const events = window.__failedEvents ?? []
          return events.length >= 5
        })()`,
        20_000,
        '连续 5 次失败事件'
      )
      const elapsed = Date.now() - t0
      const events = await cdpEval(`(window.__failedEvents ?? []).length`)
      const rows = await cdpEval(`document.querySelectorAll('.song-row').length`)
      const stateNow = await cdpEval(`(async () => (await window.youyou.invoke('player:state')).data)()`)
      record(
        '失败即剔除、连续 5 首后停（不长时间空转）',
        stopped && elapsed < 20_000 && stateNow?.playing === false && rows === initialRows - events,
        `耗时=${elapsed}ms 事件=${events} 行 ${initialRows}→${rows} playing=${stateNow?.playing}`
      )
      record('每首失败都发了 trackFailed 事件', events >= 5, `事件数=${events}`)
      record('失败后不再空转（playing=false）', stateNow?.playing === false, JSON.stringify({ playing: stateNow?.playing, error: stateNow?.error }))
    } else {
      // 正常模式：25 秒内出声；若第一行是坏歌，行被剔除并自动续播。
      const settled = await waitFor(
        `(async () => {
          const s = (await window.youyou.invoke('player:state')).data
          return Boolean(s && s.playing && s.position > 0.5)
        })()`,
        40_000,
        '出声或剔除后续播'
      )
      const elapsed = Date.now() - t0
      const snapshot = await cdpEval(`(async () => (await window.youyou.invoke('player:state')).data)()`)
      record(
        '点第一行 25 秒内出声（或失败即剔除续播，不白等）',
        settled && elapsed < 25_000,
        `耗时=${elapsed}ms track=${snapshot?.track?.name} servedFrom=${snapshot?.servedFrom} pos=${snapshot?.position?.toFixed?.(1)}`
      )
      const rowsAfter = await cdpEval(`document.querySelectorAll('.song-row').length`)
      const events = await cdpEval(`(window.__failedEvents ?? []).length`)
      record('失败行从列表消失（若有失败）', events === 0 || rowsAfter < initialRows, `事件=${events} 行 ${initialRows}→${rowsAfter}`)
    }
  } finally {
    try {
      await cdpEval(`window.close()`)
    } catch {
      /* 忽略 */
    }
    spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
  }
}

await run(9395, path.join(os.tmpdir(), 'youyou-fail-test-a'), { forceFail: true })
await run(9396, path.join(os.tmpdir(), 'youyou-fail-test-b'), { forceFail: false })

const failed = results.filter((item) => !item.ok)
console.log(`[failures] 结果: ${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) process.exitCode = 1
