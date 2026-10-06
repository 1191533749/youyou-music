/**
 * 「一起听」页面：找房 → 一起听 → 聊天/送礼 → 充值。
 *
 * 服务端是自建中继（wss://yy.ytw.asia/relay，带连接口令），房主广播播放状态，
 * 其他成员自动跟随。支付走支付宝当面付：下单拿收款码 → 轮询订单 → 到账加余额。
 *
 * 注意：聊天与礼物里的表情是**用户明确要求的功能**（互发文字与表情、赠礼），
 * 页面其余部分保持无表情装饰。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { usePlayerStore } from '../store/player'
import { useTogetherStore } from '../store/together'
import { useAuthStore } from '../store/auth'
import { useNavigation } from '../store/navigation'
import { call } from '../lib/ipc'
import { IconGift, IconHeart, IconMusic, IconSend, IconUser } from '../components/Icons'
import GiftOverlay from '../components/GiftOverlay'
import type { RelayGift } from '../lib/relay'

/** 常用表情：聊天与送礼时的快捷选择（用户要求的功能，不是装饰）。 */
const CHAT_EMOJIS = ['😀', '😂', '🥰', '😍', '😎', '🤔', '😭', '😡', '👍', '👏', '🙏', '🎵', '🎶', '🔥', '💖', '🌹', '🍻', '🎁']

/** 充值面额（分）。 */
const RECHARGE_OPTIONS = [1000, 2000, 5000, 10000, 20000, 50000]

const TIER_LABELS: Record<RelayGift['tier'], string> = {
  common: '普通',
  rare: '稀有',
  epic: '史诗',
  legend: '传说'
}

interface QrMatrix {
  size: number
  modules: boolean[][]
}

