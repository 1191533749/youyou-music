/**
 * 「一起听」中继客户端（RelayClient）的自动化测试。
 *
 * 全部走真实的 RelayClient + 真实的 server/index.mjs：token 校验、广播范围、
 * 余额扣减这些行为只有在真服务器上才成立，mock 掉 socket 就什么都没验证。
 * 服务器在 beforeAll 起、afterAll 杀；每个用例自建的客户端在 afterEach 关。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  RelayClient,
  type RelayMessage,
  type RelayProfile,
  type RelayStatus
} from '../src/renderer/src/lib/relay'
import type { TrackDTO } from '@shared/types'

const PORT = 8797
const TOKEN = 'test-token'
const URL = `ws://127.0.0.1:${PORT}`
/** 单次等待上限：本地服务器很快，8 秒足够，超过就是真的没收到。 */
const WAIT_MS = 8000
const TEST_TIMEOUT = 20_000

type MessageOf<T extends RelayMessage['type']> = Extract<RelayMessage, { type: T }>

interface Harness {
  client: RelayClient
  messages: RelayMessage[]
  statuses: RelayStatus[]
}

let server: ChildProcess | undefined
/** 当前用例创建的客户端；afterEach 统一关闭，避免连接泄漏到下一条用例。 */
let live: RelayClient[] = []
/** 健康检查返回的 alipay.configured，用来判断「未配置私钥」前提是否成立。 */
let alipayConfigured = false

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms) as unknown as { unref?: () => void }
    // 等待本身不该拖住进程退出。
    timer.unref?.()
  })
}

