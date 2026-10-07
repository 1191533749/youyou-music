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
import { useCallback, useEffect, useRef, useState } from 'react'
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
import { useDebounced } from '../lib/hooks'
import { IconDisc, IconLayers, IconMusic, IconPlay, IconPlus, IconSearch, IconUser } from '../components/Icons'
import type { SearchResultDTO, SearchSuggestDTO } from '@shared/ipc'
import {
  EXTERNAL_SOURCES,
  EXTERNAL_SOURCE_NAMES,
  type ExternalSource,
  type ExternalTrackDTO
} from '@shared/types'

/** 图标组件的公共形状：尺寸与类名可传，颜色跟随 currentColor。 */
type IconComponent = (props: { size?: number; className?: string }) => JSX.Element

const TABS = [
  { value: 'comprehensive', label: '综合' },
  { value: 'songs', label: '单曲' },
  { value: 'artists', label: '歌手' },
  { value: 'albums', label: '专辑' },
  { value: 'playlists', label: '歌单' }
] as const

type Tab = (typeof TABS)[number]['value']
type SearchType = 'songs' | 'artists' | 'albums' | 'playlists'

/** 音源：网易云是本站曲库，其余三个是站外曲库。 */
type SourceChoice = 'netease' | ExternalSource

const SOURCES: Array<{ value: SourceChoice; label: string }> = [
  { value: 'netease', label: '网易云' },
  ...EXTERNAL_SOURCES.map((source) => ({ value: source, label: EXTERNAL_SOURCE_NAMES[source] }))
]

/** 综合标签每类只取一小批，单类标签才是完整一页。 */
const OVERVIEW_LIMIT = 8
const PAGE_SIZE = 30
/** 站外曲库一次取多少条。 */
const EXTERNAL_LIMIT = 30

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

/** 静默刷新提示：一条 2px 的流动细条，替代整块骨架。 */
function RefreshBar({ active }: { active: boolean }): JSX.Element | null {
  if (!active) return null
  return <div className="refresh-bar" role="status" aria-label="正在刷新" />
}

interface Suggestion {
  key: string
  label: string
  hint: string
  /** 联想项的类别图标，替代原来的「单曲」文字前缀。 */
  Icon: IconComponent
  /** 点联想后用于搜索的关键词。 */
  keywords: string
}

