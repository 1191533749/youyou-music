/**
 * 0.4.1 优化第 2/6/8 项的真机验证（CDP）：
 *  A. 每日推荐「昨天」能读回本地快照（网易云历史接口已死，靠本地 daily-history 落盘）；
 *  B. 队列为空时点播放按钮 → 立即从今日推荐随机播一首；
 *  C. 播放开始后 muted=false（版权提示音检测的静音要还原，第 8 项的副作用检查）。
 *
 * 用法：npx electron-vite build 之后 node scripts/test-optimize.mjs
 * 说明：复制真实配置到临时目录（YOYOU_USER_DATA），删掉 settings.json 保证空队列；
 *      所有弹窗由页面内 watchdog 自动点击，不需要人工介入。
 */
import { spawn, execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9347
const tmpProfile = path.join(os.tmpdir(), 'youyou-optimize-test')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[optimize] ${message}`)

function localDateKey(offsetDays = 0) {
  const date = new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000)
  const pad = (v) => String(v).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

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
    // awaitPromise 必须为 true：否则 async 表达式只会拿回一个 Promise 对象。
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

/** 页面内 watchdog：所有「确定/知道了/关闭/重试」类弹窗按钮每 2.5s 自动点一次。 */
const installDialogWatchdog = () =>
  cdp(`(() => {
    if (window.__youyouWatchdog) return true
    window.__youyouWatchdog = setInterval(() => {
      try {
        const button = [...document.querySelectorAll('.dialog button, .modal button, [role="dialog"] button, .toast button')]
          .find((item) => /确定|知道了|关闭|取消|重试|稍后/.test(item.textContent ?? ''))
        if (button) button.click()
      } catch { /* 页面切换瞬间的 DOM 抖动，忽略 */ }
    }, 2500)
    return true
  })()`)

function seedYesterdaySnapshot() {
  const directory = path.join(tmpProfile, 'daily-history')
  mkdirSync(directory, { recursive: true })
  const make = (id, name, durationMS) => ({
    id,
    name,
    artists: [{ id: 6452, name: '快照歌手' }],
    album: { id: 1, name: '快照专辑' },
    durationMS,
    alias: [],
    transNames: [],
    fee: 0,
    mvID: 0,
    noCopyright: false,
    isCloud: false,
    playability: 'playable'
  })
  writeFileSync(
    path.join(directory, `${localDateKey(1)}.json`),
    JSON.stringify({
      date: localDateKey(1),
      tracks: [make(9000001, '测试快照曲一', 200000), make(9000002, '测试快照曲二', 210000)]
    }),
    'utf8'
  )
  log(`已种入昨天快照 ${localDateKey(1)}.json`)
}

function prepareProfile() {
  const real = path.join(process.env.APPDATA ?? '', 'youyou-music')
  rmSync(tmpProfile, { recursive: true, force: true })
  const skip = [
    'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
    'blob_storage', 'Network', 'Session Storage', 'Shared Dictionary', 'Dictionaries',
    'Local Storage', 'SharedStorage'
  ]
  cpSync(real, tmpProfile, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src)
      return !skip.includes(name)
    }
  })
  // 删掉设置：默认设置 + 空队列 + 空音量等，保证「队列为空」的前提成立。
  rmSync(path.join(tmpProfile, 'settings.json'), { force: true })
  seedYesterdaySnapshot()
}

async function main() {
  prepareProfile()
  const env = { ...process.env, YOYOU_USER_DATA: tmpProfile }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    stdio: 'ignore',
    env,
    cwd: root,
    detached: true
  })
  child.unref()
  log(`dev 实例 PID=${child.pid}，配置目录 ${tmpProfile}`)

  try {
    let booted = false
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await wait(1500)
      try {
        if (await cdp(`Boolean(document.querySelector('.sidebar__link'))`)) {
          booted = true
          break
        }
      } catch {
        /* 还没起来 */
      }
    }
    if (!booted) throw new Error('应用 45 秒内未完成启动')
    await wait(2500)
    await installDialogWatchdog()

    // --- A1. 今天：列表拉出来 + 今天快照落盘 ---
    await clickNav('每日推荐')
    let todayRows = 0
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await wait(1500)
      todayRows = Number(
        await cdp(`document.querySelector('.page-slot:not([hidden])')?.querySelectorAll('.daily-card, .song-row').length ?? document.querySelectorAll('.daily-card, .song-row').length`)
      ) || 0
      if (todayRows > 0) break
    }
    record('今天的日推列表能出来', todayRows > 0, `${todayRows} 行`)
    const todayFile = path.join(tmpProfile, 'daily-history', `${localDateKey(0)}.json`)
    record('今天列表已落盘成快照文件', existsSync(todayFile), todayFile)

    // --- A2. 昨天：点日期条读回快照 ---
    await cdp(`(() => {
      const chip = [...document.querySelectorAll('.daily-dates__day')].find((item) => item.textContent.includes('昨天'))
      if (!chip) return false
      chip.click()
      return true
    })()`)
    let yesterdayRows = 0
    let rowText = ''
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await wait(1200)
      const sample = await cdp(`(() => {
        const root = document.querySelector('.page-slot:not([hidden])') ?? document
        const rows = [...root.querySelectorAll('.daily-card, .song-row')]
        return { count: rows.length, text: rows.map((row) => row.textContent ?? '').join('|') }
      })()`)
      yesterdayRows = sample?.count ?? 0
      rowText = sample?.text ?? ''
      if (yesterdayRows > 0) break
    }
    record(
      '昨天能读回本地快照（含种入的歌曲）',
      yesterdayRows >= 2 && rowText.includes('测试快照曲一') && rowText.includes('测试快照曲二'),
      `${yesterdayRows} 行`
    )

    // --- B. 队列为空时点播放 → 从今日推荐随机播一首 ---
    await clickNav('发现')
    await wait(2000)
    const before = await cdp(`(async () => {
      const reply = await window.youyou.invoke('player:state')
      const state = reply?.data ?? reply
      return { queue: state?.queue?.length ?? -1, playing: state?.playing === true }
    })()`)
    log(`播放前状态：${JSON.stringify(before)}`)

    await cdp(`(() => {
      const button = document.querySelector('.player-bar__controls .icon-button--primary')
      if (!button) return false
      button.click()
      return true
    })()`)

    let after = null
    let skipClicks = 0
    for (let attempt = 0; attempt < 70; attempt += 1) {
      await wait(2000)
      after = await cdp(`(async () => {
        const reply = await window.youyou.invoke('player:state')
        const state = reply?.data ?? reply
        return {
          queue: state?.queue?.length ?? 0,
          playing: state?.playing === true,
          muted: state?.muted === true,
          track: state?.track?.name ?? null,
          loading: state?.loading === true,
          error: state?.error ?? null
        }
      })()`)
      log(`  第 ${attempt + 1} 次采样：${JSON.stringify(after)}`)
      if (after?.playing && (after?.queue ?? 0) > 0) break
      // 某首歌解析卡死（限流/风控）时自动跳下一首，最多帮点 2 次：
      // 主进程本身也有「解析失败自动下一首」，这里只是兜底真机环境里
      // 长时间排队的情况，不掩盖断言。
      if (!after?.loading && !after?.playing && attempt === 24 && skipClicks < 2) {
        await cdp(`(() => {
          const button = [...document.querySelectorAll('.player-bar__controls button')]
            .find((item) => /下一曲|下一首/.test((item.getAttribute('aria-label') ?? '') + (item.title ?? '')))
          if (!button) return false
          button.click()
          return true
        })()`)
        skipClicks += 1
        log('  已点下一曲（解析长时间未出结果）')
      }
    }
    record(
      '空队列点播放 → 自动从今日推荐随机播一首',
      (after?.queue ?? 0) > 0 && after?.playing === true,
      `队列=${after?.queue} 曲目=${after?.track}`
    )
    record('播放后静音已还原（提示音检测的副作用检查）', after?.muted === false)
  } catch (cause) {
    record('测试执行异常', false, String(cause).slice(0, 160))
  } finally {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    } catch {
      /* 已经退出了 */
    }
    rmSync(tmpProfile, { recursive: true, force: true })
  }

  const failed = results.filter((item) => !item.ok)
  log(failed.length === 0 ? 'OPTIMIZE OK' : `OPTIMIZE FAILED (${failed.length}/${results.length})`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((cause) => {
  console.error(`[optimize] 失败: ${cause}`)
  process.exit(1)
})
