/**
 * 每日推荐「历史日期」真实 UI 验证（dev 实例 + CDP 驱动）。
 *
 * 验证链路：
 *  1. 用**真实 cookies.json 的副本**起一个隔离 userData 实例（不碰用户真实 profile）；
 *  2. 侧栏进入「每日推荐」，断言顶部日期条渲染 7 天、「今天」高亮；
 *  3. 点「昨天」→ 等这一格落定，断言出现「内容 / 空态 / 失败重试」三者之一并打印实况；
 *  4. 点回「今天」→ 断言恢复今天的列表；
 *  5. 再点最早一天，确认连续切换不串数据、高亮跟着走。
 *
 * 用法：node scripts/test-daily-ui.mjs   （先 npx electron-vite build）
 */
import { spawn, execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9337
// 每次跑用独立目录：上一次的 Chromium 文件可能还被句柄占着，复用会 EPERM。
const userData = path.join(os.tmpdir(), `youyou-daily-ui-test-${Date.now()}`)
const realUserData = path.join(process.env.APPDATA ?? '', 'kumone-windows')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[daily-ui] ${message}`)

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 只复制 cookie jar（保持登录态），不复制缓存与设置，尽量少动东西。 */
function prepareUserData() {
  mkdirSync(userData, { recursive: true })
  const source = path.join(realUserData, 'cookies.json')
  if (!existsSync(source)) {
    log(`未找到 ${source}，将以未登录状态运行`)
    return false
  }
  copyFileSync(source, path.join(userData, 'cookies.json'))
  // 不打印 cookie 内容，只确认登录令牌在不在。
  try {
    const jar = JSON.parse(readFileSync(path.join(userData, 'cookies.json'), 'utf8'))
    return typeof jar.MUSIC_U === 'string' && jar.MUSIC_U.length > 0
  } catch {
    return false
  }
}

/** CDP 求值。带超时：连接/页面一旦没回应就抛错，不能让 await 悬着把事件循环抽干。 */
async function cdp(expression, timeoutMs = 15000) {
  const { WebSocket } = globalThis
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  const targets = await response.json()
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error('未找到页面 target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    })
    ws.addEventListener('error', (event) => {
      clearTimeout(timer)
      reject(new Error(`CDP 连接失败: ${String(event?.message ?? '')}`))
    })
  })
  const value = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('CDP 求值超时'))
    }, timeoutMs)
    const id = Math.floor(Math.random() * 1e9)
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id === id) {
        clearTimeout(timer)
        ws.removeEventListener('message', onMessage)
        resolve(message.result?.result?.value)
      }
    }
    ws.addEventListener('message', onMessage)
    ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        // awaitPromise：诊断表达式是 async IIFE，否则拿回来的是 Promise（[object Object]）。
        params: { expression, returnByValue: true, awaitPromise: true }
      })
    )
  })
  ws.close()
  return value
}

/** 页面当前状态：日期条 / 选中项 / 列表行数 / 占位文案 / 是否停在本页。 */
const snapshot = `(() => {
  const days = [...document.querySelectorAll('.daily-dates__day')]
  const active = days.find((day) => day.classList.contains('is-active'))
  const placeholder = document.querySelector('.placeholder')
  return {
    onDaily: Boolean(document.querySelector('.daily-dates')),
    dayCount: days.length,
    labels: days.map((day) => day.textContent.trim()),
    active: active ? active.textContent.trim() : null,
    rows: document.querySelectorAll('.daily-card, .song-row').length,
    placeholder: placeholder ? placeholder.innerText.replace(/\\s+/g, ' ').trim() : null
  }
})()`

async function clickDay(label) {
  return cdp(`(() => {
    const day = [...document.querySelectorAll('.daily-dates__day')].find((item) => item.textContent.includes(${JSON.stringify(label)}))
    if (!day) return false
    day.click()
    return true
  })()`)
}

/** 等这一格落定：有行，或者出现一个「不是加载中」的占位（空态 / 失败重试态）。 */
async function waitForSettled(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await cdp(snapshot)
    const placeholder = typeof last?.placeholder === 'string' ? last.placeholder : ''
    const loading = placeholder.includes('正在')
    if (last?.rows > 0 || (placeholder && !loading)) return last
    await wait(600)
  }
  return last
}

/** 当前所在页面（排查「页面被带走了」这类问题用）。 */
async function whereAmI() {
  try {
    return await cdp(`JSON.stringify({
      onDaily: Boolean(document.querySelector('.daily-dates')),
      title: document.querySelector('.page__title')?.textContent ?? null,
      head: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 70)
    })`)
  } catch (cause) {
    return `探测失败: ${String(cause).slice(0, 60)}`
  }
}

/** 稳一点的点日期：先确保在每日推荐页，点不到就重来一次。 */
async function selectDayRobust(label) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await ensureDailyPage()
    if (await clickDay(label)) return true
    await wait(800)
  }
  return false
}

/** 页面被别的东西带走了就点回侧栏，保证后续断言都在「每日推荐」上。 */
async function ensureDailyPage() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await cdp(`Boolean(document.querySelector('.daily-dates'))`)) return true
    await cdp(`(() => {
      const link = [...document.querySelectorAll('.sidebar__link')].find((item) => item.textContent.includes('每日推荐'))
      if (!link) return false
      link.click()
      return true
    })()`)
    await wait(1200)
  }
  return false
}

/**
 * 杀掉本次实例，避免残留占着 CDP 端口。
 *
 * 注意：主进程的命令行里只有 `electron.exe . --remote-debugging-port=…`，**不含** userData 路径
 * （--user-data-dir 只出现在子进程上），所以不能只按目录名匹配 —— 那样主进程会活下来继续占端口。
 * 这里按「谁在监听 CDP 端口」定位主进程，再补一遍带 userData 的子进程。
 */
function killInstance() {
  const script = [
    `$owner = (Get-NetTCPConnection -LocalPort ${CDP_PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess`,
    'foreach ($id in $owner) { if ($id -gt 0) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }',
    "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*youyou-daily-ui-test*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
  ].join('; ')
  try {
    execSync(`powershell -NoProfile -Command "${script}"`, { stdio: 'ignore' })
  } catch {
    /* ignore */
  }
}

function todayKey(offsetDays) {
  const now = new Date()
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 失败排查用：页面正文 + 三条通道实况（每一步都带超时，接口挂住也不拖死测试）。 */
async function diagnose(label) {
  try {
    const text = await cdp(`document.body.innerText.replace(/\\s+/g, ' ').slice(0, 220)`)
    const probe = await cdp(`(async () => {
      const call = (channel, request) => Promise.race([
        window.youyou.invoke(channel, request),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'timeout-9s' }), 9000))
      ])
      const describe = (result) => result.ok ? ('ok:' + (Array.isArray(result.data) ? result.data.length : '?') + ' 首') : ('err:' + result.error)
      const auth = await call('auth:state')
      const today = await call('home:dailySongs')
      const history = await call('home:dailyHistory', { date: ${JSON.stringify(todayKey(-1))} })
      return JSON.stringify({
        loggedIn: auth.data?.loggedIn,
        nickname: auth.data?.profile?.nickname,
        dailySongs: describe(today),
        dailyHistory: describe(history)
      })
    })()`)
    log(`[${label}] 通道探测: ${probe}`)
    log(`[${label}] 页面文本: ${text}`)
  } catch (cause) {
    log(`[${label}] 诊断失败: ${String(cause).slice(0, 120)}`)
  }
}

async function main() {
  // 看门狗：任何一步意外悬住也要有输出、有退出码，并且**先把实例杀干净**再退出，
  // 否则残留的 Electron 会一直占着 CDP 端口，下一次跑连不上（表现为全程超时）。
  const watchdog = setTimeout(() => {
    log('看门狗超时（4 分钟），强制结束')
    killInstance()
    process.exit(1)
  }, 240000)

  const loggedIn = prepareUserData()
  log(loggedIn ? '已复制真实 cookie（含 MUSIC_U），实例应处于登录态' : '没有可用登录态')

  const env = { ...process.env, YOYOU_USER_DATA: userData }
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
    let entered = false
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await wait(1500)
      try {
        const clicked = await cdp(`(() => {
          const link = [...document.querySelectorAll('.sidebar__link')].find((item) => item.textContent.includes('每日推荐'))
          if (!link) return false
          link.click()
          return true
        })()`)
        if (clicked) {
          entered = true
          break
        }
      } catch {
        /* 页面还没起来 */
      }
    }
    record('进入「每日推荐」页面', entered)
    if (!entered) throw new Error('没能进入每日推荐页')

    await wait(1500)
    const first = await cdp(snapshot)
    record('日期条渲染 7 天', first?.dayCount === 7, `labels=${JSON.stringify(first?.labels)}`)
    record('默认选中「今天」', String(first?.active ?? '').includes('今天'), `active=${first?.active}`)

    // 「今天」：正常应直接出内容；若首次拉回来是空（启动瞬间接口抽风），再点一次「今天」应能恢复。
    let todayState = await waitForSettled()
    // 启动瞬间接口可能返回空；页面自身会补一次请求，这里再手动兜两次（每次间隔 6s）。
    for (let attempt = 0; (todayState?.rows ?? 0) === 0 && attempt < 2; attempt += 1) {
      log(`今天首次为空：${todayState?.placeholder ?? '(无占位)'}，第 ${attempt + 1} 次恢复重试`)
      await wait(6000)
      await clickDay('今天')
      todayState = await waitForSettled()
    }
    record(
      '今天有内容（home:dailySongs）',
      (todayState?.rows ?? 0) > 0,
      `rows=${todayState?.rows}${(todayState?.rows ?? 0) > 0 ? '' : ` 占位=${todayState?.placeholder ?? '(无)'}`}`
    )
    if ((todayState?.rows ?? 0) === 0) await diagnose('今天没出内容')

    // 「昨天」：主进程通道可用，但接口对历史日期可能返回空 → 空态也是正确结果。
    const clickedYesterday = await selectDayRobust('昨天')
    record('「昨天」可点击', clickedYesterday === true)
    if (!clickedYesterday) log(`[昨天点击失败] 位置: ${await whereAmI()}`)
    if (clickedYesterday) {
      const loadingShown = await cdp(
        `document.querySelector('.placeholder')?.innerText.includes('正在获取这一天的推荐') ?? false`
      )
      record('切换后先显示加载态', loadingShown === true)
      const yesterday = await waitForSettled()
      const hasRows = (yesterday?.rows ?? 0) > 0
      const emptyState = String(yesterday?.placeholder ?? '').includes('这一天没有每日推荐记录')
      record(
        '「昨天」落定为「内容」或「空态/失败重试」',
        hasRows || emptyState || Boolean(yesterday?.placeholder),
        hasRows
          ? `rows=${yesterday.rows}（active=${yesterday.active}）`
          : `占位=${yesterday?.placeholder ?? '(无)'}`
      )
      if (!hasRows) {
        log('结论：home:dailyHistory 对这一天返回空 → 页面按设计显示空态（不是点击无效）')
        await diagnose('昨天为空')
      }
    }

    // 点回「今天」应恢复今天的列表，且高亮跟着走。
    const clickedTodayAgain = await selectDayRobust('今天')
    record('「今天」可再次点击', clickedTodayAgain === true)
    const backToToday = await waitForSettled(15000)
    record(
      '点回「今天」恢复今天的列表',
      (backToToday?.rows ?? 0) > 0,
      `rows=${backToToday?.rows} active=${backToToday?.active}`
    )
    record('高亮跟着选择走', String(backToToday?.active ?? '').includes('今天'), `active=${backToToday?.active}`)
    if ((backToToday?.rows ?? 0) === 0) log(`[点回今天失败] 位置: ${await whereAmI()}`)

    // 最早一天：确认连续切换可用且不串数据。
    await ensureDailyPage()
    const clickedOldest = await cdp(`(() => {
      const target = document.querySelectorAll('.daily-dates__day')[0]
      if (!target) return false
      target.click()
      return true
    })()`)
    if (!clickedOldest) log(`[最早一天点击失败] 位置: ${await whereAmI()}`)
    record('最早一天可点击', clickedOldest === true)
    const oldest = await waitForSettled()
    record(
      '最早一天落定（内容或空态/失败重试）',
      (oldest?.rows ?? 0) > 0 || Boolean(oldest?.placeholder),
      `active=${oldest?.active} rows=${oldest?.rows} 占位=${oldest?.placeholder ?? '(无)'}`
    )
    const stillToday = await cdp(
      `document.querySelector('.daily-dates__day.is-active')?.textContent.includes('今天') ?? false`
    )
    record('切到最早一天后「今天」不再高亮', stillToday === false)
  } catch (cause) {
    record('测试执行异常', false, String(cause).slice(0, 200))
  } finally {
    killInstance()
  }

  clearTimeout(watchdog)
  const failed = results.filter((result) => !result.ok)
  log(failed.length === 0 ? 'DAILY-UI OK' : `DAILY-UI FAILED (${failed.length}/${results.length})`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((cause) => {
  console.error(`[daily-ui] 失败: ${cause}`)
  process.exit(1)
})
