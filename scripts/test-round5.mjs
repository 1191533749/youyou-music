/**
 * 第五轮打磨的真机验证（CDP 端口 9363，profile 用真实登录态拷贝）：
 *  ① 真全屏歌词区无滚动条（scrollbar-width:none 且 ::-webkit-scrollbar display:none）；
 *  ② 真全屏点过播放/暂停（焦点滞留在按钮上）3 秒后仍必隐藏 → mousemove 唤醒 → 再藏 → Esc 退出；
 *  ③ 一起听雷达无幽灵听友：服务器 listeners 含真实 uid 且带头像、无 1-3 位回退 uid、无无头像条目；
 *  ④ 登录态侧边栏头像显示、auth:profile 通道能返回带头像资料（登录后无需重启）；
 *  ⑤ 私人漫游启动即长队列（≥10 首，主进程循环多批补足）；
 *  ⑥ 服务器已存今天的每日推荐（直连 /relay/daily 读回 ≥10 首 → 明天可看）；
 *  ⑦ 首页无日期条、无「今天 202x」日期文案；每日推荐页 7 天日期条仍在。
 */
import { spawn, execSync } from 'node:child_process'
import { cpSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9363
const tmpProfile = path.join(os.tmpdir(), 'youyou-round5-test')
const RELAY_URL = 'wss://yy.ytw.asia/relay'
const RELAY_TOKEN = 'yy-7f3a9c2e51d84b06'
const DAILY_URL = 'https://yy.ytw.asia/relay/daily'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[round5] ${message}`)

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

/** 打开 CDP Network 域收集 WebSocket 事件（诊断中继连接用），返回 { stop }。 */
function startNetworkLog() {
  return new Promise((resolve, reject) => {
    const events = []
    const ws = new WebSocket(appWsUrl)
    const timer = setTimeout(() => reject(new Error('Network 会话打开超时')), 10000)
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id === 1) {
        clearTimeout(timer)
        resolve({
          stop() {
            try {
              ws.close()
            } catch {
              /* ignore */
            }
            return events
          }
        })
        return
      }
      const params = message.params ?? {}
      if (message.method === 'Network.webSocketCreated') {
        events.push({ kind: 'created', url: params.url, at: Date.now() })
      } else if (message.method === 'Network.webSocketClosed') {
        events.push({ kind: 'closed', url: params.url, code: params.closeCode, at: Date.now() })
      } else if (message.method === 'Network.webSocketFrameError') {
        events.push({ kind: 'frameError', error: params.errorMessage, at: Date.now() })
      } else if (message.method === 'Network.webSocketFrameSent') {
        events.push({ kind: 'sent', payload: String(params.response?.payloadData ?? '').slice(0, 160), at: Date.now() })
      }
    }
    ws.addEventListener('open', () => {
      ws.addEventListener('message', onMessage)
      ws.send(JSON.stringify({ id: 1, method: 'Network.enable', params: {} }))
    })
    ws.addEventListener('error', reject)
  })
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
  const skipDirs = [
    'Cache', 'cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
    'blob_storage', 'Network', 'Session Storage', 'Shared Dictionary', 'Dictionaries',
    'Local Storage', 'SharedStorage'
  ]
  cpSync(real, tmpProfile, { recursive: true, filter: (src) => !skipDirs.includes(path.basename(src)) })
  // 只覆盖 settings（关掉桌面歌词等干扰），登录态 cookies.json 原样保留——③④⑥ 需要真实 uid。
  writeFileSync(path.join(tmpProfile, 'settings.json'), JSON.stringify({ theme: 'system' }), 'utf8')
  log(`已准备隔离配置（真实登录态）：${tmpProfile}`)
}

function launch() {
  const env = { ...process.env, YOYOU_USER_DATA: tmpProfile }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.YOYOU_BOOT_LOG
  delete env.YOYOU_FORCE_UID // 本轮必须用真实 uid（③⑥ 依赖）
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

const localDateKey = () => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 用 Node 直连中继服务器，收 welcome 里的 listeners 全量列表（网络抖动时重试 3 次）。 */
async function relayProbe(timeoutMs = 15000) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await relayProbeOnce(timeoutMs, attempt)
    if (result.listeners) return result
    if (attempt === 3) return result
    await new Promise((r) => setTimeout(r, 800))
  }
  return { error: 'probe 重试耗尽' }
}

function relayProbeOnce(timeoutMs, attempt) {
  return new Promise((resolve) => {
    const probeUid = `probe-${Date.now()}-${attempt}`
    let ws
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      try {
        ws?.close()
      } catch {
        /* ignore */
      }
      resolve(value)
    }
    const timer = setTimeout(() => done({ error: 'welcome 超时' }), timeoutMs)
    try {
      ws = new WebSocket(`${RELAY_URL}?token=${encodeURIComponent(RELAY_TOKEN)}`)
    } catch (cause) {
      clearTimeout(timer)
      done({ error: String(cause) })
      return
    }
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          profile: { uid: probeUid, nickname: '回归探针', avatar: 'https://p1.music.126.net/probe-avatar.jpg' }
        })
      )
    })
    ws.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.type === 'welcome') {
        clearTimeout(timer)
        done({ probeUid, listeners: message.listeners ?? [] })
      } else if (message.type === 'error') {
        clearTimeout(timer)
        done({ error: message.message })
      }
    })
    ws.addEventListener('error', (event) => {
      clearTimeout(timer)
      done({ error: `ws error（第 ${attempt} 次，${String(event?.message ?? '')}）` })
    })
    ws.addEventListener('close', () => {
      clearTimeout(timer)
      done({ error: `welcome 前连接关闭（第 ${attempt} 次）` })
    })
  })
}

async function main() {
  prepareProfile()
  const child = launch()
  let uid = null
  let realNickname = null
  try {
    if (!(await waitBooted())) throw new Error('应用 45 秒内未完成启动')
    await installDialogWatchdog()
    log('应用已启动')

    // ---------- ④ 登录态头像 ----------
    const authState = await call('auth:state')
    log(`auth:state=${JSON.stringify(authState)}`)
    uid = authState?.profile?.userId ?? null
    const realNickname = authState?.profile?.nickname ?? null
    const avatarImg = await cdp(
      `(() => { const img = document.querySelector('.sidebar img[alt=""]'); return img ? img.src : null })()`
    )
    record(
      '④ 登录态侧边栏头像显示（img 存在且有地址）',
      typeof avatarImg === 'string' && avatarImg.length > 20,
      `src=${avatarImg}`
    )
    const profileRaw = await call('auth:profile')
    const profileAvatar = profileRaw?.avatarUrl ?? profileRaw?.profile?.avatarUrl ?? null
    record(
      '④ auth:profile 通道返回带头像资料（qrPoll 803 后 store 重试路径依赖它）',
      typeof profileAvatar === 'string' && profileAvatar.length > 20,
      `avatar=${profileAvatar}`
    )

    // ---------- ⑦ 首页无日期条 / 日推页日期条保留 ----------
    await clickNav('首页')
    await wait(1500)
    const homeDates = await cdp(`(() => {
      const slot = document.querySelector('.page-slot:not([hidden])')
      const text = slot ? slot.textContent : ''
      return {
        strip: slot ? slot.querySelectorAll('.home-dates').length : -1,
        subtitle: [...(slot?.querySelectorAll('.page__subtitle') ?? [])].map((el) => el.textContent.trim()),
        hasTodayDate: /今天\\s*\\d{4}/.test(text),
        hasDailyUpdate: text.includes('推荐每天更新')
      }
    })()`)
    record(
      '⑦ 首页无日期条（.home-dates 不存在）、无「今天 202x」日期文案',
      homeDates?.strip === 0 && homeDates?.hasTodayDate === false,
      JSON.stringify(homeDates)
    )

    await clickNav('每日推荐')
    let daily = null
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await wait(1000)
      daily = await cdp(`(() => {
        const slot = document.querySelector('.page-slot:not([hidden])')
        const empty = [...document.querySelectorAll('.page__empty')].map((el) => el.textContent ?? '').join('|')
        return {
          days: slot ? slot.querySelectorAll('.daily-dates .daily-dates__day').length : -1,
          cards: slot ? slot.querySelectorAll('.daily-card').length : -1,
          emptyText: empty
        }
      })()`)
      // 只等卡片出来；days 只是附带信息（日期条渲染快，不能拿它当落定条件）。
      if (daily?.cards > 0) break
    }
    record(
      '⑦ 每日推荐页 7 天日期条仍在且今天列表已加载',
      daily?.days === 7 && daily?.cards > 0,
      JSON.stringify(daily)
    )

    // ---------- ⑤ 私人漫游长队列 ----------
    await clickNav('私人漫游')
    let fmLength = 0
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await wait(1500)
      const state = await call('player:state')
      fmLength = Array.isArray(state?.queue) ? state.queue.length : 0
      if (fmLength >= 10) break
      if (attempt % 4 === 3) log(`FM 队列长度目前 ${fmLength}`)
    }
    record('⑤ 私人漫游启动即长队列（≥10 首，主进程多批补足）', fmLength >= 10, `queue=${fmLength}`)

    // ---------- ① ② 真全屏：歌词无滚动条 + 3 秒必隐藏 ----------
    await cdp(`(() => { document.querySelector('.player-bar__art')?.click(); return true })()`)
    let npOpen = false
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(700)
      if (await cdp(`Boolean(document.querySelector('.np-fullscreen .np-fs__dock'))`)) {
        npOpen = true
        break
      }
    }
    if (!npOpen) {
      record('①/② 播放详情页未能打开，两项无法验证', false)
    } else {
      await cdp(`(() => {
        const button = [...document.querySelectorAll('.np-fullscreen button')].find((item) => (item.getAttribute('aria-label') ?? '') === '进入系统全屏')
        if (!button) return false
        button.click()
        return true
      })()`)
      let inFullscreen = false
      for (let attempt = 0; attempt < 16; attempt += 1) {
        await wait(500)
        inFullscreen = Boolean(
          await cdp(`window.innerWidth >= window.screen.width - 1 && window.innerHeight >= window.screen.height - 1`)
        )
        if (inFullscreen) break
      }

      const lyricEval = `(() => {
        const list = document.querySelector('.np-fullscreen .np-lyrics__list')
        if (!list) return null
        const base = getComputedStyle(list)
        const webkit = getComputedStyle(list, '::-webkit-scrollbar')
        return {
          scrollbarWidth: base.scrollbarWidth,
          webkitDisplay: webkit.display,
          scrollable: list.scrollHeight > list.clientHeight + 8
        }
      })()`
      let lyricList = null
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await wait(1000)
        lyricList = await cdp(lyricEval)
        if (lyricList) break
      }
      if (!lyricList) {
        for (let attempt = 0; attempt < 4 && !lyricList; attempt += 1) {
          await call('player:next')
          for (let poll = 0; poll < 10; poll += 1) {
            await wait(800)
            lyricList = await cdp(lyricEval)
            if (lyricList) break
          }
        }
      }
      if (!lyricList) {
        skip('① 真全屏歌词无滚动条', 'FM 队列各首都无歌词或歌词面板未加载，无法采样')
      } else {
        record(
          '① 真全屏歌词区无滚动条（scrollbar-width:none 且 ::-webkit-scrollbar display:none）',
          lyricList.scrollbarWidth === 'none' && lyricList.webkitDisplay === 'none',
          JSON.stringify({ inFullscreen, ...lyricList })
        )
      }

      // ② 点播放/暂停（mousedown+click+focus，焦点滞留按钮）→ 3.4s 后仍隐藏。
      await cdp(`(() => {
        const button = document.querySelector('.np-fs__dock button[aria-label="暂停"], .np-fs__dock button[aria-label="播放"]')
        if (!button) return false
        const rect = button.getBoundingClientRect()
        const opts = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
        button.dispatchEvent(new MouseEvent('mousemove', opts))
        button.dispatchEvent(new MouseEvent('mousedown', opts))
        button.dispatchEvent(new MouseEvent('mouseup', opts))
        button.dispatchEvent(new MouseEvent('click', opts))
        button.focus()
        return true
      })()`)
      await wait(3400)
      const idleAfterClick = await cdp(`document.documentElement.classList.contains('fullscreen-idle')`)
      record(
        '② 真全屏点过播放/暂停（焦点留在按钮上）3 秒后仍必隐藏',
        inFullscreen === true && idleAfterClick === true,
        JSON.stringify({ inFullscreen, idleAfterClick })
      )

      await cdp(`(() => { document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 300 })); return true })()`)
      let woke = false
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await wait(100)
        if (!(await cdp(`document.documentElement.classList.contains('fullscreen-idle')`))) {
          woke = true
          break
        }
      }
      await wait(3400)
      const idleAgain = await cdp(`document.documentElement.classList.contains('fullscreen-idle')`)
      record('② mousemove 唤醒控件（<1s），静止 3 秒后再次隐藏', woke === true && idleAgain === true, JSON.stringify({ woke, idleAgain }))

      await cdp(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); true`)
      await wait(2500)
      const afterEsc = await cdp(`(() => ({
        idle: document.documentElement.classList.contains('fullscreen-idle'),
        windowed: window.innerWidth < window.screen.width - 1 || window.innerHeight < window.screen.height - 1,
        back: document.querySelectorAll('.np-fullscreen .np-fs__back').length
      }))()`)
      record('② Esc 退出真全屏：控件恢复、窗口化', afterEsc?.idle === false && afterEsc?.windowed === true, JSON.stringify(afterEsc))
    }

    // ---------- ③ 一起听雷达无幽灵 ----------
    await cdp(`window.resizeTo(1280, 820); true`)
    await wait(1000)
    await findApp() // 保证 appWsUrl 已就绪，startNetworkLog 才能挂事件
    const netLog = await startNetworkLog()
    await clickNav('一起听')
    let radar = null
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await wait(800)
      radar = await cdp(`(() => ({
        blips: document.querySelectorAll('.radar__blip').length,
        dish: Boolean(document.querySelector('.radar__dish')),
        status: document.querySelector('.together__status')?.textContent?.trim() ?? null,
        detail: document.querySelector('.together__detail')?.textContent?.trim() ?? null,
        error: document.querySelector('.together__error')?.textContent?.trim() ?? null
      }))()`)
      if (radar?.status === '已连接') break
    }
    const wsEvents = netLog.stop()
    log(`一起听雷达：${JSON.stringify(radar)}`)
    if (wsEvents.length > 0) log(`中继 WS 事件：${JSON.stringify(wsEvents.slice(0, 12))}`)
    if (uid == null) {
      skip('③ 一起听雷达无幽灵听友', 'auth:state 未返回 profile.userId（账号资料接口受限），无法核对服务器条目')
    } else {
      // 应用 hello 可能比探针晚到服务器：探针最多 3 次，看到应用条目才定案。
      let probe = null
      for (let attempt = 0; attempt < 3; attempt += 1) {
        probe = await relayProbe()
        if (probe?.listeners?.some((item) => item.nickname === realNickname && Boolean(item.avatar))) break
        await wait(2000)
      }
      if (probe?.error) {
        record('③ 一起听雷达无幽灵听友（中继探针失败）', false, probe.error)
      } else {
        const listeners = probe.listeners
        // 服务器 listenerList 不带 uid（只有 clientId/nickname/avatar），所以用真实昵称匹配应用条目。
        const appEntry = listeners.find((item) => item.nickname === realNickname && Boolean(item.avatar))
        // 幽灵 = 昵称还是「听友N」回退值的条目（第一条 hello 没带 uid/昵称才会这样登记）。
        const fallbackGhosts = listeners.filter((item) => /^听友\\d+$/.test(String(item.nickname ?? '')))
        // 无头像条目（探针自己带占位头像，不算）。
        const avatarless = listeners.filter(
          (item) => item.nickname !== '回归探针' && !item.avatar
        )
        record(
          '③ 雷达无幽灵听友：应用条目以真实昵称+头像登记、无「听友N」回退条目、无无头像条目',
          Boolean(appEntry) && fallbackGhosts.length === 0 && avatarless.length === 0,
          JSON.stringify({
            nickname: realNickname,
            entries: listeners.map((item) => ({ id: item.id, nickname: item.nickname, avatar: Boolean(item.avatar) })),
            fallbackGhosts: fallbackGhosts.map((item) => item.nickname),
            avatarless: avatarless.map((item) => item.nickname)
          })
        )
      }
    }

    // ---------- ⑥ 服务器已存今天的每日推荐 ----------
    if (uid == null) {
      skip('⑥ 服务器每日推荐记录', 'uid 未知')
    } else {
      const today = localDateKey()
      let serverTracks = null
      for (let attempt = 0; attempt < 4 && serverTracks == null; attempt += 1) {
        await clickNav('每日推荐')
        for (let poll = 0; poll < 10; poll += 1) {
          await wait(1000)
          const cards = await cdp(`document.querySelectorAll('.daily-card').length`)
          if (cards > 0) break
        }
        await wait(2500)
        try {
          const resp = await fetch(
            `${DAILY_URL}?token=${encodeURIComponent(RELAY_TOKEN)}&uid=${encodeURIComponent(String(uid))}&date=${encodeURIComponent(today)}`
          )
          const body = await resp.json()
          if (body?.ok === true && Array.isArray(body.tracks) && body.tracks.length >= 10) {
            serverTracks = body.tracks
          } else {
            log(`⑥ 服务器读回：ok=${body?.ok} tracks=${Array.isArray(body?.tracks) ? body.tracks.length : '非数组'}（HTTP ${resp.status}）`)
          }
        } catch (cause) {
          log(`⑥ 直连服务器失败：${String(cause)}`)
        }
      }
      record(
        '⑥ 服务器已存今天的每日推荐（直连 /relay/daily 读回 ≥10 首 → 明天可看）',
        Array.isArray(serverTracks) && serverTracks.length >= 10,
        `tracks=${serverTracks?.length}`
      )
    }
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
  log(`ROUND5 ${failed.length === 0 ? 'OK' : 'FAILED'} ${results.length - failed.length}/${results.length}${skips.length ? `（SKIP ${skips.length}）` : ''}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  log(`崩溃：${error?.stack ?? error}`)
  process.exitCode = 1
})
