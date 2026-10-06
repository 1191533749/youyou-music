/**
 * 公网中继验证：连到已部署的中继地址跑完整流程，并验证支付宝真实下单出码。
 *
 * 用法：
 *   $env:RELAY_URL="ws://198.44.179.69:8787"; node scripts/test-relay-public.mjs
 */
import process from 'node:process'

const URL_BASE = process.env.RELAY_URL ?? 'ws://198.44.179.69:8787'
const TOKEN = process.env.RELAY_TOKEN ?? ''
const HTTP_BASE = URL_BASE.replace(/^ws/, 'http')
const CONNECT_URL = TOKEN ? `${URL_BASE}${URL_BASE.includes('?') ? '&' : '?'}token=${TOKEN}` : URL_BASE

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeClient(name) {
  const received = []
  const socket = new WebSocket(CONNECT_URL)
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error(`${name} 连接失败`)))
  })
  socket.addEventListener('message', (event) => {
    try {
      received.push(JSON.parse(event.data))
    } catch {
      /* ignore */
    }
  })
  const send = (message) => socket.send(JSON.stringify(message))
  const waitFor = async (type, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = received.find((entry) => entry.type === type)
      if (found) return found
      await wait(60)
    }
    throw new Error(`${name} 未收到 ${type}（收到：${received.map((r) => r.type).join(',')}）`)
  }
  return {
    name,
    received,
    send,
    waitFor,
    hello: async (profile) => {
      await ready
      send({ type: 'hello', profile })
      return waitFor('welcome')
    },
    close: () => socket.close()
  }
}

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  console.log(`[public] 目标: ${URL_BASE}${TOKEN ? ' (带口令)' : ''}`)
  const health = await (await fetch(`${HTTP_BASE}/health`)).json()
  record('公网健康检查', health.ok === true, `alipay=${health.alipay} gifts=${health.gifts} uptime=${health.uptime}s`)

  if (TOKEN) {
    // 口令错误的连接必须被拒绝
    const denied = await new Promise((resolve) => {
      const bad = new WebSocket(`${URL_BASE}?token=wrong-token`)
      bad.addEventListener('open', () => {
        bad.close()
        resolve(false)
      })
      bad.addEventListener('error', () => resolve(true))
      setTimeout(() => resolve(true), 5000)
    })
    record('错误口令被拒绝', denied === true)
  }

  const a = makeClient('A')
  const b = makeClient('B')
  const welcome = await a.hello({ uid: 'pub-a', nickname: '小鱼', gender: 'female', age: 24, region: '上海' })
  record('握手', Array.isArray(welcome.gifts) && welcome.gifts.length > 0, `礼物 ${welcome.gifts?.length} 种`)
  await b.hello({ uid: 'pub-b', nickname: '阿海', gender: 'male', age: 27, region: '广东' })

  a.send({ type: 'createRoom', name: '公网一起听' })
  const room = await a.waitFor('roomJoined')
  b.send({ type: 'joinRoom', roomId: room.room.id })
  const joined = await b.waitFor('roomJoined')
  record('公网建房/加入', joined.room.members === 2, `roomId=${room.room.id} 成员=${joined.room.members}`)

  a.send({ type: 'roomState', state: { track: { id: 1901371647, name: '漠河舞厅' }, position: 33.5, playing: true, at: Date.now() } })
  const sync = await b.waitFor('roomState')
  record('公网播放同步', sync.state?.track?.name === '漠河舞厅', `position=${sync.state?.position}`)

  b.send({ type: 'chat', text: '公网聊天测试' })
  const chat = await a.waitFor('chat')
  record('公网聊天', chat.text === '公网聊天测试', `来自 ${chat.nickname}`)

  // 去重检查：表情消息在双方各应只出现一次（曾经发一条到对方会显示两条）
  b.send({ type: 'chat', text: '', emoji: '🎵' })
  await wait(1800)
  const bEmoji = b.received.filter((m) => m.type === 'chat' && m.emoji === '🎵').length
  const aEmoji = a.received.filter((m) => m.type === 'chat' && m.emoji === '🎵').length
  record('表情消息不重复（发送方与接收方各一条）', bEmoji === 1 && aEmoji === 1, `发送方=${bEmoji} 接收方=${aEmoji}`)

  // 礼物价格区间：最低 1 元、最高 99.99 元
  const prices = welcome.gifts.map((gift) => gift.price)
  record(
    '礼物价格在 1.00 ~ 99.99 元之间',
    prices.every((price) => price >= 100 && price <= 9999),
    `最低 ${Math.min(...prices) / 100} 元 / 最高 ${Math.max(...prices) / 100} 元`
  )

  // 进房即同步：新成员请求同步后，房主应收到 syncRequest
  b.send({ type: 'syncRequest' })
  const syncRequest = await a.waitFor('syncRequest', 6000)
  record('新成员进房可要求房主立即同步', typeof syncRequest.from === 'number', `from=${syncRequest.from}`)

  a.send({ type: 'listListeners', filter: { gender: 'male', region: '广东' } })
  const listeners = await a.waitFor('listeners')
  record('公网听友筛选', listeners.listeners.length >= 1, `命中 ${listeners.listeners.length} 人`)

  // 真实支付宝下单：1 元，仅验证出码与订单可查询（不支付，订单会自然失效）
  a.send({ type: 'recharge', amountFen: 100 })
  const recharge = await a.waitFor('rechargeResult', 20000)
  record(
    '支付宝真实下单出码',
    recharge.ok === true && String(recharge.qrCode ?? '').startsWith('https://qr.alipay.com/'),
    `outTradeNo=${recharge.outTradeNo} qr=${String(recharge.qrCode ?? '').slice(0, 46)}...`
  )

  if (recharge.ok) {
    a.send({ type: 'pollOrder', outTradeNo: recharge.outTradeNo })
    const status = await a.waitFor('orderStatus', 20000)
    record(
      '订单状态可轮询（未支付应为 pending）',
      status.ok === true && status.paid === false,
      `status=${status.status}`
    )
  }

  a.close()
  b.close()

  // 首次使用赠送 1 元礼物额度（用全新 uid，保证是"首次"）
  const fresh = makeClient('C')
  const freshWelcome = await fresh.hello({ uid: `first-${Date.now()}`, nickname: '首赠测试', gender: 'female', age: 22, region: '北京' })
  record(
    '首次使用赠送 1 元礼物额度',
    freshWelcome.balance === 100 && freshWelcome.firstGift === true,
    `balance=${freshWelcome.balance} firstGift=${freshWelcome.firstGift}`
  )
  fresh.close()

  const failed = results.filter((r) => !r.ok)
  console.log(failed.length === 0 ? '[public] PUBLIC-RELAY OK' : `[public] PUBLIC-RELAY FAILED (${failed.length})`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((cause) => {
  console.error('[public] 异常:', cause.message ?? cause)
  process.exit(1)
})