export default function Search({ initialKeywords }: { initialKeywords?: string }): JSX.Element {
  const navigation = useNavigation()
  const player = usePlayerStore()
  const toast = useToast()

  const [input, setInput] = useState(initialKeywords ?? '')
  const [query, setQuery] = useState<{ keywords: string; nonce: number } | undefined>()
  const [tab, setTab] = useState<Tab>('comprehensive')
  const [source, setSource] = useState<SourceChoice>('netease')
  const [defaultKeyword, setDefaultKeyword] = useState<string | undefined>()

  const [suggest, setSuggest] = useState<Suggestion[]>([])
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)

  const [result, setResult] = useState<SearchResultDTO | undefined>()
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [more, setMore] = useState(false)

  // 站外音源有自己的一套取数状态：三态 + 重试 + 正在点播的那一条。
  const [external, setExternal] = useState<ExternalTrackDTO[] | undefined>()
  const [externalLoading, setExternalLoading] = useState(false)
  const [externalRefreshing, setExternalRefreshing] = useState(false)
  const [externalError, setExternalError] = useState<string | undefined>()
  const [externalNonce, setExternalNonce] = useState(0)
  const [playingKey, setPlayingKey] = useState<string | undefined>()
  /** 网易云档位在换页签/换关键词时的静默刷新标记（有旧内容时用它代替骨架）。 */
  const [refreshing, setRefreshing] = useState(false)

  const generationRef = useRef(0)
  const externalGenerationRef = useRef(0)
  const offsetRef = useRef(0)
  const boxRef = useRef<HTMLDivElement | null>(null)
  // effect 里要判断「屏幕上当前有没有内容」，闭包里的 result 可能是旧的，统一读 ref。
  const resultRef = useRef(result)
  resultRef.current = result

  const keywords = query?.keywords ?? ''
  const nonce = query?.nonce ?? 0
  const offline = source !== 'netease'

  // 挂载时取一个热搜词当占位符，用户不知道搜什么的时候有个提示。
  useEffect(() => {
    void call('search:defaultKeyword')
      .then((value) => setDefaultKeyword(value))
      .catch(() => undefined)
  }, [])

  /**
   * 热搜词本身可能带表情符号（网易云会把它混进热搜文案里）。它只作为界面文案
   * 出现，这里抹掉表情符号，免得破坏全站线性图标的视觉语言；搜索结果里的歌名、
   * 歌手名属于内容，一律不动。
   */
  const defaultKeywordText = defaultKeyword?.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '').trim()

  const submit = useCallback((value: string): void => {
    const trimmed = value.trim()
    if (!trimmed) return
    setInput(trimmed)
    setSuggestOpen(false)
    setHighlight(-1)
    setQuery((current) => ({ keywords: trimmed, nonce: (current?.nonce ?? 0) + 1 }))
  }, [])

  // 从别处跳进来（例如歌单页的「搜索」入口）时自动搜索一次。
  useEffect(() => {
    if (!initialKeywords) return
    submit(initialKeywords)
  }, [initialKeywords, submit])

  // --- 联想 -------------------------------------------------------------
  const debouncedInput = useDebounced(input.trim(), 300)

  useEffect(() => {
    if (!debouncedInput || debouncedInput === keywords) {
      setSuggest([])
      return
    }
    let cancelled = false
    void call('search:suggest', { keywords: debouncedInput })
      .then((value) => {
        if (cancelled) return
        setSuggest(flattenSuggestions(value))
      })
      .catch(() => {
        if (!cancelled) setSuggest([])
      })
    return () => {
      cancelled = true
    }
  }, [debouncedInput, keywords])

  // 点空白处收起下拉：mousedown 早于 blur，不会和选项点击抢事件。
  useEffect(() => {
    const onMouseDown = (event: MouseEvent): void => {
      if (!boxRef.current?.contains(event.target as Node)) setSuggestOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

  // --- 搜索（网易云）----------------------------------------------------
  useEffect(() => {
    if (offline) return
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
          setResult(page)
          writeSearchCache(cacheKey, { result: page, more: false, offset: 0 })
        } else {
          const page = await call('search:query', { keywords, type: tab, limit: PAGE_SIZE, offset: 0 })
          if (generation !== generationRef.current) return
          const offset = countOf(tab, page)
          const nextMore = hasMoreAfter(tab, page, 0)
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
    // 切回网易云时也要重取一次（offline 变化会重新跑这个 effect）。
  }, [keywords, nonce, tab, offline])

  // --- 搜索（站外曲库）--------------------------------------------------
  useEffect(() => {
    if (!offline || !keywords) {
      setExternal(undefined)
      setExternalError(undefined)
      setExternalLoading(false)
      return
    }
    const generation = ++externalGenerationRef.current
    const cacheKey = `${source}:${keywords}`
    const cached = EXTERNAL_CACHE.get(cacheKey)
    setExternalError(undefined)
    if (cached && cached.length > 0) {
      setExternal(cached)
      setExternalLoading(false)
      setExternalRefreshing(true)
    } else {
      // 换音源但没有这个源的缓存：保留上一个源的列表（压暗 + 细条），不清空。
      setExternalLoading(false)
      setExternalRefreshing(true)
    }
    void call('search:external', { source, keywords, limit: EXTERNAL_LIMIT })
      .then((items) => {
        if (generation !== externalGenerationRef.current) return
        setExternal(items)
        writeExternalCache(cacheKey, items)
      })
      .catch((cause) => {
        if (generation === externalGenerationRef.current) {
          setExternalError(cause instanceof Error ? cause.message : String(cause))
        }
      })
      .finally(() => {
        if (generation === externalGenerationRef.current) {
          setExternalLoading(false)
          setExternalRefreshing(false)
        }
      })
  }, [offline, source, keywords, nonce, externalNonce])

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
  // 综合标签展示的是四类各一小批，说「共 N 条」会误导，只报单类标签的真实总数。
  const totalCount = overview ? undefined : (totalOf(tab, result ?? {}) ?? loaded)

  return (
    <div className="page search">
      <header className="page__header">
        <div>
          <h1 className="page__title">搜索</h1>
          <div className="page__subtitle">支持歌曲、歌手、专辑与歌单</div>
        </div>
      </header>

      <div className="search__box" ref={boxRef}>
        <div className="search__field">
          <span className="search__icon">
            <IconSearch size={17} />
          </span>
          <input
            className="search__input"
            value={input}
            placeholder={defaultKeywordText ? `搜索「${defaultKeywordText}」` : '搜索歌曲、歌手、专辑或歌单'}
            onChange={(event) => {
              setInput(event.target.value)
              setSuggestOpen(true)
              setHighlight(-1)
            }}
            onFocus={() => setSuggestOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                if (suggestOpen && highlight >= 0 && suggest[highlight]) submit(suggest[highlight].keywords)
                else submit(input)
              } else if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSuggestOpen(true)
                setHighlight((current) => (current + 1) % Math.max(1, suggest.length))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setHighlight((current) => (current <= 0 ? suggest.length - 1 : current - 1))
              } else if (event.key === 'Escape') {
                setSuggestOpen(false)
              }
            }}
          />
          <button type="button" className="button button--primary" onClick={() => submit(input)}>
            搜索
          </button>
        </div>

        {suggestOpen && suggest.length > 0 ? (
          <ul className="search__suggest">
            {suggest.map((item, index) => (
              <li key={item.key}>
                <button
                  type="button"
                  className={`search__suggest-item${index === highlight ? ' is-active' : ''}`}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => submit(item.keywords)}
                >
                  <span className="search__suggest-label">{item.label}</span>
                  <span className="search__suggest-hint">
                    <item.Icon size={13} />
                    {item.hint}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* 音源切换：默认网易云；另外三个是站外曲库，用来找网易云没有的歌。 */}
      <div className="toolbar search__sources">
        <div className="chip-row">
          {SOURCES.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`chip${source === item.value ? ' is-active' : ''}`}
              onClick={() => setSource(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {!offline && keywords ? (
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
          <span className="search__summary">
            {loading
              ? '正在搜索…'
              : totalCount === undefined
                ? `「${keywords}」的搜索结果`
                : `「${keywords}」共 ${totalCount} 条结果`}
          </span>
        </div>
      ) : null}

      {/* 站外曲库只有单曲，且没有综合/歌手/专辑/歌单之分，只给一行结果说明。 */}
      {offline && keywords ? (
        <div className="toolbar search__tabs">
          <span className="search__summary">
            {externalLoading
              ? `正在 ${EXTERNAL_SOURCE_NAMES[source]} 里搜索…`
              : externalRefreshing
                ? `正在 ${EXTERNAL_SOURCE_NAMES[source]} 里搜索…`
                : `「${keywords}」· ${EXTERNAL_SOURCE_NAMES[source]}${external ? ` 共 ${external.length} 条结果` : ''}`}
          </span>
        </div>
      ) : null}

      {!offline && error ? <div className="page__error">搜索失败：{error}</div> : null}

      {!offline && loading ? (
        <div className="search__loading">
          <div className="loading-state">
            <IconDisc size={16} className="spin" />
            <span>正在搜索…</span>
          </div>
          <div className="skeleton search__skeleton" />
          <div className="skeleton search__skeleton" />
        </div>
      ) : null}

      {offline && externalError ? (
        <div className="page__error">
          <span>搜索失败：{externalError}</span>
          <button type="button" className="button" onClick={() => setExternalNonce((value) => value + 1)}>
            重试
          </button>
        </div>
      ) : null}

      {offline && externalLoading ? (
        <div className="search__loading">
          <div className="loading-state">
            <IconDisc size={16} className="spin" />
            <span>正在搜索站外曲库…</span>
          </div>
          <div className="skeleton search__skeleton" />
          <div className="skeleton search__skeleton" />
        </div>
      ) : null}

      {/* 静默刷新：细条 + 内容压暗，切页签/换音源时不出现空白帧。 */}
      <RefreshBar active={!offline && refreshing} />
      <RefreshBar active={offline && externalRefreshing} />

      {!loading && !keywords ? (
        <div className="placeholder">
          <div className="placeholder__title">输入关键词开始搜索</div>
          {defaultKeywordText ? <div>试试搜索「{defaultKeywordText}」</div> : null}
        </div>
      ) : null}

      {offline && keywords && !externalLoading && !externalError && external?.length === 0 ? (
        <div className="placeholder">
          <div className="placeholder__title">没有找到相关歌曲</div>
          <div>换个关键词，或者换一个音源再试试。</div>
        </div>
      ) : null}

      {offline && external && external.length > 0 ? (
        <section className={`page__section${externalRefreshing ? ' is-refreshing' : ''}`}>
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
                  title={`${item.name} — ${item.artists}（${EXTERNAL_SOURCE_NAMES[item.source]}）`}
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
                      <div className="song-row__sub">{item.artists || EXTERNAL_SOURCE_NAMES[item.source]}</div>
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

      {!offline && !loading && keywords && !error && loaded === 0 ? (
        <div className="placeholder">
          <div className="placeholder__title">没有找到与「{keywords}」相关的内容</div>
          <div>换个关键词，或者检查一下输入。</div>
        </div>
      ) : null}

      {!offline && !loading && result ? (
        <div className={refreshing ? 'is-refreshing' : undefined}>
          {songs.length > 0 ? (
            <section className="page__section">
              <SectionHeader
                icon={IconMusic}
                title="单曲"
                count={result.songCount}
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
                count={result.artistCount}
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
                count={result.albumCount}
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
                count={result.playlistCount}
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

function SectionHeader({
  icon: Icon,
  title,
  count,
  action,
  onPlayAll
}: {
  icon: IconComponent
  title: string
  count?: number
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
        ) : count !== undefined && count > 0 ? (
          <span className="section__more">共 {count} 条</span>
        ) : null}
      </div>
    </div>
  )
}

/** 把四类联想压成一个扁平列表，键盘上下键只需要在这一个列表里移动。 */
function flattenSuggestions(value: SearchSuggestDTO | undefined): Suggestion[] {
  if (!value) return []
  const items: Suggestion[] = []
  for (const [index, track] of (value.songs ?? []).entries()) {
    items.push({
      key: `song-${track.id}-${index}`,
      label: track.name,
      hint: artistLine(track),
      Icon: IconMusic,
      keywords: track.name
    })
  }
  for (const artist of value.artists ?? []) {
    items.push({
      key: `artist-${artist.id}`,
      label: artist.name,
      hint: '歌手',
      Icon: IconUser,
      keywords: artist.name
    })
  }
  for (const album of value.albums ?? []) {
    items.push({
      key: `album-${album.id}`,
      label: album.name,
      hint: album.artistName,
      Icon: IconDisc,
      keywords: album.name
    })
  }
  for (const playlist of value.playlists ?? []) {
    items.push({
      key: `playlist-${playlist.id}`,
      label: playlist.name,
      hint: `${playlist.trackCount} 首`,
      Icon: IconLayers,
      keywords: playlist.name
    })
  }
  return items.slice(0, 12)
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
