/**
 * 「一起听」公网中继服务器（零依赖：只用 Node 标准库）。
 *
 * 职责：
 *  1. 房间：创建/加入/离开，成员列表，房主广播播放状态 → 其他成员同步；
 *  2. 聊天：文字与表情消息；
 *  3. 赠礼：扣除赠送者余额、累加接收者收益，广播礼物事件；
 *  4. 找听友：在线用户资料（昵称/性别/年龄/地区），支持筛选；
 *  5. 充值：调用支付宝当面付下单 + 轮询到账后加余额（私钥只在服务器）。
 *
 * 启动：node server/index.mjs  （PORT 环境变量可改端口，默认 8787）
 * 数据：data/state.json（余额/订单/用户资料），data/alipay-key.pem（应用私钥）
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acceptKey, decodeFrames, encodeClose, encodeFrame } from './ws.mjs'
import { GIFTS, findGift } from './gifts.mjs'
import { Alipay, loadPrivateKey } from './alipay.mjs'
import { getDaily, sanitiseTracks, saveDaily, validDate, validUid } from './daily.mjs'
import { clientIp, sanitiseLogs, saveLogs } from './logs.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(root, 'data')
const stateFile = path.join(dataDir, 'state.json')
const PORT = Number(process.env.PORT ?? 8787)
const APP_ID = process.env.ALIPAY_APP_ID ?? '2019101168266558'
/** 连接口令：设置后所有 WebSocket 连接都必须带 ?token=xxx，防止陌生人接入。 */
const RELAY_TOKEN = process.env.RELAY_TOKEN ?? ''

mkdirSync(dataDir, { recursive: true })

/** 持久化状态：用户资料、余额、订单、礼物记录。 */
const state = loadState()
function loadState() {
  const fallback = { users: {}, balances: {}, orders: {}, giftLog: [] }
  try {
    if (!existsSync(stateFile)) return fallback
    return { ...fallback, ...JSON.parse(readFileSync(stateFile, 'utf8')) }
  } catch {
    return fallback
  }
}
let saveTimer
function saveState() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8')
    } catch (cause) {
      console.error('[state] 保存失败', cause)
    }
  }, 300)
}

const alipay = new Alipay({ appId: APP_ID, privateKey: loadPrivateKey(root) })
console.log(`[alipay] ${alipay.configured ? '已配置（可扫码支付）' : '未配置：缺少应用私钥，支付功能将不可用'}`)

// --- 内存态：连接、房间、在线听友 ---
const clients = new Map() // id -> { id, socket, profile, roomId, alive }
const rooms = new Map() // id -> { id, name, hostId, members:Set, state, createdAt }
let nextClientId = 1
let nextRoomId = 1

function send(client, type, data) {
  try {
    client.socket.write(encodeFrame(JSON.stringify({ type, ...data })))
  } catch {
    /* 连接可能已断开 */
  }
}

function broadcast(roomId, type, data, exceptId) {
  const room = rooms.get(roomId)
  if (!room) return
  for (const memberId of room.members) {
    if (memberId === exceptId) continue
    const member = clients.get(memberId)
    if (member) send(member, type, data)
  }
}

function roomSummary(room) {
  return {
    id: room.id,
    name: room.name,
    hostId: room.hostId,
    members: room.members.size,
    track: room.state?.track ?? null,
    playing: Boolean(room.state?.playing)
  }
}

