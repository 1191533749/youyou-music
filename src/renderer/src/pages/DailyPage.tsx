/**
 * 每日推荐 —— 每天 6:00 更新的 30 首。
 *
 * 「不喜欢」不是删除：主进程会返回一首替换曲目，我们原地把那一行换掉。行号
 * 保持不变，用户能立刻看出「换了一首」，而不是列表突然短了一截。
 *
 * 未登录时路由也会渲染本页，所以这里自己处理未登录态：给一张轻提示卡引导去
 * 登录，而不是把整页让给二维码，也不去发注定会被拒的请求。
 */
import { useMemo, useState } from 'react'
import { SongList, call, useAuthStore, useNavigation, usePlayerStore } from '../lib/contract'
import { useAsync } from '../lib/hooks'
import { IconCalendar, IconPlay, IconUser } from '../components/Icons'
import { useToast } from '../components/Toast'
import type { TrackDTO } from '@shared/types'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export default function DailyPage(): JSX.Element {
  const player = usePlayerStore()
  const auth = useAuthStore()
  const navigation = useNavigation()
  const toast = useToast()
  const [replacing, setReplacing] = useState<number | undefined>()

  // 未登录时不请求：主进程只会回 needLogin，页面直接用提示卡引导登录。
  const daily = useAsync<TrackDTO[]>(
    () => (auth.loggedIn ? call('home:dailySongs') : Promise.resolve([])),
    [auth.loggedIn]
  )

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

  const banner = (
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
  )

  // 登录态还没确认完之前先当作正常路径：已登录用户不该看到一闪而过的登录提示。
  if (!auth.loading && !auth.loggedIn) {
    return (
      <div className="page">
        {banner}
        <div className="daily__gate">
          <span className="daily__gate-icon">
            <IconUser size={26} />
          </span>
          <div className="daily__gate-title">登录后解锁每日推荐</div>
          <div className="daily__gate-hint">
            登录网易云账号后，这里每天会按你的收听口味更新一批歌曲。
          </div>
          <button
            type="button"
            className="button button--primary icon-label glass-btn"
            onClick={() => navigation.push({ name: 'library' })}
          >
            <IconUser size={15} />
            去登录
          </button>
        </div>
        {toast.node}
      </div>
    )
  }

  return (
    <div className="page">
      {banner}

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
