/**
 * 「一起听」状态容器：把中继客户端包成 React 可用的 store，并负责播放同步。
 *
 * 同步策略：
 *  - 房主（room.hostId === 我的 clientId）在播放状态变化时节流广播；
 *  - 其他成员收到广播后校正本地播放（换歌 → 重设队列并定位；同曲 → 偏差过大才 seek，
 *    播放/暂停状态不一致则跟随），避免双方互相抖动。
 *
 * 实现说明（重要）：这是一个**模块级单例**。App 外壳在启动时用它自动连接中继，
 * 一起听页面读的是同一份状态——两者必须是同一个 store。历史上它曾被写成
 * per-component Hook（每个组件各自 useState），导致「App 连上了、页面却永远显示
 * 正在连接…」的 bug，不要改回 Hook 形态。
 */
import { useSyncExternalStore } from 'react'
import { call } from '../lib/ipc'
import {
  DEFAULT_RELAY_TOKEN,
  DEFAULT_RELAY_URL,
  RelayClient,
  type RelayChatMessage,
  type RelayGift,
  type RelayGiftEvent,
  type RelayListener,
  type RelayMessage,
  type RelayOrderResult,
  type RelayOrderStatus,
  type RelayProfile,
  type RelayRoom,
  type RelayRoomState,
  type RelayStatus
} from '../lib/relay'
import type { PlayerStateDTO, TrackDTO } from '@shared/types'

const STORAGE_KEY = 'youyou.together.v1'

/**
 * 给 IPC 调用加超时：mpv 加载音源时某些调用可能长时间不返回，
 * 没有超时就会永久卡住跟随同步（seek 那步踩过这个坑）。
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (cause) => {
        clearTimeout(timer)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    )
  })
}

interface Persisted {
  url: string
  token: string
  profile: RelayProfile
}

function loadPersisted(): Persisted {
  const fallback: Persisted = { url: DEFAULT_RELAY_URL, token: DEFAULT_RELAY_TOKEN, profile: {} }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<Persisted>
    return {
      url: parsed.url ?? fallback.url,
      token: parsed.token ?? fallback.token,
      profile: parsed.profile ?? {}
    }
  } catch {
    return fallback
  }
}

export interface TogetherMember {
  id: number
  nickname?: string
  isHost?: boolean
}

export interface TogetherRoomView {
  id: string
  name: string
  hostId: number
  you: number
  isHost: boolean
  members: TogetherMember[]
}

export interface TogetherStore {
  state: {
    status: RelayStatus
    detail?: string
    url: string
    token: string
    profile: RelayProfile
    gifts: RelayGift[]
    balance: number
    rooms: RelayRoom[]
    listeners: RelayListener[]
    room?: TogetherRoomView
    messages: RelayChatMessage[]
    giftEvents: RelayGiftEvent[]
    order?: RelayOrderResult
    orderStatus?: RelayOrderStatus
    error?: string
    syncInfo?: string
    notice?: string
  }
  setUrl: (url: string) => void
  setToken: (token: string) => void
  setProfile: (profile: RelayProfile) => void
  /** 连接中继；withProfile 会合并进第一条 hello（保证首个 hello 就带 uid/头像，不留幽灵）。 */
  connect: (withProfile?: RelayProfile) => void
  disconnect: () => void
  listRooms: () => void
  listListeners: (filter?: { gender?: string; region?: string; minAge?: number; maxAge?: number }) => void
  createRoom: (name: string, state?: RelayRoomState) => void
  joinRoom: (roomId: string) => void
  leaveRoom: () => void
  publishState: (state: RelayRoomState) => void
  /** 请求房主同步一次（进房/重连后调用）。 */
  requestSync: () => void
  sendChat: (text: string, emoji?: string) => void
  sendGift: (giftId: string) => void
  recharge: (amountFen: number) => void
  pollOrder: (outTradeNo: string) => void
  clearOrder: () => void
  requestBalance: () => void
}

interface TogetherState {
  status: RelayStatus
  detail?: string
  url: string
  token: string
  profile: RelayProfile
  gifts: RelayGift[]
  balance: number
  rooms: RelayRoom[]
  listeners: RelayListener[]
  room?: TogetherRoomView
  messages: RelayChatMessage[]
  giftEvents: RelayGiftEvent[]
  order?: RelayOrderResult
  orderStatus?: RelayOrderStatus
  error?: string
  syncInfo?: string
  notice?: string
}

const persisted = loadPersisted()

