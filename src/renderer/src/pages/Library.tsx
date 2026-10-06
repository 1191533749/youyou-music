/**
 * 我的音乐 —— 顶部用户卡 + 五个区段入口卡（手机端「我的」页的排版）。
 *
 * 五类数据来自同一次 `library:overview`，所以全部平铺在一个页面里：没有切换，
 * 也就没有「切过去才发现数据没加载」的等待。喜欢的歌曲另有一步：接口只给 id，
 * 详情要按批另取，所以它自己维护加载/错误状态，不拖累其它卡片。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent
} from 'react'
import {
  ArtCard,
  SongList,
  artistLine,
  call,
  coverUrl,
  formatDuration,
  formatPlayCount,
  useAuthStore,
  useNavigation,
  usePlayerStore
} from '../lib/contract'
import { useAsync } from '../lib/hooks'
import { applyLikeOverrides, clearLikeOverride, markLike } from '../lib/likes'
import ContextMenu, { type ContextMenuItem } from '../components/ContextMenu'
import Dialog from '../components/Dialog'
import {
  IconClock,
  IconDisc,
  IconHeartFilled,
  IconMic,
  IconMore,
  IconPause,
  IconPlay,
  IconPlus,
  IconQueue,
  IconUser
} from '../components/Icons'
import { useToast } from '../components/Toast'
import type { LibraryDTO, PlayRecordDTO } from '@shared/ipc'
import type { AlbumSummaryDTO, ArtistSummaryDTO, PlaylistSummaryDTO, TrackDTO } from '@shared/types'

/**
 * 喜欢的歌曲接口只返回 id，详情要拿这批 id 去 song/detail 换。一次带太多 id
 * 服务端会拒绝，所以按 200 一批串行取 —— 并发几十个请求比慢一点更糟。
 */
const LIKED_BATCH = 200

/** 最近播放默认只露几条，其余收在「展开」后面，免得单张卡吃掉整屏。 */
const RECENT_PREVIEW = 6

interface ConfirmRequest {
  title: string
  body: string
  confirmLabel: string
  run: () => void
}

interface MenuState {
  x: number
  y: number
  items: ContextMenuItem[]
}

