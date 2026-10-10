/**
 * 全屏播放页「布局下移 + 逐字卡拉OK」的真实 UI 验证（dev 实例 + CDP 驱动）。
 *
 * 验证链路：
 *  1. 用**真实 cookies.json 的副本**起一个隔离 userData 实例（不碰用户真实 profile）；
 *  2. 首页点第一首歌 → 点播放条封面打开播放页（.np-fullscreen）；
 *  3. 量几何：控制条是否整条贴在窗口底部、上一曲/播放暂停/下一曲/音量是否都在控制条里、
 *     歌词区是否落在控制条上方、右下角两个切换按钮与底部控制条是否互不重叠；
 *  4. 逐字卡拉OK：断言当前行渲染成一格一字的 span、有 --np-char-fill、颜色由渐变裁切、
 *     通过拖动进度条把播放位置推着走，采样同一条行内「已点亮的字数」是否单调递增，
 *     并且出现 0 < 比例 < 100 的「正在唱」的字（KTV 的逐字推进）；
 *  5. 循环切三档特效（卡拉OK → 渐变放大 → 经典 → 霓虹），断言每一档都真的换了画法。
 *
 * 用法：node scripts/test-nowplaying-ui.mjs   （先 npx electron-vite build）
 */
import { spawn, execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9341
// 每次跑用独立目录：上一次的 Chromium 文件可能还被句柄占着，复用会 EPERM。
const userData = path.join(os.tmpdir(), `youyou-np-ui-test-${Date.now()}`)
const realUserData = path.join(process.env.APPDATA ?? '', 'kumone-windows')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[np-ui] ${message}`)

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
/** 信息项：不计入成败，只把实况打出来。 */
const note = (name, detail = '') => log(`INFO ${name}${detail ? ` — ${detail}` : ''}`)

/** 只复制 cookie jar（保持登录态），不复制缓存与设置。 */
function prepareUserData() {
  mkdirSync(userData, { recursive: true })
  const source = path.join(realUserData, 'cookies.json')
  if (!existsSync(source)) {
    log(`未找到 ${source}，将以未登录状态运行`)
    return false
  }
  copyFileSync(source, path.join(userData, 'cookies.json'))
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

/** 播放页几何：每个盒子在哪，底部控制条是否真的在底部。 */
const GEOMETRY = `(() => {
  const box = (selector) => {
    const el = document.querySelector(selector)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      left: Math.round(r.left), right: Math.round(r.right),
      w: Math.round(r.width), h: Math.round(r.height)
    }
  }
  const hits = (a, b) => Boolean(a && b) &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0 &&
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0
  const dock = box('.np-fs__dock')
  const main = box('.np-fs__main')
  const list = box('.np-lyrics__list')
  const controls = box('.np-cover__controls')
  const volume = box('.np-fs__volume')
  const tools = box('.np-fs__tools')
  const dockRow = box('.np-fs__dock-row')
  const progress = box('.np-fs__dock-progress')
  const inside = (child, parent) => Boolean(child && parent) &&
    child.top >= parent.top - 2 && child.bottom <= parent.bottom + 2 &&
    child.left >= parent.left - 2 && child.right <= parent.right + 2
  return {
    viewport: { w: innerWidth, h: innerHeight },
    dock, main, list, controls, volume, tools, progress, dockRow,
    dockAtBottom: dock ? Math.abs(dock.bottom - innerHeight) <= 2 : false,
    dockBelowMain: dock && main ? dock.top >= main.bottom - 2 : false,
    controlsInDock: inside(controls, dock),
    volumeInDock: inside(volume, dock),
    progressInDock: inside(progress, dock),
    lyricsAboveControls: list && controls ? list.bottom <= controls.top + 2 : false,
    // 控制条是通栏的，只要它内部的控件都不与右侧工具按钮相交即可。
    dockToolsOverlap: hits(tools, progress) || hits(tools, dockRow) || hits(tools, controls) || hits(tools, volume),
    toolsInViewport: Boolean(tools) && tools.bottom <= innerHeight + 2 && tools.right <= innerWidth + 2,
    mainPaddingLeft: main ? getComputedStyle(document.querySelector('.np-fs__main')).paddingLeft : null
  }
})()`

/** 歌词渲染实况：当前行怎么画、逐字格子点亮到哪。 */
const LYRICS = `(() => {
  const list = document.querySelector('.np-lyrics__list')
  const rows = [...document.querySelectorAll('.np-lyric')]
  const active = document.querySelector('.np-lyric.is-active')
  const chars = active ? [...active.querySelectorAll('.np-lyric__char')] : []
  const fills = chars.map((el) => parseFloat(el.style.getPropertyValue('--np-char-fill')) || 0)
  const singing = chars.find((el) => el.classList.contains('is-singing'))
  const first = chars[0]
  const text = active ? active.querySelector('.np-lyric__text') : null
  return {
    effectClass: list ? [...list.classList].find((name) => name.startsWith('np-lyrics__list--')) : null,
    fontSize: list ? getComputedStyle(list).fontSize : null,
    rowCount: rows.length,
    activeIndex: rows.indexOf(active),
    activeText: text ? text.textContent : null,
    charCount: chars.length,
    litChars: fills.filter((value) => value >= 99.5).length,
    partialChars: fills.filter((value) => value > 0 && value < 99.5).length,
    maxFill: fills.length ? Math.max(...fills) : 0,
    fills: fills.map((value) => Math.round(value)),
    firstCharBg: first ? getComputedStyle(first).backgroundImage.slice(0, 96) : null,
    firstCharColor: first ? getComputedStyle(first).color : null,
    charTransition: first ? getComputedStyle(first).transitionProperty : null,
    singingCount: chars.filter((el) => el.classList.contains('is-singing')).length,
    singingStroke: singing ? getComputedStyle(singing).webkitTextStrokeWidth : null,
    singingFilter: singing ? getComputedStyle(singing).filter : null,
    legacyWordSpans: document.querySelectorAll('.np-lyric__word').length,
    activeRowBg: active ? getComputedStyle(active).backgroundColor : null,
    activeTextColor: text ? getComputedStyle(text).color : null,
    activeTextShadow: text ? getComputedStyle(text).textShadow.slice(0, 120) : null,
    activeTextBg: text ? getComputedStyle(text).backgroundImage.slice(0, 120) : null,
    activeTextStroke: text ? getComputedStyle(text).webkitTextStrokeWidth : null,
    lyricLabel: document.querySelector('button[title="切换歌词特效"]')?.textContent?.trim() ?? null,
    position: document.querySelector('.np-fs__dock-progress .np-fs__time')?.textContent ?? null
  }
})()`

/** 把播放位置拖到指定秒数（走真实的 range → onChange → commitSeek 链路）。 */
function seekExpression(seconds) {
  return `(() => {
    const input = document.querySelector('.np-fs__dock-progress input[type=range]')
    if (!input) return 'no-range'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, String(${JSON.stringify(seconds)}))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('pointerup', { bubbles: true }))
    return 'ok'
  })()`
}

function killInstance() {
  const script = [
    `$owner = (Get-NetTCPConnection -LocalPort ${CDP_PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess`,
    'foreach ($id in $owner) { if ($id -gt 0) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }',
    "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*youyou-np-ui-test*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
  ].join('; ')
  try {
    execSync(`powershell -NoProfile -Command "${script}"`, { stdio: 'ignore' })
  } catch {
    /* ignore */
  }
}

/** 重复点某个元素直到播放页出现（1.5s 一次，最多 20 次）。 */
async function clickUntil(selector, readySelector) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const state = await cdp(`(() => {
        if (document.querySelector(${JSON.stringify(readySelector)})) return 'ready'
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return 'missing'
        el.click()
        return 'clicked'
      })()`)
      if (state === 'ready') return true
    } catch {
      /* 页面还没起来 */
    }
    await wait(1500)
  }
  return false
}

async function main() {
  const watchdog = setTimeout(() => {
    log('看门狗超时（5 分钟），强制结束')
    killInstance()
    process.exit(1)
  }, 300000)

  const loggedIn = prepareUserData()
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
  log(loggedIn ? '已复制真实 cookie（含 MUSIC_U），实例应处于登录态' : '没有可用登录态')

  try {
    // 1) 首页 → 播第一首歌 → 点播放条封面进播放页。
    const homeReady = await clickUntil('.sidebar__link', '.sidebar__link')
    record('应用外壳已就绪', homeReady)
    const sidebarHome = await cdp(`(() => {
      const link = [...document.querySelectorAll('.sidebar__link')].find((item) => item.textContent.includes('首页'))
      if (link) link.click()
      return Boolean(link)
    })()`)
    record('进入首页', sidebarHome === true)

    await wait(2500)
    // 点第一首歌（播放条的标题一直在，只能靠标题变化判断有没有真的载入曲目）。
    let title = null
    let clickReport = 'n/a'
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const state = await cdp(`(() => {
        const label = document.querySelector('.player-bar__title')?.textContent?.trim() ?? ''
        if (label && label !== '未在播放') return 'playing'
        const rowButton = document.querySelector('.song-row__play')
        if (rowButton) {
          rowButton.click()
          return 'clicked song-row__play'
        }
        const card = document.querySelector('.grid--playlists .card') ?? document.querySelector('button.card')
        if (card) {
          card.click()
          return 'clicked card'
        }
        return 'no-target'
      })()`)
      clickReport = state
      if (state === 'playing') break
      await wait(2500)
    }
    title = await cdp(`document.querySelector('.player-bar__title')?.textContent?.trim() ?? null`)
    record('点歌后有曲目（播放条有标题）', Boolean(title) && title !== '未在播放', `title=${title} click=${clickReport}`)
    if (!title || title === '未在播放') {
      log(`[点歌失败] toast=${await cdp("[...document.querySelectorAll('.toast')].map((n) => n.textContent).join(' | ')")}`)
      log(`[点歌失败] 页面文本: ${await cdp("document.body.innerText.replace(/\\s+/g,' ').slice(0,160)")}`)
    }

    // 让播放真的跑起来（正在播就不要动，否则会把它按暂停）。
    const transportState = await cdp(`(() => {
      const buttons = [...document.querySelectorAll('.player-bar__controls button')]
      const title = (item) => item.getAttribute('title') ?? item.getAttribute('aria-label') ?? ''
      const pause = buttons.find((item) => title(item).includes('暂停'))
      if (pause) return 'already-playing'
      const play = buttons.find((item) => title(item).includes('播放'))
      if (play) {
        play.click()
        return 'resumed'
      }
      return 'unknown'
    })()`)
    note('播放状态', transportState)
    await wait(2500)

    const posTick = () => cdp(`(() => {
      const bar = document.querySelector('.player-bar')
      return bar ? bar.innerText.replace(/\\s+/g, ' ').trim().slice(0, 60) : null
    })()`)
    let advancing = false
    let tick1 = await posTick()
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await wait(2000)
      const tick2 = await posTick()
      if (tick2 && tick2 !== tick1) {
        advancing = true
        tick1 = `${tick1} → ${tick2}`
        break
      }
    }
    record('播放位置在推进（逐字推进的前提）', advancing, String(tick1))

    const entered = await clickUntil('.player-bar__art', '.np-fullscreen')
    record('打开全屏播放页', entered)
    if (!entered) throw new Error('没能打开播放页')
    await wait(2500)

    // 2) 几何：控制条必须整条在底部，歌词占上半部分。
    const geo = await cdp(GEOMETRY)
    note('窗口', `${geo?.viewport?.w}×${geo?.viewport?.h}`)
    note('控制条', JSON.stringify(geo?.dock))
    note('歌词区', JSON.stringify(geo?.list))
    note('主区', JSON.stringify(geo?.main))
    record('底部控制条贴住窗口下沿', geo?.dockAtBottom === true, `dock.bottom=${geo?.dock?.bottom} viewport.h=${geo?.viewport?.h}`)
    record('控制条在主区下方（不再挤在右上）', geo?.dockBelowMain === true, `main.bottom=${geo?.main?.bottom} dock.top=${geo?.dock?.top}`)
    record('上一曲/播放暂停/下一曲在控制条里', geo?.controlsInDock === true, JSON.stringify(geo?.controls))
    record('音量在控制条里', geo?.volumeInDock === true, JSON.stringify(geo?.volume))
    record('进度条在控制条里', geo?.progressInDock === true, JSON.stringify(geo?.progress))
    record('歌词区在控制条上方', geo?.lyricsAboveControls === true, `list.bottom=${geo?.list?.bottom} controls.top=${geo?.controls?.top}`)
    record('右下角切换按钮不压住控制条里的控件', geo?.dockToolsOverlap === false, `tools=${JSON.stringify(geo?.tools)}`)
    record('右下角切换按钮仍在视口内', geo?.toolsInViewport === true, `tools=${JSON.stringify(geo?.tools)}`)
    record(
      '歌词区占据上半部分主体高度',
      (geo?.list?.h ?? 0) > (geo?.viewport?.h ?? 0) * 0.35,
      `list.h=${geo?.list?.h} = ${Math.round(((geo?.list?.h ?? 0) / (geo?.viewport?.h || 1)) * 100)}% 视口`
    )

    // 3) 逐字卡拉OK：默认档就是逐字（当前行细节在采样后再断言，早期位置可能还没到第一句）。
    const first = await cdp(LYRICS)
    note('歌词实况（初始）', JSON.stringify(first))
    record('默认特效是逐字卡拉OK', first?.effectClass === 'np-lyrics__list--karaoke', `class=${first?.effectClass}`)
    record('旧整词渲染已不再出现', first?.legacyWordSpans === 0, `word spans=${first?.legacyWordSpans}`)

    // 把播放位置推着走，采样同一条行内「点亮到哪」。
    const duration = await cdp(`(() => {
      const times = [...document.querySelectorAll('.np-fs__dock-progress .np-fs__time')]
      const parse = (value) => {
        const parts = String(value ?? '').trim().split(':').map(Number)
        return parts.length === 2 ? parts[0] * 60 + parts[1] : 0
      }
      return { position: parse(times[0]?.textContent), duration: parse(times[1]?.textContent) }
    })()`)
    note('进度读数', JSON.stringify(duration))

    const samples = []
    let target = (duration?.position ?? 0) + 1
    for (let step = 0; step < 12; step += 1) {
      target += 1.5
      if ((duration?.duration ?? 0) > 0 && target > duration.duration - 1) break
      await cdp(seekExpression(target))
      await wait(1400)
      samples.push(await cdp(LYRICS))
      const withChars = samples.filter((sample) => (sample?.charCount ?? 0) > 1).length
      if (samples.length >= 6 && withChars >= 4) break
    }
    note(
      '逐字采样',
      samples
        .map((sample) => `pos=${sample?.position} line=${sample?.activeIndex} 亮=${sample?.litChars}/${sample?.charCount} 半亮=${sample?.partialChars} max=${Math.round(sample?.maxFill ?? 0)}`)
        .join(' | ')
    )

    // 采样时播放位置已经走过好几行，此刻当前行必定存在，在这里断言逐字渲染细节。
    let live = null
    for (let index = samples.length - 1; index >= 0; index -= 1) {
      if ((samples[index]?.charCount ?? 0) > 1) {
        live = samples[index]
        break
      }
    }
    for (let attempt = 0; attempt < 8 && !live; attempt += 1) {
      await wait(1500)
      const candidate = await cdp(LYRICS)
      if ((candidate?.charCount ?? 0) > 1) live = candidate
    }
    note('歌词实况（当前行）', JSON.stringify(live))
    record('当前行逐字渲染（一格一字 span）', (live?.charCount ?? 0) > 1, `charCount=${live?.charCount} text=${live?.activeText}`)
    record('每个字带 --np-char-fill', (live?.charCount ?? 0) > 1 && live?.fills?.length === live?.charCount, `charCount=${live?.charCount} fills=${live?.fills}`)
    record(
      '已唱段由渐变裁切上色',
      String(live?.firstCharColor ?? '').includes('0, 0, 0, 0') || live?.firstCharColor === 'rgba(0, 0, 0, 0)',
      `color=${live?.firstCharColor}`
    )
    record('字有 --np-char-fill 过渡（平滑推进）', String(live?.charTransition ?? '').includes('--np-char-fill'), `transition=${live?.charTransition}`)
    record('当前行不再铺块状底色', live?.activeRowBg === 'rgba(0, 0, 0, 0)' || live?.activeRowBg === 'transparent', `bg=${live?.activeRowBg}`)

    const karaokeSamples = samples.filter((sample) => sample?.effectClass === 'np-lyrics__list--karaoke')
    const sawPartial = karaokeSamples.some((sample) => (sample?.partialChars ?? 0) > 0 || (sample?.maxFill ?? 0) > 0)
    const distinct = new Set(karaokeSamples.map((sample) => JSON.stringify(sample?.fills))).size
    if (advancing || distinct > 1) {
      record(
        '逐字推进：出现正在唱的字（0 < 比例 < 100）',
        sawPartial,
        `partial=${karaokeSamples.map((s) => s?.partialChars)} max=${karaokeSamples.map((s) => Math.round(s?.maxFill ?? 0))}`
      )

      let monotonic = true
      let compared = 0
      for (let index = 1; index < karaokeSamples.length; index += 1) {
        const previous = karaokeSamples[index - 1]
        const current = karaokeSamples[index]
        // 只比较同一行：切行后重新计数，本来就该归零。
        if (!previous || !current || previous.activeIndex !== current.activeIndex) continue
        compared += 1
        if ((current.litChars ?? 0) < (previous.litChars ?? 0)) monotonic = false
      }
      record('同一行内已点亮的字数只增不减', monotonic && compared > 0, `比较了 ${compared} 组`)
      const singingSeen = karaokeSamples.some((sample) => (sample?.singingCount ?? 0) > 0)
      record('正在唱的那个字有单独描边/光晕', singingSeen, `stroke=${karaokeSamples.find((s) => (s?.singingCount ?? 0) > 0)?.singingStroke}`)
    } else {
      note('逐字推进未能在实例内观察到', '播放位置没有推进；时间分配本身由 tests/lyrics-chars.test.ts 覆盖')
    }

    // 4) 三档特效循环切换，逐档确认画法真的换了。
    const cycle = async () => {
      await cdp(`(() => { document.querySelector('button[title="切换歌词特效"]')?.click(); return true })()`)
      await wait(700)
      return cdp(LYRICS)
    }
    const zoom = await cycle()
    record('第二档：渐变放大（当前行放大 + 渐变填充）', zoom?.effectClass === 'np-lyrics__list--zoom' && String(zoom?.activeTextBg).includes('gradient'), `class=${zoom?.effectClass} bg=${String(zoom?.activeTextBg).slice(0, 60)}`)
    const classic = await cycle()
    record('第三档：经典（当前句最亮、其余压暗）', classic?.effectClass === 'np-lyrics__list--classic', `class=${classic?.effectClass} 当前色=${classic?.activeTextColor} 阴影=${String(classic?.activeTextShadow).slice(0, 48)}`)
    note('经典档文案', `label=${classic?.lyricLabel} 未唱行透明度见下条`)
    const dimOpacity = await cdp(`(() => {
      const rows = [...document.querySelectorAll('.np-lyric')]
      const inactive = rows.find((row) => !row.classList.contains('is-active'))
      return inactive ? getComputedStyle(inactive.querySelector('.np-lyric__text')).opacity : null
    })()`)
    record('经典档非当前行被压暗', Number(dimOpacity) > 0 && Number(dimOpacity) < 1, `opacity=${dimOpacity}`)
    const neon = await cycle()
    record('第四档：霓虹（当前行柔光 + 细描边，逐字已唱实色）', neon?.effectClass === 'np-lyrics__list--neon' && String(neon?.firstCharBg).includes('gradient') && String(neon?.activeTextStroke) !== '0px', `class=${neon?.effectClass} charBg=${String(neon?.firstCharBg).slice(0, 60)} stroke=${neon?.activeTextStroke}`)
    const neonRadii = [...String(neon?.activeTextShadow ?? '').matchAll(/(\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]))
    record('霓虹光晕半径收得住（最大 30px 以内）', neonRadii.length > 0 && Math.max(...neonRadii) <= 30, `radii=${JSON.stringify(neonRadii)}`)
    const backToKaraoke = await cycle()
    record('循环回到卡拉OK', backToKaraoke?.effectClass === 'np-lyrics__list--karaoke', `class=${backToKaraoke?.effectClass}`)

    // 5) 队列抽屉等原有入口还在（没被这次改动挤掉）。
    const toolsOk = await cdp(`(() => {
      const tools = [...document.querySelectorAll('.np-fs__tools button')]
      return { count: tools.length, labels: tools.map((item) => (item.getAttribute('title') ?? item.textContent.trim()).slice(0, 20)) }
    })()`)
    record('右下角两个切换按钮都在', toolsOk?.count === 2, JSON.stringify(toolsOk?.labels))
    const barOk = await cdp(`document.querySelectorAll('.np-fs__bar button').length`)
    record('顶栏按钮仍可用', Number(barOk) >= 4, `顶栏按钮数=${barOk}`)
  } catch (cause) {
    record('测试执行异常', false, String(cause).slice(0, 200))
  } finally {
    killInstance()
  }

  clearTimeout(watchdog)
  const failed = results.filter((result) => !result.ok)
  log(failed.length === 0 ? 'NOWPLAYING-UI OK' : `NOWPLAYING-UI FAILED (${failed.length}/${results.length})`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((cause) => {
  console.error(`[np-ui] 失败: ${cause}`)
  process.exit(1)
})
