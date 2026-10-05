/**
 * 发现页：分类歌单（无限滚动）、精品歌单（before 游标翻页）、热门歌手。
 *
 * 三个板块对应三个接口，翻页语义也不同 —— 分类歌单按 offset 翻，精品歌单按
 * before 时间戳翻，热门歌手一次取回。所以这里把「取一页」抽象成游标函数，
 * 由调用方决定游标怎么算，列表本身只关心去重和加载状态。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArtCard, call, coverUrl, formatPlayCount, useNavigation } from '../lib/contract'
import { useAsync } from '../lib/hooks'
import { IconDiamond, IconDisc, IconLayers, IconPlus, IconUser } from '../components/Icons'
import type { ArtistSummaryDTO, PlaylistSummaryDTO } from '@shared/types'

/** 图标组件的公共形状：尺寸与类名可传，颜色跟随 currentColor。 */
type IconComponent = (props: { size?: number; className?: string }) => JSX.Element

/** 网易云真实分类词，顺序与官方客户端一致。 */
const CATEGORIES = [
  '全部',
  '华语',
  '欧美',
  '日本',
  '韩国',
  '流行',
  '摇滚',
  '民谣',
  '电子',
  '说唱',
  '轻音乐',
  '爵士',
  '古典',
  '影视原声',
  'ACG'
]

const ORDERS: Array<{ value: string; label: string }> = [
  { value: 'hot', label: '最热' },
  { value: 'new', label: '最新' }
]

type Tab = 'top' | 'high' | 'artists'

const TABS: Array<{ value: Tab; label: string; Icon: IconComponent }> = [
  { value: 'top', label: '分类歌单', Icon: IconLayers },
  { value: 'high', label: '精品歌单', Icon: IconDiamond },
  { value: 'artists', label: '热门歌手', Icon: IconUser }
]

const PAGE_SIZE = 50
/** 分类歌单最多翻到 500 首，与上游客户端一致，避免一直翻下去拖垮接口。 */
const MAX_ITEMS = 500

interface Page {
  items: PlaylistSummaryDTO[]
  /** 下一页的游标：offset 或 before 时间戳，由调用方解释。 */
  cursor: number
  more?: boolean
}

interface InfiniteList {
  items: PlaylistSummaryDTO[]
  loading: boolean
  loadingMore: boolean
  error?: string
  more: boolean
  loadMore: () => void
  reload: () => void
}

