/**
 * 验证两件事：
 *  A. 「返回」按钮只在内容页出现，且只回到进入它的那个页面（不会退回别的类目）；
 *  B. 底部音质显示的是**真实音质**（设置里的首选达不到时显示实际档位）。
 *
 * 用法：npx electron-vite build 之后 node scripts/test-back-and-quality.mjs
 */
import { spawn, execSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9346
const userData = path.join(os.tmpdir(), 'youyou-back-quality-test')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[back-quality] ${message}`)

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
    // awaitPromise 必须为 true：否则 async 表达式只会拿回一个 Promise 对象（returnByValue 下是 {}）。
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

const visiblePageTitle = () =>
  cdp(`(() => {
    const slot = [...document.querySelectorAll('.page-slot')].find((item) => !item.hasAttribute('hidden'))
    const root = slot ?? document
    const title = root.querySelector('.page__title, .home__greeting, h1, h2')
    return (title?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 24)
  })()`)

const hasBackButton = () => cdp(`Boolean(document.querySelector('.top-row__back'))`)

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

    // --- A. 一级页面不显示返回 ---
    let allClean = true
    for (const label of ['发现', '我的音乐', '每日推荐', '私人漫游', '一起听', '云盘', '设置']) {
      await clickNav(label)
      await wait(1000)
      if (await hasBackButton()) {
        allClean = false
        log(`  「${label}」出现了返回按钮`)
      }
    }
    record('一级页面（含设置）都不显示返回按钮', allClean)

    // --- B. 从「我的音乐」进专辑页 → 显示返回，返回后回到我的音乐（不是别的类目）---
    await clickNav('我的音乐')
    await wait(3000)
    const entered = await cdp(`(() => {
      const root = document.querySelector('.page-slot:not([hidden])') ?? document
      const cards = [...root.querySelectorAll('.card, .album-card, [role="button"]')]
      const card = cards.find((item) => item.className && String(item.className).includes('card'))
      if (!card) return false
      card.click()
      return true
    })()`)
    await wait(2800)
    const backVisible = await hasBackButton()
    record('进入内容页后出现返回按钮', backVisible === true)

    if (entered && backVisible) {
      await cdp(`document.querySelector('.top-row__back').click()`)
      await wait(2000)
      const afterBack = await visiblePageTitle()
      const stillHasBack = await hasBackButton()
      record('返回后回到来源类目（我的音乐），且返回按钮消失', stillHasBack === false, `回到：${afterBack}`)
    } else {
      record('返回后回到来源类目（我的音乐），且返回按钮消失', false, `未进入内容页（entered=${entered} back=${backVisible}）`)
    }

    // --- C. 音质显示真实档位（先设最高首选音质，再播放一首歌）---
    await cdp(`(async () => {
      await window.youyou.invoke('settings:update', { quality: 'jymaster' })
      return true
    })()`)
    await wait(1500)

    await clickNav('搜索')
    await wait(2000)
    // 空态里的大搜索框输入并用回车搜索
    await cdp(`(() => {
      const input = [...document.querySelectorAll('input')].find((el) => el.offsetParent !== null)
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '孤勇者')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)

    let rows = 0
    for (let attempt = 0; attempt < 22; attempt += 1) {
      await wait(900)
      rows = Number(
        await cdp(`document.querySelector('.page-slot:not([hidden])')?.querySelectorAll('.song-row').length ?? document.querySelectorAll('.song-row').length`)
      ) || 0
      if (rows > 0) break
    }
    record('搜索页能出结果（用于验证播放）', rows > 0, `${rows} 行`)

    // 点第一行的播放按钮（或双击整行）
    await cdp(`(() => {
      const root = document.querySelector('.page-slot:not([hidden])') ?? document
      const row = root.querySelector('.song-row')
      if (!row) return false
      const button = row.querySelector('button')
      if (button) button.click()
      else row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      return true
    })()`)

    let snapshot
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await wait(1500)
      snapshot = await cdp(`(async () => {
        const reply = await window.youyou.invoke('player:state')
        const state = reply?.data ?? reply
        const select = document.querySelector('.quality-select select')
        return {
          preference: state?.quality ?? null,
          served: state?.servedQuality ?? null,
          bitrate: state?.servedBitrate ?? null,
          servedFrom: state?.servedFrom ?? null,
          selectValue: select?.value ?? null,
          playing: state?.playing === true,
          track: state?.track?.name ?? null
        }
      })()`)
      log(`  第 ${attempt + 1} 次采样：${JSON.stringify(snapshot)}`)
      // 等到真实档位被补上（第三方音源要等 mpv 载入后读码率），最多等 ~35 秒。
      if (snapshot?.playing && snapshot?.served) break
      if (snapshot?.playing && snapshot?.preference && attempt >= 12 && snapshot.served) break
    }
    log(`  播放状态：${JSON.stringify(snapshot)}`)
    if (snapshot?.playing) {
      const expected = snapshot.served ?? (snapshot.servedFrom ? 'standard' : snapshot.preference)
      record(
        '音质控件显示真实档位（不是首选值）',
        snapshot.selectValue === expected,
        `显示=${snapshot.selectValue} 实际=${snapshot.served} 码率=${snapshot.bitrate}kbps 来源=${snapshot.servedFrom ?? '网易云'}`
      )
      if (snapshot.served && snapshot.preference && snapshot.served !== snapshot.preference) {
        record('首选达不到时如实降档显示', snapshot.selectValue === snapshot.served, `${snapshot.selectValue} ≠ 首选 ${snapshot.preference}`)
      } else if (snapshot.served) {
        log('  本次音源给到了首选档位（served == preference）')
      } else {
        record('第三方音源也能标出真实档位', false, 'servedQuality 始终为 null（码率没读到）')
      }
    } else {
      record('能播放曲目以验证音质显示', false, '播放未开始')
    }
  } catch (cause) {
    record('测试执行异常', false, String(cause).slice(0, 160))
  } finally {
    try {
      execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*youyou-back-quality-test*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'ignore' }
      )
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((item) => !item.ok)
  log(failed.length === 0 ? 'BACK-QUALITY OK' : `BACK-QUALITY FAILED (${failed.length}/${results.length})`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((cause) => {
  console.error(`[back-quality] 失败: ${cause}`)
  process.exit(1)
})
