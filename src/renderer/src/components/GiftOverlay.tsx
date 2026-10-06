/**
 * 赠礼动效浮层（受控组件，纯展示，不持有任何业务状态）。
 *
 * 用法 —— 页面只需要把「最新一条赠礼事件」丢进来，其余交给组件：
 *
 *   const [giftEvent, setGiftEvent] = useState<GiftOverlayEvent>()
 *   ...
 *   <GiftOverlay event={giftEvent} />
 *
 * 行为约定：
 *   - `event` 变化时播放一次 2.5 秒的动效；以 `at` 去重，同一个事件（at 相同）
 *     重复传入只会播一次，2.5 秒后自动隐藏（隐藏状态在组件内部）。
 *   - `event` 为 undefined（例如刚进房间还没有人送礼）时什么都不渲染。
 *   - 播放期间来了新的事件（at 不同）会重新开始一轮，并重新计时。
 *
 * props 形状与 lib/relay 的 RelayGiftEvent 结构兼容（后者多出的 id/price 字段
 * 可以直接传进来），但不 import 它：本组件保持独立，换数据源也不用改这里。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'

export type GiftTier = 'common' | 'rare' | 'epic' | 'legend'

export interface GiftOverlayEvent {
  gift: { emoji: string; name: string; tier: GiftTier }
  nickname?: string
  /** 事件时间戳，用于去重：同一个 at 只播一次。 */
  at: number
}

export interface GiftOverlayProps {
  event?: GiftOverlayEvent
}

/** 动效总时长；与 together-gift.css 里各 keyframes 的时长相符。 */
const DURATION_MS = 2500
/** legend 档的彩带数量，按下标均匀分布一圈。 */
const RIBBONS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]

export default function GiftOverlay({ event }: GiftOverlayProps): JSX.Element | null {
  const [playing, setPlaying] = useState<GiftOverlayEvent | undefined>()
  const lastPlayedAt = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!event) return
    // at 相同说明还是同一条事件（父组件重渲染也会传新对象），不重播。
    if (lastPlayedAt.current === event.at) return
    lastPlayedAt.current = event.at
    setPlaying(event)
    const timer = window.setTimeout(() => setPlaying(undefined), DURATION_MS)
    // 播放中来了新事件：清掉旧计时，effect 会用新事件重新走一遍。
    return () => window.clearTimeout(timer)
  }, [event])

  if (!playing) return null

  const { gift, nickname } = playing
  const tier = gift.tier

  return (
    <div className="gift-overlay" aria-live="polite">
      {/* key 绑 at：换一条事件时整棵树重建，CSS 动画才会从头播。 */}
      <div key={playing.at} className={`gift-overlay__card gift-overlay__card--${tier}`}>
        <div className="gift-overlay__stage">
          {tier === 'rare' || tier === 'epic' || tier === 'legend' ? (
            <span className="gift-overlay__halo" aria-hidden="true" />
          ) : null}
          {tier === 'epic' || tier === 'legend' ? (
            <>
              <span className="gift-overlay__ring" aria-hidden="true" />
              <span className="gift-overlay__ring gift-overlay__ring--inner" aria-hidden="true" />
            </>
          ) : null}
          {tier === 'legend' ? (
            <span className="gift-overlay__burst" aria-hidden="true">
              {RIBBONS.map((index) => (
                <span
                  key={index}
                  className="gift-overlay__ribbon"
                  // --angle 决定这片的飞出方向，动画各帧都带着它旋转。
                  style={{ '--angle': `${index * 30}deg` } as CSSProperties}
                />
              ))}
            </span>
          ) : null}
          <span className="gift-overlay__emoji" aria-hidden="true">
            {gift.emoji}
          </span>
        </div>
        <p className="gift-overlay__text">
          <span className="gift-overlay__nickname">{nickname ?? '听友'}</span>
          <span className="gift-overlay__verb">送出</span>
          <span className="gift-overlay__gift-name">{gift.name}</span>
        </p>
      </div>
    </div>
  )
}
