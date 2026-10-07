/**
 * 每日推荐 —— 每天 6:00 更新的 30 首，并且可以回看最近 7 天。
 *
 * 顶部日期条里每一天都能点：
 *   - 「今天」走原来的 home:dailySongs；
 *   - 其他日期走 home:dailyHistory({ date })，主进程按日期取那天的日推。
 *
 * 「不喜欢」不是删除：主进程会返回一首替换曲目，我们原地把那一行换掉。行号
 * 保持不变，用户能立刻看出「换了一首」，而不是列表突然短了一截。换歌只对今天
 * 有意义（历史日推是回看），所以日期不是今天时不提供这一行操作。
 *
 * 未登录时路由也会渲染本页，所以这里自己处理未登录态：给一张轻提示卡引导去
 * 登录，而不是把整页让给二维码，也不去发注定会被拒的请求。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SongList, call, useAuthStore, useNavigation, usePlayerStore } from '../lib/contract'
import { useAsync } from '../lib/hooks'
import { IconCalendar, IconPlay, IconUser } from '../components/Icons'
import { useToast } from '../components/Toast'
import '../styles/daily.css'
import type { TrackDTO } from '@shared/types'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
/** 日期条回看的天数（含今天）。 */
const HISTORY_DAYS = 7

interface DayEntry {
  /** YYYY-MM-DD，直接作为 home:dailyHistory 的 date 参数。 */
  key: string
  /** 按钮上的一行字：今天 / 昨天 / 10/1（不写周几）。 */
  label: string
  /** 2026 年 10 月 7 日 · 星期三，给 title 与页面大标题用。 */
  long: string
}

/** 本地日期键：不能用 toISOString()，那会按 UTC 把东八区的凌晨算成前一天。 */
function keyOf(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function describe(date: Date, offset: number): DayEntry {
  const weekday = WEEKDAYS[date.getDay()]
  return {
    key: keyOf(date),
    // 只显示日期本身；今天 / 昨天保留这两个写法。
    label: offset === 0 ? '今天' : offset === 1 ? '昨天' : `${date.getMonth() + 1}/${date.getDate()}`,
    long: `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日 · 星期${weekday}`
  }
}

/** 最近 7 天，按时间正序：最左是 6 天前，最右是今天。 */
function recentDays(): DayEntry[] {
  const now = new Date()
  const days: DayEntry[] = []
  for (let offset = HISTORY_DAYS - 1; offset >= 0; offset -= 1) {
    days.push(describe(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset), offset))
  }
  return days
}

export default function DailyPage(): JSX.Element {
  const player = usePlayerStore()
  const auth = useAuthStore()
  const navigation = useNavigation()
  const toast = useToast()
  const [replacing, setReplacing] = useState<number | undefined>()

  // 日期只在进入页面时算一次；跨零点还停在这一页属于可以接受的偏差。
  const days = useMemo(recentDays, [])
  const today = days[days.length - 1]
  const [selected, setSelected] = useState<string>(() => keyOf(new Date()))
  const isToday = selected === today.key
  const selectedDay = days.find((day) => day.key === selected) ?? today

  // 未登录时不请求：主进程只会回 needLogin，页面直接用提示卡引导登录。
  const daily = useAsync<TrackDTO[]>(
    () => (auth.loggedIn ? call('home:dailySongs') : Promise.resolve([])),
    [auth.loggedIn]
  )

  // 历史日推：只在选中非今天时拉取。generation 防止快速切换日期时旧响应覆盖新日期。
  const [history, setHistory] = useState<TrackDTO[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | undefined>()
  const historyGeneration = useRef(0)

  const loadHistory = useCallback(
    (date: string) => {
      if (!auth.loggedIn) return
      const generation = ++historyGeneration.current
      setHistoryLoading(true)
      setHistoryError(undefined)
      void call('home:dailyHistory', { date })
        .then((items) => {
          if (generation === historyGeneration.current) setHistory(items)
        })
        .catch((cause) => {
          if (generation !== historyGeneration.current) return
          setHistory([])
          setHistoryError(messageOf(cause))
        })
        .finally(() => {
          if (generation === historyGeneration.current) setHistoryLoading(false)
        })
    },
    [auth.loggedIn]
  )

  useEffect(() => {
    if (isToday || !auth.loggedIn) return
    loadHistory(selected)
  }, [auth.loggedIn, isToday, loadHistory, selected])

  /**
   * 刚启动那一瞬 /v3/discovery/recommend/songs 会返回「ok 但没有 dailySongs 字段」，
   * 主进程解码成空数组，页面就成了「今天还没有推荐」。这里自动补一次请求（每挂载只补一次，
   * 不给真的没有推荐的账号反复发请求）；手动再点一次「今天」或「重新加载」也能恢复。
   */
  const retriedEmptyToday = useRef(false)
  useEffect(() => {
    if (!isToday || daily.loading || daily.error !== undefined) return
    if ((daily.data?.length ?? 0) > 0 || retriedEmptyToday.current) return
    retriedEmptyToday.current = true
    const timer = window.setTimeout(() => daily.reload(), 2500)
    return () => window.clearTimeout(timer)
  }, [daily, isToday])

  // 选中哪天就用哪天的数据；「播放全部」的队列自然也就是当天列表。
  const tracks = isToday ? daily.data ?? [] : history
  const loading = isToday ? daily.loading : historyLoading
  const error = isToday ? daily.error : historyError
  const retry = isToday ? daily.reload : (): void => loadHistory(selected)

  /**
   * 点日期条。今天是 useAsync 拉的，只在 auth 变化时自动重跑；如果上一次拿回来是空
   * （刚启动那一瞬接口抽风很常见），再点一次「今天」就重拉一次，给用户一条不用切页面
   * 的恢复路径 —— 否则这一格会一直停在空态。
   */
  const selectDay = (key: string): void => {
    setSelected(key)
    if (key === today.key && (daily.error !== undefined || (daily.data?.length ?? 0) === 0)) {
      daily.reload()
    }
  }

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

  const dateStrip = (
    <div className="daily-dates" role="group" aria-label="选择日期">
      {days.map((day) => {
        const active = day.key === selected
        return (
          <button
            key={day.key}
            type="button"
            aria-pressed={active}
            className={`daily-dates__day${active ? ' is-active' : ''}`}
            title={day.long}
            onClick={() => selectDay(day.key)}
          >
            <span className="daily-dates__label">{day.label}</span>
          </button>
        )
      })}
    </div>
  )

  const banner = (
    <div className="daily__banner">
      <div className="daily__headline">
        <div className="daily__date">
          <IconCalendar size={15} />
          {selectedDay.long}
        </div>
        <h1 className="daily__title">每日推荐</h1>
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
      {dateStrip}
      {banner}

      {loading ? (
        <div className="placeholder">{isToday ? '正在获取今天的推荐' : '正在获取这一天的推荐'}</div>
      ) : error ? (
        <div className="placeholder">
          <div className="placeholder__title">每日推荐加载失败</div>
          <div>{error}</div>
          <button type="button" className="button glass-btn" onClick={retry}>
            重试
          </button>
        </div>
      ) : tracks.length === 0 ? (
        <div className="placeholder">
          <div className="placeholder__title">{isToday ? '今天还没有推荐' : '这一天没有每日推荐记录'}</div>
        </div>
      ) : (
        <div className="daily__panel">
          <SongList
            tracks={tracks}
            currentTrackID={player.state.track?.id}
            onPlay={play}
            rowAction={
              isToday
                ? { label: '不喜欢，换一首', onSelect: (track, index) => void dislike(track, index) }
                : undefined
            }
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