function listenerList(filter = {}) {
  const list = []
  // 按账号去重：同一 uid 只显示最新的一条连接（旧连接被顶掉后可能还有几秒
  // 在内存里，列表不能出现好几个「自己」）。
  const newestByUid = new Map()
  for (const client of clients.values()) {
    if (!client.alive || !client.profile) continue
    const uid = String(client.profile.uid)
    const existing = newestByUid.get(uid)
    if (!existing || client.id > existing.id) newestByUid.set(uid, client)
  }
  for (const client of newestByUid.values()) {
    if (filter.gender && client.profile.gender !== filter.gender) continue
    if (filter.region && !String(client.profile.region ?? '').includes(filter.region)) continue
    if (filter.minAge && Number(client.profile.age ?? 0) < Number(filter.minAge)) continue
    if (filter.maxAge && Number(client.profile.age ?? 0) > Number(filter.maxAge)) continue
    list.push({
      id: client.id,
      nickname: client.profile.nickname,
      avatar: client.profile.avatar,
      gender: client.profile.gender,
      age: client.profile.age,
      region: client.profile.region,
      signature: client.profile.signature,
      roomId: client.roomId ?? null,
      listening: Boolean(client.roomId)
    })
  }
  return list
}

/** 健康检查里的在线人数：按账号去重后的真实在线数。 */
function onlineCount() {
  const uids = new Set()
  for (const client of clients.values()) {
    if (client.alive && client.profile) uids.add(String(client.profile.uid))
  }
  return uids.size
}

function balanceOf(uid) {
  return state.balances[uid] ?? 0
}

function addBalance(uid, delta) {
  state.balances[uid] = Math.max(0, (state.balances[uid] ?? 0) + delta)
  saveState()
  return state.balances[uid]
}

