/**
 * 第六轮打磨的真机验证（CDP 端口 9364=正常实例、9365=YOYOU_FAIL_SEARCH 实例）：
 *  ① 一起听聊天消息无「我/对方」名字前缀（页面内 .together__msg-name 应为 0）；
 *  ② 我的音乐五张卡全通栏一行一张、顺序=喜欢的音乐→收藏专辑→关注歌手→我的歌单→最近播放；
 *  ③ 搜索风控报错静默兜底：YOYOU_FAIL_SEARCH=1 实例搜索不弹 .page__error，出站外兜底行或空态；
 *  ④ 搜索综合页「单曲」卡片化（卡片>0 且行=0），切「单曲」页签仍是行列表（行>0 且卡片=0）。
 */
import { spawn, execSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const tmpA = path.join(os.tmpdir(), 'youyou-round6-test')
const tmpB = path.join(os.tmpdir(), 'youyou-round6b-test')
const PORT_A = 9364
const PORT_B = 9365
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[round6] ${message}`)

const results = []
const skips = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const skip = (name, detail) => {
  skips.push(name)
  log(`SKIP ${name} — ${detail}`)
}

let port = PORT_A
async function pages() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  return list.filter((target) => target.type === 'page')
}

function evaluateOn(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      reject(new Error('CDP 超时'))
    }, 30000)
    ws.addEventListener('error', reject)
    ws.addEventListener('open', () => {
      const id = Math.floor(Math.random() * 1e9)
      ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data)
        if (message.id !== id) return
        clearTimeout(timer)
        ws.close()
        resolve(message.result?.result?.value)
      })
      ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true }
        })
      )
    })
  })
}

let appWsUrl = null
async function findApp() {
  if (appWsUrl) {
    const list = await pages()
    if (list.some((target) => target.webSocketDebuggerUrl === appWsUrl)) return appWsUrl
  }
  for (const target of await pages()) {
    try {
      if (await evaluateOn(target.webSocketDebuggerUrl, `Boolean(document.querySelector('.sidebar'))`)) {
        appWsUrl = target.webSocketDebuggerUrl
        return appWsUrl
      }
    } catch {
      /* 换下一个 */
    }
  }
  throw new Error('没有找到业务窗口（.sidebar 不存在）')
}

async function cdp(expression) {
  return evaluateOn(await findApp(), expression)
}

const clickNav = (label) =>
  cdp(`(() => {
    const link = [...document.querySelectorAll('.sidebar__link')].find((item) => item.textContent.includes(${JSON.stringify(label)}))
    if (!link) return false
    link.click()
    return true
  })()`)

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

function prepareProfile(tmp, { real } = {}) {
  rmSync(tmp, { recursive: true, force: true })
  if (real) {
    const src = path.join(process.env.APPDATA ?? '', 'youyou-music')
    const skipDirs = [
      'Cache', 'cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
      'blob_storage', 'Network', 'Session Storage', 'Shared Dictionary', 'Dictionaries',
      'Local Storage', 'SharedStorage'
    ]
    cpSync(src, tmp, { recursive: true, filter: (s) => !skipDirs.includes(path.basename(s)) })
  } else {
    mkdirSync(tmp, { recursive: true })
  }
  // 只覆盖 settings（关掉桌面歌词等干扰）；登录态 cookies.json 原样保留（真实配置才有）。
  writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ theme: 'system' }), 'utf8')
  log(`已准备隔离配置：${tmp}${real ? '（真实登录态拷贝）' : '（全新）'}`)
}

function launch(portNo, envExtra) {
  const env = { ...process.env, ...envExtra }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.YOYOU_BOOT_LOG
  delete env.YOYOU_FORCE_UID
  const child = spawn(electron, ['.', `--remote-debugging-port=${portNo}`], {
    stdio: 'ignore',
    env,
    cwd: root,
    detached: true
  })
  child.unref()
  log(`实例 PID=${child.pid}（端口 ${portNo}）`)
  return child
}

async function waitBooted(timeoutMs = 45000) {
  const started = Date.now()
  appWsUrl = null
  while (Date.now() - started < timeoutMs) {
    await wait(1500)
    try {
      if (await cdp(`Boolean(document.querySelector('.sidebar__link'))`)) return true
    } catch {
      /* 还没起来 */
    }
  }
  return false
}

function kill(child) {
  if (!child?.pid) return
  try {
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
  } catch {
    /* 已经退出 */
  }
}

/** 在搜索页输入关键词并回车（React 受控输入要用原生 setter 再派发 input；搜索只在 Enter 后触发）。 */
const typeSearch = (keywords) =>
  cdp(`(() => {
    const input = document.querySelector('.search-hero__input') || document.querySelector('.search-bar__input')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(keywords)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)

async function phaseA() {
  port = PORT_A
  prepareProfile(tmpA, { real: true })
  const child = launch(PORT_A, { YOYOU_USER_DATA: tmpA })
  try {
    if (!(await waitBooted())) throw new Error('实例 A 45 秒内未完成启动')
    await installDialogWatchdog()
    log('实例 A 已启动')

    // ---------- ② 我的音乐五卡全通栏 ----------
    await clickNav('我的音乐')
    let library = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(1000)
      library = await cdp(`(() => {
        const grid = document.querySelector('.library__grid')
        const cards = grid ? [...grid.querySelectorAll(':scope > .library__card')] : []
        return {
          titles: cards.map((c) => c.querySelector('.library__card-title')?.textContent?.trim() ?? ''),
          allWide: cards.length > 0 && cards.every((c) => c.classList.contains('library__card--wide')),
          widths: cards.map((c) => c.offsetWidth),
          gridWidth: grid ? grid.offsetWidth : 0
        }
      })()`)
      if (library?.titles?.length >= 5) break
    }
    const expectedOrder = ['喜欢的音乐', '收藏专辑', '关注歌手', '我的歌单', '最近播放']
    const orderOk = JSON.stringify(library?.titles?.slice(0, 5)) === JSON.stringify(expectedOrder)
    const widthOk = library && library.gridWidth > 0 && library.widths.every((w) => w >= library.gridWidth - 6)
    record(
      '② 我的音乐五张卡全通栏一行一张，顺序=喜欢的音乐→收藏专辑→关注歌手→我的歌单→最近播放',
      orderOk && library?.allWide === true && widthOk,
      JSON.stringify(library)
    )

    // ---------- ④ 搜索综合页单曲卡片化 ----------
    await clickNav('搜索')
    await wait(1200)
    if (!(await typeSearch('孤勇者'))) {
      record('④ 搜索页输入框未找到（.search-hero__input）', false)
    } else {
      let overview = null
      for (let attempt = 0; attempt < 32; attempt += 1) {
        await wait(1000)
        overview = await cdp(`(() => {
          const section = [...document.querySelectorAll('.page__section')].find((s) => (s.querySelector('.section__title')?.textContent ?? '').includes('单曲'))
          if (!section) return null
          return {
            cards: section.querySelectorAll('.grid .card').length,
            rows: section.querySelectorAll('.song-row').length
          }
        })()`)
        if (overview && overview.cards > 0) break
      }
      record(
        '④ 综合页「单曲」区卡片化（卡片>0 且行=0）',
        overview?.cards > 0 && overview?.rows === 0,
        JSON.stringify(overview)
      )

      const tabClicked = await cdp(`(() => {
        const chip = [...document.querySelectorAll('.search__tabs .chip')].find((c) => c.textContent.trim() === '单曲')
        if (!chip) return false
        chip.click()
        return true
      })()`)
      if (!tabClicked) {
        record('④ 「单曲」页签按钮未找到', false)
      } else {
        let songsTab = null
        for (let attempt = 0; attempt < 32; attempt += 1) {
          await wait(1000)
          songsTab = await cdp(`(() => {
            const active = document.querySelector('.search__tabs .chip.is-active')?.textContent?.trim() ?? null
            const section = [...document.querySelectorAll('.page__section')].find((s) => (s.querySelector('.section__title')?.textContent ?? '').includes('单曲'))
            return {
              activeTab: active,
              rows: section ? section.querySelectorAll('.song-row').length : -1,
              cards: section ? section.querySelectorAll('.card').length : -1
            }
          })()`)
          if (songsTab?.activeTab === '单曲' && songsTab.rows > 0) break
        }
        record(
          '④ 「单曲」页签仍是行列表（行>0 且卡片=0）',
          songsTab?.activeTab === '单曲' && songsTab?.rows > 0 && songsTab?.cards === 0,
          JSON.stringify(songsTab)
        )
      }
    }

    // ---------- ① 一起听消息无名字前缀 ----------
    await clickNav('一起听')
    await wait(2500)
    const together = await cdp(`(() => ({
      mounted: Boolean(document.querySelector('.together')),
      namePrefixes: document.querySelectorAll('.together__msg-name').length,
      members: document.querySelectorAll('.together__member').length
    }))()`)
    record(
      '① 一起听聊天消息无名字前缀（.together__msg-name=0，页面正常挂载）',
      together?.mounted === true && together?.namePrefixes === 0,
      JSON.stringify(together)
    )
  } finally {
    kill(child)
    await wait(1500)
    try {
      rmSync(tmpA, { recursive: true, force: true })
    } catch {
      /* 目录被占用时留给系统清理 */
    }
  }
}

async function phaseB() {
  port = PORT_B
  prepareProfile(tmpB, { real: false })
  const child = launch(PORT_B, { YOYOU_USER_DATA: tmpB, YOYOU_FAIL_SEARCH: '1' })
  try {
    if (!(await waitBooted())) throw new Error('实例 B 45 秒内未完成启动')
    await installDialogWatchdog()
    log('实例 B（YOYOU_FAIL_SEARCH=1）已启动')

    // ---------- ③ 搜索报错静默兜底 ----------
    await clickNav('搜索')
    await wait(1200)
    if (!(await typeSearch('孤勇者'))) {
      record('③ 搜索页输入框未找到（.search-hero__input）', false)
    } else {
      let state = null
      for (let attempt = 0; attempt < 32; attempt += 1) {
        await wait(1000)
        state = await cdp(`(() => ({
          pageError: document.querySelectorAll('.page__error').length,
          rows: document.querySelectorAll('.song-row').length,
          externalRows: document.querySelectorAll('.song-row--external').length,
          placeholder: document.querySelector('.placeholder__title')?.textContent?.trim() ?? null
        }))()`)
        // 落定：出现兜底行或空态（说明 catch 支路走完、没在 loading 里卡住）。
        if (state.rows > 0 || state.placeholder) break
      }
      record(
        '③ 搜索风控报错静默兜底：无 .page__error 横幅，出站外兜底行或空态',
        state?.pageError === 0 && (state?.rows > 0 || Boolean(state?.placeholder)),
        JSON.stringify(state)
      )
    }
  } finally {
    kill(child)
    await wait(1500)
    try {
      rmSync(tmpB, { recursive: true, force: true })
    } catch {
      /* 目录被占用时留给系统清理 */
    }
  }
}

async function main() {
  await phaseA()
  await phaseB()

  const failed = results.filter((item) => !item.ok)
  log(`ROUND6 ${failed.length === 0 ? 'OK' : 'FAILED'} ${results.length - failed.length}/${results.length}${skips.length ? `（SKIP ${skips.length}）` : ''}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  log(`崩溃：${error?.stack ?? error}`)
  process.exitCode = 1
})
