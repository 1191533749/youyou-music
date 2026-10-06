/**
 * 一起听中继的本地端到端测试：启动服务器 + 两个客户端跑完整流程。
 *
 * 覆盖：握手资料 → 建房/加入 → 播放状态同步 → 聊天 → 听友筛选 → 赠礼扣费/收益 → 余额。
 * 支付路径只验证「未配置私钥时的明确报错」，真实下单需要服务器配置支付宝私钥。
 *
 * 用法：node scripts/test-relay.mjs
 */
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const PORT = 8799

function log(message) {
  console.log(`[relay-test] ${message}`)
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForHealth(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`)
      if (response.ok) return await response.json()
    } catch {
      /* 还没起来 */
    }
    await wait(200)
  }
  throw new Error('服务器未在超时内就绪')
}

/** 一个测试客户端：把收到的消息按类型收集起来，并提供 await 某个类型的能力。 */
function makeClient(name) {
  const received = []
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}`)
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', (event) => reject(new Error(`${name} 连接失败 ${event.message ?? ''}`)))
  })
  socket.addEventListener('message', (event) => {
    try {
      received.push(JSON.parse(event.data))
    } catch {
      /* ignore */
    }
  })
  const send = (message) => socket.send(JSON.stringify(message))
  const waitFor = async (type, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = received.find((entry) => entry.type === type)
      if (found) return found
      await wait(50)
    }
    throw new Error(`${name} 未收到 ${type}（已收到：${received.map((r) => r.type).join(',')}）`)
  }
  const hello = async (profile) => {
    await ready
    send({ type: 'hello', profile })
    return waitFor('welcome')
  }
  return { name, received, send, waitFor, hello, close: () => socket.close() }
}

async function main() {
  const server = spawn(process.execPath, [path.join(root, 'server', 'index.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'ignore'],
    cwd: root
  })

  const results = []
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  }

  try {
    const health = await waitForHealth()
    record('服务器健康检查', health.ok === true, `gifts=${health.gifts} alipay=${health.alipay}`)

    const alice = makeClient('alice')
    const bob = makeClient('bob')
    const welcomeA = await alice.hello({
      uid: 'u-alice',
      nickname: '小鱼',
      gender: 'female',
      age: 24,
      region: '上海'
    })
    record('客户端握手并拿到礼物目录', Array.isArray(welcomeA.gifts) && welcomeA.gifts.length >= 5, `礼物 ${welcomeA.gifts?.length} 种`)
    await bob.hello({ uid: 'u-bob', nickname: '阿海', gender: 'male', age: 27, region: '广东' })

    // 建房 / 加入
    alice.send({ type: 'createRoom', name: '一起听周杰伦' })
    const joinedA = await alice.waitFor('roomJoined')
    const roomId = joinedA.room.id
    record('创建房间', Boolean(roomId), `roomId=${roomId}`)

    bob.send({ type: 'joinRoom', roomId })
    const joinedB = await bob.waitFor('roomJoined')
    record('加入房间', joinedB.room.members === 2, `成员数=${joinedB.room.members}`)
    const peerJoined = await alice.waitFor('peerJoined')
    record('房主收到新成员通知', peerJoined.member?.nickname === '阿海', `nickname=${peerJoined.member?.nickname}`)

    // 播放状态同步
    alice.send({
      type: 'roomState',
      state: { track: { id: 186016, name: '晴天' }, position: 12.5, playing: true, at: Date.now() }
    })
    const sync = await bob.waitFor('roomState')
    record('播放状态同步到对方', sync.state?.track?.name === '晴天' && sync.state?.playing === true, `position=${sync.state?.position}`)

    // 聊天
    bob.send({ type: 'chat', text: '这首歌好听', emoji: '🎵' })
    const chatA = await alice.waitFor('chat')
    record('聊天消息互达', chatA.text === '这首歌好听' && chatA.nickname === '阿海', `from=${chatA.nickname}`)

    // 听友筛选
    alice.send({ type: 'listListeners', filter: { gender: 'male' } })
    const listeners = await alice.waitFor('listeners')
    const onlyMale = listeners.listeners.every((entry) => entry.gender === 'male')
    record('按性别筛选听友', onlyMale && listeners.listeners.length >= 1, `命中 ${listeners.listeners.length} 人`)

    alice.send({ type: 'listListeners', filter: { region: '广东', minAge: 25 } })
    const byRegion = await alice.waitFor('listeners')
    record(
      '按地区+年龄筛选',
      byRegion.listeners.length === 1 && byRegion.listeners[0].nickname === '阿海',
      `命中 ${byRegion.listeners.length} 人`
    )

    // 余额与赠礼（余额为 0 时应明确报错）
    alice.send({ type: 'balance' })
    const balance = await alice.waitFor('balance')
    record('查询余额', typeof balance.balance === 'number', `余额=${balance.balance} 分`)

    alice.send({ type: 'gift', giftId: 'rose' })
    const giftError = await alice.waitFor('error')
    record('余额不足时拒绝赠礼', String(giftError.message).includes('余额不足'), giftError.message)

    // 支付：未配置私钥时必须给出明确原因，而不是静默失败
    alice.send({ type: 'recharge', amountFen: 1000 })
    const recharge = await alice.waitFor('rechargeResult')
    record('充值未配置私钥时明确报错', recharge.ok === false && /私钥/.test(String(recharge.message)), recharge.message)

    alice.send({ type: 'listRooms' })
    const rooms = await alice.waitFor('rooms')
    record('房间列表可见', rooms.rooms.some((room) => room.id === roomId), `房间数=${rooms.rooms.length}`)

    alice.send({ type: 'leaveRoom' })
    await alice.waitFor('roomLeft')
    const peerLeft = await bob.waitFor('peerLeft')
    record('离开房间通知对方', peerLeft.member !== undefined, `成员=${peerLeft.member?.nickname}`)

    alice.close()
    bob.close()
  } catch (cause) {
    record('测试执行异常', false, String(cause).slice(0, 200))
  } finally {
    server.kill()
  }

  const failed = results.filter((result) => !result.ok)
  log(failed.length === 0 ? 'RELAY-E2E OK' : `RELAY-E2E FAILED (${failed.length}/${results.length})`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main()
