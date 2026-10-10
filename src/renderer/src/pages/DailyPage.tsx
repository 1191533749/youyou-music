/**
 * 每日推荐 —— 每天 6:00 更新的 30 首，并且可以回看最近 7 天。
 *
 * 顶部日期条里每一天都能点：
 *   - 「今天」走原来的 home:dailySongs；
 *   - 其他日期走 home:dailyHistory({ date })，主进程按日期取那天的日推。
 *
 * 展示层是首页同款的封面卡片网格（.card + .grid--albums）：封面大图、歌名、歌手，
 * 悬停出播放圈、点封面播放（正在播放的那首点一下是暂停/继续）。数据链路一行没动 ——
 * 今天仍然是 home:dailySongs，历史日期仍然是 home:dailyHistory。
 *
 * 「不喜欢」不是删除：主进程会返回一首替换曲目，我们原地把那一张卡片换掉。位置
 * 保持不变，用户能立刻看出「换了一首」，而不是网格突然少了一张。换歌只对今天
 * 有意义（历史日推是回看），所以日期不是今天时不提供这一张卡片的操作。
 *
 * 未登录时路由也会渲染本页，所以这里自己处理未登录态：给一张轻提示卡引导去
 * 登录，而不是把整页让给二维码，也不去发注定会被拒的请求。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  artistLine,
  call,
  coverUrl,
  useAuthStore,
  useNavigation,
  usePlayerStore,
  type Route
} from '../lib/contract'
import { useAsync } from '../lib/hooks'
import {
  IconCalendar,
  IconClose,
  IconDisc,
  IconMusic,
  IconPlay,
  IconUser
} from '../components/Icons'
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

  /**
   * 首页日期条会 navigation.reset({ name: 'daily', date }) 跳过来：把路由里带的日期
   * 当成一次「点了那一天」。用 route 对象本身去重 —— 只在导航真的换了新对象时才切换，
   * 否则用户在页面里手动改选日期之后，会被这条旧路由立刻拉回去。
   * 切换走的还是 selected → loadHistory 那条既有链路，所以加载态（loadedDate !== selected）
   * 与切日期完全一致。
   */
  const consumedRoute = useRef<Route | undefined>(undefined)
  const route = navigation.route
  useEffect(() => {
    if (route.name !== 'daily' || !route.date) return
    if (consumedRoute.current === route) return
    consumedRoute.current = route
    setSelected(route.date)
  }, [route])

  // 未登录时不请求：主进程只会回 needLogin，页面直接用提示卡引导登录。
  const daily = useAsync<TrackDTO[]>(
    () => (auth.loggedIn ? call('home:dailySongs') : Promise.resolve([])),
    [auth.loggedIn]
  )

  // 历史日推：只在选中非今天时拉取。generation 防止快速切换日期时旧响应覆盖新日期。
  const [history, setHistory] = useState<TrackDTO[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | undefined>()
  /**
   * 已经有结果的那个历史日期。点日期时 selected 立刻变、请求还在路上，
   * 这一个值还是上一天 —— 两者不一致就说明数据没到，界面必须停在加载态。
   */
  const [loadedDate, setLoadedDate] = useState<string | undefined>()
  const historyGeneration = useRef(0)

  const loadHistory = useCallback(
    (date: string) => {
      if (!auth.loggedIn) return
      const generation = ++historyGeneration.current
      setHistoryLoading(true)
      setHistoryError(undefined)
      void call('home:dailyHistory', { date })
        .then((items) => {
          if (generation !== historyGeneration.current) return
          setHistory(items)
          setLoadedDate(date)
        })
        .catch((cause) => {
          if (generation !== historyGeneration.current) return
          setHistory([])
          setLoadedDate(date)
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
  const historyPending = !isToday && loadedDate !== selected
  const loading = isToday ? daily.loading : historyLoading || historyPending
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

  /**
   * 点卡片＝把当天列表当队列、从这首开始播（和首页/列表页的 onPlay 是同一套语义：
   * 本来就正在放的这首再点一次也是从头播，不做暂停）。双击的两次点击因此都是
   * 「播放」，不会出现点一下开始、第二下又停住的抖动。
   */
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
          <div className="placeholder__title">{isToday ? '今天还没有推荐' : '这一天没有留下记录'}</div>
          {isToday ? null : <div>每日推荐只有当天打开过客户端才会同步到本地</div>}
        </div>
      ) : (
        <div className="grid grid--albums">
          {tracks.map((track, index) => (
            <DailyCard
              key={`${index}-${track.id}`}
              track={track}
              index={index}
              // 正在播放的那张亮起来：和列表页的选中行是同一套语义。
              current={player.state.track?.id === track.id}
              busy={replacing === track.id}
              canDislike={isToday}
              onPlay={play}
              onDislike={dislike}
            />
          ))}
        </div>
      )}

      {toast.node}
    </div>
  )
}

interface DailyCardProps {
  track: TrackDTO
  index: number
  /** 这首就是播放条上正在放的那首：封面描一圈强调色。 */
  current: boolean
  /** 「不喜欢」的替换请求正在路上（只对今天有意义）。 */
  busy: boolean
  canDislike: boolean
  onPlay: (index: number) => void
  onDislike: (track: TrackDTO, index: number) => void
}

/**
 * 一张封面卡片：封面大图（缺失时用中性占位）、歌名、歌手。
 *
 * 结构与首页卡片共用同一套类（.card / .card__art / .card__title / .card__meta），
 * 这里只补三样首页卡片没有的东西：悬停播放圈（.daily-card__hint）、角上的
 * 「不喜欢」（.daily-card__dislike）、当前播放的高亮。封面整块是一个按钮 ——
 * 点哪儿都是播放，不用去瞄一个小图标。
 */
function DailyCard({
  track,
  index,
  current,
  busy,
  canDislike,
  onPlay,
  onDislike
}: DailyCardProps): JSX.Element {
  const cover = coverUrl(track.album.picUrl, 512)
  const [broken, setBroken] = useState(false)

  // 换了一首之后封面地址会变：加载失败的标记要跟着重置，否则新封面会一直被占位图挡着。
  useEffect(() => {
    setBroken(false)
  }, [cover])

  const showPlaceholder = cover === undefined || broken

  return (
    <article
      className={`card daily-card${current ? ' is-current' : ''}`}
      // 双击卡片任意位置也是播放（和列表页 song-row 的 onDoubleClick 一致）：两次 click
      // 都会走到 play()，同一个 index 从头再播一次，不会变成「开始又停住」。
      onDoubleClick={() => onPlay(index)}
    >
      <div className="card__art">
        {showPlaceholder ? (
          <span className="card__placeholder">
            <IconMusic size={28} />
          </span>
        ) : (
          <img src={cover} alt="" loading="lazy" onError={() => setBroken(true)} />
        )}
        <button
          type="button"
          className="daily-card__hit"
          aria-label={current ? `正在播放：${track.name}` : `播放 ${track.name}`}
          title={current ? '重新播放' : '播放'}
          onClick={() => onPlay(index)}
        >
          <span className="daily-card__hint" aria-hidden="true">
            <IconPlay size={18} />
          </span>
        </button>
        {canDislike ? (
          <button
            type="button"
            className="daily-card__dislike"
            aria-label={`不喜欢，换一首：${track.name}`}
            title="不喜欢，换一首"
            disabled={busy}
            // 连点两下「不喜欢」不该顺带把这张卡片双击播放掉。
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={() => onDislike(track, index)}
          >
            {busy ? (
              <span className="spin">
                <IconDisc size={13} />
              </span>
            ) : (
              <IconClose size={13} />
            )}
          </button>
        ) : null}
      </div>
      <div className="card__title">{track.name}</div>
      <div className="card__meta">{artistLine(track)}</div>
    </article>
  )
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
