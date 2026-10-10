/**
 * 搜索页：综合 / 单曲 / 歌手 / 专辑 / 歌单五个标签，带输入联想。
 *
 * 联想走 300ms 防抖 —— 每敲一个字就请求一次既浪费也会让下拉在输入过程中
 * 反复跳动；回车或点击联想才真正搜索。综合标签把四类结果各取一小批并排
 * 展示（用 allSettled，某一类失败不影响其它类），单类标签才做分页。
 *
 * 顶部可以切音源：默认网易云（行为与以前完全一致），另外三个是站外曲库
 * （汽水 / 酷狗 / 酷我），用来找网易云曲库里没有的歌（例如抖音热歌）。
 * 站外结果走独立的取数与播放通道，且没有「喜欢」概念，所以不复用 SongList 组件，
 * 只复用它的样式类。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArtCard,
  SongList,
  artistLine,
  call,
  coverUrl,
  formatDuration,
  formatPlayCount,
  useNavigation,
  usePlayerStore,
  useToast
} from '../lib/contract'
import { isSearchRelevant } from '../lib/relevance'
import { IconClose, IconDisc, IconLayers, IconMusic, IconPlay, IconPlus, IconSearch, IconUser } from '../components/Icons'
import type { SearchResultDTO } from '@shared/ipc'
import {
  EXTERNAL_SOURCES,
  type ArtistSummaryDTO,
  type ExternalSource,
  type ExternalTrackDTO
} from '@shared/types'


const TABS = [
  { value: 'comprehensive', label: '综合' },
  { value: 'songs', label: '单曲' },
  { value: 'artists', label: '歌手' },
  { value: 'albums', label: '专辑' },
  { value: 'playlists', label: '歌单' }
] as const

type Tab = (typeof TABS)[number]['value']
type SearchType = 'songs' | 'artists' | 'albums' | 'playlists'

/** 兜底顺序：网易云 0 条时按这个顺序静默找，第一个有结果的源胜出。 */
const FALLBACK_SOURCES: ExternalSource[] = [...EXTERNAL_SOURCES]

/** 综合标签每类只取一小批，单类标签才是完整一页。 */
const OVERVIEW_LIMIT = 8
const PAGE_SIZE = 30
/** 站外曲库一次取多少条。 */
const EXTERNAL_LIMIT = 30

/** 空态头像墙：取一批热门歌手，够铺满背景（接口对 limit 不敏感，一般会给 60~100 位）。 */
const WALL_ARTISTS = 60
/** 头像池的持久化键：只存 id 与头像地址，冷启动第一帧就能铺满，不用等接口。 */
const WALL_STORAGE_KEY = 'youyou-search-avatars'
/** 与 home.css 里 .avatar-wall 的尺寸对齐：头像 64px、间距 18px。 */
const WALL_ITEM_SIZE = 64
const WALL_GAP = 18
const WALL_STEP = WALL_ITEM_SIZE + WALL_GAP
/** 一行至少这么多个头像；不够就轮着用同一批，保证任何宽度都铺得满。 */
const WALL_ROW_MIN = 16

/** 站外行：序号 | 封面 | 歌名 | 歌手 | 专辑 | 时长（比 SongList 多一列封面）。 */
const EXTERNAL_COLUMNS = '34px 40px minmax(0, 1fr) minmax(110px, 200px) minmax(120px, 220px) 60px'

/**
 * 页内切换（页签 / 音源）的内存缓存。
 *
 * 切页签或换音源时先用这里的内容顶上、后台静默刷新，避免整块清空再出现的
 * 「重新加载」感；页面被卸载（点进详情再回来）时也是同一条捷径。
 */
interface SearchCacheEntry {
  result: SearchResultDTO
  more: boolean
  offset: number
}
const SEARCH_CACHE = new Map<string, SearchCacheEntry>()
const SEARCH_CACHE_LIMIT = 24

function readSearchCache(key: string): SearchCacheEntry | undefined {
  return SEARCH_CACHE.get(key)
}

function writeSearchCache(key: string, entry: SearchCacheEntry): void {
  SEARCH_CACHE.delete(key)
  SEARCH_CACHE.set(key, entry)
  while (SEARCH_CACHE.size > SEARCH_CACHE_LIMIT) {
    const oldest = SEARCH_CACHE.keys().next()
    if (oldest.done) break
    SEARCH_CACHE.delete(oldest.value)
  }
}

