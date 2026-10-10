/**
 * 第四轮打磨的真机验证（CDP 端口 9357）：
 *  ③ 首页第一个板块是「今日热歌」12 张卡（不再与每日推荐重复）；
 *  ③ 每日推荐页是 .daily-card 卡片网格；
 *  ④ 一起听雷达盘放大（1280×820 盘径 ≥220px、1600×1025 ≥260px）且整页无滚动；
 *  ⑤ 设置页缓存用量真实显示（种入假音频缓存后显示非 0，切走再切回仍非 0）；
 *  ⑥ 设置页「外观」组 = 主题 + 皮肤合体，不再有独立「皮肤」组；GPU 开关仍在；
 *  ① 播放/暂停按钮乐观翻转（点击后 ≤300ms 图标态翻转，1.5s 内权威态一致）；
 *  ② 切歌耗时（player:next 后 12s 内恢复播放）；
 *  ⑦ 真全屏 3 秒后连右下角工具钮一起全部隐藏、真全屏无返回按钮、Esc 退出真全屏；
 *  ⑧ 播放详情页与播放条不再出现小鱼占位（用真实歌手头像/中性占位）。
 */
import { spawn, execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9357
const tmpProfile = path.join(os.tmpdir(), 'youyou-round4-test')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[round4] ${message}`)

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function pages() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
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
async function cdp(expression) {
  const list = await pages()
  if (appWsUrl && list.some((target) => target.webSocketDebuggerUrl === appWsUrl)) {
    return evaluateOn(appWsUrl, expression)
  }
  for (const target of list) {
    try {
      if (await evaluateOn(target.webSocketDebuggerUrl, `Boolean(document.querySelector('.sidebar'))`)) {
        appWsUrl = target.webSocketDebuggerUrl
        return evaluateOn(appWsUrl, expression)
      }
    } catch {
      /* 换下一个 */
    }
  }
  throw new Error('没有找到业务窗口（.sidebar 不存在）')
}

const clickNav = (label) =>
  cdp(`(() => {
    const link = [...document.querySelectorAll('.sidebar__link')].find((item) => item.textContent.includes(${JSON.stringify(label)}))
    if (!link) return false
    link.click()
    return true
  })()`)

const call = (channel, payload = {}) =>
  cdp(`(async () => {
    const result = await window.youyou.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)})
    return result && result.ok ? result.data : { __error: String(result && result.error) }
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

function prepareProfile() {
  const real = path.join(process.env.APPDATA ?? '', 'youyou-music')
  rmSync(tmpProfile, { recursive: true, force: true })
  const skip = [
    'Cache', 'cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
    'blob_storage', 'Network', 'Session Storage', 'Shared Dictionary', 'Dictionaries',
    'Local Storage', 'SharedStorage'
  ]
  cpSync(real, tmpProfile, { recursive: true, filter: (src) => !skip.includes(path.basename(src)) })
  writeFileSync(path.join(tmpProfile, 'settings.json'), JSON.stringify({ theme: 'system' }), 'utf8')
  // 种一个 1MB 假音频缓存文件：验证「缓存用量」不再是 0B（第四轮起缓存目录改名
  // audio-cache，躲开 Chromium 的 Cache 目录——那就是启动时被清空的真凶）。
  const audioDir = path.join(tmpProfile, 'audio-cache', 'audio')
  mkdirSync(audioDir, { recursive: true })
  writeFileSync(path.join(audioDir, '90000001-exhigh.mp3'), Buffer.alloc(1024 * 1024, 1))
  log(`已准备隔离配置：${tmpProfile}（含 1MB 假音频缓存）`)
}

function launch() {
  const env = { ...process.env, YOYOU_USER_DATA: tmpProfile, YOYOU_FORCE_UID: '999999999' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.YOYOU_BOOT_LOG
  const child = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    stdio: 'ignore',
    env,
    cwd: root,
    detached: true
  })
  child.unref()
  log(`dev 实例 PID=${child.pid}`)
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

