/**
 * 「一起听」中继客户端。
 *
 * 纯 TypeScript、无框架依赖，方便被 store 包装，也方便在 vitest 里直接连真服务器测试。
 * 协议见 server/index.mjs：JSON 消息，type 字段区分。
 */
import type { TrackDTO } from '@shared/types'

export const DEFAULT_RELAY_URL = 'wss://yy.ytw.asia/relay'
/** 连接口令：与服务端 RELAY_TOKEN 对应。 */
export const DEFAULT_RELAY_TOKEN = 'yy-7f3a9c2e51d84b06'

export interface RelayGift {
  id: string
  name: string
  emoji: string
  price: number
  tier: 'common' | 'rare' | 'epic' | 'legend'
}

export interface RelayProfile {
  uid?: string
  nickname?: string
  avatar?: string
  gender?: string
  age?: number
  region?: string
  signature?: string
}

export interface RelayListener extends RelayProfile {
  id: number
  roomId?: string | null
  listening?: boolean
}

export interface RelayRoom {
  id: string
  name: string
  hostId: number
  members: number
  track?: { id: number; name: string } | null
  playing?: boolean
}

export interface RelayRoomState {
  track?: TrackDTO | null
  position?: number
  playing?: boolean
  at?: number
}

export interface RelayChatMessage {
  from: number
  nickname?: string
  avatar?: string
  text: string
  emoji?: string
  at: number
}

export interface RelayGiftEvent {
  from: number
  nickname?: string
  avatar?: string
  to?: number | null
  gift: RelayGift
  at: number
}

export interface RelayOrderResult {
  ok: boolean
  outTradeNo?: string
  qrCode?: string
  amountFen?: number
  message?: string
}

export interface RelayOrderStatus {
  ok: boolean
  paid?: boolean
  status?: string
  balance?: number
  message?: string
}

export type RelayMessage =
  | {
      type: 'welcome'
      clientId: number
      gifts: RelayGift[]
      balance: number
      /** 首次使用一起听时赠送 1 元礼物额度。 */
      firstGift?: boolean
      rooms: RelayRoom[]
      listeners: RelayListener[]
    }
  | { type: 'rooms'; rooms: RelayRoom[] }
  | { type: 'listeners'; listeners: RelayListener[] }
  | { type: 'roomJoined'; room: RelayRoom; you: number; members: Array<{ id: number; nickname?: string }>; state?: RelayRoomState }
  | { type: 'peerJoined'; member: { id: number; nickname?: string } }
  | { type: 'peerLeft'; member: { id: number; nickname?: string } }
  | { type: 'roomLeft' }
  | { type: 'roomState'; from: number; state: RelayRoomState }
  /** 有人请求同步：房主收到后应立即广播一次当前播放状态。 */
  | { type: 'syncRequest'; from: number }
  | ({ type: 'chat' } & RelayChatMessage)
  | ({ type: 'gift' } & RelayGiftEvent)
  | { type: 'balance'; balance: number }
  | ({ type: 'rechargeResult' } & RelayOrderResult)
  | ({ type: 'orderStatus' } & RelayOrderStatus)
  | { type: 'error'; message: string }

export type RelayStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error'

export interface RelayClientOptions {
  url?: string
  token?: string
  profile?: RelayProfile
  onMessage?: (message: RelayMessage) => void
  onStatus?: (status: RelayStatus, detail?: string) => void
}

export class RelayClient {
  private socket?: WebSocket
  private closedByUser = false
  private reconnectTimer?: number
  private reconnectDelay = 1000
  private profile: RelayProfile = {}

  constructor(private readonly options: RelayClientOptions = {}) {
    // 构造时就把资料存下来：connect() 不传参也能用（测试里踩过这个坑）。
    this.profile = { ...(options.profile ?? {}) }
  }

  get url(): string {
    return this.options.url ?? DEFAULT_RELAY_URL
  }

  get connected(): boolean {
    return this.socket?.readyState === 1
  }

