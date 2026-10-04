/**
 * 私人 FM —— 进入即开始漫游，垃圾桶换一首，队列快见底时静默补货。
 *
 * 队列的权威副本在主进程（player:playTracks 建立、player:append 追加），这里
 * 不再另存一份：两份曲序迟早会对不上，而「当前播放」永远以 player:state 为准。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { artistLine, call, coverUrl, usePlayerStore } from '../lib/contract'
import { useToast } from '../components/Toast'
import type { TrackDTO } from '@shared/types'

/** 剩余曲目少于这个数就补货，免得用户听到一半卡在队列结尾。 */
const REFILL_THRESHOLD = 2

export default function FM(): JSX.Element {
  const player = usePlayerStore()
  const toast = useToast()
  const [starting, setStarting] = useState(true)
  const [startError, setStartError] = useState<string | undefined>()
  const [trashing, setTrashing] = useState(false)

  // StrictMode 下 effect 会跑两次：进入页面只能开始一次漫游。
  const started = useRef(false)
  // 只有首批曲目已经进了队列，补货才有意义 —— 否则会和 start() 抢同一个队列。
  const ready = useRef(false)
  const refilling = useRef(false)

  const start = useCallback(async (): Promise<void> => {
    // 先置位再 await：第二个 effect 会在 Promise 落定之前就跑起来。
    started.current = true
    ready.current = false
    setStarting(true)
    setStartError(undefined)
    try {
      const tracks = await call('track:fm')
      if (tracks.length === 0) return
      await player.playTracks(tracks, 0)
      ready.current = true
    } catch (cause) {
      started.current = false
      setStartError(messageOf(cause))
    } finally {
      setStarting(false)
    }
  }, [player])

  useEffect(() => {
    if (started.current) return
    void start()
    // 只在进入页面时开始一次漫游；start 的标识会随播放状态变化，不能进依赖数组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const remaining = player.state.queue.length - player.state.index - 1

  /**
   * 队列不足时补一批。补货失败不打扰用户，也不断掉正在播放的歌 —— 下一次队列
   * 推进（remaining 变化）还会再试。
   */
  useEffect(() => {
    if (!ready.current || refilling.current || remaining > REFILL_THRESHOLD) return
    refilling.current = true
    void call('track:fm')
      .then((tracks) => (tracks.length > 0 ? player.append(tracks) : undefined))
      .catch(() => undefined)
      .finally(() => {
        refilling.current = false
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining])

  const trash = async (track: TrackDTO): Promise<void> => {
    if (trashing) return
    setTrashing(true)
    try {
      await call('track:fmTrash', { id: track.id })
      await player.next()
      toast.show('已记录不喜欢，换一首', 'success')
    } catch (cause) {
      toast.show(`操作失败：${messageOf(cause)}`, 'error')
    } finally {
      setTrashing(false)
    }
  }

  const retry = (): void => {
    started.current = false
    void start()
  }

  const track = player.state.track
  const cover = coverUrl(track?.album.picUrl, 768)

  return (
    <div className="fm">
      {track?.album.picUrl ? (
        <div
          className="fm__backdrop"
          style={{ backgroundImage: `url(${coverUrl(track.album.picUrl, 384)})` }}
        />
      ) : null}

      <div className="fm__body">
        {starting ? (
          <div className="placeholder">正在为你挑选漫游曲目…</div>
        ) : startError ? (
          <div className="placeholder">
            <div className="placeholder__title">私人漫游启动失败</div>
            <div>{startError}</div>
            <button type="button" className="button" onClick={retry}>
              重试
            </button>
          </div>
        ) : !track ? (
          <div className="placeholder">
            <div className="placeholder__title">暂时没有可漫游的歌曲</div>
            <div>登录并多听几首歌之后，网易云会给出更准的推荐</div>
            <button type="button" className="button" onClick={retry}>
              重新漫游
            </button>
          </div>
        ) : (
          <>
            {cover ? (
              <img className="fm__art" src={cover} alt="" />
            ) : (
              <div className="fm__art fm__art--empty">♪</div>
            )}

            <div className="fm__meta">
              <div className="fm__title" title={track.name}>
                {track.name}
              </div>
              <div className="fm__artist">{artistLine(track)}</div>
            </div>

            <div className="fm__controls">
              <button
                type="button"
                className="fm__control"
                title="不喜欢，换一首"
                disabled={trashing}
                onClick={() => void trash(track)}
              >
                {trashing ? '…' : '🗑'}
              </button>
              <button
                type="button"
                className="fm__control fm__control--primary"
                title={player.state.playing ? '暂停' : '播放'}
                onClick={() => void player.toggle()}
              >
                {player.state.loading ? '⏳' : player.state.playing ? '⏸' : '▶'}
              </button>
              <button type="button" className="fm__control" title="下一首" onClick={() => void player.next()}>
                ⏭
              </button>
            </div>

            <div className="fm__queue">
              漫游队列剩余 {Math.max(0, remaining)} 首
              {remaining <= REFILL_THRESHOLD ? ' · 正在补充' : ''}
            </div>
          </>
        )}
      </div>

      {toast.node}
    </div>
  )
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