async function waitForHealth(timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`)
      if (response.ok) return (await response.json()) as Record<string, unknown>
    } catch {
      /* 还没起来，继续等 */
    }
    await delay(150)
  }
  throw new Error(`中继服务器未在 ${timeoutMs}ms 内就绪（端口 ${PORT}）`)
}

/** uid 每次随机：余额是持久化的，固定 uid 会让「余额为 0」的用例在第二次运行时失败。 */
function freshUid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function connect(profile: RelayProfile, token = TOKEN): Harness {
  const messages: RelayMessage[] = []
  const statuses: RelayStatus[] = []
  const client = new RelayClient({
    url: URL,
    token,
    onMessage: (message) => messages.push(message),
    onStatus: (status) => statuses.push(status)
  })
  live.push(client)
  // 资料必须走 connect(profile) 传进去：构造参数里的 profile 不会写进客户端自身的资料，
  // 而 hello 是在 socket open 时用那份资料发的。
  client.connect(profile)
  return { client, messages, statuses }
}

async function waitFor<T extends RelayMessage['type']>(
  harness: Harness,
  type: T,
  timeoutMs = WAIT_MS
): Promise<MessageOf<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = harness.messages.find((message) => message.type === type)
    if (found) return found as MessageOf<T>
    if (Date.now() > deadline) {
      const seen = harness.messages.map((message) => message.type).join(', ') || '（无）'
      throw new Error(`等待 ${type} 超时（${timeoutMs}ms）；已收到：${seen}`)
    }
    await delay(25)
  }
}

async function waitForStatus(
  harness: Harness,
  wanted: RelayStatus[],
  timeoutMs = WAIT_MS
): Promise<RelayStatus> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = harness.statuses.find((status) => wanted.includes(status))
    if (found) return found
    if (Date.now() > deadline) {
      const seen = harness.statuses.join(', ') || '（无）'
      throw new Error(`等待状态 ${wanted.join(' / ')} 超时；已收到：${seen}`)
    }
    await delay(25)
  }
}

/** 只带 id/name 的迷你 TrackDTO：中继只转发状态，不校验字段完整性。 */
function miniTrack(id: number, name: string): TrackDTO {
  return { id, name } as unknown as TrackDTO
}

/** 建一对客户端并把它们放进同一个房间，返回房间与两个端点。 */
async function joinTwo(
  roomName = '一起听测试'
): Promise<{ roomId: string; host: Harness; guest: Harness; hostId: number }> {
  const host = connect({ uid: freshUid('host'), nickname: '房主', gender: 'male', region: '上海', age: 30 })
  const hostWelcome = await waitFor(host, 'welcome')
  const guest = connect({ uid: freshUid('guest'), nickname: '听友', gender: 'female', region: '广东', age: 25 })
  await waitFor(guest, 'welcome')

  host.client.createRoom(roomName)
  const created = await waitFor(host, 'roomJoined')

  guest.client.joinRoom(created.room.id)
  const joined = await waitFor(guest, 'roomJoined')
  expect(joined.room.members).toBe(2)

  return { roomId: created.room.id, host, guest, hostId: hostWelcome.clientId }
}

beforeAll(async () => {
  server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), RELAY_TOKEN: TOKEN },
    stdio: 'ignore'
  })
  const health = await waitForHealth()
  expect(health.ok).toBe(true)
  alipayConfigured = health.alipay === true
}, 30_000)

afterEach(() => {
  for (const client of live) client.close()
  live = []
})

afterAll(async () => {
  const child = server
  server = undefined
  if (!child) return
  child.kill()
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    delay(3000)
  ])
})

describe('RelayClient 与中继服务器', () => {
  it(
    '带正确 token 能连接并收到 welcome（gifts 非空、balance 为数字）',
    async () => {
      const alice = connect({ uid: freshUid('alice'), nickname: '小鱼', gender: 'female', region: '上海' })
      const welcome = await waitFor(alice, 'welcome')

      expect(await waitForStatus(alice, ['connected'])).toBe('connected')
      expect(alice.client.connected).toBe(true)
      expect(welcome.clientId).toBeGreaterThan(0)
      expect(Array.isArray(welcome.gifts)).toBe(true)
      expect(welcome.gifts.length).toBeGreaterThan(0)
      expect(typeof welcome.balance).toBe('number')
      expect(Array.isArray(welcome.rooms)).toBe(true)
    },
    TEST_TIMEOUT
  )

  it(
    '错误 token 被拒绝：状态最终为 error/closed，且不会收到 welcome',
    async () => {
      const intruder = connect({ uid: freshUid('intruder'), nickname: '陌生人' }, 'wrong-token')

      expect(await waitForStatus(intruder, ['error', 'closed'])).toMatch(/error|closed/)
      expect(intruder.messages.some((message) => message.type === 'welcome')).toBe(false)
      expect(intruder.client.connected).toBe(false)
    },
    TEST_TIMEOUT
  )

  it(
    'createRoom + joinRoom：成员数为 2，加入者收到 roomJoined',
    async () => {
      const host = connect({ uid: freshUid('host'), nickname: '房主', gender: 'male' })
      const hostWelcome = await waitFor(host, 'welcome')
      const guest = connect({ uid: freshUid('guest'), nickname: '听友', gender: 'female' })
      const guestWelcome = await waitFor(guest, 'welcome')

      host.client.createRoom('一起听测试')
      const created = await waitFor(host, 'roomJoined')
      expect(created.room.id).toBeTruthy()
      expect(created.room.members).toBe(1)
      expect(created.you).toBe(hostWelcome.clientId)

      guest.client.joinRoom(created.room.id)
      const joined = await waitFor(guest, 'roomJoined')
      expect(joined.room.id).toBe(created.room.id)
      expect(joined.room.members).toBe(2)
      expect(joined.you).toBe(guestWelcome.clientId)
      expect(joined.members.map((member) => member.id)).toContain(guestWelcome.clientId)

      // 房主侧同步收到新成员通知
      const peer = await waitFor(host, 'peerJoined')
      expect(peer.member.id).toBe(guestWelcome.clientId)
    },
    TEST_TIMEOUT
  )

  it(
    'A.broadcastState → B 收到 roomState，且 state.track.name 正确',
    async () => {
      const { host, guest, hostId } = await joinTwo('一起听状态同步')

      host.client.broadcastState({
        track: miniTrack(186016, '晴天'),
        position: 12.5,
        playing: true,
        at: Date.now()
      })

      const state = await waitFor(guest, 'roomState')
      expect(state.from).toBe(hostId)
      expect(state.state.track?.name).toBe('晴天')
      expect(state.state.position).toBe(12.5)
      expect(state.state.playing).toBe(true)
    },
    TEST_TIMEOUT
  )

  it(
    "A.chat('hi','🎵') → B 收到 chat，且 text / emoji 正确",
    async () => {
      const { host, guest } = await joinTwo('一起听聊天')

      host.client.chat('hi', '🎵')
      const chat = await waitFor(guest, 'chat')
      expect(chat.text).toBe('hi')
      expect(chat.emoji).toBe('🎵')
      expect(typeof chat.at).toBe('number')

      // 发言者自己也会收到回显
      const echo = await waitFor(host, 'chat')
      expect(echo.text).toBe('hi')
    },
    TEST_TIMEOUT
  )

  it(
    "A.listListeners({ gender: 'male' }) → 收到 listeners，且全部为 male",
    async () => {
      const male = connect({ uid: freshUid('male'), nickname: '男听友', gender: 'male', region: '北京' })
      await waitFor(male, 'welcome')
      const female = connect({ uid: freshUid('female'), nickname: '女听友', gender: 'female', region: '成都' })
      await waitFor(female, 'welcome')

      male.client.listListeners({ gender: 'male' })
      const result = await waitFor(male, 'listeners')

      expect(result.listeners.length).toBeGreaterThan(0)
      expect(result.listeners.every((listener) => listener.gender === 'male')).toBe(true)
      expect(result.listeners.some((listener) => listener.nickname === '女听友')).toBe(false)
    },
    TEST_TIMEOUT
  )

  it(
    "余额不足以买礼物 → 收到 error，且包含「余额不足」",
    async () => {
      const giver = connect({ uid: freshUid('giver'), nickname: '穷听友', gender: 'male' })
      const welcome = await waitFor(giver, 'welcome')
      // 新账号会拿到「首次使用赠送 1 元礼物额度」，所以起步余额是 100 分。
      expect(welcome.balance).toBe(100)
      expect(welcome.firstGift).toBe(true)

      // 再确认一次余额（同时也是对 balance 通道的验证）
      giver.client.requestBalance()
      const balance = await waitFor(giver, 'balance')
      expect(balance.balance).toBe(100)

      // 玫瑰 2 元 > 1 元额度 → 必须被拒绝
      giver.client.sendGift('rose')
      const error = await waitFor(giver, 'error')
      expect(String(error.message)).toContain('余额不足')
    },
    TEST_TIMEOUT
  )

  it(
    '同一账号重复连接 → 只保留最新一条，雷达列表不出现重复的「自己」',
    async () => {
      const uid = freshUid('dup')
      const first = connect({ uid, nickname: '同一个我', gender: 'male' })
      await waitFor(first, 'welcome')

      // 第二个连接（同 uid，比如断网重连/多开实例）上线后，第一个连接被 4000 顶掉。
      const second = connect({ uid, nickname: '同一个我', gender: 'male' })
      await waitFor(second, 'welcome')

      // 旧连接收到 close code 4000 → 不应自动重连（状态回到 closed）。
      await waitForStatus(first, ['closed', 'error'])
      expect(first.client.connected).toBe(false)

      // 找听友列表里同一个 uid 只出现一次。
      second.client.listListeners()
      const listeners = await waitFor(second, 'listeners')
      const mine = (listeners.listeners ?? []).filter((item) => item.nickname === '同一个我')
      expect(mine).toHaveLength(1)
    },
    TEST_TIMEOUT
  )

  it(
    'A.recharge(100) 在未配置支付宝私钥时 → rechargeResult ok=false 且 message 含「私钥」',
    async () => {
      const payer = connect({ uid: freshUid('payer'), nickname: '充值听友', gender: 'male' })
      await waitFor(payer, 'welcome')

      payer.client.recharge(100)
      const result = await waitFor(payer, 'rechargeResult')

      expect(alipayConfigured, '本地服务器不应配置支付宝私钥').toBe(false)
      expect(result.ok).toBe(false)
      expect(String(result.message)).toContain('私钥')
    },
    TEST_TIMEOUT
  )
})