let state: TogetherState = {
  status: 'idle',
  detail: undefined,
  url: persisted.url,
  token: persisted.token,
  profile: persisted.profile,
  gifts: [],
  balance: 0,
  rooms: [],
  listeners: [],
  room: undefined,
  messages: [],
  giftEvents: [],
  order: undefined,
  orderStatus: undefined,
  error: undefined,
  syncInfo: undefined,
  notice: undefined
}

const listeners = new Set<() => void>()
let version = 0

function patch(next: Partial<TogetherState>): void {
  state = { ...state, ...next }
  version += 1
  for (const listener of listeners) listener()
  syncOrderPolling()
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ url: state.url, token: state.token, profile: state.profile }))
  } catch {
    // 存储失败不影响功能
  }
}

// ---- 中继客户端（模块级单例） ----
let client: RelayClient | undefined

/** 房主身份、最近一次广播时间、以及正在应用远端状态时避免回环。 */
let roomRef: TogetherRoomView | undefined
let applyingRef = false
let lastPublishRef = 0
/** 本地最新播放状态：房主被要求同步时（有新人进房）立即用它广播一次。 */
let lastLocalStateRef: RelayRoomState | undefined

/** 支付后自动查询到账：每 3 秒查一次，查到已支付或弹窗关闭就停。 */
let pollTimer: number | undefined

function syncOrderPolling(): void {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer)
    pollTimer = undefined
  }
  if (state.order?.ok && state.order.outTradeNo && !state.orderStatus?.paid) {
    const outTradeNo = state.order.outTradeNo
    pollTimer = window.setInterval(() => client?.pollOrder(outTradeNo), 3000)
  }
}

function ensureClient(): RelayClient {
  if (!client) {
    client = new RelayClient({
      url: state.url,
      token: state.token,
      profile: state.profile,
      onMessage: handleMessage,
      onStatus: (next, why) => patch({ status: next, detail: why })
    })
  }
  return client
}

/** 立刻广播本地状态（绕过节流），用于「新人进房必须马上同步听歌」。 */
function publishNow(): void {
  const local = lastLocalStateRef
  if (local) client?.broadcastState(local)
}

/** 把远端播放状态落到本地播放器。 */
async function applyRemoteState(remote: RelayRoomState): Promise<void> {
  if (!remote?.track) return
  applyingRef = true
  const elapsed = remote.playing ? Math.max(0, (Date.now() - (remote.at ?? Date.now())) / 1000) : 0
  const target = (remote.position ?? 0) + elapsed
  // 先给出提示再执行动作：mpv 正在加载新曲时 seek/play 可能长时间不返回，
  // 若把提示放在最后，用户会看到"点了没反应、也没有任何说明"。
  patch({ syncInfo: `已跟随房主：${remote.track.name} @ ${Math.floor(target)}s` })
  try {
    const current = (await withTimeout(call('player:state') as Promise<PlayerStateDTO>, 5000, '读取播放状态'))
    if (current.track?.id !== remote.track.id) {
      await withTimeout(
        call('player:playTracks', { tracks: [remote.track as TrackDTO], startIndex: 0 }),
        15000,
        '切换歌曲'
      )
      if (target > 1) {
        await withTimeout(call('player:seek', { seconds: target }), 5000, '定位进度').catch(() => undefined)
      }
    } else if (Math.abs((current.position ?? 0) - target) > 3) {
      await withTimeout(call('player:seek', { seconds: target }), 5000, '定位进度').catch(() => undefined)
    }
    if (remote.playing && !current.playing) {
      await withTimeout(call('player:play'), 8000, '开始播放').catch(() => undefined)
    }
    if (remote.playing === false && current.playing) {
      await withTimeout(call('player:pause'), 8000, '暂停').catch(() => undefined)
    }
    patch({ error: undefined })
  } catch (cause) {
    // 以前这里静默失败，导致「跟随不上」无从排查；现在把原因显示在页面上。
    const message = `跟随播放失败：${cause instanceof Error ? cause.message : String(cause)}`
    patch({ syncInfo: message, error: message })
  } finally {
    applyingRef = false
  }
}

