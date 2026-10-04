/**
 * 我的音乐 —— 喜欢的音乐、歌单、收藏专辑、关注歌手、最近播放。
 *
 * 五类数据挤在一个路由里，所以用顶部区段切换而不是五个独立页面：它们来自
 * 同一次 `library:overview`，来回切换不该重新联网。喜欢的歌曲另有一步：接口
 * 只给 id，详情要按批另取，所以它自己维护加载/错误状态，不拖累其它区段。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
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
import ContextMenu, { type ContextMenuItem } from '../components/ContextMenu'
import Dialog from '../components/Dialog'
import { useToast } from '../components/Toast'
import type { LibraryDTO, PlayRecordDTO } from '@shared/ipc'
import type { AlbumSummaryDTO, ArtistSummaryDTO, PlaylistSummaryDTO, TrackDTO } from '@shared/types'

type Section = 'liked' | 'playlists' | 'albums' | 'artists' | 'recent'

const SECTIONS: Array<{ id: Section; label: string; icon: string }> = [
  { id: 'liked', label: '喜欢的音乐', icon: '♥' },
  { id: 'playlists', label: '歌单', icon: '≡' },
  { id: 'albums', label: '收藏专辑', icon: '💿' },
  { id: 'artists', label: '关注歌手', icon: '🎤' },
  { id: 'recent', label: '最近播放', icon: '🕘' }
]

/**
 * 喜欢的歌曲接口只返回 id，详情要拿这批 id 去 song/detail 换。一次带太多 id
 * 服务端会拒绝，所以按 200 一批串行取 —— 并发几十个请求比慢一点更糟。
 */