/** 把一段文本渲染成二维码（复用主进程的编码能力）。 */
function QrCode({ url }: { url: string }): JSX.Element {
  const [matrix, setMatrix] = useState<QrMatrix | undefined>()
  const [error, setError] = useState<string | undefined>()
  useEffect(() => {
    let cancelled = false
    setMatrix(undefined)
    setError(undefined)
    void call('app:qrMatrix', { url })
      .then((result) => {
        if (!cancelled) setMatrix(result)
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [url])

  if (error) return <div className="together__qr-error">{error}</div>
  if (!matrix) return <div className="together__qr-error">正在生成二维码…</div>
  return (
    <div
      className="qr-grid together__qr"
      style={{ gridTemplateColumns: `repeat(${matrix.size}, 1fr)` }}
      aria-label="支付二维码"
    >
      {matrix.modules.flatMap((row, rowIndex) =>
        row.map((dark, colIndex) => (
          <span key={`${rowIndex}-${colIndex}`} className={dark ? 'qr-grid__on' : 'qr-grid__off'} />
        ))
      )}
    </div>
  )
}

export default function Together(): JSX.Element {
  const together = useTogetherStore()
  const player = usePlayerStore()
  const auth = useAuthStore()
  const { state } = together

  const [roomName, setRoomName] = useState('')
  const [chatText, setChatText] = useState('')
  const [gender, setGender] = useState('')
  const [region, setRegion] = useState('')
  const [minAge, setMinAge] = useState('')
  const [maxAge, setMaxAge] = useState('')
  const [rechargeOpen, setRechargeOpen] = useState(false)
  const [rechargeAmount, setRechargeAmount] = useState(RECHARGE_OPTIONS[2])

  // 首次进入自动带上网易云账号资料，用户可再改。
  const profileSeeded = useRef(false)
  useEffect(() => {
    if (profileSeeded.current || !auth.profile) return
    profileSeeded.current = true
    together.setProfile({
      uid: String(auth.profile.userId ?? ''),
      nickname: auth.profile.nickname,
      avatar: auth.profile.avatarUrl
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.profile])

  // 房主广播播放状态（store 内已做 900ms 节流）。
  const { track, playing, position } = player.state
  useEffect(() => {
    if (!state.room?.isHost || !track) return
    together.publishState({ track, position, playing, at: Date.now() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.room?.isHost, track?.id, playing, Math.floor(position / 3)])

  // 充值成功提示
  const paid = state.orderStatus?.paid === true

  const listeners = state.listeners
  const giftsByTier = useMemo(() => {
    const groups = new Map<RelayGift['tier'], RelayGift[]>()
    for (const gift of state.gifts) {
      const list = groups.get(gift.tier) ?? []
      list.push(gift)
      groups.set(gift.tier, list)
    }
    return [...groups.entries()]
  }, [state.gifts])

  return (
    <div className="together">
      <header className="together__head">
        <h1 className="page__title">一起听</h1>
        <p className="together__sub">
          和朋友同步听同一首歌：创建房间后对方加入即可，房主的播放进度会自动同步给对方。
        </p>
      </header>

      <section className="together__connect glass">
        <div className="together__field">
          <label>中继地址</label>
          <input className="text-input" value={state.url} onChange={(event) => together.setUrl(event.target.value)} />
        </div>
        <div className="together__field">
          <label>连接口令</label>
          <input className="text-input" value={state.token} onChange={(event) => together.setToken(event.target.value)} />
        </div>
        <div className="together__field">
          <label>昵称</label>
          <input
            className="text-input"
            value={state.profile.nickname ?? ''}
            onChange={(event) => together.setProfile({ nickname: event.target.value })}
          />
        </div>
        <div className="together__field">
          <label>性别</label>
          <select
            value={state.profile.gender ?? ''}
            onChange={(event) => together.setProfile({ gender: event.target.value })}
          >
            <option value="">不公开</option>
            <option value="female">女生</option>
            <option value="male">男生</option>
          </select>
        </div>
        <div className="together__field">
          <label>年龄</label>
          <input
            className="text-input"
            type="number"
            value={state.profile.age ?? ''}
            onChange={(event) => together.setProfile({ age: Number(event.target.value) || undefined })}
          />
        </div>
        <div className="together__field">
          <label>地区</label>
          <input
            className="text-input"
            value={state.profile.region ?? ''}
            onChange={(event) => together.setProfile({ region: event.target.value })}
          />
        </div>
        <div className="together__actions">
          <span className={`together__status together__status--${state.status}`}>
            {state.status === 'connected'
              ? '已连接'
              : state.status === 'connecting'
                ? '连接中…'
                : state.status === 'idle'
                  ? '未连接'
                  : '连接断开（自动重连中）'}
          </span>
          {state.status === 'connected' ? (
            <button type="button" className="button" onClick={() => together.disconnect()}>
              断开
            </button>
          ) : (
            <button type="button" className="button button--primary" onClick={() => together.connect()}>
              连接中继
            </button>
          )}
        </div>
        <p className="together__balance">
          我的礼物余额：<strong>{(state.balance / 100).toFixed(2)}</strong> 元
          <button type="button" className="button button--small" onClick={() => setRechargeOpen(true)}>
            充值
          </button>
        </p>
        {state.error ? <p className="together__error">{state.error}</p> : null}
      </section>

      <div className="together__grid">
        <section className="together__panel glass">
          <h2 className="together__h2">房间</h2>
          <div className="together__create">
            <input
              className="text-input"
              placeholder="房间名，例如：一起听周杰伦"
              value={roomName}
              onChange={(event) => setRoomName(event.target.value)}
            />
            <button
              type="button"
              className="button button--primary"
              disabled={state.status !== 'connected' || !roomName.trim()}
              onClick={() => {
                together.createRoom(roomName.trim(), track ? { track, position, playing, at: Date.now() } : undefined)
                setRoomName('')
              }}
            >
              创建房间
            </button>
            <button type="button" className="button" disabled={state.status !== 'connected'} onClick={() => together.listRooms()}>
              刷新
            </button>
          </div>

          {state.rooms.length === 0 ? (
            <p className="together__empty">还没有房间。创建一个，把房间名发给朋友即可一起听。</p>
          ) : (
            <ul className="together__rooms">
              {state.rooms.map((room) => (
                <li key={room.id} className="together__room">
                  <div className="together__room-info">
                    <span className="together__room-name">{room.name}</span>
                    <span className="together__room-meta">
                      {room.members} 人 · {room.track ? `正在听《${room.track.name}》` : '暂无播放'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="button button--small"
                    disabled={state.room?.id === room.id}
                    onClick={() => together.joinRoom(room.id)}
                  >
                    {state.room?.id === room.id ? '已加入' : '加入'}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <h2 className="together__h2">找听友</h2>
          <div className="together__filter">
            <select value={gender} onChange={(event) => setGender(event.target.value)}>
              <option value="">不限性别</option>
              <option value="female">女生</option>
              <option value="male">男生</option>
            </select>
            <input
              className="text-input"
              placeholder="地区，例如 上海"
              value={region}
              onChange={(event) => setRegion(event.target.value)}
            />
            <input
              className="text-input"
              type="number"
              placeholder="最小年龄"
              value={minAge}
              onChange={(event) => setMinAge(event.target.value)}
            />
            <input
              className="text-input"
              type="number"
              placeholder="最大年龄"
              value={maxAge}
              onChange={(event) => setMaxAge(event.target.value)}
            />
            <button
              type="button"
              className="button button--primary"
              disabled={state.status !== 'connected'}
              onClick={() =>
                together.listListeners({
                  gender: gender || undefined,
                  region: region || undefined,
                  minAge: minAge ? Number(minAge) : undefined,
                  maxAge: maxAge ? Number(maxAge) : undefined
                })
              }
            >
              雷达搜索
            </button>
          </div>

          {listeners.length === 0 ? (
            <p className="together__empty">还没有搜到听友。设置条件后点「雷达搜索」。</p>
          ) : (
            <ul className="together__listeners">
              {listeners.map((listener) => (
                <li key={listener.id} className="together__listener">
                  <span className="together__listener-avatar">
                    <IconUser size={18} />
                  </span>
                  <div className="together__listener-info">
                    <span className="together__listener-name">
                      {listener.nickname}
                      {listener.gender === 'female' ? ' · 女生' : listener.gender === 'male' ? ' · 男生' : ''}
                      {listener.age ? ` · ${listener.age} 岁` : ''}
                    </span>
                    <span className="together__listener-meta">
                      {listener.region || '未填写地区'} · {listener.listening ? '正在一起听' : '空闲'}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="together__panel glass">
          {state.room ? (
            <>
              <div className="together__room-head">
                <h2 className="together__h2">
                  {state.room.name}
                  <span className="together__badge">{state.room.isHost ? '我是房主' : '跟随房主'}</span>
                </h2>
                <button type="button" className="button button--small" onClick={() => together.leaveRoom()}>
                  离开房间
                </button>
              </div>

              <p className="together__now">
                <IconMusic size={16} />
                {track ? `正在播放：${track.name} · ${player.state.playing ? '播放中' : '已暂停'}` : '还没有播放歌曲'}
              </p>
              {state.syncInfo ? <p className="together__sync">{state.syncInfo}</p> : null}

              <div className="together__members">
                {state.room.members.map((member) => (
                  <span key={member.id} className="together__member">
                    {member.nickname ?? `听友${member.id}`}
                    {member.isHost ? '（房主）' : ''}
                    {member.id === state.room?.you ? '（我）' : ''}
                  </span>
                ))}
              </div>

              <div className="together__chat">
                {state.messages.length === 0 ? (
                  <p className="together__empty">说点什么吧，房间里的所有人都能看到。</p>
                ) : (
                  state.messages.map((message, index) => (
                    <div
                      key={`${message.at}-${index}`}
                      className={`together__msg${message.from === state.room?.you ? ' is-mine' : ''}`}
                    >
                      <span className="together__msg-name">{message.from === state.room?.you ? '我' : message.nickname}</span>
                      <span className="together__msg-text">
                        {message.text}
                        {message.emoji ? <em className="together__msg-emoji">{message.emoji}</em> : null}
                      </span>
                    </div>
                  ))
                )}
              </div>

              <div className="together__compose">
                <input
                  className="text-input"
                  placeholder="发消息…"
                  value={chatText}
                  onChange={(event) => setChatText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && chatText.trim()) {
                      together.sendChat(chatText.trim())
                      setChatText('')
                    }
                  }}
                />
                <button
                  type="button"
                  className="button button--primary"
                  disabled={!chatText.trim()}
                  onClick={() => {
                    together.sendChat(chatText.trim())
                    setChatText('')
                  }}
                >
                  <IconSend size={16} />
                  发送
                </button>
              </div>

              <div className="together__emoji-row">
                {CHAT_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="together__emoji"
                    onClick={() => together.sendChat('', emoji)}
                    title={`发送表情 ${emoji}`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>

              <h3 className="together__h3">
                <IconGift size={16} />
                送礼物（余额 {(state.balance / 100).toFixed(2)} 元）
              </h3>
              <div className="together__gifts">
                {giftsByTier.map(([tier, gifts]) => (
                  <div key={tier} className="together__gift-group">
                    <span className="together__gift-tier">{TIER_LABELS[tier]}</span>
                    <div className="together__gift-items">
                      {gifts.map((gift) => (
                        <button
                          key={gift.id}
                          type="button"
                          className={`together__gift is-${gift.tier}`}
                          disabled={state.balance < gift.price}
                          onClick={() => together.sendGift(gift.id)}
                          title={`${gift.name} · ${(gift.price / 100).toFixed(2)} 元`}
                        >
                          <span className="together__gift-emoji">{gift.emoji}</span>
                          <span className="together__gift-name">{gift.name}</span>
                          <span className="together__gift-price">{(gift.price / 100).toFixed(2)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {state.giftEvents.length > 0 ? (
                <div className="together__gift-log">
                  {state.giftEvents.slice(-4).map((event, index) => (
                    <p key={`${event.at}-${index}`} className="together__gift-event">
                      <IconHeart size={14} />
                      {event.nickname ?? '听友'} 送出 {event.gift.emoji} {event.gift.name}
                    </p>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <p className="together__empty">还没有加入房间。创建或加入一个房间后就能一起听、聊天和送礼物。</p>
          )}
        </section>
      </div>

      {/* 赠礼动效浮层：只吃最新一条事件，按 at 去重，纯装饰不拦截点击。 */}
      <GiftOverlay event={state.giftEvents[state.giftEvents.length - 1]} />

      {rechargeOpen ? (
        <div className="together__modal">
          <div className="together__dialog glass">
            <h3 className="together__h3">充值礼物余额</h3>
            <div className="together__amounts">
              {RECHARGE_OPTIONS.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  className={`chip${rechargeAmount === amount ? ' is-active' : ''}`}
                  onClick={() => setRechargeAmount(amount)}
                >
                  {(amount / 100).toFixed(0)} 元
                </button>
              ))}
            </div>

            {!state.order ? (
              <>
                <p className="together__hint">扫码支付后会自动到账（每 3 秒查询一次订单状态）。</p>
                <div className="together__dialog-actions">
                  <button type="button" className="button" onClick={() => setRechargeOpen(false)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="button button--primary"
                    onClick={() => together.recharge(rechargeAmount)}
                  >
                    生成收款码
                  </button>
                </div>
              </>
            ) : state.order.ok && state.order.qrCode ? (
              <div className="together__pay">
                <QrCode url={state.order.qrCode} />
                <p className="together__pay-amount">
                  应付 <strong>{((state.order.amountFen ?? 0) / 100).toFixed(2)}</strong> 元 · 订单号 {state.order.outTradeNo}
                </p>
                {paid ? (
                  <p className="together__pay-ok">支付成功，余额已到账（{(state.balance / 100).toFixed(2)} 元）</p>
                ) : (
                  <p className="together__hint">
                    请用支付宝扫码支付，支付完成后点「我已支付」查询到账（当前状态：
                    {state.orderStatus?.status ?? '等待支付'}）
                  </p>
                )}
                <div className="together__dialog-actions">
                  <button type="button" className="button" onClick={() => together.clearOrder()}>
                    关闭
                  </button>
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={paid}
                    onClick={() => state.order?.outTradeNo && together.pollOrder(state.order.outTradeNo)}
                  >
                    我已支付，查询到账
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="together__error">{state.order.message ?? '下单失败，请稍后重试'}</p>
                <div className="together__dialog-actions">
                  <button type="button" className="button" onClick={() => together.clearOrder()}>
                    关闭
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