export default function Explore(): JSX.Element {
  const navigation = useNavigation()
  const [tab, setTab] = useState<Tab>('top')
  const [category, setCategory] = useState('全部')
  const [order, setOrder] = useState('hot')

  const top = useInfinitePlaylists(`top:${category}:${order}`, tab === 'top', (cursor) =>
    call('explore:topPlaylists', { category, order, limit: PAGE_SIZE, offset: cursor }).then((page) => ({
      items: page.items,
      cursor: cursor + page.items.length,
      more: (page.more ?? page.items.length >= PAGE_SIZE) && cursor + page.items.length < MAX_ITEMS
    }))
  )

  const high = useInfinitePlaylists(`high:${category}`, tab === 'high', (cursor) =>
    call('explore:highQuality', { category, limit: PAGE_SIZE, before: cursor }).then((page) => ({
      items: page.items,
      // 精品歌单拿最后一条的更新时间当游标；接口不再给 lasttime 就说明到底了。
      cursor: page.lasttime ?? 0,
      more: page.more
    }))
  )

  // 热门歌手只在切到该标签时请求；其余标签下解析成空数组，不产生网络调用。
  const artists = useAsync<ArtistSummaryDTO[]>(
    () => (tab === 'artists' ? call('explore:topArtists', { limit: 60 }) : Promise.resolve([])),
    [tab]
  )

  const list = tab === 'top' ? top : high

  return (
    <div className="page explore">
      <header className="page__header">
        <div>
          <h1 className="page__title">发现</h1>
          <div className="page__subtitle">按分类逛歌单，或者看看最近的精品推荐</div>
        </div>
      </header>

      <div className="toolbar">
        <div className="chip-row">
          {TABS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`chip${tab === item.value ? ' is-active' : ''}`}
              onClick={() => setTab(item.value)}
            >
              <item.Icon size={14} />
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {tab !== 'artists' ? (
        <div className="toolbar explore__filters">
          <div className="chip-row">
            {CATEGORIES.map((item) => (
              <button
                key={item}
                type="button"
                className={`chip${category === item ? ' is-active' : ''}`}
                onClick={() => setCategory(item)}
              >
                {item}
              </button>
            ))}
          </div>
          {tab === 'top' ? (
            <div className="chip-row explore__orders">
              {ORDERS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={`chip${order === item.value ? ' is-active' : ''}`}
                  onClick={() => setOrder(item.value)}
                  title={`按${item.label}排序`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === 'artists' ? (
        <ArtistsGrid
          artists={artists.data ?? []}
          loading={artists.loading}
          error={artists.error}
          onRetry={artists.reload}
          onOpen={(artist) => navigation.push({ name: 'artist', id: artist.id, title: artist.name })}
        />
      ) : (
        <PlaylistGrid
          list={list}
          emptyMessage={tab === 'top' ? '这个分类暂时没有歌单' : '暂时没有精品歌单'}
          onOpen={(playlist) => navigation.push({ name: 'playlist', id: playlist.id, title: playlist.name })}
        />
      )}
    </div>
  )
}

function PlaylistGrid({
  list,
  emptyMessage,
  onOpen
}: {
  list: InfiniteList
  emptyMessage: string
  onOpen: (playlist: PlaylistSummaryDTO) => void
}): JSX.Element {
  return (
    <>
      {list.error ? (
        <div className="page__error">
          <span>加载失败：{list.error}</span>
          <button type="button" className="button" onClick={list.reload}>
            重试
          </button>
        </div>
      ) : null}

      {list.loading ? (
        <div className="explore__loading">
          <div className="loading-state">
            <IconDisc size={16} className="spin" />
            <span>正在加载歌单…</span>
          </div>
          <div className="skeleton explore__skeleton" />
        </div>
      ) : null}

      {!list.loading && list.items.length === 0 && !list.error ? (
        <div className="placeholder">
          <div className="placeholder__title">{emptyMessage}</div>
          <div>换个分类或者稍后再试。</div>
        </div>
      ) : null}

      {list.items.length > 0 ? (
        <div className="grid grid--playlists">
          {list.items.map((playlist) => (
            <ArtCard
              key={playlist.id}
              title={playlist.name}
              subtitle={playlist.creator?.nickname ?? `${playlist.trackCount} 首`}
              imageUrl={coverUrl(playlist.coverURL, 320)}
              badge={playlist.playCount > 0 ? formatPlayCount(playlist.playCount) : undefined}
              onClick={() => onOpen(playlist)}
            />
          ))}
        </div>
      ) : null}

      <InfiniteFooter list={list} />
    </>
  )
}

/** 触底哨兵 + 兜底按钮：滚进视野就自动翻页，观察者失灵时按钮仍然可用。 */
function InfiniteFooter({ list }: { list: InfiniteList }): JSX.Element | null {
  const observerRef = useRef<IntersectionObserver | undefined>(undefined)
  const loadMoreRef = useRef(list.loadMore)

  // 观察者只订阅一次，回调里读 ref，避免拿到旧分类的闭包。
  useEffect(() => {
    loadMoreRef.current = list.loadMore
  })

  const sentinelRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = undefined
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreRef.current()
      },
      // 提前 240px 触发，用户基本看不到等待。
      { rootMargin: '240px' }
    )
    observer.observe(node)
    observerRef.current = observer
  }, [])

  if (!list.more) {
    return list.items.length > 0 ? <div className="explore__end">已经到底了</div> : null
  }

  return (
    <div className="explore__footer">
      <div ref={sentinelRef} className="explore__sentinel" aria-hidden="true" />
      {list.loadingMore ? (
        <div className="loading-state">
          <IconDisc size={15} className="spin" />
          <span>正在加载更多…</span>
        </div>
      ) : (
        <button type="button" className="button" onClick={list.loadMore}>
          <IconPlus size={15} />
          加载更多
        </button>
      )}
    </div>
  )
}

function ArtistsGrid({
  artists,
  loading,
  error,
  onRetry,
  onOpen
}: {
  artists: ArtistSummaryDTO[]
  loading: boolean
  error?: string
  onRetry: () => void
  onOpen: (artist: ArtistSummaryDTO) => void
}): JSX.Element {
  if (loading) {
    return (
      <div className="explore__loading">
        <div className="loading-state">
          <IconDisc size={16} className="spin" />
          <span>正在加载歌手…</span>
        </div>
        <div className="skeleton explore__skeleton" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="page__error">
        <span>加载失败：{error}</span>
        <button type="button" className="button" onClick={onRetry}>
          重试
        </button>
      </div>
    )
  }

  if (artists.length === 0) {
    return (
      <div className="placeholder">
        <div className="placeholder__title">暂时没有热门歌手</div>
      </div>
    )
  }

  return (
    <div className="grid grid--artists">
      {artists.map((artist) => (
        <ArtCard
          key={artist.id}
          title={artist.name}
          subtitle={`${artist.musicSize} 首歌曲，${artist.albumSize} 张专辑`}
          imageUrl={coverUrl(artist.picUrl, 240)}
          round
          onClick={() => onOpen(artist)}
        />
      ))}
    </div>
  )
}

/**
 * 游标式无限列表。
 *
 * lib/hooks 里的 usePaged 只在 pageSize 变化时重置，筛选条件（分类、排序）
 * 变化时不会重新取数，所以这里自己管游标：`signature` 是「换一批」的唯一
 * 依据，generation 保证换分类之后旧请求的返回不会写进新列表。
 */
function useInfinitePlaylists(
  signature: string,
  enabled: boolean,
  fetchPage: (cursor: number) => Promise<Page>
): InfiniteList {
  const [items, setItems] = useState<PlaylistSummaryDTO[]>([])
  const [loading, setLoading] = useState(enabled)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [more, setMore] = useState(true)

  const cursorRef = useRef(0)
  const generationRef = useRef(0)
  const seenRef = useRef(new Set<number>())
  const signatureRef = useRef<string | undefined>(undefined)

  // fetchPage 每次渲染都是新闭包，放进 ref；下面的 effect 先于取数 effect 执行，
  // 所以切分类时用到的永远是当次渲染的那份。
  const fetchRef = useRef(fetchPage)
  useEffect(() => {
    fetchRef.current = fetchPage
  })

  async function load(mode: 'reset' | 'more'): Promise<void> {
    if (mode === 'more' && (!more || loadingMore || loading)) return
    if (mode === 'reset') {
      generationRef.current += 1
      cursorRef.current = 0
      seenRef.current = new Set()
      setItems([])
      setMore(true)
      setError(undefined)
      setLoading(true)
    } else {
      setLoadingMore(true)
    }
    const generation = generationRef.current

    try {
      const page = await fetchRef.current(cursorRef.current)
      if (generation !== generationRef.current) return
      cursorRef.current = page.cursor
      if (mode === 'reset') {
        seenRef.current = new Set(page.items.map((item) => item.id))
        setItems(page.items)
        setMore(page.more ?? page.items.length >= PAGE_SIZE)
      } else {
        const fresh = page.items.filter((item) => !seenRef.current.has(item.id))
        for (const item of fresh) seenRef.current.add(item.id)
        setItems((existing) => [...existing, ...fresh])
        // 返回的全是重复项说明游标没前进（接口不再给新数据），到此为止。
        setMore(fresh.length > 0 ? (page.more ?? true) : false)
      }
    } catch (cause) {
      if (generation !== generationRef.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
      // 翻页失败就停下来，把重试交给上面的错误条，而不是自动重试打转。
      if (mode === 'more') setMore(false)
    } finally {
      if (generation === generationRef.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }

  // 换分类/排序（signature 变化）或首次进入该标签时才取第一页；切回来用缓存。
  useEffect(() => {
    if (!enabled) return
    if (signatureRef.current === signature) return
    signatureRef.current = signature
    void load('reset')
    // load 的闭包只对 'more' 分支敏感，而 reset 分支不读那些状态；把它放进 deps
    // 会让每次取数完成后立刻再取一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, signature])

  const reload = (): void => {
    signatureRef.current = signature
    void load('reset')
  }

  return { items, loading, loadingMore, error, more, loadMore: () => void load('more'), reload }
}
