/**
 * bug 猎手 · 路径 10：一起听（进出房间 / 送礼 / 被顶号）。
 * 改名项：Together.tsx 无任何改名控件、relay.ts 协议无 renameRoom —— 记为 N/A（脚本末尾打印证据）。
 * 验证链路：渲染进程 WebSocket → wss://yy.ytw.asia/relay?token=yy-7f3a9c2e51d84b06
 *  - 应用创建房间成为房主 → 脚本端(不同 uid)加入 → 成员数 2
 *  - 应用送最便宜礼物 → 脚本端收到 gift 广播 + 应用余额扣减 + 礼物日志出现
 *  - 离开房间 → 加入脚本端(房主)房间 → 跟随房主 → 房主广播状态 → 应用真实切歌出声
 *  - 脚本端用相同 uid 顶号 → 应用侧 close code 4000 → 状态 closed + 详情「被同一账号的新连接取代」且不自动重连死循环
 */
import * as path from 'node:path'
import * as os from 'node:os'
import {
  log, wait, launchBugInstance, killInstance, waitReady, cdp, waitFor, playerState,
  waitPlaying, clickNav, freshUserData, waitPortFree, plantCachedAudio
} from './test-qa-bug-lib.mjs'

const PORT = 9421
const userData = path.join(os.tmpdir(), 'youyou-bug-together')
const ROOM_NAME = `QA房间${Date.now() % 10000}`
const SYNC_ROOM = `QA同步房${Date.now() % 10000}`
const RELAY_URL = 'wss://yy.ytw.asia/relay'
const RELAY_TOKEN = 'yy-7f3a9c2e51d84b06'
const FIXTURE = { id: 999000001, name: '同步测试曲', artists: [{ id: 1, name: 'QA' }], album: { id: 1, name: 'QA专辑' }, durationMS: 30000 }

const results = []
const bugs = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'BUG?'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const report = (pathNo, operation, symptom, severity, evidence) => {
  bugs.push(`路径${pathNo} → ${operation} → ${symptom} → 严重度:${severity}${evidence ? ` | 证据:${evidence}` : ''}`)
  log(`🐛 ${bugs[bugs.length - 1]}`)
}

/** 极简脚本端中继客户端。 */
function scriptClient(uid, nickname) {
  const socket = new WebSocket(`${RELAY_URL}?token=${RELAY_TOKEN}`)
  const received = []
  socket.addEventListener('message', (event) => {
    try { received.push(JSON.parse(event.data)) } catch { /* ignore */ }
  })
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('脚本端连接失败')))
  })
  const send = (payload) => socket.send(JSON.stringify(payload))
  const waitFor = async (type, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = received.find((entry) => entry.type === type)
      if (hit) return hit
      await wait(80)
    }
    return null
  }
  return { socket, send, waitFor, ready, received }
}

const j = (value) => JSON.stringify(value)