async function handleMessage(client, message) {
  switch (message.type) {
    case 'hello': {
      // 合并而非整体替换：旧客户端会先发一条不带 uid 的 hello、再补发昵称/头像，
      // 若整体替换，后面那条不带 uid 的 hello 会把已登记的真实 uid 又抹回 client.id。
      // 合并后，只有真正提供了新值的字段才更新，uid 一旦登记就稳定。
      const previous = client.profile
      client.profile = {
        uid: String(message.profile?.uid ?? previous?.uid ?? client.id),
        nickname: String(message.profile?.nickname ?? previous?.nickname ?? `听友${client.id}`),
        avatar: message.profile?.avatar ?? previous?.avatar,
        gender: message.profile?.gender ?? previous?.gender,
        age: message.profile?.age ?? previous?.age,
        region: message.profile?.region ?? previous?.region,
        signature: message.profile?.signature ?? previous?.signature
      }
      state.users[client.profile.uid] = client.profile
      // 同一账号只保留最新一条连接：把更早的连接顶掉（close code 4000，
      // 客户端收到 4000 不会自动重连，避免两个连接互相顶、无限循环）。
      {
        const uid = client.profile.uid
        for (const other of clients.values()) {
          if (other !== client && other.alive && String(other.profile?.uid) === uid) {
            other.cleanup?.(4000)
          }
        }
      }
      // 首次使用一起听：赠送 1 元礼物额度（每个账号只送一次）。
      state.gifted ??= {}
      let firstGift = false
      if (!state.gifted[client.profile.uid]) {
        state.gifted[client.profile.uid] = Date.now()
        state.balances[client.profile.uid] = (state.balances[client.profile.uid] ?? 0) + 100
        firstGift = true
      }
      saveState()
      send(client, 'welcome', {
        clientId: client.id,
        gifts: GIFTS,
        balance: balanceOf(client.profile.uid),
        firstGift,
        rooms: [...rooms.values()].map(roomSummary),
        listeners: listenerList()
      })
      break
    }

    case 'listRooms':
      send(client, 'rooms', { rooms: [...rooms.values()].map(roomSummary) })
      break

    case 'listListeners':
      send(client, 'listeners', { listeners: listenerList(message.filter ?? {}) })
      break

    case 'createRoom': {
      const id = `R${nextRoomId++}`
      const room = {
        id,
        name: String(message.name ?? `${client.profile?.nickname ?? '我'}的房间`),
        hostId: client.id,
        members: new Set([client.id]),
        state: message.state ?? null,
        createdAt: Date.now()
      }
      rooms.set(id, room)
      client.roomId = id
      send(client, 'roomJoined', {
        room: roomSummary(room),
        you: client.id,
        members: [...room.members].map((memberId) => ({ id: memberId, nickname: clients.get(memberId)?.profile?.nickname ?? `听友${memberId}` }))
      })
      broadcast(id, 'peerJoined', { member: { id: client.id, nickname: client.profile?.nickname ?? `听友${client.id}` } }, client.id)
      break
    }

    case 'joinRoom': {
      const room = rooms.get(String(message.roomId))
      if (!room) {
        send(client, 'error', { message: '房间不存在或已解散' })
        break
      }
      if (client.roomId && client.roomId !== room.id) leaveRoom(client)
      room.members.add(client.id)
      client.roomId = room.id
      send(client, 'roomJoined', {
        room: roomSummary(room),
        you: client.id,
        members: [...room.members].map((id) => ({ id, nickname: clients.get(id)?.profile?.nickname ?? `听友${id}` })),
        state: room.state
      })
      broadcast(room.id, 'peerJoined', { member: { id: client.id, nickname: client.profile?.nickname ?? `听友${client.id}` } }, client.id)
      break
    }

    case 'leaveRoom':
      leaveRoom(client)
      break

    /** 新成员加入后主动请求一次同步：房主收到后立即广播当前播放状态。 */
    case 'syncRequest': {
      const room = rooms.get(client.roomId)
      if (!room) break
      broadcast(room.id, 'syncRequest', { from: client.id }, client.id)
      break
    }

    /** 房主（或任意成员）广播播放状态；服务器只做转发与「最新状态」缓存。 */
    case 'roomState': {
      const room = rooms.get(client.roomId)
      if (!room) break
      room.state = message.state ?? null
      broadcast(room.id, 'roomState', { from: client.id, state: room.state }, client.id)
      break
    }

    case 'chat': {
      const room = rooms.get(client.roomId)
      if (!room) break
      const payload = {
        from: client.id,
        nickname: client.profile?.nickname,
        avatar: client.profile?.avatar,
        text: String(message.text ?? '').slice(0, 500),
        emoji: message.emoji,
        at: Date.now()
      }
      // 广播时排除发送者，再单独回显给发送者：否则发送者会收到两份
      // （对方点表情时就会「发出两条」，用户已反馈过）。
      broadcast(room.id, 'chat', payload, client.id)
      send(client, 'chat', payload)
      break
    }

    case 'gift': {
      const room = rooms.get(client.roomId)
      const gift = findGift(String(message.giftId))
      if (!gift || !client.profile) {
        send(client, 'error', { message: '礼物不存在' })
        break
      }
      const uid = client.profile.uid
      if (balanceOf(uid) < gift.price) {
        send(client, 'error', { message: '余额不足，请先充值' })
        break
      }
      addBalance(uid, -gift.price)
      const target = [...(room?.members ?? [])].find((id) => id !== client.id)
      const targetUid = target ? clients.get(target)?.profile?.uid : undefined
      if (targetUid) addBalance(targetUid, Math.round(gift.price * 0.7))
      state.giftLog.push({ at: Date.now(), from: uid, to: targetUid ?? null, gift: gift.id, price: gift.price })
      if (state.giftLog.length > 2000) state.giftLog.splice(0, 1000)
      saveState()
      const payload = {
        from: client.id,
        nickname: client.profile.nickname,
        avatar: client.profile.avatar,
        to: target ?? null,
        gift,
        at: Date.now()
      }
      if (room) broadcast(room.id, 'gift', payload, client.id)
      send(client, 'gift', payload)
      send(client, 'balance', { balance: balanceOf(uid) })
      break
    }

    case 'balance':
      send(client, 'balance', { balance: balanceOf(client.profile?.uid ?? String(client.id)) })
      break

    /** 充值：创建支付宝当面付订单，返回二维码内容。 */
    case 'recharge': {
      client.profile ??= { uid: String(client.id), nickname: `听友${client.id}` }
      // 单次充值区间：1.00 ~ 100.00 元。
      // 越界/非法金额**直接拒绝，不静默改成别的金额**：以前是 clamp，结果客户端把
      // 元当成分（或传了空值）时会悄悄下成 1 元订单，用户看到「输入 95、应付 1.00」。
      const requested = Number(message.amountFen)
      if (!Number.isFinite(requested) || requested < 100 || requested > 10000) {
        send(client, 'rechargeResult', { ok: false, message: '单次充值金额需在 1.00 ~ 100.00 元之间' })
        break
      }
      const amountFen = Math.round(requested)
      if (!alipay.configured) {
        send(client, 'rechargeResult', { ok: false, message: '服务器未配置支付宝私钥，无法下单' })
        break
      }
      const outTradeNo = `YY${Date.now()}${Math.floor(Math.random() * 1000)}`
      try {
        const result = await alipay.precreate({
          outTradeNo,
          amountFen,
          subject: `悠悠音乐-一起听礼物充值 ${(amountFen / 100).toFixed(2)} 元`
        })
        if (!result.ok) {
          send(client, 'rechargeResult', {
            ok: false,
            message: `支付宝下单失败：${result.raw?.sub_msg ?? result.raw?.msg ?? '未知错误'}`
          })
          break
        }
        state.orders[outTradeNo] = {
          uid: client.profile.uid,
          amountFen,
          status: 'pending',
          createdAt: Date.now()
        }
        saveState()
        send(client, 'rechargeResult', { ok: true, outTradeNo, qrCode: result.qrCode, amountFen })
      } catch (cause) {
        send(client, 'rechargeResult', { ok: false, message: `支付宝请求异常：${String(cause).slice(0, 120)}` })
      }
      break
    }

    /** 轮询订单：到账则加余额并广播。 */
    case 'pollOrder': {
      const order = state.orders[String(message.outTradeNo)]
      if (!order) {
        send(client, 'orderStatus', { ok: false, message: '订单不存在' })
        break
      }
      if (order.status === 'paid') {
        send(client, 'orderStatus', { ok: true, paid: true, balance: balanceOf(order.uid) })
        break
      }
      try {
        const result = await alipay.query(String(message.outTradeNo))
        if (result.paid) {
          order.status = 'paid'
          order.paidAt = Date.now()
          addBalance(order.uid, order.amountFen)
          saveState()
          send(client, 'orderStatus', { ok: true, paid: true, balance: balanceOf(order.uid) })
          send(client, 'balance', { balance: balanceOf(order.uid) })
        } else {
          send(client, 'orderStatus', { ok: true, paid: false, status: result.status ?? 'WAIT_BUYER_PAY' })
        }
      } catch (cause) {
        send(client, 'orderStatus', { ok: false, message: `查询失败：${String(cause).slice(0, 120)}` })
      }
      break
    }

    default:
      send(client, 'error', { message: `未知消息类型：${message.type}` })
  }
}

