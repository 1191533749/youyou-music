/**
 * 「一起听」页面真实 UI 验证（dev 实例 + CDP 驱动）。
 *
 * 验证链路：渲染进程 WebSocket → wss://yy.ytw.asia/relay（带口令，走 CSP 白名单）
 *  1. 点侧栏进入「一起听」页；
 *  2. 点「连接中继」，断言状态变成「已连接」且礼物目录已下发；
 *  3. 填房间名点「创建房间」，断言变为房主（我是房主）且成员列表包含自己。
 *
 * 用法：node scripts/test-together-ui.mjs
 */
import { spawn, execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9336
const userData = path.join(os.tmpdir(), 'youyou-together-ui-test')
const ROOM_NAME = `自测房间${Date.now() % 10000}`
const SYNC_ROOM = `同步房间${Date.now() % 10000}`
const RELAY_URL = 'wss://yy.ytw.asia/relay'
const RELAY_TOKEN = 'yy-7f3a9c2e51d84b06'
/** 用 smoke 自检的离线样本造缓存音源：不需要登录、不需要网络也能真的播放。 */
const FIXTURE = path.join(root, 'tests', 'fixtures', 'offline.m4a')
const CACHED_TRACK_ID = 999000001
const CACHED_TRACK_NAME = '同步测试曲'
/** 记录实际使用的登录凭证来源，便于排查「实例没登录」。 */
let plantCookiesSource = '(未复制)'

function plantCachedAudio() {
  const fixture = process.env.YOYOU_FIXTURE ?? FIXTURE
  if (!existsSync(fixture)) {
    log(`未找到样本 ${fixture}，跳过真实播放同步验证`)
    return false
  }
  const directory = path.join(userData, 'cache', 'audio')
  mkdirSync(directory, { recursive: true })
  copyFileSync(fixture, path.join(directory, `${CACHED_TRACK_ID}-exhigh.m4a`))
  return true
}

/**
 * 一起听需要登录：把真实 profile 的 cookies.json 复制一份到隔离目录
 * （只读复制，绝不修改真实 profile）。
 *
 * 注意：不同时期的构建用过不同的 userData 目录名，其中只有仍是有效登录态的
 * 那份 cookie 能让实例处于登录状态，所以按「已知可用的目录」顺序尝试。
 */
function plantCookies() {
  const candidates = [
    process.env.YOYOU_COOKIE_PROFILE,
    path.join(process.env.APPDATA ?? '', 'kumone-windows', 'cookies.json'),
    path.join(process.env.APPDATA ?? '', 'youyou-music', 'cookies.json'),
    path.join(process.env.APPDATA ?? '', 'YouyouMusic', 'cookies.json')
  ].filter(Boolean)
  const source = candidates.find((candidate) => existsSync(candidate))
  if (!source) {
    log('未找到任何登录凭证：未登录状态下页面只会显示登录提示卡')
    return false
  }
  mkdirSync(userData, { recursive: true })
  copyFileSync(source, path.join(userData, 'cookies.json'))
  plantCookiesSource = source
  log(`已复制登录凭证：${source}`)
  return true
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[together-ui] ${message}`)

async function cdp(expression) {
  const { WebSocket } = globalThis
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  const targets = await response.json()
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
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expression, returnByValue: true } }))
  })
  ws.close()
  return value
}

async function clickByText(text) {
  return cdp(`(() => {
    const node = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === ${JSON.stringify(text)})
    if (!node) return false
    node.click()
    return true
  })()`)
}

/** 极简脚本端客户端：用于当「房主」验证应用端的跟随同步。 */
function scriptClient() {
  const socket = new WebSocket(`${RELAY_URL}?token=${RELAY_TOKEN}`)
  const received = []
  socket.addEventListener('message', (event) => {
    try {
      received.push(JSON.parse(event.data))
    } catch {
      /* ignore */
    }
  })
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('脚本端连接失败')))
  })
  const send = (payload) => socket.send(JSON.stringify(payload))
  const waitFor = async (type, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = received.find((entry) => entry.type === type)
      if (hit) return hit
      await wait(80)
    }
    throw new Error(`脚本端未收到 ${type}`)
  }
  return { socket, send, waitFor, ready }
}

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  const planted = plantCachedAudio()
  const loggedIn = plantCookies()
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
    // 1. 进入「一起听」页
    let entered = false
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await wait(1500)
      try {
        const clicked = await cdp(`(() => {
          const link = [...document.querySelectorAll('.sidebar__link')].find((item) => item.textContent.includes('一起听'))
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
    record('进入「一起听」页面', entered)
    if (!entered) throw new Error('没能进入一起听页')

    await wait(1200)
    // 登录态与资料是异步加载的，等它落定再判断（最多 20 秒）。
    let loggedInApp = false
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const state = await cdp(
        `({ account: Boolean(document.querySelector('.sidebar__account')), gate: Boolean(document.querySelector('.together__gate')) })`
      )
      if (state?.account === true && state?.gate === false) {
        loggedInApp = true
        break
      }
      await wait(1000)
    }
    record('测试实例处于登录态', loggedInApp, plantCookiesSource)
    const gate = await cdp(`Boolean(document.querySelector('.together__gate'))`)
    record('登录后不显示登录门禁', gate === false)
    const rendered = await cdp(
      `Boolean(document.querySelector('.together__connect')) && Boolean(document.querySelector('.together__grid'))`
    )
    record('页面控件渲染', rendered === true)

    // 2. 登录后应自动连接中继（页面上已无「连接中继」「断开」按钮）
    const noConnectButton = await cdp(`(() => {
      const texts = [...document.querySelectorAll('.together__connect button')].map((b) => b.textContent.trim())
      return { buttons: texts, hasConnect: texts.some((t) => t.includes('连接中继')), hasDisconnect: texts.some((t) => t.includes('断开')) }
    })()`)
    record(
      '已移除连接/断开入口（自动连接）',
      noConnectButton?.hasConnect === false && noConnectButton?.hasDisconnect === false,
      `连接卡按钮=${JSON.stringify(noConnectButton?.buttons ?? [])}`
    )

    let connected = false
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await wait(800)
      const status = await cdp(`document.querySelector('.together__status')?.textContent ?? ''`)
      if (String(status).includes('已连接')) {
        connected = true
        break
      }
    }
    record('自动连接公网中继（wss + 口令）', connected)
    if (!connected) {
      const err = await cdp(`document.querySelector('.together__error')?.textContent ?? '(无错误信息)'`)
      log(`状态异常，页面错误提示: ${err}`)
    }

    // 地区应是内置下拉（34 个省级行政区 + 不限地区）
    const regionOptions = await cdp(`(() => {
      const selects = [...document.querySelectorAll('.together__filter select')]
      const region = selects[selects.length - 1]
      return region ? region.options.length : 0
    })()`)
    record('地区为内置下拉', Number(regionOptions) >= 30, `地区选项 ${regionOptions} 个`)

    await wait(1000)
    const balanceShown = await cdp(`/账户余额|充值余额|礼物余额/.test(document.body.innerText)`)
    record('余额区域渲染', balanceShown === true)

    // 3. 建房 → 成为房主
    await cdp(`(() => {
      const input = document.querySelector('.together__create .text-input')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(ROOM_NAME)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await wait(400)
    await clickByText('创建房间')
    let isHost = false
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await wait(700)
      const badge = await cdp(`document.querySelector('.together__badge')?.textContent ?? ''`)
      if (String(badge).includes('我是房主')) {
        isHost = true
        break
      }
    }
    record('创建房间并成为房主', isHost, `房间名 ${ROOM_NAME}`)

    const roomVisible = await cdp(`document.body.innerText.includes(${JSON.stringify(ROOM_NAME)})`)
    record('房间信息回显到房间列表', roomVisible === true)

    // 4. 聊天：发一条消息并断言出现在聊天区
    await cdp(`(() => {
      const input = document.querySelector('.together__compose .text-input')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '自测消息')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await wait(700)
    // 用回车发送（与真实用户一致，也避免按钮仍处于 disabled 时点空）
    await cdp(`(() => {
      const input = document.querySelector('.together__compose .text-input')
      if (!input) return false
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)
    let chatShown = false
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await wait(500)
      chatShown = (await cdp(`document.querySelector('.together__chat')?.innerText.includes('自测消息') ?? false`)) === true
      if (chatShown) break
    }
    if (!chatShown) await clickByText('发送')
    if (!chatShown) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await wait(500)
        chatShown = (await cdp(`document.querySelector('.together__chat')?.innerText.includes('自测消息') ?? false`)) === true
        if (chatShown) break
      }
    }
    record('聊天消息发送成功', chatShown === true)

    // 5. 礼物：进入房间后礼物目录应可见；余额（含首次赠送 1 元）只买得起便宜的礼物
    await wait(800)
    const giftCount = await cdp(`document.querySelectorAll('.together__gift').length`)
    record('礼物目录已下发（房间内展示）', Number(giftCount) > 0, `礼物按钮 ${giftCount} 个`)
    const giftState = await cdp(`(() => {
      const gifts = [...document.querySelectorAll('.together__gift')]
      return {
        total: gifts.length,
        enabled: gifts.filter((gift) => !gift.disabled).length,
        maxDisabled: gifts.length > 0 ? gifts[gifts.length - 1].disabled : null
      }
    })()`)
    record(
      '余额决定可购范围（1 元礼物可买、最贵礼物禁用）',
      Number(giftState?.enabled) >= 1 && giftState?.maxDisabled === true,
      `可买 ${giftState?.enabled} / 共 ${giftState?.total}`
    )

    // 6. 充值：自定义 95 元必须下成 95.00 元的订单（回归「输入 95 显示 1 元」）
    const openedRecharge = await cdp(`(() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('充值'))
      if (!button) return false
      button.click()
      return true
    })()`)
    record('点击充值入口', openedRecharge === true)
    await wait(800)
    const modalOpen = await cdp(`Boolean(document.querySelector('.together__modal'))`)
    record('充值弹窗打开', modalOpen === true)

    if (modalOpen) {
      // 选「自定义金额」并输入 95
      await cdp(`(() => {
        const button = [...document.querySelectorAll('.together__amount')].find((item) => item.textContent.includes('自定义'))
        if (button) button.click()
        return Boolean(button)
      })()`)
      await wait(400)
      await cdp(`(() => {
        const input = document.querySelector('.together__custom .text-input')
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, '95')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await wait(500)
      const hint = await cdp(`document.querySelector('.together__custom .together__hint')?.textContent ?? ''`)
      record('自定义金额提示正确', String(hint).includes('95.00'), `${hint}`)

      await clickByText('生成收款码')
      let orderText = ''
      for (let attempt = 0; attempt < 25; attempt += 1) {
        await wait(900)
        orderText = (await cdp(`document.querySelector('.together__pay-amount')?.textContent ?? ''`)) || ''
        if (orderText.includes('95.00')) break
      }
      record('下单金额与输入一致（95.00 元）', orderText.includes('95.00'), orderText || '(未出码)')
      if (!orderText.includes('95.00')) log(`支付区文本: ${orderText || '(空)'}`)
      await clickByText('关闭')
      await wait(500)
    }
    if (modalOpen) {
      await clickByText('生成收款码')
      let qrShown = false
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await wait(900)
        qrShown = (await cdp(`Boolean(document.querySelector('.together__qr'))`)) === true
        if (qrShown) break
      }
      record('支付宝真实下单并渲染收款码', qrShown)
      const payText = await cdp(`document.querySelector('.together__pay')?.innerText ?? ''`)
      if (!qrShown) log(`支付区文本: ${String(payText).slice(0, 120)}`)
      await clickByText('关闭')
      await wait(500)
    }

    // 7. 双端同步：脚本端建房并当房主，应用端加入后应跟随房主的播放状态
    const script = scriptClient()
    await script.ready
    script.send({
      type: 'hello',
      profile: { uid: `script-${Date.now()}`, nickname: '脚本房主', gender: 'male', age: 26, region: '香港' }
    })
    await script.waitFor('welcome')
    script.send({ type: 'createRoom', name: SYNC_ROOM })
    const created = await script.waitFor('roomJoined')
    record('脚本端创建同步房间', Boolean(created.room?.id), `roomId=${created.room?.id}`)

    // 应用端先离开自己的房间，再刷新房间列表并加入脚本房间
    await clickByText('离开房间')
    await wait(600)
    await clickByText('刷新')
    await wait(1200)
    const joined = await cdp(`(() => {
      const rooms = [...document.querySelectorAll('.together__room')]
      const target = rooms.find((room) => room.textContent.includes(${JSON.stringify(SYNC_ROOM)}))
      if (!target) return false
      const button = [...target.querySelectorAll('button')].find((item) => item.textContent.trim() === '加入')
      if (!button) return false
      button.click()
      return true
    })()`)
    record('应用端加入脚本房间', joined === true)

    let following = false
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await wait(600)
      const badge = await cdp(`document.querySelector('.together__badge')?.textContent ?? ''`)
      if (String(badge).includes('跟随房主')) {
        following = true
        break
      }
    }
    record('应用端显示「跟随房主」', following)

    // 对照组：先在同一房间发一条聊天，确认消息投递链路本身是通的
    script.send({ type: 'chat', text: '同步链路对照消息' })
    let chatArrived = false
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await wait(500)
      chatArrived = (await cdp(`document.querySelector('.together__chat')?.innerText.includes('同步链路对照消息') ?? false`)) === true
      if (chatArrived) break
    }
    record('同房间消息投递正常（对照组）', chatArrived)

    // 房主广播播放状态 → 应用端播放器应切到这首歌（用缓存音源，能真的播放）
    script.send({
      type: 'roomState',
      state: {
        track: {
          id: CACHED_TRACK_ID,
          name: CACHED_TRACK_NAME,
          artists: [{ id: 1, name: '同步测试' }],
          album: { id: 1, name: '同步测试', picUrl: '' },
          durationMS: 30000
        },
        position: 2,
        playing: true,
        at: Date.now()
      }
    })

    let synced = false
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await wait(700)
      const title = await cdp(`document.querySelector('.player-bar__title')?.textContent ?? ''`)
      if (String(title).includes(CACHED_TRACK_NAME)) {
        synced = true
        break
      }
    }
    record('应用端跟随房主播放（歌名同步）', synced, planted ? '使用缓存音源真实播放' : '无样本（预期失败）')
    await wait(1500)
    const syncInfo = await cdp(`document.querySelector('.together__sync')?.textContent ?? '(无同步提示)'`)
    const bodyHasSync = await cdp(`document.body.innerText.includes('已同步房主进度') || document.body.innerText.includes('跟随播放失败')`)
    log(`同步提示元素: ${syncInfo} / 页面文本含同步提示: ${bodyHasSync}`)
    log(`跟随状态提示: ${syncInfo}`)
    if (!synced) {
      const title = await cdp(`document.querySelector('.player-bar__title')?.textContent ?? '(空)'`)
      const error = await cdp(`document.querySelector('.together__error')?.textContent ?? '(无错误提示)'`)
      log(`播放条歌名仍为: ${title}`)
      log(`页面错误提示: ${error}`)
    }

    script.socket.close()
  } catch (cause) {
    record('测试执行异常', false, String(cause).slice(0, 200))
  } finally {
    try {
      execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*youyou-together-ui-test*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'ignore' }
      )
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((result) => !result.ok)
  log(failed.length === 0 ? 'TOGETHER-UI OK' : `TOGETHER-UI FAILED (${failed.length}/${results.length})`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((cause) => {
  console.error(`[together-ui] 失败: ${cause}`)
  process.exit(1)
})