  setProfile(profile: RelayProfile): void {
    this.profile = { ...this.profile, ...profile }
    if (this.connected) this.send({ type: 'hello', profile: this.profile })
  }

  connect(profile?: RelayProfile): void {
    if (profile) this.profile = { ...this.profile, ...profile }
    this.closedByUser = false
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return
    this.options.onStatus?.('connecting')
    const token = this.options.token ?? DEFAULT_RELAY_TOKEN
    const target = token ? `${this.url}${this.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : this.url
    let socket
    try {
      socket = new WebSocket(target)
    } catch (cause) {
      this.options.onStatus?.('error', String(cause))
      this.scheduleReconnect()
      return
    }
    this.socket = socket

    // CONNECTING 状态挂死（TLS/网络僵住时不触发 error/close）会导致永远连不上：
    // 12 秒还没 open 就主动关掉，close 事件会走 scheduleReconnect 重试。
    let connectTimer: number | undefined
    const clearConnectTimer = (): void => {
      if (connectTimer !== undefined) {
        globalThis.clearTimeout(connectTimer)
        connectTimer = undefined
      }
    }
    connectTimer = globalThis.setTimeout(() => {
      if (socket.readyState === 0) socket.close()
    }, 12000) as unknown as number

    socket.addEventListener('open', () => {
      clearConnectTimer()
      this.reconnectDelay = 1000
      this.options.onStatus?.('connected')
      this.send({ type: 'hello', profile: this.profile })
    })
    socket.addEventListener('message', (event) => {
      let message: RelayMessage
      try {
        message = JSON.parse(String(event.data)) as RelayMessage
      } catch {
        return
      }
      this.options.onMessage?.(message)
    })
    socket.addEventListener('close', (event) => {
      clearConnectTimer()
      // 4000 = 服务端判定「同一账号已有更新的连接」：这是主动顶掉旧连接，
      // 不是网络故障，不能自动重连，否则两个连接会互相顶、无限循环。
      if (event.code === 4000) {
        this.closedByUser = true
        this.options.onStatus?.('closed', '连接被同一账号的新连接取代')
        return
      }
      this.options.onStatus?.(this.closedByUser ? 'closed' : 'error')
      if (!this.closedByUser) this.scheduleReconnect()
    })
    socket.addEventListener('error', () => {
      clearConnectTimer()
      this.options.onStatus?.('error')
    })
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== undefined) return
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = undefined
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000)
      this.connect()
    }, this.reconnectDelay) as unknown as number
  }

  close(): void {
    this.closedByUser = true
    if (this.reconnectTimer !== undefined) {
      globalThis.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.socket?.close()
    this.socket = undefined
    this.options.onStatus?.('closed')
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.connected) return
    this.socket?.send(JSON.stringify(payload))
  }

  listRooms(): void {
    this.send({ type: 'listRooms' })
  }

  listListeners(filter: { gender?: string; region?: string; minAge?: number; maxAge?: number } = {}): void {
    this.send({ type: 'listListeners', filter })
  }

  createRoom(name: string, state?: RelayRoomState): void {
    this.send({ type: 'createRoom', name, state })
  }

  joinRoom(roomId: string): void {
    this.send({ type: 'joinRoom', roomId })
  }

  leaveRoom(): void {
    this.send({ type: 'leaveRoom' })
  }

  broadcastState(state: RelayRoomState): void {
    this.send({ type: 'roomState', state })
  }

  /** 请求房主同步一次（新加入房间时调用，保证「一进房就同步听歌」）。 */
  requestSync(): void {
    this.send({ type: 'syncRequest' })
  }

  chat(text: string, emoji?: string): void {
    this.send({ type: 'chat', text, emoji })
  }

  sendGift(giftId: string): void {
    this.send({ type: 'gift', giftId })
  }

  requestBalance(): void {
    this.send({ type: 'balance' })
  }

  recharge(amountFen: number): void {
    this.send({ type: 'recharge', amountFen })
  }

  pollOrder(outTradeNo: string): void {
    this.send({ type: 'pollOrder', outTradeNo })
  }
}