const LIKED_BATCH = 200

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
  const [section, setSection] = useState<Section>('liked')

  const overview = useAsync<LibraryDTO>(() => call('library:overview'), [])

  // 本地副本：删除歌单、取消收藏、喜欢一首歌之后只改这里，不为了一个写操作
  // 重新拉整个 overview。
  const [playlists, setPlaylists] = useState<PlaylistSummaryDTO[]>([])
  const [albums, setAlbums] = useState<AlbumSummaryDTO[]>([])
  const [artists, setArtists] = useState<ArtistSummaryDTO[]>([])
  const [recent, setRecent] = useState<PlayRecordDTO[]>([])
  const [likedIDs, setLikedIDs] = useState<Set<number>>(new Set())

  const [likedTracks, setLikedTracks] = useState<TrackDTO[]>([])
  const [likedLoading, setLikedLoading] = useState(false)
  const [likedError, setLikedError] = useState<string | undefined>()

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
    setLikedIDs(new Set(data.likedTrackIDs))
  }, [overview.data])

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
    const next = new Set(likedIDs)
    if (liked) next.delete(track.id)
    else next.add(track.id)
    const previous = likedIDs
    setLikedIDs(next)
    try {
      await call('library:likeTrack', { id: track.id, like: !liked })
    } catch (cause) {
      setLikedIDs(previous)
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
   * 卡片的「⋯」和右键都走同一个菜单：⋯ 从按钮下沿弹出（键盘也能点到），右键
   * 跟随光标。
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

  if (overview.loading) {
    return (
      <div className="page">
        <div className="page__header">
          <h1 className="page__title">我的音乐</h1>
        </div>
        <div className="placeholder">正在加载你的音乐库…</div>
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
        <button type="button" className="button" onClick={overview.reload}>
          重试
        </button>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">我的音乐</h1>
        <span className="page__subtitle">
          {auth.profile?.nickname ? `${auth.profile.nickname} 的收藏` : ''}
        </span>
      </div>

      <div className="chip-row library__tabs">
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`chip${section === item.id ? ' is-active' : ''}`}
            onClick={() => setSection(item.id)}
          >
            <span className="library__tab-icon">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </div>

      {section === 'liked' ? (
        <div className="page__section">
          <div className="section__header">
            <h2 className="section__title">
              喜欢的音乐
              <span className="section__more">{likedIDs.size} 首</span>
            </h2>
            <div className="library__actions">
              <button
                type="button"
                className="button button--primary"
                disabled={visibleLiked.length === 0}
                onClick={() => void player.playTracks(visibleLiked, 0)}
              >
                ▶ 播放全部
              </button>
            </div>
          </div>
          {likedLoading ? (
            <div className="placeholder">正在加载喜欢的歌曲…</div>
          ) : likedError ? (
            <div className="placeholder">
              <div className="placeholder__title">喜欢的歌曲加载失败</div>
              <div>{likedError}</div>
              <button
                type="button"
                className="button"
                onClick={() => void loadLiked(overview.data?.likedTrackIDs ?? [])}
              >
                重试
              </button>
            </div>
          ) : (
            <SongList
              tracks={visibleLiked}
              likedTrackIDs={likedIDs}
              currentTrackID={player.state.track?.id}
              onPlay={(index) => void player.playTracks(visibleLiked, index)}
              onToggleLike={(track) => void toggleLike(track)}
              emptyMessage="还没有喜欢的歌曲，点歌曲右侧的 ♡ 就会出现在这里"
            />
          )}
        </div>
      ) : null}

      {section === 'playlists' ? (
        <div className="page__section">
          <div className="section__header">
            <h2 className="section__title">
              歌单
              <span className="section__more">{playlists.length} 个</span>
            </h2>
            <div className="library__actions">
              <button type="button" className="button" onClick={() => setCreating(true)}>
                ＋ 新建歌单
              </button>
            </div>
          </div>

          {playlists.length === 0 ? (
            <div className="placeholder">
              <div className="placeholder__title">还没有歌单</div>
              <div>新建一个歌单，或者去发现页收藏别人的歌单</div>
            </div>
          ) : (
            <>
              {created.length > 0 ? (
                <div className="library__group">
                  <div className="library__group-title">创建的歌单（{created.length}）</div>
                  <div className="grid grid--playlists">
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
                <div className="library__group">
                  <div className="library__group-title">收藏的歌单（{collected.length}）</div>
                  <div className="grid grid--playlists">
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
        </div>
      ) : null}

      {section === 'albums' ? (
        <div className="page__section">
          <div className="section__header">
            <h2 className="section__title">
              收藏专辑
              <span className="section__more">{albums.length} 张</span>
            </h2>
          </div>
          {albums.length === 0 ? (
            <div className="placeholder">
              <div className="placeholder__title">还没有收藏专辑</div>
              <div>在专辑页点「收藏」后会出现在这里</div>
            </div>
          ) : (
            <div className="grid grid--albums">
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
                    onClick={(event) => openTileMenu(event, albumMenu(album))}
                  >
                    ⋯
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {section === 'artists' ? (
        <div className="page__section">
          <div className="section__header">
            <h2 className="section__title">
              关注歌手
              <span className="section__more">{artists.length} 位</span>
            </h2>
          </div>
          {artists.length === 0 ? (
            <div className="placeholder">
              <div className="placeholder__title">还没有关注歌手</div>
              <div>在歌手页点「关注」后会出现在这里</div>
            </div>
          ) : (
            <div className="grid grid--artists">
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
                    onClick={() =>
                      navigation.push({ name: 'artist', id: artist.id, title: artist.name })
                    }
                  />
                  <button
                    type="button"
                    className="icon-button library-tile__more"
                    title="更多操作"
                    onClick={(event) => openTileMenu(event, artistMenu(artist))}
                  >
                    ⋯
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {section === 'recent' ? (
        <div className="page__section">
          <div className="section__header">
            <h2 className="section__title">
              最近播放
              <span className="section__more">{recent.length} 首</span>
            </h2>
            <div className="library__actions">
              <button
                type="button"
                className="button button--primary"
                disabled={recentSongs.length === 0}
                onClick={() => void player.playTracks(recentSongs, 0)}
              >
                ▶ 播放全部
              </button>
            </div>
          </div>
          {recent.length === 0 ? (
            <div className="placeholder">
              <div className="placeholder__title">暂无播放记录</div>
              <div>听过的歌会按播放次数排在这里</div>
            </div>
          ) : (
            <div className="library-recent">
              {recent.map((record, index) => (
                <div
                  key={`${record.song.id}-${index}`}
                  className={`library-recent__row${
                    player.state.track?.id === record.song.id ? ' is-current' : ''
                  }`}
                  onDoubleClick={() => void player.playTracks(recentSongs, index)}
                  title={`${record.song.name} — ${artistLine(record.song)}`}
                >
                  <div className="library-recent__index">{index + 1}</div>
                  <div className="library-recent__title">
                    <button
                      type="button"
                      className="song-row__play"
                      title="播放"
                      onClick={() => void player.playTracks(recentSongs, index)}
                    >
                      {player.state.track?.id === record.song.id ? '♪' : '▶'}
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
              ))}
            </div>
          )}
        </div>
      ) : null}

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
            <button type="button" className="button" onClick={() => setCreating(false)}>
              取消
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={busy || !newName.trim()}
              onClick={() => void createPlaylist()}
            >
              {busy ? '创建中…' : '创建'}
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
            <button type="button" className="button" onClick={() => setConfirm(undefined)}>
              取消
            </button>
            <button
              type="button"
              className="button button--primary"
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
        onClick={onMenu}
      >
        ⋯
      </button>
    </div>
  )
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