async function main() {
  freshUserData(userData)
  killInstance(userData)
  plantCachedAudio(userData)
  const inst = await launchBugInstance({ port: PORT, userData })
  try {
    const ready = await waitReady(PORT, 90_000)
    record('实例启动', ready)
    if (!ready) return

    const auth = await cdp(PORT, `(async () => (await window.youyou.invoke('auth:state')).data)()`)
    const userId = auth.value?.profile?.userId
    record('登录态（一起听需要登录）', auth.ok && auth.value?.loggedIn === true, `nick=${auth.value?.profile?.nickname} uid=${userId}`)
    if (!userId) return

    await clickNav(PORT, '一起听')
    await wait(1500)

    // 等中继连上
    let connected = false
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await wait(1000)
      const status = await cdp(PORT, `document.querySelector('.together__status')?.textContent ?? ''`)
      if (String(status.value ?? '').includes('已连接')) { connected = true; break }
    }
    record('自动连接中继', connected)
    if (!connected) {
      const err = await cdp(PORT, `document.querySelector('.together__error')?.textContent ?? document.querySelector('.together__detail')?.textContent ?? '(无)'`)
      log(`中继未连接，错误: ${err.value}`)
      return
    }

    // 1. 创建房间成为房主（进）
    await cdp(PORT, `(() => {
      const input = document.querySelector('.together__create .text-input')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${j(ROOM_NAME)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await wait(400)
    await cdp(PORT, `(() => {
      const button = document.querySelector('.together__create button.button--primary')
      if (button) button.click()
      return Boolean(button)
    })()`)
    let isHost = false
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(700)
      const badge = await cdp(PORT, `document.querySelector('.together__badge')?.textContent ?? ''`)
      if (String(badge.value ?? '').includes('我是房主')) { isHost = true; break }
    }
    record('创建房间并成为房主（进房）', isHost, `房间=${ROOM_NAME}`)
    if (!isHost) return

    // 2. 脚本端（另一 uid）加入应用房间
    const peer = scriptClient(`qa-peer-${Date.now()}`, 'QA听友')
    await peer.ready
    peer.send({ type: 'hello', profile: { uid: 'qa-peer-x', nickname: 'QA听友' } })
    await peer.waitFor('welcome')
    peer.send({ type: 'listRooms' })
    const roomsMsg = await peer.waitFor('rooms')
    const myRoom = (roomsMsg?.rooms ?? []).find((room) => room.name === ROOM_NAME)
    record('脚本端能看到应用创建的房间', Boolean(myRoom), `roomId=${myRoom?.id}`)
    if (!myRoom) return
    peer.send({ type: 'joinRoom', roomId: myRoom.id })
    const joined = await peer.waitFor('roomJoined')
    record('脚本端加入房间', Boolean(joined))
    await wait(1500)
    const members = await cdp(PORT, `document.querySelectorAll('.together__member').length`)
    record('应用端成员列表包含对方（peerJoined）', Number(members.value) >= 2, `成员数=${members.value}`)

    // 3. 送礼：点最便宜的可用礼物 → 脚本端收到 gift 广播、余额扣减、礼物日志出现
    const before = await cdp(PORT, `(async () => {
      const text = document.querySelector('.together__balance')?.innerText ?? ''
      const gifts = [...document.querySelectorAll('.together__gift')]
      const enabled = gifts.filter((gift) => !gift.disabled)
      if (enabled.length === 0) return { text, enabled: 0 }
      const pick = enabled[0]
      pick.click()
      return { text, enabled: enabled.length, gift: pick.textContent.trim() }
    })()`)
    if (before.value?.enabled > 0) {
      const giftEvt = await peer.waitFor('gift', 12000)
      await wait(2500)
      const afterGift = await cdp(PORT, `(() => ({
        balance: document.querySelector('.together__balance')?.innerText ?? '',
        log: document.querySelector('.together__gift-log')?.innerText ?? ''
      }))()`)
      const balanceDropped = before.value?.text !== afterGift.value?.balance && /[1-9]/.test(before.value?.text ?? '')
      record('送礼：脚本端收到 gift 广播', Boolean(giftEvt), j(giftEvt).slice(0, 120))
      record('送礼：应用端礼物日志/余额落定', Boolean(afterGift.value?.log) || balanceDropped, `${j(afterGift.value).slice(0, 120)} 送前:${j(before.value?.text)}`)
      if (!giftEvt) report(10, '一起听送礼', '礼物点了但对方收不到广播', '体验差', `无 gift 事件 ${j(before.value).slice(0, 100)}`)
    } else {
      log(`N/A 送礼：余额不足所有礼物均禁用（enabled=0），无法点击 —— 非 bug（按钮 disabled 是设计）`)
    }

    // 4. 离开房间（出）
    await cdp(PORT, `(() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '离开房间')
      if (button) button.click()
      return Boolean(button)
    })()`)
    let leftRoom = false
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await wait(700)
      const badge = await cdp(PORT, `document.querySelector('.together__badge')`)
      if (badge.value === null) { leftRoom = true; break }
    }
    record('离开房间（出房）', leftRoom)

    // 5. 加入脚本端的房间并跟随房主（进出+同步）
    peer.send({ type: 'createRoom', name: SYNC_ROOM })
    const hostRoom = await peer.waitFor('roomJoined')
    record('脚本端创建房间', Boolean(hostRoom))
    let joinedSync = false
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await cdp(PORT, `(() => {
        const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '刷新')
        if (button) button.click()
        return Boolean(button)
      })()`)
      await wait(1500)
      const clickRes = await cdp(PORT, `(() => {
        const rooms = [...document.querySelectorAll('.together__room')]
        const target = rooms.find((room) => room.textContent.includes(${j(SYNC_ROOM)}))
        if (!target) return false
        const button = [...target.querySelectorAll('button')].find((item) => item.textContent.trim() === '加入')
        if (!button) return false
        button.click()
        return true
      })()`)
      if (clickRes.value === true) { joinedSync = true; break }
    }
    let following = false
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await wait(700)
      const badge = await cdp(PORT, `document.querySelector('.together__badge')?.textContent ?? ''`)
      if (String(badge.value ?? '').includes('跟随房主')) { following = true; break }
    }
    record('加入脚本房间并显示「跟随房主」', joinedSync === true && following, `joined=${joinedSync} follow=${following}`)

    // 6. 房主广播 → 应用跟随播放（真实出声）
    peer.send({
      type: 'roomState',
      state: { track: FIXTURE, position: 2, playing: true, at: Date.now() }
    })
    let synced = false
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await wait(800)
      const title = await cdp(PORT, `document.querySelector('.player-bar__title')?.textContent ?? ''`)
      if (String(title.value ?? '').includes('同步测试曲')) { synced = true; break }
    }
    const syncPlaying = await playerState(PORT)
    record('跟随房主切歌并出声', synced && syncPlaying.value?.playing === true, `title同步=${synced} playing=${syncPlaying.value?.playing} pos=${syncPlaying.value?.position?.toFixed(1)}`)
    if (!synced) {
      const syncInfo = await cdp(PORT, `document.querySelector('.together__sync')?.textContent ?? document.querySelector('.together__error')?.textContent ?? '(无)'`)
      report(10, '一起听跟随房主', '房主广播后应用未跟随播放', '体验差', `提示:${syncInfo.value}`)
    }

    // 7. 被顶号：相同 uid 的新连接 → 应用 close 4000 → 状态 closed + 详情，且不自动重连
    peer.socket.close()
    await wait(1000)
    const kicker = scriptClient(String(userId), '顶号者')
    await kicker.ready
    kicker.send({ type: 'hello', profile: { uid: String(userId), nickname: '顶号者' } })
    await wait(3000)
    const kicked = await cdp(PORT, `(() => ({
      status: document.querySelector('.together__status')?.textContent ?? '',
      detail: document.querySelector('.together__detail')?.textContent ?? ''
    }))()`)
    const kickedOk = kicked.value?.detail?.includes('同一账号的新连接取代') === true && !(kicked.value?.status ?? '').includes('已连接')
    record('被顶号：旧连接关闭且显示明确详情', kickedOk, j(kicked.value))
    if (!kickedOk) report(10, '一起听被顶号', '顶号后无明确提示或仍显示已连接', '体验差', j(kicked.value))

    // 不自动重连：8s 内状态应稳定在 closed（不循环连接）
    await wait(4000)
    const s1 = await cdp(PORT, `document.querySelector('.together__status')?.textContent ?? ''`)
    await wait(4000)
    const s2 = await cdp(PORT, `document.querySelector('.together__status')?.textContent ?? ''`)
    const stable = s1.value === s2.value && !String(s1.value ?? '').includes('连接中')
    record('被顶号后不自动重连（无互顶循环）', stable, `status=${s1.value}`)
    if (!stable) report(10, '一起听被顶号', '被顶号后仍在反复重连（互顶循环）', '挂死', `status ${s1.value} → ${s2.value}`)

    // 应用存活、播放器仍可用
    const alive = await cdp(PORT, `Boolean(window.youyou)`)
    const st = await playerState(PORT)
    record('全程实例存活、播放器通道仍响应', alive.value === true && st.ok, `playing=${st.value?.playing}`)

    // 改名项：无入口的证据
    const renameUi = await cdp(PORT, `(() => {
      const texts = [...document.querySelectorAll('button')].map((b) => b.textContent.trim())
      return { hasRename: texts.some((t) => t.includes('改名') || t.includes('重命名') || t.includes('修改房间名')) }
    })()`)
    record('改名入口存在性检查（预期：不存在→N/A）', renameUi.value?.hasRename === false, `改名按钮=${renameUi.value?.hasRename}`)

    peer.socket.close()
    kicker.socket.close()
  } catch (cause) {
    record('执行异常', false, String(cause).slice(0, 200))
  } finally {
    killInstance(userData, inst?.pid ?? 0)
    await waitPortFree(PORT)
  }
}

await main()

const failed = results.filter((item) => !item.ok)
log(`结果: ${results.length - failed.length}/${results.length} 通过，bugs=${bugs.length}`)
for (const line of bugs) console.log(`REPORT|${line}`)
if (failed.length > 0 || bugs.length > 0) process.exitCode = 1