function leaveRoom(client) {
  const roomId = client.roomId
  if (!roomId) return
  const room = rooms.get(roomId)
  client.roomId = undefined
  if (!room) return
  room.members.delete(client.id)
  broadcast(roomId, 'peerLeft', { member: { id: client.id, nickname: client.profile?.nickname ?? `听友${client.id}` } })
  if (room.members.size === 0) rooms.delete(roomId)
  else if (room.hostId === client.id) room.hostId = [...room.members][0]
  send(client, 'roomLeft', {})
}

// --- HTTP + WebSocket 升级 ---
const server = createServer((request, response) => {
  void handleHttp(request, response).catch((cause) => {
    console.error('[http] 处理失败', cause)
    respond(response, 500, { ok: false, message: '服务器内部错误' })
  })
})

function respond(response, status, data) {
  try {
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    })
    response.end(JSON.stringify(data))
  } catch {
    /* 响应可能已中断 */
  }
}

/** 与 WebSocket 一致的口令校验：?token= 或 x-relay-token 头。 */
function tokenOk(searchParams, headers) {
  if (!RELAY_TOKEN) return true
  const supplied = searchParams.get('token') ?? headers['x-relay-token']
  return supplied === RELAY_TOKEN
}

async function handleHttp(request, response) {
  let parsed
  try {
    parsed = new URL(request.url ?? '/', 'http://localhost')
  } catch {
    respond(response, 400, { ok: false, message: '无效的请求地址' })
    return
  }
  // 兼容反代前缀：/relay/health 与 /health 都算健康检查。
  if (parsed.pathname === '/health' || parsed.pathname.endsWith('/health')) {
    respond(response, 200, {
      ok: true,
      rooms: rooms.size,
      online: onlineCount(),
      gifts: GIFTS.length,
      alipay: alipay.configured,
      uptime: Math.round(process.uptime())
    })
    return
  }

  // 每日推荐历史（悠悠音乐自己的跨设备同步逻辑）。
  const isDaily = parsed.pathname === '/daily' || parsed.pathname === '/relay/daily'
  const isDailySave = parsed.pathname === '/daily/save' || parsed.pathname === '/relay/daily/save'
  if (isDaily || isDailySave) {
    if (!tokenOk(parsed.searchParams, request.headers)) {
      respond(response, 401, { ok: false, message: '未授权' })
      return
    }
    const uid = parsed.searchParams.get('uid')
    const date = parsed.searchParams.get('date')
    if (!validUid(uid)) {
      respond(response, 400, { ok: false, message: 'uid 非法' })
      return
    }
    if (!validDate(date)) {
      respond(response, 400, { ok: false, message: 'date 非法' })
      return
    }
    if (isDailySave) {
      let body = ''
      try {
        for await (const chunk of request) body += chunk
      } catch {
        respond(response, 400, { ok: false, message: '请求体读取失败' })
        return
      }
      if (body.length > 1_000_000) {
        respond(response, 413, { ok: false, message: '请求体过大' })
        return
      }
      let payload
      try {
        payload = JSON.parse(body || '{}')
      } catch {
        respond(response, 400, { ok: false, message: 'JSON 解析失败' })
        return
      }
      const tracks = sanitiseTracks(payload.tracks)
      if (!tracks) {
        respond(response, 400, { ok: false, message: 'tracks 非法（需要非空数组）' })
        return
      }
      try {
        saveDaily(uid, date, tracks)
        console.log(`[daily] uid=${uid} date=${date} 保存 ${tracks.length} 首`)
        respond(response, 200, { ok: true, saved: tracks.length })
      } catch (cause) {
        console.error('[daily] 保存失败', cause)
        respond(response, 500, { ok: false, message: '保存失败' })
      }
      return
    }
    try {
      respond(response, 200, { ok: true, date, tracks: getDaily(uid, date) })
    } catch (cause) {
      console.error('[daily] 读取失败', cause)
      respond(response, 500, { ok: false, message: '读取失败' })
    }
    return
  }

  // 诊断日志上报（悠悠音乐客户端异常/崩溃收集）。
  const isLogs = parsed.pathname === '/logs' || parsed.pathname === '/relay/logs'
  if (isLogs) {
    if (!tokenOk(parsed.searchParams, request.headers)) {
      respond(response, 401, { ok: false, message: '未授权' })
      return
    }
    if (request.method !== 'POST') {
      respond(response, 405, { ok: false, message: '仅支持 POST' })
      return
    }
    let body = ''
    try {
      for await (const chunk of request) body += chunk
    } catch {
      respond(response, 400, { ok: false, message: '请求体读取失败' })
      return
    }
    if (body.length > 1_000_000) {
      respond(response, 413, { ok: false, message: '请求体过大' })
      return
    }
    let payload
    try {
      payload = JSON.parse(body || '{}')
    } catch {
      respond(response, 400, { ok: false, message: 'JSON 解析失败' })
      return
    }
    const logs = sanitiseLogs(payload.logs)
    if (!logs) {
      respond(response, 400, { ok: false, message: 'logs 非法（需要非空数组）' })
      return
    }
    try {
      const stored = saveLogs(logs, clientIp(request))
      console.log(`[logs] 收到 ${logs.length} 条，落盘 ${stored} 条`)
      respond(response, 200, { ok: true, stored })
    } catch (cause) {
      console.error('[logs] 保存失败', cause)
      respond(response, 500, { ok: false, message: '保存失败' })
    }
    return
  }

  response.writeHead(404)
  response.end()
}

