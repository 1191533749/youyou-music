/**
 * 「一起听」状态容器：把中继客户端包成 React 可用的 store，并负责播放同步。
 *
 * 同步策略：
 *  - 房主（room.hostId === 我的 clientId）在播放状态变化时节流广播；
 *  - 其他成员收到广播后校正本地播放（换歌 → 重设队列并定位；同曲 → 偏差过大才 seek，
 *    播放/暂停状态不一致则跟随），避免双方互相抖动。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  connect: () => void
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

export function useTogetherStore(): TogetherStore {
  const persisted = useMemo(loadPersisted, [])
  const clientRef = useRef<RelayClient>()
  const [status, setStatus] = useState<RelayStatus>('idle')
  const [detail, setDetail] = useState<string | undefined>()
  const [url, setUrlState] = useState(persisted.url)
  const [token, setTokenState] = useState(persisted.token)
  const [profile, setProfileState] = useState<RelayProfile>(persisted.profile)
  const [gifts, setGifts] = useState<RelayGift[]>([])
  const [balance, setBalance] = useState(0)
  const [rooms, setRooms] = useState<RelayRoom[]>([])
  const [listeners, setListeners] = useState<RelayListener[]>([])
  const [room, setRoom] = useState<TogetherRoomView | undefined>()
  const [messages, setMessages] = useState<RelayChatMessage[]>([])
  const [giftEvents, setGiftEvents] = useState<RelayGiftEvent[]>([])
  const [order, setOrder] = useState<RelayOrderResult | undefined>()
  const [orderStatus, setOrderStatus] = useState<RelayOrderStatus | undefined>()
  const [error, setError] = useState<string | undefined>()
  /** 一次性提示（例如首次使用赠送的 1 元礼物额度）。 */
  const [notice, setNotice] = useState<string | undefined>()
  /** 最近一次跟随同步的结果，显示给用户（也便于排查"跟随不上"）。 */
  const [syncInfo, setSyncInfo] = useState<string | undefined>()

  // 同步用：房主身份、最近一次广播时间、以及正在应用远端状态时避免回环。
  const roomRef = useRef<TogetherRoomView | undefined>()
  const applyingRef = useRef(false)
  const lastPublishRef = useRef(0)
  /** 本地最新播放状态：房主被要求同步时（有新人进房）立即用它广播一次。 */
  const lastLocalStateRef = useRef<RelayRoomState | undefined>()

  /** 立刻广播本地状态（绕过节流），用于「新人进房必须马上同步听歌」。 */
  const publishNow = useCallback(() => {
    const state = lastLocalStateRef.current
    if (state) clientRef.current?.broadcastState(state)
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ url, token, profile }))
  }, [url, token, profile])

  /** 把远端播放状态落到本地播放器。 */
  const applyRemoteState = useCallback(async (state: RelayRoomState) => {
    if (!state?.track) return
    applyingRef.current = true
    const elapsed = state.playing ? Math.max(0, (Date.now() - (state.at ?? Date.now())) / 1000) : 0
    const target = (state.position ?? 0) + elapsed
    // 先给出提示再执行动作：mpv 正在加载新曲时 seek/play 可能长时间不返回，
    // 若把提示放在最后，用户会看到"点了没反应、也没有任何说明"。
    setSyncInfo(`已跟随房主：${state.track.name} @ ${Math.floor(target)}s`)
    try {
      const current = (await withTimeout(call('player:state') as Promise<PlayerStateDTO>, 5000, '读取播放状态'))
      if (current.track?.id !== state.track.id) {
        await withTimeout(
          call('player:playTracks', { tracks: [state.track as TrackDTO], startIndex: 0 }),
          15000,
          '切换歌曲'
        )
        if (target > 1) {
          await withTimeout(call('player:seek', { seconds: target }), 5000, '定位进度').catch(() => undefined)
        }
      } else if (Math.abs((current.position ?? 0) - target) > 3) {
        await withTimeout(call('player:seek', { seconds: target }), 5000, '定位进度').catch(() => undefined)
      }
      if (state.playing && !current.playing) {
        await withTimeout(call('player:play'), 8000, '开始播放').catch(() => undefined)
      }
      if (state.playing === false && current.playing) {
        await withTimeout(call('player:pause'), 8000, '暂停').catch(() => undefined)
      }
      setError(undefined)
    } catch (cause) {
      // 以前这里静默失败，导致「跟随不上」无从排查；现在把原因显示在页面上。
      const message = `跟随播放失败：${cause instanceof Error ? cause.message : String(cause)}`
      setSyncInfo(message)
      setError(message)
    } finally {
      applyingRef.current = false
    }
  }, [])

  const handleMessage = useCallback(
    (message: RelayMessage) => {
      switch (message.type) {
        case 'welcome':
          setGifts(message.gifts ?? [])
          setBalance(message.balance ?? 0)
          setRooms(message.rooms ?? [])
          setListeners(message.listeners ?? [])
          setError(undefined)
          // 首次使用一起听：服务器赠送 1 元礼物额度。
          setNotice(message.firstGift ? '首次使用赠送 1 元礼物额度' : undefined)
          break
        case 'rooms':
          setRooms(message.rooms ?? [])
          break
        case 'listeners':
          setListeners(message.listeners ?? [])
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
          roomRef.current = view
          setRoom(view)
          setMessages([])
          // 一进房就同步：房主立刻广播自己的进度；成员主动请求一次（若服务器
          // 有缓存状态则先跟随缓存，随后仍会收到房主的实时状态）。
          if (message.state && !view.isHost) void applyRemoteState(message.state)
          if (view.isHost) window.setTimeout(publishNow, 300)
          else window.setTimeout(() => clientRef.current?.requestSync(), 300)
          break
        }
        case 'peerJoined':
          setRoom((previous) => {
            if (!previous) return previous
            if (previous.members.some((member) => member.id === message.member.id)) return previous
            const next = { ...previous, members: [...previous.members, { id: message.member.id, nickname: message.member.nickname }] }
            roomRef.current = next
            return next
          })
          // 有人进来：房主立刻广播一次，保证对方一进房就听到同一首、同一进度。
          if (roomRef.current?.isHost) window.setTimeout(publishNow, 200)
          break
        case 'peerLeft':
          setRoom((previous) => {
            if (!previous) return previous
            const next = { ...previous, members: previous.members.filter((member) => member.id !== message.member.id) }
            roomRef.current = next
            return next
          })
          break
        case 'roomLeft':
          roomRef.current = undefined
          setRoom(undefined)
          setMessages([])
          break
        case 'roomState':
          if (message.from !== roomRef.current?.you && !roomRef.current?.isHost) void applyRemoteState(message.state)
          break
        case 'syncRequest':
          // 有人（或自己重连后）请求同步：房主立刻广播当前状态。
          if (roomRef.current?.isHost) publishNow()
          break
        case 'chat':
          setMessages((previous) => [...previous.slice(-199), message])
          break
        case 'gift':
          setGiftEvents((previous) => [...previous.slice(-19), message])
          break
        case 'balance':
          setBalance(message.balance ?? 0)
          break
        case 'rechargeResult':
          setOrder(message)
          break
        case 'orderStatus':
          setOrderStatus(message)
          if (typeof message.balance === 'number') setBalance(message.balance)
          break
        case 'error':
          setError(message.message)
          break
      }
    },
    [applyRemoteState]
  )

  const handleMessageRef = useRef(handleMessage)

  const client = useMemo(() => {
    const instance = new RelayClient({
      url,
      token,
      profile,
      onMessage: (message) => handleMessageRef.current(message),
      onStatus: (next, why) => {
        setStatus(next)
        setDetail(why)
      }
    })
    return instance
    // url/token 变化时重建客户端（由 connect() 触发重连）
  }, [url, token])

  useEffect(() => {
    handleMessageRef.current = handleMessage
  }, [handleMessage])

  // relay.ts 在构造时用到了 options.profile；这里在 profile 变化时同步过去。
  useEffect(() => {
    client.setProfile(profile)
  }, [client, profile])

  useEffect(() => {
    clientRef.current = client
    return () => client.close()
  }, [client])

  /**
   * 支付后自动查询到账：每 3 秒查一次，查到已支付或弹窗关闭就停。
   * 用户不需要再点「我已支付」（他明确说过不要这个按钮）。
   */
  useEffect(() => {
    if (!order?.ok || !order.outTradeNo || orderStatus?.paid) return
    const outTradeNo = order.outTradeNo
    const timer = window.setInterval(() => clientRef.current?.pollOrder(outTradeNo), 3000)
    return () => window.clearInterval(timer)
  }, [order?.ok, order?.outTradeNo, orderStatus?.paid])

  return useMemo<TogetherStore>(
    () => ({
      state: { status, detail, url, token, profile, gifts, balance, rooms, listeners, room, messages, giftEvents, order, orderStatus, error, syncInfo, notice },
      setUrl: setUrlState,
      setToken: setTokenState,
      setProfile: (patch) => setProfileState((previous) => ({ ...previous, ...patch })),
      connect: () => client.connect(profile),
      disconnect: () => client.close(),
      listRooms: () => client.listRooms(),
      listListeners: (filter) => client.listListeners(filter),
      createRoom: (name, state) => client.createRoom(name, state),
      joinRoom: (roomId) => client.joinRoom(roomId),
      leaveRoom: () => client.leaveRoom(),
      publishState: (state) => {
        lastLocalStateRef.current = state
        const now = Date.now()
        if (now - lastPublishRef.current < 900) return
        lastPublishRef.current = now
        client.broadcastState(state)
      },
      requestSync: () => client.requestSync(),
      sendChat: (text, emoji) => client.chat(text, emoji),
      sendGift: (giftId) => client.sendGift(giftId),
      recharge: (amountFen) => {
        setOrderStatus(undefined)
        client.recharge(amountFen)
      },
      pollOrder: (outTradeNo) => client.pollOrder(outTradeNo),
      clearOrder: () => {
        setOrder(undefined)
        setOrderStatus(undefined)
      },
      requestBalance: () => client.requestBalance()
    }),
    [status, detail, url, token, profile, gifts, balance, rooms, listeners, room, messages, giftEvents, order, orderStatus, error, syncInfo, notice, client]
  )
}