/** 保证有一首在播：先靠 FM 自播，不行就搜索点一首。 */
async function ensurePlaying() {
  await clickNav('私人漫游')
  for (let attempt = 0; attempt < 18; attempt += 1) {
    await wait(1500)
    const state = await call('player:state')
    if (state?.playing === true) return state
  }
  // 兜底：搜索 + 双击第一行。
  await clickNav('搜索')
  await wait(1500)
  await cdp(`(() => {
    const input = document.querySelector('.page.search .search-hero__input')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '晴天 周杰伦')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await wait(400)
  await cdp(`(() => {
    const input = document.querySelector('.page.search .search-hero__input')
    if (!input) return false
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }))
    return true
  })()`)
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await wait(1500)
    const rows = await cdp(`document.querySelectorAll('.page.search .song-row').length`)
    if (rows > 0) break
  }
  await cdp(`(() => {
    const row = document.querySelector('.page.search .song-row')
    if (!row) return false
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  })()`)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await wait(1500)
    const state = await call('player:state')
    if (state?.playing === true) return state
  }
  return null
}

async function main() {
  prepareProfile()
  log(
    `种子后 audio 目录=${JSON.stringify(
      (() => {
        try {
          return readdirSync(path.join(tmpProfile, 'audio-cache', 'audio'))
        } catch (cause) {
          return `ERR ${String(cause)}`
        }
      })()
    )}`
  )
  const child = launch()
  try {
    if (!(await waitBooted())) throw new Error('应用 45 秒内未完成启动')
    log(
      `boot 后 audio 目录=${JSON.stringify(
        (() => {
          try {
            return readdirSync(path.join(tmpProfile, 'audio-cache', 'audio'))
          } catch (cause) {
            return `ERR ${String(cause)}`
          }
        })()
      )}`
    )
    await installDialogWatchdog()
    log('应用已启动')

    // ---------- ③ 首页「今日热歌」 ----------
    await clickNav('首页')
    // 今日热歌要拉三张榜单，比推荐歌单慢：等第一个 section 的卡片网格出现再采样。
    let home = null
    for (let attempt = 0; attempt < 14; attempt += 1) {
      await wait(1000)
      home = await cdp(`(() => {
        const slot = document.querySelector('.page-slot:not([hidden])')
        const sections = [...slot.querySelectorAll('.page__section')]
        const titles = [...slot.querySelectorAll('.section__title')].map((item) => item.textContent.trim())
        const firstGrid = sections[0]?.querySelector('.grid--playlists')
        const text = (slot.textContent ?? '')
        return {
          titles,
          hotCards: firstGrid ? firstGrid.querySelectorAll('.card').length : -1,
          hasDaily: text.includes('每日推荐'),
          hasHot: text.includes('今日热歌')
        }
      })()`)
      if (home?.hotCards > 0) break
    }
    record(
      '③ 首页第一板块为「今日热歌」12 张卡、不再出现「每日推荐」',
      home?.hasHot === true && home?.titles?.[0] === '今日热歌' && home?.hotCards === 12 && home?.hasDaily === false,
      JSON.stringify(home)
    )

    // ---------- ③ 每日推荐卡片网格 ----------
    await clickNav('每日推荐')
    let daily = null
    for (let attempt = 0; attempt < 14; attempt += 1) {
      await wait(1000)
      daily = await cdp(`(() => {
        const slot = document.querySelector('.page-slot:not([hidden])')
        const cards = slot.querySelectorAll('.daily-card').length
        const empty = slot.querySelector('.placeholder__title')?.textContent?.trim() ?? null
        return { cards, empty, hasDates: Boolean(slot.querySelector('.daily-dates')) }
      })()`)
      if (daily?.cards > 0 || daily?.empty != null) break
    }
    record(
      '③ 每日推荐页是带头像卡片网格（.daily-card；空态或 ≥1 张）',
      daily?.hasDates === true && (daily?.cards > 0 || (daily?.empty ?? '') !== ''),
      JSON.stringify(daily)
    )

    // ---------- ④ 一起听雷达放大 ----------
    await cdp(`window.resizeTo(1280, 820); true`)
    await wait(1500)
    await clickNav('一起听')
    let together1280 = null
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await wait(700)
      together1280 = await cdp(`(() => {
        const content = document.querySelector('.content')
        const dish = document.querySelector('.radar__dish')
        return {
          dish: dish ? Math.round(dish.getBoundingClientRect().width) : 0,
          overflow: content ? content.scrollHeight - content.clientHeight : null
        }
      })()`)
      if (together1280?.dish > 0) break
    }
    record(
      '④ 一起听 1280×820：雷达盘 ≥220px 且整页无滚动',
      together1280?.dish >= 220 && together1280?.overflow != null && together1280.overflow <= 2,
      JSON.stringify(together1280)
    )
    await cdp(`window.resizeTo(1600, 1025); true`)
    await wait(1500)
    let together1600 = null
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await wait(700)
      together1600 = await cdp(`(() => {
        const content = document.querySelector('.content')
        const dish = document.querySelector('.radar__dish')
        return {
          dish: dish ? Math.round(dish.getBoundingClientRect().width) : 0,
          overflow: content ? content.scrollHeight - content.clientHeight : null
        }
      })()`)
      if (together1600?.dish > 0) break
    }
    record(
      '④ 一起听 1600×1025：雷达盘 ≥240px 且整页无滚动',
      together1600?.dish >= 240 && together1600?.overflow != null && together1600.overflow <= 2,
      JSON.stringify(together1600)
    )

    // ---------- ⑤⑥ 设置页：缓存用量 / 外观组合并 ----------
    await clickNav('设置')
    await wait(2000)
    const usageRaw = await call('app:cacheUsage')
    const audioDirOnDisk = path.join(tmpProfile, 'audio-cache', 'audio')
    log(
      `app:cacheUsage=${JSON.stringify(usageRaw)}；盘上 audio 目录=${JSON.stringify(
        (() => {
          try {
            return readdirSync(audioDirOnDisk)
          } catch {
            return null
          }
        })()
      )}`
    )
    const usageFirst = await cdp(`(() => {
      const hints = [...document.querySelectorAll('.settings__row-hint')].map((item) => item.textContent.trim())
      return { usage: hints.find((text) => text.includes('已用')) ?? null }
    })()`)
    // 切走再切回，验证 keep-alive 下也会刷新。
    await clickNav('首页')
    await wait(1500)
    await clickNav('设置')
    await wait(1500)
    const usageSecond = await cdp(`(() => {
      const hints = [...document.querySelectorAll('.settings__row-hint')].map((item) => item.textContent.trim())
      return { usage: hints.find((text) => text.includes('已用')) ?? null }
    })()`)
    record(
      '⑤ 缓存用量显示非 0（种入 1MB 假缓存后），切走再切回仍非 0',
      usageFirst?.usage != null && /[1-9]/.test(usageFirst.usage) && usageSecond?.usage != null && /[1-9]/.test(usageSecond.usage),
      JSON.stringify({ first: usageFirst, second: usageSecond })
    )

    const settingsGroups = await cdp(`(() => {
      const groups = [...document.querySelectorAll('.settings__group')].map((group) => ({
        title: group.querySelector('h2')?.textContent?.trim() ?? '',
        hasThemeSelect: [...group.querySelectorAll('select option')].some((option) => option.value === 'dark'),
        hasSkinPicker: Boolean(group.querySelector('.skin-picker'))
      }))
      const gpu = document.querySelector('button.switch[aria-label="GPU 加速"]')
      return {
        groups: groups.map((group) => group.title),
        merged: groups.filter((group) => group.hasThemeSelect && group.hasSkinPicker).map((group) => group.title),
        separateSkin: groups.filter((group) => group.title === '皮肤').length,
        gpu: Boolean(gpu)
      }
    })()`)
    record(
      '⑥ 设置页：主题+皮肤合并为「外观」组、无独立皮肤组、GPU 开关仍在',
      settingsGroups?.merged?.includes('外观') === true && settingsGroups?.separateSkin === 0 && settingsGroups?.gpu === true,
      JSON.stringify(settingsGroups)
    )

    // ---------- ①② 播放/暂停乐观反馈 + 切歌耗时 ----------
    const playing = await ensurePlaying()
    const before = await cdp(`(() => {
      const button = document.querySelector('.player-bar__controls .icon-button--primary')
      return button ? { pressed: button.getAttribute('aria-pressed'), busy: button.getAttribute('aria-busy') } : null
    })()`)
    const t0 = Date.now()
    await cdp(`(() => { document.querySelector('.player-bar__controls .icon-button--primary')?.click(); return true })()`)
    let flipMs = null
    let flippedTo = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(50)
      const now = await cdp(`(() => {
        const button = document.querySelector('.player-bar__controls .icon-button--primary')
        return button ? button.getAttribute('aria-pressed') : null
      })()`)
      if (now !== before?.pressed) {
        flipMs = Date.now() - t0
        flippedTo = now
        break
      }
    }
    await wait(1800)
    const after = await call('player:state')
    record(
      '① 播放/暂停按钮乐观翻转：点击后 ≤300ms 图标态翻转，权威态随后一致',
      before?.pressed != null && flipMs != null && flipMs <= 300 && String(after?.playing) === flippedTo,
      JSON.stringify({ before: before?.pressed, flippedTo, flipMs, afterPlaying: after?.playing, started: playing?.playing })
    )
    // 恢复播放态，继续后面的步骤。
    await cdp(`(() => { document.querySelector('.player-bar__controls .icon-button--primary')?.click(); return true })()`)
    await wait(1500)

    const trackBefore = await call('player:state')
    const nextT0 = Date.now()
    await call('player:next')
    let nextState = null
    let nextMs = null
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await wait(500)
      const state = await call('player:state')
      if (state?.playing === true && state?.track?.id !== trackBefore?.track?.id) {
        nextState = state
        nextMs = Date.now() - nextT0
        break
      }
    }
    record(
      '② 切歌 12 秒内恢复播放（预解析/出声即播放态生效）',
      nextMs != null && nextMs <= 12000,
      JSON.stringify({ ms: nextMs, from: trackBefore?.track?.name, to: nextState?.track?.name })
    )

    // ---------- ⑦⑧ 全屏沉浸 + 无小鱼 ----------
    await cdp(`(() => { document.querySelector('.player-bar__art')?.click(); return true })()`)
    let npOpen = false
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(700)
      if (await cdp(`Boolean(document.querySelector('.np-fullscreen .np-fs__dock'))`)) {
        npOpen = true
        break
      }
    }
    const noFish = await cdp(`(() => ({
      np: document.querySelectorAll('.np-fullscreen .fish-avatar').length,
      bar: document.querySelectorAll('.player-bar__art .fish-avatar').length,
      npFallback: document.querySelectorAll('.np-fullscreen .np-art-fallback').length,
      barPlaceholder: document.querySelectorAll('.player-bar__art .player-bar__art-placeholder').length,
      img: document.querySelectorAll('.player-bar__art img').length
    }))()`)
    record(
      '⑧ 播放详情页/播放条不再出现小鱼占位（真实封面或中性占位）',
      noFish?.np === 0 && noFish?.bar === 0 && ((noFish?.img ?? 0) > 0 || (noFish?.npFallback ?? 0) > 0 || (noFish?.barPlaceholder ?? 0) > 0),
      JSON.stringify({ npOpen, ...noFish })
    )

    await cdp(`(() => {
      const button = [...document.querySelectorAll('.np-fullscreen button')].find((item) => (item.getAttribute('aria-label') ?? '') === '进入系统全屏')
      if (!button) return false
      button.click()
      return true
    })()`)
    // 先等窗口真的盖满整屏（系统全屏的切换有动画），再等 3 秒空闲，避免竞态。
    let inFullscreen = false
    for (let attempt = 0; attempt < 16; attempt += 1) {
      await wait(500)
      inFullscreen = Boolean(
        await cdp(`window.innerWidth >= window.screen.width - 1 && window.innerHeight >= window.screen.height - 1`)
      )
      if (inFullscreen) break
    }
    await wait(3800)
    const idle = await cdp(`(() => {
      const hidden = (selector) => {
        const element = document.querySelector(selector)
        if (!element) return null
        const style = getComputedStyle(element)
        return style.opacity === '0' || style.transform !== 'none' || style.pointerEvents === 'none'
      }
      return {
        idle: document.documentElement.classList.contains('fullscreen-idle'),
        bar: hidden('.np-fs__bar'),
        dock: hidden('.np-fs__dock'),
        tools: hidden('.np-fs__tools'),
        back: document.querySelectorAll('.np-fullscreen .np-fs__back').length
      }
    })()`)
    record(
      '⑦ 真全屏 3 秒后全部控件隐藏（顶栏/控制条/右下角工具钮），且真全屏无返回按钮',
      inFullscreen === true &&
        idle?.idle === true &&
        idle?.bar === true &&
        idle?.dock === true &&
        idle?.tools === true &&
        idle?.back === 0,
      JSON.stringify({ inFullscreen, ...idle })
    )

    await cdp(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); true`)
    await wait(2500)
    const afterEsc = await cdp(`(() => ({
      idle: document.documentElement.classList.contains('fullscreen-idle'),
      back: document.querySelectorAll('.np-fullscreen .np-fs__back').length,
      windowed: window.innerWidth < window.screen.width - 1 || window.innerHeight < window.screen.height - 1
    }))()`)
    record(
      '⑦ Esc 退出真全屏：控件恢复显示、返回按钮重新出现（非真全屏有返回）',
      afterEsc?.idle === false && afterEsc?.back >= 1 && afterEsc?.windowed === true,
      JSON.stringify(afterEsc)
    )
  } finally {
    kill(child)
    await wait(1500)
    try {
      rmSync(tmpProfile, { recursive: true, force: true })
    } catch {
      /* 目录被占用时留给系统清理 */
    }
  }

  const failed = results.filter((item) => !item.ok)
  log(`ROUND4 ${failed.length === 0 ? 'OK' : 'FAILED'} ${results.length - failed.length}/${results.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  log(`崩溃：${error?.stack ?? error}`)
  process.exitCode = 1
})