function handleMessage(message: RelayMessage): void {
  switch (message.type) {
    case 'welcome':
      patch({
        gifts: message.gifts ?? [],
        balance: message.balance ?? 0,
        rooms: message.rooms ?? [],
        listeners: message.listeners ?? [],
        error: undefined,
        // 首次使用一起听：服务器赠送 1 元礼物额度。
        notice: message.firstGift ? '首次使用赠送 1 元礼物额度' : undefined
      })
      break
    case 'rooms':
      patch({ rooms: message.rooms ?? [] })
      break
    case 'listeners':
      patch({ listeners: message.listeners ?? [] })
      break
    case 'roomJoined': {
      const view: TogetherRoomView = {
        id: message.room.id,
        name: message.room.name,
        hostId: message.room.hostId,
        you: message.you,
        isHost: message.room.hostId === message.you,
        members: (message.members ?? []).map((member) => ({
          id: member.id,
          nickname: member.nickname,
          isHost: member.id === message.room.hostId
        }))
      }
      roomRef = view
      patch({ room: view, messages: [] })
      // 一进房就同步：房主立刻广播自己的进度；成员主动请求一次（若服务器
      // 有缓存状态则先跟随缓存，随后仍会收到房主的实时状态）。
      if (message.state && !view.isHost) void applyRemoteState(message.state)
      if (view.isHost) window.setTimeout(publishNow, 300)
      else window.setTimeout(() => client?.requestSync(), 300)
      break
    }
    case 'peerJoined':
      if (state.room && !state.room.members.some((member) => member.id === message.member.id)) {
        const next = { ...state.room, members: [...state.room.members, { id: message.member.id, nickname: message.member.nickname }] }
        roomRef = next
        patch({ room: next })
      }
      // 有人进来：房主立刻广播一次，保证对方一进房就听到同一首、同一进度。
      if (roomRef?.isHost) window.setTimeout(publishNow, 200)
      break
    case 'peerLeft':
      if (state.room) {
        const next = { ...state.room, members: state.room.members.filter((member) => member.id !== message.member.id) }
        roomRef = next
        patch({ room: next })
      }
      break
    case 'roomLeft':
      roomRef = undefined
      patch({ room: undefined, messages: [] })
      break
    case 'roomState':
      if (message.from !== roomRef?.you && !roomRef?.isHost) void applyRemoteState(message.state)
      break
    case 'syncRequest':
      // 有人（或自己重连后）请求同步：房主立刻广播当前状态。
      if (roomRef?.isHost) publishNow()
      break
    case 'chat':
      patch({ messages: [...state.messages.slice(-199), message] })
      break
    case 'gift':
      patch({ giftEvents: [...state.giftEvents.slice(-19), message] })
      break
    case 'balance':
      patch({ balance: message.balance ?? 0 })
      break
    case 'rechargeResult':
      patch({ order: message })
      break
    case 'orderStatus':
      patch({ orderStatus: message, balance: typeof message.balance === 'number' ? message.balance : state.balance })
      break
    case 'error':
      patch({ error: message.message })
      break
  }
}

function rebuildClient(): void {
  if (client) {
    client.close()
    client = undefined
  }
  const next = ensureClient()
  // url/token 变了说明之前可能连过；保持「已连则继续连」的体验。
  if (state.status === 'connected' || state.status === 'connecting') {
    next.connect(state.profile)
  }
}

const store: TogetherStore = {
  get state() {
    return state
  },
  setUrl: (url) => {
    if (url === state.url) return
    patch({ url })
    persist()
    rebuildClient()
  },
  setToken: (token) => {
    if (token === state.token) return
    patch({ token })
    persist()
    rebuildClient()
  },
  setProfile: (profile) => {
    const next = { ...state.profile, ...profile }
    patch({ profile: next })
    persist()
    client?.setProfile(next)
  },
  connect: (withProfile) => {
    ensureClient().connect(withProfile ?? state.profile)
  },
  disconnect: () => client?.close(),
  listRooms: () => client?.listRooms(),
  listListeners: (filter) => client?.listListeners(filter),
  createRoom: (name, roomState) => client?.createRoom(name, roomState),
  joinRoom: (roomId) => client?.joinRoom(roomId),
  leaveRoom: () => client?.leaveRoom(),
  publishState: (next) => {
    lastLocalStateRef = next
    const now = Date.now()
    if (now - lastPublishRef < 900) return
    lastPublishRef = now
    client?.broadcastState(next)
  },
  requestSync: () => client?.requestSync(),
  sendChat: (text, emoji) => client?.chat(text, emoji),
  sendGift: (giftId) => client?.sendGift(giftId),
  recharge: (amountFen) => {
    // 兜底校验：金额非法时不下单，避免出现「输入 95 却下成 1 元」这类静默偏差。
    if (!Number.isFinite(amountFen) || amountFen < 100 || amountFen > 10000) {
      patch({ order: { ok: false, message: '充值金额需在 1.00 ~ 100.00 元之间' } })
      return
    }
    patch({ orderStatus: undefined })
    ensureClient().recharge(Math.round(amountFen))
  },
  pollOrder: (outTradeNo) => client?.pollOrder(outTradeNo),
  clearOrder: () => patch({ order: undefined, orderStatus: undefined }),
  requestBalance: () => client?.requestBalance()
}

export function useTogetherStore(): TogetherStore {
  useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => version
  )
  return store
}