server.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key']
  if (!key) {
    socket.destroy()
    return
  }
  // 口令校验：/health 之外的连接都必须带对 token。
  if (RELAY_TOKEN) {
    let supplied
    try {
      supplied = new URL(request.url ?? '/', 'http://localhost').searchParams.get('token') ?? undefined
    } catch {
      supplied = undefined
    }
    supplied ??= request.headers['x-relay-token']
    if (supplied !== RELAY_TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
  }
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '\r\n'
    ].join('\r\n')
  )
  socket.setNoDelay(true)

  const client = { id: nextClientId++, socket, profile: undefined, roomId: undefined, alive: true, lastSeen: Date.now(), cleanup: undefined }
  clients.set(client.id, client)

  let buffered = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    client.lastSeen = Date.now()
    buffered = Buffer.concat([buffered, chunk])
    const { frames, rest } = decodeFrames(buffered)
    buffered = rest
    for (const frame of frames) {
      if (frame.opcode === 0x8) {
        cleanup()
        return
      }
      if (frame.opcode === 0x9) {
        socket.write(encodeFrame(frame.payload, 0xa))
        continue
      }
      if (frame.opcode !== 0x1) continue
      let message
      try {
        message = JSON.parse(frame.payload.toString('utf8'))
      } catch {
        continue
      }
      try {
        // 支付相关分支是异步的（调用支付宝网关），这里统一兜住异常。
        void handleMessage(client, message).catch((cause) => {
          console.error('[message] 处理失败', cause)
          send(client, 'error', { message: String(cause).slice(0, 200) })
        })
      } catch (cause) {
        console.error('[message] 处理失败', cause)
        send(client, 'error', { message: String(cause).slice(0, 200) })
      }
    }
  })

  const cleanup = (code = 1000) => {
    if (!client.alive) return
    client.alive = false
    leaveRoom(client)
    clients.delete(client.id)
    try {
      socket.write(encodeClose(code))
    } catch {
      /* ignore */
    }
    socket.destroy()
  }
  client.cleanup = cleanup

  socket.on('close', () => cleanup())
  socket.on('error', () => cleanup())
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[relay] 一起听中继已启动: http://0.0.0.0:${PORT}  (健康检查 /health)`)

  // 心跳回收：浏览器对服务端 ping 会自动回 pong，任何数据都会刷新 lastSeen。
  // 超过 90 秒没有任何数据的连接视为死连接清理掉，避免「幽灵在线」越积越多。
  setInterval(() => {
    const now = Date.now()
    for (const client of [...clients.values()]) {
      if (now - (client.lastSeen ?? now) > 90_000) {
        console.log(`[relay] 清理无响应连接 #${client.id}（${client.profile?.nickname ?? '未打招呼'}）`)
        client.cleanup?.()
        continue
      }
      try {
        client.socket.write(encodeFrame(Buffer.alloc(0), 0x9))
      } catch {
        client.cleanup?.()
      }
    }
  }, 30_000).unref()
  console.log(`[relay] 连接口令: ${RELAY_TOKEN ? '已启用' : '未设置（任何人都能连接）'}`)
})