/** 站外列表按「音源 + 关键词」缓存，切回同一个源时立刻出内容。 */
const EXTERNAL_CACHE = new Map<string, ExternalTrackDTO[]>()
const EXTERNAL_CACHE_LIMIT = 16

function writeExternalCache(key: string, items: ExternalTrackDTO[]): void {
  EXTERNAL_CACHE.delete(key)
  EXTERNAL_CACHE.set(key, items)
  while (EXTERNAL_CACHE.size > EXTERNAL_CACHE_LIMIT) {
    const oldest = EXTERNAL_CACHE.keys().next()
    if (oldest.done) break
    EXTERNAL_CACHE.delete(oldest.value)
  }
}

/**
 * 头像墙只关心 id 与头像地址，所以缓存和持久化也只存这两项。
 */
type WallArtist = Pick<ArtistSummaryDTO, 'id' | 'picUrl'>

/** 会话内头像池：进过一次搜索页之后就不再等接口。 */
let wallPool: WallArtist[] = []

/** 从 localStorage 读回上次存下的头像池；坏了就当没有。 */
function readStoredWall(): WallArtist[] {
  try {
    const raw = window.localStorage.getItem(WALL_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (item): item is WallArtist =>
          typeof item === 'object' && item !== null && typeof (item as WallArtist).id === 'number'
      )
      .map((item) => ({ id: item.id, picUrl: item.picUrl }))
  } catch {
    return []
  }
}

/** 首帧要用的头像池：会话缓存优先，其次上次落盘的。 */
function readWallPool(): WallArtist[] {
  if (wallPool.length === 0) wallPool = readStoredWall()
  return wallPool
}

/** 取回一批就写回会话缓存 + localStorage，下次冷启动秒出。 */
function writeWallPool(list: WallArtist[]): void {
  wallPool = list
  try {
    window.localStorage.setItem(WALL_STORAGE_KEY, JSON.stringify(list.slice(0, WALL_ARTISTS)))
  } catch {
    // 存不下就算了，会话内的池还在。
  }
}

/** 静默刷新提示：一条 2px 的流动细条，替代整块骨架。 */
function RefreshBar({ active }: { active: boolean }): JSX.Element | null {
  if (!active) return null
  return <div className="refresh-bar" role="status" aria-label="正在刷新" />
}

