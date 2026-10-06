/**
 * 「一起听」的雷达盘：把搜到的听友画成盘上的头像光点。
 *
 * 每个光点的角度、半径、漂移方向与速度都由听友 id 做**确定性哈希**算出来，不用
 * Math.random —— 随机数会让每次重渲染都跳到新位置，而这里要的是「每个点各自慢慢
 * 流动、但位置固定」。四个漂移关键帧错开使用，避免所有点整齐划一地移动。
 *
 * 头像用真实 <img>，没有头像或加载失败时退回 IconUser 占位。
 * 悬停或点击某个光点，右侧信息卡显示昵称、年龄、地区与个性签名（点击可固定住）。
 */
import { useMemo, useState, type CSSProperties } from 'react'
import { IconUser } from './Icons'
import type { RelayListener, RelayProfile } from '../lib/relay'

export interface RadarProps {
  listeners: RelayListener[]
  /** 听友在房间里时，信息卡里给出「加入 TA 的房间」。 */
  onJoinRoom?: (roomId: string) => void
  /** 已经在的房间不再提示加入。 */
  joinedRoomId?: string
}

/** 听友头像：加载失败或无头像时用线性图标占位。 */
export function ListenerAvatar({ src, size = 16 }: { src?: string; size?: number }): JSX.Element {
  const [broken, setBroken] = useState(false)
  if (!src || broken) return <IconUser size={size} />
  return <img className="radar__avatar" src={src} alt="" loading="lazy" onError={() => setBroken(true)} />
}

/** 0..1 的确定性伪随机：同一个 id + 同一个盐永远得到同一个值。 */
function seeded(id: number, salt: number): number {
  const value = Math.sin(id * 12.9898 + salt * 78.233) * 43758.5453
  return value - Math.floor(value)
}

interface Blip {
  listener: RelayListener
  /** 相对盘心的百分比偏移（相对盘宽，范围 -35 ~ 35）。 */
  x: number
  y: number
  /** 漂移关键帧编号 a/b/c/d。 */
  drift: string
  duration: number
  delay: number
}

const DRIFTS = ['a', 'b', 'c', 'd']

function toBlips(listeners: RelayListener[]): Blip[] {
  return listeners.map((listener) => {
    const angle = seeded(listener.id, 1) * Math.PI * 2
    // 半径压在 20%~70%（百分比是「盘半径的百分比」）：太靠边会被圆盘裁掉，
    // 太靠中心会和扫描线挤在一起。除以 2 换成相对盘**宽度**的偏移，方便 calc。
    const radius = (20 + seeded(listener.id, 2) * 50) / 2
    return {
      listener,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      drift: DRIFTS[Math.floor(seeded(listener.id, 3) * DRIFTS.length)] ?? 'a',
      duration: 7 + seeded(listener.id, 4) * 7,
      delay: -seeded(listener.id, 5) * 8
    }
  })
}

function genderLabel(gender?: string): string | undefined {
  if (gender === 'female') return '女生'
  if (gender === 'male') return '男生'
  return undefined
}

/** 「女生 · 26 岁 · 上海」这样的一行小字，缺哪项就少哪项。 */
export function listenerMeta(listener: RelayProfile): string {
  return [genderLabel(listener.gender), listener.age ? `${listener.age} 岁` : undefined, listener.region]
    .filter(Boolean)
    .join(' · ')
}

export default function Radar({ listeners, onJoinRoom, joinedRoomId }: RadarProps): JSX.Element {
  const [hovered, setHovered] = useState<number>()
  const [picked, setPicked] = useState<number>()
  const blips = useMemo(() => toBlips(listeners), [listeners])

  const activeId = hovered ?? picked
  const active = blips.find((blip) => blip.listener.id === activeId)
  const meta = active ? listenerMeta(active.listener) : ''

  return (
    <div className="radar">
      <div className="radar__stage">
        <div className="radar__dish">
        <span className="radar__ring radar__ring--outer" aria-hidden="true" />
        <span className="radar__ring radar__ring--mid" aria-hidden="true" />
        <span className="radar__ring radar__ring--inner" aria-hidden="true" />
        <span className="radar__axis radar__axis--h" aria-hidden="true" />
        <span className="radar__axis radar__axis--v" aria-hidden="true" />
        <span className="radar__sweep" aria-hidden="true" />
        <span className="radar__core" aria-hidden="true" />

        {blips.map((blip) => {
          const { listener, x, y, drift, duration, delay } = blip
          return (
            <button
              key={listener.id}
              type="button"
              className={`radar__blip radar__blip--drift-${drift}${activeId === listener.id ? ' is-active' : ''}${
                picked === listener.id ? ' is-picked' : ''
              }`}
              style={
                {
                  '--radar-x': `${x}%`,
                  '--radar-y': `${y}%`,
                  animationDuration: `${duration.toFixed(2)}s`,
                  animationDelay: `${delay.toFixed(2)}s`
                } as CSSProperties
              }
              title={listener.nickname ?? '听友'}
              aria-label={`听友 ${listener.nickname ?? ''}`}
              onMouseEnter={() => setHovered(listener.id)}
              onMouseLeave={() => setHovered((current) => (current === listener.id ? undefined : current))}
              onFocus={() => setHovered(listener.id)}
              onBlur={() => setHovered((current) => (current === listener.id ? undefined : current))}
              onClick={() => setPicked((current) => (current === listener.id ? undefined : listener.id))}
            >
              <span className="radar__halo" aria-hidden="true" />
              <span className="radar__dot">
                <ListenerAvatar src={listener.avatar} size={15} />
              </span>
            </button>
          )
        })}

        </div>

        {/* 说明放盘外：盘内的光点会漂到任意位置，压在文字上就不好读了。 */}
        <span className="radar__caption">
          {listeners.length > 0 ? `盘上 ${listeners.length} 位听友` : '等待扫描'}
        </span>
      </div>

      <aside className="radar__info" aria-live="polite">
        {active ? (
          <>
            <div className="radar__info-head">
              <span className="radar__info-avatar">
                <ListenerAvatar src={active.listener.avatar} size={20} />
              </span>
              <div className="radar__info-title">
                <span className="radar__info-name">{active.listener.nickname ?? '听友'}</span>
                <span className="radar__info-meta">{meta || '资料未公开'}</span>
              </div>
            </div>
            <p className={`radar__info-sign${active.listener.signature ? '' : ' is-muted'}`}>
              {active.listener.signature || 'TA 还没有写个性签名'}
            </p>
            {active.listener.listening ? <span className="radar__info-tag">正在一起听</span> : null}
            {onJoinRoom && active.listener.roomId && active.listener.roomId !== joinedRoomId ? (
              <button
                type="button"
                className="button button--small button--primary"
                onClick={() => onJoinRoom(active.listener.roomId as string)}
              >
                加入 TA 的房间
              </button>
            ) : null}
          </>
        ) : (
          <p className="radar__info-idle">
            把鼠标移到盘上的头像光点，查看昵称、年龄、地区与个性签名；点击光点可以固定住资料。
          </p>
        )}
      </aside>
    </div>
  )
}