export default function Library(): JSX.Element {
  const navigation = useNavigation()
  const player = usePlayerStore()
  const auth = useAuthStore()
  const toast = useToast()

  const overview = useAsync<LibraryDTO>(() => call('library:overview'), [])

  // 本地副本：删除歌单、取消收藏、喜欢一首歌之后只改这里，不为了一个写操作
  // 重新拉整个 overview。
  const [playlists, setPlaylists] = useState<PlaylistSummaryDTO[]>([])
  const [albums, setAlbums] = useState<AlbumSummaryDTO[]>([])
  const [artists, setArtists] = useState<ArtistSummaryDTO[]>([])
  const [recent, setRecent] = useState<PlayRecordDTO[]>([])
  // serverLikedIDs 是「服务器那份」，渲染统一走下面的 likedIDs（套了本地乐观覆盖）。
  const [serverLikedIDs, setServerLikedIDs] = useState<Set<number>>(new Set())

  const [likedTracks, setLikedTracks] = useState<TrackDTO[]>([])
  const [likedLoading, setLikedLoading] = useState(false)
  const [likedError, setLikedError] = useState<string | undefined>()

  // 两张「预览 + 展开」卡的折叠状态，纯展示。
  const [expanded, setExpanded] = useState<{ liked: boolean; recent: boolean }>({
    liked: false,
    recent: false
  })

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | undefined>()
  const [menu, setMenu] = useState<MenuState | undefined>()

  // StrictMode 下 effect 会跑两次，详情只该取一轮。
  const likedRequested = useRef(false)

  useEffect(() => {
    const data = overview.data
    if (!data) return
    setPlaylists(data.playlists)
    setAlbums(data.albums)
    setArtists(data.artists)
    setRecent(data.recent)
    setServerLikedIDs(new Set(data.likedTrackIDs))
  }, [overview.data])

  /**
   * 渲染用的喜欢集合 = 服务器数据 + 本地乐观覆盖。
   * 重新拉 overview 时服务器那份可能还是旧的，套上覆盖后 TTL 内不会被盖回去
   * —— 这正是「点完喜欢、鼠标一悬停又变回未喜欢」的根因。
   */
  const likedIDs = useMemo(() => applyLikeOverrides(serverLikedIDs), [serverLikedIDs])

  const loadLiked = useCallback(async (ids: number[]): Promise<void> => {
    if (ids.length === 0) {
      setLikedTracks([])
      return
    }
    setLikedLoading(true)
    setLikedError(undefined)
    try {
      const collected: TrackDTO[] = []
      for (let index = 0; index < ids.length; index += LIKED_BATCH) {
        const batch = ids.slice(index, index + LIKED_BATCH)
        collected.push(...(await call('track:detail', { ids: batch })))
      }
      setLikedTracks(collected)
    } catch (cause) {
      setLikedError(messageOf(cause))
    } finally {
      setLikedLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!overview.data || likedRequested.current) return
    likedRequested.current = true
    void loadLiked(overview.data.likedTrackIDs)
  }, [overview.data, loadLiked])

  /** 列表按 likedIDs 裁剪，取消喜欢后回滚只要还原 id 集合。 */
  const visibleLiked = useMemo(
    () => likedTracks.filter((track) => likedIDs.has(track.id)),
    [likedTracks, likedIDs]
  )

  const toggleLike = async (track: TrackDTO): Promise<void> => {
    const liked = likedIDs.has(track.id)
    const next = new Set(serverLikedIDs)
    if (liked) next.delete(track.id)
    else next.add(track.id)
    const previous = serverLikedIDs
    // 乐观覆盖 + 乐观状态：刷新回来的旧数据在 TTL 内都盖不掉这一下。
    markLike(track.id, !liked)
    setServerLikedIDs(next)
    try {
      await call('library:likeTrack', { id: track.id, like: !liked })
    } catch (cause) {
      clearLikeOverride(track.id)
      setServerLikedIDs(previous)
      toast.show(`操作失败：${messageOf(cause)}`, 'error')
    }
  }

  const createPlaylist = async (): Promise<void> => {
    const name = newName.trim()
    if (!name || busy) return
    setBusy(true)
    try {
      await call('library:createPlaylist', { name })
      setNewName('')
      setCreating(false)
      toast.show(`已创建歌单「${name}」`, 'success')
      // 新歌单只有 id，没有封面和曲目数，本地补不出一张完整卡片，重取一次。
      overview.reload()
    } catch (cause) {
      toast.show(`创建失败：${messageOf(cause)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const deletePlaylist = async (playlist: PlaylistSummaryDTO): Promise<void> => {
    try {
      await call('library:deletePlaylist', { id: playlist.id })
      setPlaylists((current) => current.filter((item) => item.id !== playlist.id))
      toast.show(`已删除歌单「${playlist.name}」`, 'success')
    } catch (cause) {
      toast.show(`删除失败：${messageOf(cause)}`, 'error')
    }
  }

  const unsubscribePlaylist = async (playlist: PlaylistSummaryDTO): Promise<void> => {
    try {
      await call('library:subscribePlaylist', { id: playlist.id, subscribe: false })
      setPlaylists((current) => current.filter((item) => item.id !== playlist.id))
      toast.show(`已取消收藏「${playlist.name}」`, 'success')
    } catch (cause) {
      toast.show(`取消收藏失败：${messageOf(cause)}`, 'error')
    }
  }

  const unsubscribeAlbum = async (album: AlbumSummaryDTO): Promise<void> => {
    try {
      await call('library:subscribeAlbum', { id: album.id, subscribe: false })
      setAlbums((current) => current.filter((item) => item.id !== album.id))
      toast.show(`已取消收藏「${album.name}」`, 'success')
    } catch (cause) {
      toast.show(`取消收藏失败：${messageOf(cause)}`, 'error')
    }
  }

  const unfollowArtist = async (artist: ArtistSummaryDTO): Promise<void> => {
    try {
      await call('library:subscribeArtist', { id: artist.id, subscribe: false })
      setArtists((current) => current.filter((item) => item.id !== artist.id))
      toast.show(`已取消关注「${artist.name}」`, 'success')
    } catch (cause) {
      toast.show(`取消关注失败：${messageOf(cause)}`, 'error')
    }
  }

  /**
   * 卡片的「更多」按钮和右键走同一个菜单：按钮从自己下沿弹出（键盘也能点到），
   * 右键跟随光标。
   */
  const openTileMenu = (event: MouseEvent<HTMLElement>, items: ContextMenuItem[]): void => {
    event.preventDefault()
    event.stopPropagation()
    const fromPointer = event.type === 'contextmenu'
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({
      x: fromPointer ? event.clientX : rect.right - 4,
      y: fromPointer ? event.clientY : rect.bottom + 4,
      items
    })
  }

  const uid = auth.profile?.userId
  const isMine = useCallback(
    (playlist: PlaylistSummaryDTO): boolean =>
      playlist.isLikedSongsList ||
      // 归属优先看 userId；本页自己订阅的 auth:state 还没回来时退回 subscribed ——
      // 网易云对「我创建的」返回 false，「我收藏的」返回 true。
      (uid !== undefined ? playlist.creator?.userId === uid : !playlist.subscribed),
    [uid]
  )

  const albumMenu = (album: AlbumSummaryDTO): ContextMenuItem[] => [
    { label: '打开专辑', onSelect: () => navigation.push({ name: 'album', id: album.id, title: album.name }) },
    {
      label: '取消收藏',
      danger: true,
      onSelect: () =>
        setConfirm({
          title: '取消收藏',
          body: `确定取消收藏专辑「${album.name}」吗？`,
          confirmLabel: '取消收藏',
          run: () => void unsubscribeAlbum(album)
        })
    }
  ]

  const artistMenu = (artist: ArtistSummaryDTO): ContextMenuItem[] => [
    { label: '打开歌手', onSelect: () => navigation.push({ name: 'artist', id: artist.id, title: artist.name }) },
    {
      label: '取消关注',
      danger: true,
      onSelect: () =>
        setConfirm({
          title: '取消关注',
          body: `确定取消关注「${artist.name}」吗？`,
          confirmLabel: '取消关注',
          run: () => void unfollowArtist(artist)
        })
    }
  ]

  const created = useMemo(() => playlists.filter(isMine), [playlists, isMine])
  const collected = useMemo(() => playlists.filter((item) => !isMine(item)), [playlists, isMine])
  const recentSongs = useMemo(() => recent.map((record) => record.song), [recent])

  /**
   * 整表播放：让主进程随机起播，「播放全部」不再永远从第一首开始。
   * store 的 playTracks 还没有 randomStart 参数，所以这里直接走通道；主进程
   * 每次状态变化都会广播 player:state，store 会自己跟上。
   */
  const playAll = (tracks: TrackDTO[]): void => {
    if (tracks.length === 0) return
    void call('player:playTracks', { tracks, startIndex: 0, randomStart: true }).catch(() => undefined)
  }

  /** 顶部用户卡的轻信息：只报真实存在的数字，没有就不显示，不硬凑。 */
  const heroStats = [
    playlists.length > 0 ? `${playlists.length} 个歌单` : '',
    likedIDs.size > 0 ? `${likedIDs.size} 首喜欢` : '',
    albums.length > 0 ? `${albums.length} 张专辑` : '',
    artists.length > 0 ? `${artists.length} 位关注` : ''
  ].filter(Boolean)

  // 封面优先用「我喜欢的音乐」歌单封面，没有就退到第一首的专辑图。
  const likedCover = coverUrl(
    playlists.find((item) => item.isLikedSongsList)?.coverURL ?? visibleLiked[0]?.album.picUrl,
    160
  )
  const recentRows = expanded.recent ? recent : recent.slice(0, RECENT_PREVIEW)

  if (overview.loading) {
    return (
      <div className="page">
        <div className="page__header">
          <h1 className="page__title">我的音乐</h1>
        </div>
        <div className="placeholder">正在加载你的音乐库</div>
      </div>
    )
  }

  if (overview.error) {
    return (
      <div className="page">
        <div className="page__header">
          <h1 className="page__title">我的音乐</h1>
        </div>
        <div className="page__error">{overview.error}</div>
        <button type="button" className="button glass-btn" onClick={overview.reload}>
          重试
        </button>
      </div>
    )
  }

  return (
    <div className="page library">
      {/* 顶部用户卡：渐变玻璃，只放头像、昵称与真实存在的统计。 */}
      <section className="library__hero">
        <div className="library__hero-avatar">
          {auth.profile?.avatarUrl ? (
            <img src={auth.profile.avatarUrl} alt="" />
          ) : (
            <IconUser size={26} />
          )}
        </div>
        <div className="library__hero-body">
          <h1 className="library__hero-name">{auth.profile?.nickname ?? '我的音乐'}</h1>
          {auth.profile?.signature ? (
            <p className="library__hero-sign">{auth.profile.signature}</p>
          ) : null}
          {heroStats.length > 0 ? <div className="library__hero-stats">{heroStats.join(' · ')}</div> : null}
        </div>
      </section>

      <div className="library__grid">
        {/*
          喜欢的音乐 —— 一行歌单封面 + 播放按钮，需要时展开完整列表。
          展开时这张卡拉满整行：半宽卡里 SongList 的六列会把歌名那一列挤到只剩
          几像素，看起来就像被圆形播放键盖住。
        */}
        <section className={`library__card${expanded.liked ? ' library__card--wide' : ''}`}>
          <header className="library__card-head">
            <span className="library__card-icon">
              <IconHeartFilled size={18} />
            </span>
            <h2 className="library__card-title">喜欢的音乐</h2>
            {likedIDs.size > 0 ? <span className="library__card-count">{likedIDs.size} 首</span> : null}
            <div className="library__card-tools">
              {visibleLiked.length > 0 ? (
                <button
                  type="button"
                  className="library__link glass-btn"
                  onClick={() => setExpanded((current) => ({ ...current, liked: !current.liked }))}
                >
                  {expanded.liked ? '收起' : '查看全部'}
                </button>
              ) : null}
            </div>
          </header>

          <div className="library__row">
            <div className="library__row-art">
              {likedCover ? <img src={likedCover} alt="" loading="lazy" /> : <IconHeartFilled size={24} />}
            </div>
            <div className="library__row-body">
              <div className="library__row-title">我喜欢的音乐</div>
              <div className="library__row-meta">
                {likedIDs.size > 0 ? `${likedIDs.size} 首` : '还没有喜欢的歌曲'}
              </div>
            </div>
            <button
              type="button"
              className="library__round library__round--primary"
              title="播放全部"
              aria-label="播放全部"
              disabled={visibleLiked.length === 0}
              onClick={() => playAll(visibleLiked)}
            >
              <IconPlay size={16} />
            </button>
          </div>

          {likedLoading ? (
            <div className="library__hint">正在加载喜欢的歌曲</div>
          ) : likedError ? (
            <div className="library__hint">
              <span>{likedError}</span>
              <button
                type="button"
                className="library__link glass-btn"
                onClick={() => void loadLiked(overview.data?.likedTrackIDs ?? [])}
              >
                重试
              </button>
            </div>
          ) : expanded.liked ? (
            <>
              {/* 展开是页面内状态，顶部导航的返回按钮管不到，所以列表上方再给一个返回。 */}
              <div className="library__list-bar">
                <button
                  type="button"
                  className="library__collapse"
                  onClick={() => setExpanded((current) => ({ ...current, liked: false }))}
                >
                  返回
                </button>
                <span className="library__list-count">共 {visibleLiked.length} 首</span>
              </div>
              <div className="library__list">
                <SongList
                  tracks={visibleLiked}
                  likedTrackIDs={likedIDs}
                  currentTrackID={player.state.track?.id}
                  onPlay={(index) => void player.playTracks(visibleLiked, index)}
                  onToggleLike={(track) => void toggleLike(track)}
                  emptyMessage="还没有喜欢的歌曲，点歌曲右侧的心形按钮就会出现在这里"
                />
              </div>
            </>
          ) : null}
        </section>

        {/* 我的歌单 —— 卡头「+」直接开新建歌单对话框。 */}
        <section className="library__card">
          <header className="library__card-head">
            <span className="library__card-icon">
              <IconQueue size={18} />
            </span>
            <h2 className="library__card-title">我的歌单</h2>
            {playlists.length > 0 ? <span className="library__card-count">{playlists.length} 个</span> : null}
            <div className="library__card-tools">
              <button
                type="button"
                className="library__round"
                title="新建歌单"
                aria-label="新建歌单"
                onClick={() => setCreating(true)}
              >
                <IconPlus size={16} />
              </button>
            </div>
          </header>

          {playlists.length === 0 ? (
            <div className="library__empty">
              <div className="library__empty-title">还没有歌单</div>
              <div>点右上角新建一个，或者去发现页收藏别人的歌单</div>
            </div>
          ) : (
            <>
              {created.length > 0 ? (
                <div className="library__sub">
                  <div className="library__sub-title">创建的歌单（{created.length}）</div>
                  <div className="library__mini-grid">
                    {created.map((playlist) => (
                      <PlaylistTile
                        key={playlist.id}
                        playlist={playlist}
                        badge={playlist.isLikedSongsList ? '我喜欢' : undefined}
                        onOpen={() =>
                          navigation.push({ name: 'playlist', id: playlist.id, title: playlist.name })
                        }
                        onMenu={(event) =>
                          openTileMenu(
                            event,
                            playlist.isLikedSongsList
                              ? []
                              : [
                                  {
                                    label: '删除歌单',
                                    danger: true,
                                    onSelect: () =>
                                      setConfirm({
                                        title: '删除歌单',
                                        body: `确定删除歌单「${playlist.name}」吗？此操作不可撤销。`,
                                        confirmLabel: '删除',
                                        run: () => void deletePlaylist(playlist)
                                      })
                                  }
                                ]
                          )
                        }
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              {collected.length > 0 ? (
                <div className="library__sub">
                  <div className="library__sub-title">收藏的歌单（{collected.length}）</div>
                  <div className="library__mini-grid">
                    {collected.map((playlist) => (
                      <PlaylistTile
                        key={playlist.id}
                        playlist={playlist}
                        onOpen={() =>
                          navigation.push({ name: 'playlist', id: playlist.id, title: playlist.name })
                        }
                        onMenu={(event) =>
                          openTileMenu(event, [
                            {
                              label: '取消收藏',
                              danger: true,
                              onSelect: () =>
                                setConfirm({
                                  title: '取消收藏',
                                  body: `确定取消收藏歌单「${playlist.name}」吗？`,
                                  confirmLabel: '取消收藏',
                                  run: () => void unsubscribePlaylist(playlist)
                                })
                            }
                          ])
                        }
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </section>

        {/* 收藏专辑 */}
        <section className="library__card">
          <header className="library__card-head">
            <span className="library__card-icon">
              <IconDisc size={18} />
            </span>
            <h2 className="library__card-title">收藏专辑</h2>
            {albums.length > 0 ? <span className="library__card-count">{albums.length} 张</span> : null}
          </header>
          {albums.length === 0 ? (
            <div className="library__empty">
              <div className="library__empty-title">还没有收藏专辑</div>
              <div>在专辑页点「收藏」后会出现在这里</div>
            </div>
          ) : (
            <div className="library__mini-grid">
              {albums.map((album) => (
                <div
                  className="library-tile"
                  key={album.id}
                  onContextMenu={(event) => openTileMenu(event, albumMenu(album))}
                >
                  <ArtCard
                    title={album.name}
                    subtitle={album.artistName}
                    imageUrl={coverUrl(album.picUrl, 320)}
                    badge={album.size > 0 ? `${album.size} 首` : undefined}
                    onClick={() => navigation.push({ name: 'album', id: album.id, title: album.name })}
                  />
                  <button
                    type="button"
                    className="icon-button library-tile__more"
                    title="更多操作"
                    aria-label="更多操作"
                    onClick={(event) => openTileMenu(event, albumMenu(album))}
                  >
                    <IconMore size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 关注歌手 */}
        <section className="library__card">
          <header className="library__card-head">
            <span className="library__card-icon">
              <IconMic size={18} />
            </span>
            <h2 className="library__card-title">关注歌手</h2>
            {artists.length > 0 ? <span className="library__card-count">{artists.length} 位</span> : null}
          </header>
          {artists.length === 0 ? (
            <div className="library__empty">
              <div className="library__empty-title">还没有关注歌手</div>
              <div>在歌手页点「关注」后会出现在这里</div>
            </div>
          ) : (
            <div className="library__mini-grid library__mini-grid--round">
              {artists.map((artist) => (
                <div
                  className="library-tile"
                  key={artist.id}
                  onContextMenu={(event) => openTileMenu(event, artistMenu(artist))}
                >
                  <ArtCard
                    title={artist.name}
                    subtitle={artist.musicSize > 0 ? `${artist.musicSize} 首单曲` : undefined}
                    imageUrl={coverUrl(artist.picUrl, 300)}
                    round
                    onClick={() => navigation.push({ name: 'artist', id: artist.id, title: artist.name })}
                  />
                  <button
                    type="button"
                    className="icon-button library-tile__more"
                    title="更多操作"
                    aria-label="更多操作"
                    onClick={(event) => openTileMenu(event, artistMenu(artist))}
                  >
                    <IconMore size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 最近播放 —— 预览若干行，可展开成完整列表。 */}
        <section className="library__card library__card--wide">
          <header className="library__card-head">
            <span className="library__card-icon">
              <IconClock size={18} />
            </span>
            <h2 className="library__card-title">最近播放</h2>
            {recent.length > 0 ? <span className="library__card-count">{recent.length} 首</span> : null}
            <div className="library__card-tools">
              {recent.length > RECENT_PREVIEW ? (
                <button
                  type="button"
                  className="library__link glass-btn"
                  onClick={() => setExpanded((current) => ({ ...current, recent: !current.recent }))}
                >
                  {expanded.recent ? '收起' : '展开'}
                </button>
              ) : null}
              <button
                type="button"
                className="library__round library__round--primary"
                title="播放全部"
                aria-label="播放全部"
                disabled={recentSongs.length === 0}
                onClick={() => playAll(recentSongs)}
              >
                <IconPlay size={16} />
              </button>
            </div>
          </header>
          {recent.length === 0 ? (
            <div className="library__empty">
              <div className="library__empty-title">暂无播放记录</div>
              <div>听过的歌会按播放次数排在这里</div>
            </div>
          ) : (
            <>
              {/* 展开态同样给一个页面内的返回入口。 */}
              {expanded.recent ? (
                <div className="library__list-bar">
                  <button
                    type="button"
                    className="library__collapse"
                    onClick={() => setExpanded((current) => ({ ...current, recent: false }))}
                  >
                    返回
                  </button>
                  <span className="library__list-count">共 {recent.length} 首</span>
                </div>
              ) : null}
              <div className={`library-recent${expanded.recent ? ' is-scroll' : ''}`}>
              {recentRows.map((record, index) => {
                const current = player.state.track?.id === record.song.id
                return (
                  <div
                    key={`${record.song.id}-${index}`}
                    className={`library-recent__row${current ? ' is-current' : ''}`}
                    onDoubleClick={() => void player.playTracks(recentSongs, index)}
                    title={`${record.song.name} — ${artistLine(record.song)}`}
                  >
                    <div className="library-recent__index">{index + 1}</div>
                    <div className="library-recent__title">
                      <button
                        type="button"
                        className="song-row__play glass-btn"
                        title={current ? '正在播放' : '播放'}
                        aria-label={current ? '正在播放' : '播放'}
                        onClick={() => void player.playTracks(recentSongs, index)}
                      >
                        {current ? <IconPause size={14} /> : <IconPlay size={14} />}
                      </button>
                      <div style={{ minWidth: 0 }}>
                        <div className="song-row__name">{record.song.name}</div>
                        <div className="song-row__sub">{artistLine(record.song)}</div>
                      </div>
                    </div>
                    <div className="library-recent__album">{record.song.album.name}</div>
                    <div className="library-recent__count">{record.playCount} 次</div>
                    <div className="song-row__duration">{formatDuration(record.song.durationMS / 1000)}</div>
                  </div>
                )
              })}
              </div>
            </>
          )}
        </section>
      </div>

      {menu ? (
        <ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(undefined)} />
      ) : null}

      <Dialog
        title="新建歌单"
        open={creating}
        onClose={() => setCreating(false)}
        width={380}
        footer={
          <>
            <button type="button" className="button glass-btn" onClick={() => setCreating(false)}>
              取消
            </button>
            <button
              type="button"
              className="button button--primary glass-btn"
              disabled={busy || !newName.trim()}
              onClick={() => void createPlaylist()}
            >
              {busy ? '创建中' : '创建'}
            </button>
          </>
        }
      >
        <label className="library__field">
          <span>歌单名称</span>
          <input
            className="text-input"
            value={newName}
            placeholder="例如：通勤循环"
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void createPlaylist()
            }}
          />
        </label>
      </Dialog>

      <Dialog
        title={confirm?.title ?? ''}
        open={confirm !== undefined}
        onClose={() => setConfirm(undefined)}
        width={380}
        footer={
          <>
            <button type="button" className="button glass-btn" onClick={() => setConfirm(undefined)}>
              取消
            </button>
            <button
              type="button"
              className="button button--primary glass-btn"
              onClick={() => {
                const action = confirm?.run
                setConfirm(undefined)
                action?.()
              }}
            >
              {confirm?.confirmLabel ?? '确定'}
            </button>
          </>
        }
      >
        <p className="library__dialog-text">{confirm?.body}</p>
      </Dialog>

      {toast.node}
    </div>
  )
}

/** 歌单卡片：ArtCard 整个是一个按钮，更多操作只能是它的兄弟节点。 */
function PlaylistTile({
  playlist,
  badge,
  onOpen,
  onMenu
}: {
  playlist: PlaylistSummaryDTO
  badge?: string
  onOpen: () => void
  onMenu: (event: MouseEvent<HTMLElement>) => void
}): JSX.Element {
  const subtitle = `${playlist.trackCount} 首${
    playlist.playCount > 0 ? ` · ${formatPlayCount(playlist.playCount)} 次播放` : ''
  }`
  return (
    <div className="library-tile" onContextMenu={onMenu}>
      <ArtCard
        title={playlist.name}
        subtitle={subtitle}
        imageUrl={coverUrl(playlist.coverURL, 320)}
        badge={badge}
        onClick={onOpen}
      />
      <button
        type="button"
        className="icon-button library-tile__more"
        title="更多操作"
        aria-label="更多操作"
        onClick={onMenu}
      >
        <IconMore size={16} />
      </button>
    </div>
  )
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