export default function Search({ initialKeywords }: { initialKeywords?: string }): JSX.Element {
  const navigation = useNavigation()
  const player = usePlayerStore()
  const toast = useToast()

  const [query, setQuery] = useState<{ keywords: string; nonce: number } | undefined>()
  const [tab, setTab] = useState<Tab>('comprehensive')

  const [result, setResult] = useState<SearchResultDTO | undefined>()
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [more, setMore] = useState(false)

  /** 页面自己那个输入框（顶部全局搜索框已取消，这里是唯一入口）。 */
  const [input, setInput] = useState(initialKeywords ?? '')
  /** 空态背景的歌手头像：优先用会话缓存 / 上次落盘的池，首帧就能铺满。 */
  const [wallArtists, setWallArtists] = useState<WallArtist[]>(() => readWallPool())
  /** 头像池一次挂载只取一次（有缓存时属于后台静默刷新）。 */
  const wallFetchedRef = useRef(false)

  // 静默兜底：网易云 0 条或结果不相关时找到的站外结果。界面不出现任何来源/条数文案，
  // 只把它当普通歌曲列表渲染；点播放失败用普通 toast 报错。
  const [external, setExternal] = useState<ExternalTrackDTO[] | undefined>()
  const [fallbackLoading, setFallbackLoading] = useState(false)
  /** 网易云那批结果被判为不相关、改走兜底：不再渲染它们，免得用户先看到一屏无关行。 */
  const [fallbackActive, setFallbackActive] = useState(false)
  const [playingKey, setPlayingKey] = useState<string | undefined>()
  /** 换页签/换关键词时的静默刷新标记（有旧内容时用它代替骨架）。 */
  const [refreshing, setRefreshing] = useState(false)

  const generationRef = useRef(0)
  const fallbackRef = useRef(0)
  const offsetRef = useRef(0)
  // effect 里要判断「屏幕上当前有没有内容」，闭包里的 result 可能是旧的，统一读 ref。
  const resultRef = useRef(result)
  resultRef.current = result
  // 当前 result 对应的是哪次关键词（判定兜底前要确认结果已经跟上）
  const resultForRef = useRef<string | undefined>(undefined)

  const keywords = query?.keywords ?? ''
  const nonce = query?.nonce ?? 0
  /** 空态：没有搜索词时显示居中的大搜索框 + 头像墙。 */
  const hero = keywords.length === 0

  const submit = useCallback((value: string): void => {
    const trimmed = value.trim()
    if (!trimmed) return
    setInput(trimmed)
    setQuery((current) => ({ keywords: trimmed, nonce: (current?.nonce ?? 0) + 1 }))
  }, [])

  /** 清空输入（手动删光或点清空按钮）→ 立刻回到空态。 */
  const clear = useCallback((): void => {
    setInput('')
    setQuery(undefined)
  }, [])

  /**
   * 关键词变化时发起一次搜索：从别处跳进来（带 initialKeywords）也走这条，
   * 行为与以前保持一致。
   */
  useEffect(() => {
    const trimmed = initialKeywords?.trim()
    if (!trimmed) return
    setQuery((current) => ({ keywords: trimmed, nonce: (current?.nonce ?? 0) + 1 }))
    setInput(trimmed)
  }, [initialKeywords])

  // 空态头像墙：先用缓存（会话内 / localStorage）铺满，再静默刷新一次头像池。
  useEffect(() => {
    if (!hero || wallFetchedRef.current) return
    wallFetchedRef.current = true
    let cancelled = false
    void call('explore:topArtists', { limit: WALL_ARTISTS })
      .then((list) => {
        if (cancelled || list.length === 0) return
        const pool = list.slice(0, WALL_ARTISTS).map((artist) => ({ id: artist.id, picUrl: artist.picUrl }))
        writeWallPool(pool)
        setWallArtists(pool)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [hero])

  // --- 搜索（网易云）----------------------------------------------------
  useEffect(() => {
    if (!keywords) {
      setResult(undefined)
      return
    }
    const generation = ++generationRef.current
    const cacheKey = `${tab}:${keywords}`
    const cached = readSearchCache(cacheKey)
    offsetRef.current = cached?.offset ?? 0
    setError(undefined)
    if (cached) {
      // 命中缓存（含「切页签切回来」）：先铺旧内容，后台静默刷新，不出骨架。
      setResult(cached.result)
      setMore(cached.more)
      setLoading(false)
      setRefreshing(true)
    } else if (resultRef.current) {
      // 换页签但没有这个页签的缓存：保留当前内容，压暗 + 细条，别整块清空。
      setLoading(false)
      setRefreshing(true)
    } else {
      setLoading(true)
      setResult(undefined)
      setMore(false)
    }

    const run = async (): Promise<void> => {
      try {
        if (tab === 'comprehensive') {
          const [songs, artists, albums, playlists] = await Promise.allSettled([
            call('search:query', { keywords, type: 'songs', limit: OVERVIEW_LIMIT, offset: 0 }),
            call('search:query', { keywords, type: 'artists', limit: OVERVIEW_LIMIT, offset: 0 }),
            call('search:query', { keywords, type: 'albums', limit: OVERVIEW_LIMIT, offset: 0 }),
            call('search:query', { keywords, type: 'playlists', limit: OVERVIEW_LIMIT, offset: 0 })
          ])
          if (generation !== generationRef.current) return
          const settled = [songs, artists, albums, playlists]
          if (settled.every((item) => item.status === 'rejected')) {
            throw new Error(describeReason(settled[0]))
          }
          const page: SearchResultDTO = {
            songs: songs.status === 'fulfilled' ? songs.value.songs : undefined,
            artists: artists.status === 'fulfilled' ? artists.value.artists : undefined,
            albums: albums.status === 'fulfilled' ? albums.value.albums : undefined,
            playlists: playlists.status === 'fulfilled' ? playlists.value.playlists : undefined,
            songCount: songs.status === 'fulfilled' ? songs.value.songCount : undefined,
            artistCount: artists.status === 'fulfilled' ? artists.value.artistCount : undefined,
            albumCount: albums.status === 'fulfilled' ? albums.value.albumCount : undefined,
            playlistCount: playlists.status === 'fulfilled' ? playlists.value.playlistCount : undefined
          }
          resultForRef.current = keywords
          setResult(page)
          writeSearchCache(cacheKey, { result: page, more: false, offset: 0 })
        } else {
          const page = await call('search:query', { keywords, type: tab, limit: PAGE_SIZE, offset: 0 })
          if (generation !== generationRef.current) return
          const offset = countOf(tab, page)
          const nextMore = hasMoreAfter(tab, page, 0)
          resultForRef.current = keywords
          offsetRef.current = offset
          setResult(page)
          setMore(nextMore)
          writeSearchCache(cacheKey, { result: page, more: nextMore, offset })
        }
      } catch (cause) {
        if (generation !== generationRef.current) return
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (generation === generationRef.current) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    }

    void run()
  }, [keywords, nonce, tab])

  /**
   * 静默兜底：网易云「没搜到」时，后台按 汽水 → 酷狗 → 酷我 依次找，
   * 第一个有结果的源胜出，以普通歌曲列表呈现。
   *
   * 「没搜到」= 单曲 0 条，**或者**返回的这批结果跟关键词根本不相干 ——
   * 网易云搜索极其宽容（实测随机串都能返回 30 条），只看条数的话抖音热歌这类
   * 曲库里没有的歌永远会显示一屏模糊结果，兜底也就永远不会触发。
   *
   * 用户不需要知道音源这件事：界面里没有切换按钮、没有来源标注、没有条数说明；
   * 三个源都没有结果时保持网易云的空态，什么都不额外显示。
   */
  useEffect(() => {
    // 每次重算都让在途的旧兜底作废：否则上一次搜索发出的站外请求晚到一步，
    // 会把结果盖到这一次的列表上（实测「孤勇者」被上一轮的关键词污染过）。
    const generation = ++fallbackRef.current
    if (loading || !keywords || (tab !== 'comprehensive' && tab !== 'songs')) {
      setExternal(undefined)
      setFallbackLoading(false)
      setFallbackActive(false)
      return
    }
    // 结果还没跟上这次关键词（刚换词、网易云还在路上）时先什么都不做，
    // 免得拿旧结果做判定。
    if (resultForRef.current !== keywords) {
      setExternal(undefined)
      setFallbackLoading(false)
      setFallbackActive(false)
      return
    }
    const songs = result?.songs ?? []
    const relevant = isSearchRelevant(
      keywords,
      songs.map((track) => ({
        name: track.name,
        // TrackDTO 的歌手是数组，拼成字符串再比对。
        artists: (track.artists ?? []).map((artist) => artist.name).join(' '),
        album: track.album?.name
      }))
    )
    if (songs.length > 0 && relevant) {
      setExternal(undefined)
      setFallbackLoading(false)
      setFallbackActive(false)
      return
    }
    // 判为不相关（或压根没有结果）：走兜底，同时把网易云那批从界面上撤掉。
    setFallbackActive(true)
    setExternal(undefined)
    setFallbackLoading(true)
    void (async () => {
      for (const candidate of FALLBACK_SOURCES) {
        const key = `${candidate}:${keywords}`
        const cached = EXTERNAL_CACHE.get(key)
        if (cached && cached.length > 0) {
          if (generation !== fallbackRef.current) return
          setExternal(cached)
          setFallbackLoading(false)
          return
        }
        try {
          const items = await call('search:external', { source: candidate, keywords, limit: EXTERNAL_LIMIT })
          if (generation !== fallbackRef.current) return
          writeExternalCache(key, items)
          if (items.length > 0) {
            setExternal(items)
            setFallbackLoading(false)
            return
          }
        } catch {
          // 这个源挂了就试下一个，全程不打扰用户。
        }
      }
      if (generation === fallbackRef.current) {
        setExternal([])
        setFallbackLoading(false)
      }
    })()
  }, [loading, keywords, tab, result])

  /**
   * 点播站外曲目：主进程会严格匹配到完整音频，匹配不到直接抛错。
   * 这里同一时刻只允许一条在途，避免连点排出一串播放请求。
   */
  const playExternal = useCallback(
    async (item: ExternalTrackDTO): Promise<void> => {
      const key = `${item.source}:${item.sourceId}`
      if (playingKey) return
      setPlayingKey(key)
      try {
        await call('player:playExternal', { item })
        toast.show(`正在播放：${item.name}${item.artists ? ` - ${item.artists}` : ''}`, 'success')
      } catch (cause) {
        toast.show(cause instanceof Error ? cause.message : '播放失败，换一首试试', 'error')
      } finally {
        setPlayingKey(undefined)
      }
    },
    [playingKey, toast]
  )

  const loadMore = async (): Promise<void> => {
    if (tab === 'comprehensive' || loadingMore || loading || !more) return
    const generation = generationRef.current
    const offset = offsetRef.current
    setLoadingMore(true)
    try {
      const page = await call('search:query', { keywords, type: tab, limit: PAGE_SIZE, offset })
      if (generation !== generationRef.current) return
      setResult((existing) => mergePage(tab, existing, page))
      offsetRef.current = offset + countOf(tab, page)
      setMore(hasMoreAfter(tab, page, offset))
    } catch (cause) {
      if (generation === generationRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (generation === generationRef.current) setLoadingMore(false)
    }
  }

  const songs = result?.songs ?? []
  const artists = result?.artists ?? []
  const albums = result?.albums ?? []
  const playlists = result?.playlists ?? []
  const overview = tab === 'comprehensive'
  const loaded = songs.length + artists.length + albums.length + playlists.length

  return (
    <div className={`page search${hero ? ' search--hero' : ''}`}>
      {hero ? null : (
        <header className="page__header">
          <div>
            <h1 className="page__title">搜索</h1>
          </div>
        </header>
      )}

      {/* 空态：居中的大搜索框 + 背景流动的歌手头像；有词之后输入框回到顶部常规位置。 */}
      {hero ? (
        <HeroSearch
          value={input}
          artists={wallArtists}
          onChange={(value) => setInput(value)}
          onSubmit={() => submit(input)}
        />
      ) : (
        <div className="search-bar">
          <span className="search-bar__icon">
            <IconSearch size={16} />
          </span>
          <input
            className="search-bar__input"
            value={input}
            autoFocus
            onChange={(event) => {
              const value = event.target.value
              setInput(value)
              // 手动删空 → 立刻回到空态。
              if (!value.trim()) clear()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit(input)
            }}
          />
          {input ? (
            <button type="button" className="search-bar__clear" onClick={clear} aria-label="清空">
              <IconClose size={15} />
            </button>
          ) : null}
        </div>
      )}

      {keywords ? (
        <div className="toolbar search__tabs">
          <div className="chip-row">
            {TABS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`chip${tab === item.value ? ' is-active' : ''}`}
                onClick={() => setTab(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {error ? <div className="page__error">搜索失败：{error}</div> : null}

      {loading ? (
        <div className="search__loading">
          <div className="loading-state">
            <IconDisc size={16} className="spin" />
            <span>正在搜索…</span>
          </div>
          <div className="skeleton search__skeleton" />
          <div className="skeleton search__skeleton" />
        </div>
      ) : null}

      {/* 静默刷新：细条 + 内容压暗，切页签/兜底找歌时不出现空白帧。 */}
      <RefreshBar active={refreshing || fallbackLoading} />

      {external && external.length > 0 ? (
        <section className="page__section">
          <div className="song-list">
            {external.map((item, index) => {
              const key = `${item.source}:${item.sourceId}`
              // 主进程播放的是由站外曲目合成的曲目，歌名保持一致，用它来标当前行。
              const current = !!player.current && player.current.name === item.name
              const busy = playingKey === key
              return (
                <div
                  key={key}
                  className={`song-row song-row--external${current ? ' is-current' : ''}`}
                  style={{ gridTemplateColumns: EXTERNAL_COLUMNS }}
                  onDoubleClick={() => void playExternal(item)}
                  title={`${item.name} — ${item.artists}`}
                >
                  <div className="song-row__index">{index + 1}</div>
                  <div className="ext-row__cover">
                    <ExternalCover url={item.coverUrl} />
                  </div>
                  <div className="song-row__title">
                    <button
                      type="button"
                      className="song-row__play"
                      disabled={busy}
                      onClick={() => void playExternal(item)}
                      title={busy ? '正在匹配完整音源' : '播放'}
                      aria-label={busy ? '正在匹配完整音源' : `播放 ${item.name}`}
                    >
                      {busy ? <IconDisc size={14} className="spin" /> : <IconPlay size={14} />}
                    </button>
                    <div style={{ minWidth: 0 }}>
                      <div className="song-row__name">{item.name}</div>
                      <div className="song-row__sub">{item.artists}</div>
                    </div>
                  </div>
                  <div className="song-row__artist">{item.artists}</div>
                  <div className="song-row__album">{item.album ?? '—'}</div>
                  <div className="song-row__duration">{formatDuration(item.durationMS / 1000)}</div>
                </div>
              )
            })}
          </div>
        </section>
      ) : null}

      {/*
        空态：网易云本来就没结果，或者判为不相关且三个站外源也没找到内容时显示。
        兜底正在找、或兜底列表已经有内容时都不显示。
      */}
      {!loading &&
      !fallbackLoading &&
      !(external && external.length > 0) &&
      keywords &&
      !error &&
      (loaded === 0 || fallbackActive) ? (
        <div className="placeholder">
          <div className="placeholder__title">没有找到与「{keywords}」相关的内容</div>
          <div>换个关键词，或者检查一下输入。</div>
        </div>
      ) : null}

      {/* 判为不相关且兜底找到内容时，整段不渲染网易云那批结果。 */}
      {!loading && result && !(fallbackActive && (external?.length ?? 0) > 0) ? (
        <div className={refreshing ? 'is-refreshing' : undefined}>
          {songs.length > 0 ? (
            <section className="page__section">
              <SectionHeader
                icon={IconMusic}
                title="单曲"
                // 整表播放入口：随机起播；点具体某一行仍然从那一行开始。
                onPlayAll={() => void player.playTracks(songs, 0, { randomStart: true })}
                action={overview ? { label: '查看全部', onClick: () => setTab('songs') } : undefined}
              />
              <SongList
                tracks={songs}
                currentTrackID={player.current?.id}
                onPlay={(index) => void player.playTracks(songs, index)}
              />
            </section>
          ) : null}

          {artists.length > 0 ? (
            <section className="page__section">
              <SectionHeader
                icon={IconUser}
                title="歌手"
                action={overview ? { label: '查看全部', onClick: () => setTab('artists') } : undefined}
              />
              <div className="grid grid--artists">
                {artists.map((artist) => (
                  <ArtCard
                    key={artist.id}
                    title={artist.name}
                    subtitle={artist.alias[0] ?? `${artist.musicSize} 首`}
                    imageUrl={coverUrl(artist.picUrl, 240)}
                    round
                    onClick={() => navigation.push({ name: 'artist', id: artist.id, title: artist.name })}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {albums.length > 0 ? (
            <section className="page__section">
              <SectionHeader
                icon={IconDisc}
                title="专辑"
                action={overview ? { label: '查看全部', onClick: () => setTab('albums') } : undefined}
              />
              <div className="grid grid--albums">
                {albums.map((album) => (
                  <ArtCard
                    key={album.id}
                    title={album.name}
                    subtitle={album.artistName}
                    imageUrl={coverUrl(album.picUrl, 320)}
                    onClick={() => navigation.push({ name: 'album', id: album.id, title: album.name })}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {playlists.length > 0 ? (
            <section className="page__section">
              <SectionHeader
                icon={IconLayers}
                title="歌单"
                action={overview ? { label: '查看全部', onClick: () => setTab('playlists') } : undefined}
              />
              <div className="grid grid--playlists">
                {playlists.map((playlist) => (
                  <ArtCard
                    key={playlist.id}
                    title={playlist.name}
                    subtitle={playlist.creator?.nickname ?? `${playlist.trackCount} 首`}
                    imageUrl={coverUrl(playlist.coverURL, 320)}
                    badge={playlist.playCount > 0 ? formatPlayCount(playlist.playCount) : undefined}
                    onClick={() => navigation.push({ name: 'playlist', id: playlist.id, title: playlist.name })}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {!overview && more ? (
            <div className="search__more">
              <button type="button" className="button" disabled={loadingMore} onClick={() => void loadMore()}>
                <IconPlus size={15} />
                {loadingMore ? '正在加载…' : '加载更多'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 点播站外曲目成功/失败的提示（主进程匹配不到完整音源时会带文案抛错）。 */}
      {toast.node}
    </div>
  )
}

/** 站外封面：第三方 CDN 加载失败或没有封面时退回线性音符图标。 */
function ExternalCover({ url }: { url?: string }): JSX.Element {
  const [broken, setBroken] = useState(false)
  // 换关键词后列表会复用行，这里按 URL 重置破图标记，重新尝试加载。
  useEffect(() => setBroken(false), [url])
  const src = url?.replace(/^http:\/\//, 'https://')
  if (!src || broken) {
    return (
      <span className="ext-row__cover-fallback">
        <IconMusic size={18} />
      </span>
    )
  }
  return <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} />
}

/**
 * 空态：居中的大搜索框 + 背景里流动的歌手头像。
 *
 * 头像层是纯装饰：`aria-hidden` + `pointer-events: none`，不参与点击，也不写说明文字。
 */
/**
 * 空态要铺满可见区域：让 .search-hero 的下沿贴住外层滚动容器可视区的下沿。
 *
 * 用 rect 差算（而不是直接读 clientHeight），这样容器自己还有标题之类的
 * 兄弟节点时也算得对；容器或自己尺寸一变就重量一次（隐藏状态下量到 0 会跳过，
 * 等显示出来再算），所以任意窗口尺寸下都不会留缝。
 */
function useFillHeight(ref: React.RefObject<HTMLElement>): void {
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const host = node.closest<HTMLElement>('.content') ?? node.parentElement
    const apply = (): void => {
      const box = host ?? node.parentElement
      if (!box) return
      const rect = box.getBoundingClientRect()
      if (rect.height <= 0) return
      const style = window.getComputedStyle(box)
      const innerTop = rect.top + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.borderTopWidth) || 0)
      const innerBottom = rect.bottom - (parseFloat(style.paddingBottom) || 0) - (parseFloat(style.borderBottomWidth) || 0)
      const own = node.getBoundingClientRect()
      const height = Math.round(innerBottom - Math.max(innerTop, own.top))
      // 差不到 1px 就不动它，免得和 ResizeObserver 互相触发。
      if (height > 0 && Math.abs(height - own.height) > 1) node.style.minHeight = `${height}px`
    }
    apply()
    const raf = window.requestAnimationFrame(apply)
    window.addEventListener('resize', apply)
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(apply)
      observer.observe(node)
      if (host && host !== node) observer.observe(host)
    }
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', apply)
      observer?.disconnect()
    }
  }, [ref])
}

function HeroSearch({
  value,
  artists,
  onChange,
  onSubmit
}: {
  value: string
  artists: WallArtist[]
  onChange: (value: string) => void
  onSubmit: () => void
}): JSX.Element {
  const heroRef = useRef<HTMLDivElement>(null)
  useFillHeight(heroRef)
  return (
    <div className="search-hero" ref={heroRef}>
      <AvatarWall artists={artists} />
      <div className="search-hero__box">
        <span className="search-hero__icon">
          <IconSearch size={22} />
        </span>
        <input
          className="search-hero__input"
          value={value}
          autoFocus
          placeholder="搜索歌曲、歌手"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSubmit()
          }}
        />
      </div>
    </div>
  )
}

/** 头像：第三方图挂了就退回线性图标，不留破图。 */
function WallAvatar({ url }: { url?: string }): JSX.Element {
  const [broken, setBroken] = useState(false)
  const src = url?.replace(/^http:\/\//, 'https://')
  if (!src || broken) {
    return (
      <span className="avatar-wall__fallback">
        <IconUser size={22} />
      </span>
    )
  }
  return <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} />
}

/**
 * 背景头像墙：多行横向慢速滚动，相邻行方向相反。
 *
 * 行数按可用高度算（rows = ceil(高度 / 每行步长) + 1 行缓冲），每行个数按可用宽度算，
 * 所以任意窗口尺寸下都铺得满、不留缝；每行渲染两份同样的头像（无缝循环靠 translateX(-50%)）。
 */
function AvatarWall({ artists }: { artists: WallArtist[] }): JSX.Element {
  const wallRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })

  // 量自己的尺寸；页面藏在 slot 里（display: none）时量到 0，显示出来会再触发一次。
  useLayoutEffect(() => {
    const node = wallRef.current
    if (!node) return
    const measure = (): void => setBox({ width: node.clientWidth, height: node.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // 还没量到（首次渲染 / 隐藏中）就按视口估一个，别让第一帧空着。
  const height = box.height || (typeof window === 'undefined' ? 0 : window.innerHeight)
  const width = box.width || (typeof window === 'undefined' ? 0 : window.innerWidth)
  const rows = Math.ceil(height / WALL_STEP) + 1
  const perRow = Math.max(WALL_ROW_MIN, Math.ceil(width / WALL_STEP) + 2)

  const lines = [...Array(rows).keys()].map((rowIndex) => {
    const row: WallArtist[] = []
    if (artists.length === 0) return row
    // 交叉取数，各行内容不完全一样；不够就轮着用同一批。
    for (let index = 0; index < perRow; index++) {
      row.push(artists[(index * rows + rowIndex) % artists.length])
    }
    return row
  })

  return (
    <div className="avatar-wall" aria-hidden="true" ref={wallRef}>
      {lines.map((row, index) => (
        <div key={index} className={`avatar-wall__row${index % 2 === 1 ? ' avatar-wall__row--reverse' : ''}`}>
          {[...row, ...row].map((artist, itemIndex) => (
            <span key={`${artist.id}-${itemIndex}`} className="avatar-wall__item">
              <WallAvatar url={coverUrl(artist.picUrl, 160)} />
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

function SectionHeader({
  icon: Icon,
  title,
  action,
  onPlayAll
}: {
  /** 板块标题左侧的线性图标组件（尺寸/类名可传，颜色跟随 currentColor）。 */
  icon: (props: { size?: number; className?: string }) => JSX.Element
  title: string
  action?: { label: string; onClick: () => void }
  /** 整表播放入口（随机起播）；不传则不显示。 */
  onPlayAll?: () => void
}): JSX.Element {
  return (
    <div className="section__header">
      <h2 className="section__title">
        <Icon size={16} className="section__icon" />
        {title}
      </h2>
      <div className="section__actions">
        {onPlayAll ? (
          <button type="button" className="button section-action" onClick={onPlayAll}>
            <IconPlay size={14} />
            播放全部
          </button>
        ) : null}
        {action ? (
          <button type="button" className="section__more search__more-link" onClick={action.onClick}>
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function countOf(tab: SearchType, result: SearchResultDTO): number {
  switch (tab) {
    case 'songs':
      return (result.songs ?? []).length
    case 'artists':
      return (result.artists ?? []).length
    case 'albums':
      return (result.albums ?? []).length
    case 'playlists':
      return (result.playlists ?? []).length
  }
}

function totalOf(tab: SearchType, result: SearchResultDTO): number | undefined {
  switch (tab) {
    case 'songs':
      return result.songCount
    case 'artists':
      return result.artistCount
    case 'albums':
      return result.albumCount
    case 'playlists':
      return result.playlistCount
  }
}

function hasMoreAfter(tab: SearchType, page: SearchResultDTO, offset: number): boolean {
  const loaded = countOf(tab, page)
  const total = totalOf(tab, page)
  if (loaded === 0) return false
  return total !== undefined ? offset + loaded < total : loaded >= PAGE_SIZE
}

/** 追加一页并去掉跨页重复的条目（接口分页边界上会重复返回同一首）。 */
function mergePage(tab: SearchType, existing: SearchResultDTO | undefined, page: SearchResultDTO): SearchResultDTO {
  const base: SearchResultDTO = existing ?? {}
  if (tab === 'songs') return { ...base, ...page, songs: dedupe([...(base.songs ?? []), ...(page.songs ?? [])]) }
  if (tab === 'artists') return { ...base, ...page, artists: dedupe([...(base.artists ?? []), ...(page.artists ?? [])]) }
  if (tab === 'albums') return { ...base, ...page, albums: dedupe([...(base.albums ?? []), ...(page.albums ?? [])]) }
  return { ...base, ...page, playlists: dedupe([...(base.playlists ?? []), ...(page.playlists ?? [])]) }
}

function dedupe<T extends { id: number }>(items: T[]): T[] {
  const seen = new Set<number>()
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)))
}

function describeReason(reason: PromiseSettledResult<unknown> | undefined): string {
  if (reason && reason.status === 'rejected') {
    const value = reason.reason
    return value instanceof Error ? value.message : String(value)
  }
  return '未知错误'
}
