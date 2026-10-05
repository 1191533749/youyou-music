/**
 * 搜索页：综合 / 单曲 / 歌手 / 专辑 / 歌单五个标签，带输入联想。
 *
 * 联想走 300ms 防抖 —— 每敲一个字就请求一次既浪费也会让下拉在输入过程中
 * 反复跳动；回车或点击联想才真正搜索。综合标签把四类结果各取一小批并排
 * 展示（用 allSettled，某一类失败不影响其它类），单类标签才做分页。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArtCard,
  SongList,
  artistLine,
  call,
  coverUrl,
  formatPlayCount,
  useNavigation,
  usePlayerStore
} from '../lib/contract'
import { useDebounced } from '../lib/hooks'
import { IconDisc, IconLayers, IconMusic, IconPlay, IconPlus, IconSearch, IconUser } from '../components/Icons'
import type { SearchResultDTO, SearchSuggestDTO } from '@shared/ipc'

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

/** 综合标签每类只取一小批，单类标签才是完整一页。 */
const OVERVIEW_LIMIT = 8
const PAGE_SIZE = 30

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

  const [input, setInput] = useState(initialKeywords ?? '')
  const [query, setQuery] = useState<{ keywords: string; nonce: number } | undefined>()
  const [tab, setTab] = useState<Tab>('comprehensive')
  const [defaultKeyword, setDefaultKeyword] = useState<string | undefined>()

  const [suggest, setSuggest] = useState<Suggestion[]>([])
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)

  const [result, setResult] = useState<SearchResultDTO | undefined>()
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [more, setMore] = useState(false)

  const generationRef = useRef(0)
  const offsetRef = useRef(0)
  const boxRef = useRef<HTMLDivElement | null>(null)

  const keywords = query?.keywords ?? ''
  const nonce = query?.nonce ?? 0

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

  // --- 搜索 -------------------------------------------------------------
  useEffect(() => {
    if (!keywords) {
      setResult(undefined)
      return
    }
    const generation = ++generationRef.current
    offsetRef.current = 0
    setLoading(true)
    setError(undefined)
    setResult(undefined)
    setMore(false)

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
          setResult({
            songs: songs.status === 'fulfilled' ? songs.value.songs : undefined,
            artists: artists.status === 'fulfilled' ? artists.value.artists : undefined,
            albums: albums.status === 'fulfilled' ? albums.value.albums : undefined,
            playlists: playlists.status === 'fulfilled' ? playlists.value.playlists : undefined,
            songCount: songs.status === 'fulfilled' ? songs.value.songCount : undefined,
            artistCount: artists.status === 'fulfilled' ? artists.value.artistCount : undefined,
            albumCount: albums.status === 'fulfilled' ? albums.value.albumCount : undefined,
            playlistCount: playlists.status === 'fulfilled' ? playlists.value.playlistCount : undefined
          })
        } else {
          const page = await call('search:query', { keywords, type: tab, limit: PAGE_SIZE, offset: 0 })
          if (generation !== generationRef.current) return
          offsetRef.current = countOf(tab, page)
          setResult(page)
          setMore(hasMoreAfter(tab, page, 0))
        }
      } catch (cause) {
        if (generation !== generationRef.current) return
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (generation === generationRef.current) setLoading(false)
      }
    }

    void run()
  }, [keywords, nonce, tab])

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
          <span className="search__summary">
            {loading
              ? '正在搜索…'
              : totalCount === undefined
                ? `「${keywords}」的搜索结果`
                : `「${keywords}」共 ${totalCount} 条结果`}
          </span>
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

      {!loading && !keywords ? (
        <div className="placeholder">
          <div className="placeholder__title">输入关键词开始搜索</div>
          {defaultKeywordText ? <div>试试搜索「{defaultKeywordText}」</div> : null}
        </div>
      ) : null}

      {!loading && keywords && !error && loaded === 0 ? (
        <div className="placeholder">
          <div className="placeholder__title">没有找到与「{keywords}」相关的内容</div>
          <div>换个关键词，或者检查一下输入。</div>
        </div>
      ) : null}

      {!loading && result ? (
        <>
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
        </>
      ) : null}
    </div>
  )
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
