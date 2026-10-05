/**
 * 每日推荐 —— 每天 6:00 更新的 30 首。
 *
 * 「不喜欢」不是删除：主进程会返回一首替换曲目，我们原地把那一行换掉。行号
 * 保持不变，用户能立刻看出「换了一首」，而不是列表突然短了一截。
 */
import { useMemo, useState } from 'react'
import { SongList, call, usePlayerStore } from '../lib/contract'
import { useAsync } from '../lib/hooks'
import { IconCalendar, IconPlay } from '../components/Icons'
import { useToast } from '../components/Toast'
import type { TrackDTO } from '@shared/types'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export default function DailyPage(): JSX.Element {
  const player = usePlayerStore()
  const toast = useToast()
  const daily = useAsync<TrackDTO[]>(() => call('home:dailySongs'), [])
  const [replacing, setReplacing] = useState<number | undefined>()

  const tracks = daily.data ?? []

  // 日期只在进入页面时取一次就够；跨零点还停在这一页属于可以接受的偏差。
  const today = useMemo(() => {
    const now = new Date()
    return `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · 星期${
      WEEKDAYS[now.getDay()]
    }`
  }, [])

  const play = (index: number): void => {
    void player.playTracks(tracks, index)
  }

  /**
   * 整表播放：让主进程随机起播（store 的 playTracks 还没暴露 randomStart，
   * 这里直接走通道；状态变化由 player:state 广播回 store）。
   */
  const playAll = (): void => {
    if (tracks.length === 0) return
    void call('player:playTracks', { tracks, startIndex: 0, randomStart: true }).catch(() => undefined)
  }

  const dislike = async (track: TrackDTO, index: number): Promise<void> => {
    if (replacing !== undefined) return
    setReplacing(track.id)
    try {
      const replacement = await call('home:dislikeDaily', { trackID: track.id })
      daily.setData((current) => (current ?? []).map((item, itemIndex) => (itemIndex === index ? replacement : item)))
      toast.show('已换一首', 'success')
    } catch (cause) {
      toast.show(`换歌失败：${messageOf(cause)}`, 'error')
    } finally {
      setReplacing(undefined)
    }
  }

  return (
    <div className="page">
      <div className="daily__banner">
        <div className="daily__headline">
          <div className="daily__date">
            <IconCalendar size={15} />
            {today}
          </div>
          <h1 className="daily__title">每日推荐</h1>
          <div className="daily__hint">根据你的音乐口味 · 每天 6:00 更新</div>
        </div>
        <button
          type="button"
          className="button button--primary icon-label glass-btn"
          disabled={tracks.length === 0}
          onClick={playAll}
        >
          <IconPlay size={14} />
          播放全部
        </button>
      </div>

      {daily.loading ? (
        <div className="placeholder">正在获取今天的推荐</div>
      ) : daily.error ? (
        <div className="placeholder">
          <div className="placeholder__title">每日推荐加载失败</div>
          <div>{daily.error}</div>
          <button type="button" className="button glass-btn" onClick={daily.reload}>
            重试
          </button>
        </div>
      ) : tracks.length === 0 ? (
        <div className="placeholder">
          <div className="placeholder__title">今天还没有推荐</div>
          <div>多听几首歌培养口味，推荐每天 6:00 更新</div>
        </div>
      ) : (
        <div className="daily__panel">
          <SongList
            tracks={tracks}
            currentTrackID={player.state.track?.id}
            onPlay={play}
            rowAction={{ label: '不喜欢，换一首', onSelect: (track, index) => void dislike(track, index) }}
          />
        </div>
      )}

      {toast.node}
    </div>
  )
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
