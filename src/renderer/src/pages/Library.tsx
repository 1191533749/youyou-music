/**
 * 我的音乐 —— 自建账号的收藏与歌单。
 *
 * 布局按「账号条 + 分组卡」重做：一行账号信息，下面两张紧凑卡片，
 * 空状态只占一行，不再有大块居中留白。
 * 数据来自我们自己的服务器（`account:*`）；收藏条目存 `source + sourceId`，
 * 所以汽水 / 酷狗 / 酷我 / QQ 源的歌也能收进来。
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { usePlayerStore } from '../store/player'
import { useAccountStore } from '../store/account'
import { useNavigation } from '../store/navigation'
import { call, formatDuration } from '../lib/contract'
import { absoluteCover } from '../lib/covers'
import {
  IconHeartFilled,
  IconMusic,
  IconPause,
  IconPencil,
  IconPlay,
  IconPlus,
  IconQueue,
  IconTrash,
  IconUser
} from '../components/Icons'
import AccountAvatar from '../components/AccountAvatar'
import { useToast } from '../components/Toast'
import type { ExternalItemSource, TrackDTO, YYTrackRefDTO } from '@shared/types'

/**
 * 行内封面。收藏条目里的 `cover` 可能是网易云的 p1~p4 分片：
 * p3 在部分网络下会一直卡在加载中（见 lib/format.ts 的说明），而且给非网易云
 * 音源的图追加 `param=` 反而会 404 —— 所以这里只对网易云图加缩放参数，
 * 加载失败先退回不带 param 的原图，再失败就用歌名 + 歌手在网易云重新找一张，
 * 都失败才显示音符占位，不留破图。
 */
function RowArt({
  cover,
  name,
  artist,
  size = 18
}: {
  cover?: string
  name?: string
  artist?: string
  size?: number
}): JSX.Element {
  const [attempt, setAttempt] = useState(0)
  const [rescued, setRescued] = useState<string | undefined>(undefined)
  const asked = useRef(false)
  // 老数据可能存 http 封面（CSP 拦）、p3 分片（会卡住）或需要 App 密钥的相对地址。
  const base = absoluteCover(cover, 120)
  const stripped = base ? base.replace(/[?&]param=\d+y\d+/g, '').replace(/\?$/, '') : undefined
  const src = rescued ?? (attempt === 0 ? base : stripped)
  const exhausted = attempt > 1 && !rescued

  // 三轮都失败（典型是汽水封面链接已过期）时，用歌名 + 歌手重新找一张封面。
  useEffect(() => {
    if (!exhausted || asked.current || !name) return
    asked.current = true
    let alive = true
    void call('account:cover', { name, artist: artist ?? '' })
      .then((result) => {
        const next = absoluteCover(result.cover, 120)
        if (alive && next) setRescued(next)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [exhausted, name, artist])

  if (!src || exhausted) {
    return (
      <span className="me__row-art">
        <IconMusic size={size} />
      </span>
    )
  }

  return (
    <span className="me__row-art">
      <img
        key={src}
        src={src}
        alt=""
        loading="lazy"
        onError={() =>
          setAttempt((value) => {
            // 第二次换的是「去掉 param 的原图」；地址没变说明没得再试，直接进兜底。
            if (value === 0) return stripped && stripped !== base ? 1 : 2
            return value + 1
          })
        }
      />
    </span>
  )
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** 把收藏条目还原成可播的队列：网易云走详情接口，站外走音源直连。 */
async function playRefs(
  items: YYTrackRefDTO[],
  index: number,
  playTracks: (tracks: TrackDTO[], startIndex?: number) => Promise<void>
): Promise<void> {
  const target = items[Math.max(0, Math.min(index, items.length - 1))]
  if (!target) return
  if (target.source === 'netease') {
    const ids = items
      .filter((item) => item.source === 'netease')
      .map((item) => Number(item.sourceId))
      .filter((id) => Number.isFinite(id) && id > 0)
    if (ids.length === 0) throw new Error('这首歌暂时播不了')
    const tracks = await call('track:detail', { ids })
    const start = Math.max(0, ids.indexOf(Number(target.sourceId)))
    await playTracks(tracks, start)
    return
  }
  await call('player:playExternalList', {
    items: [
      {
        source: target.source as ExternalItemSource,
        sourceId: target.sourceId,
        name: target.name,
        artists: target.artist,
        album: target.album,
        durationMS: target.durationMs ?? 0,
        coverUrl: target.cover
      }
    ]
  })
}

export default function Library(): JSX.Element {
  const account = useAccountStore()
  const player = usePlayerStore()
  const navigation = useNavigation()
  const { show: showToast, node: toastNode } = useToast()
  const fileInput = useRef<HTMLInputElement>(null)

  const profile = account.profile
  const [nickDraft, setNickDraft] = useState<string | undefined>(undefined)
  const [avatarBusy, setAvatarBusy] = useState(false)

  const [creating, setCreating] = useState(false)
  const [newPlaylist, setNewPlaylist] = useState('')
  const [expanded, setExpanded] = useState<number | undefined>(undefined)
  const [detail, setDetail] = useState<{ id: number; tracks: YYTrackRefDTO[] } | undefined>(undefined)
  const [detailLoading, setDetailLoading] = useState(false)
  const [renaming, setRenaming] = useState<number | undefined>(undefined)
  const [renameDraft, setRenameDraft] = useState('')

  const displayName = profile?.nickname?.trim() || profile?.email?.split('@')[0] || '悠悠听友'
  const favorites = account.favorites
  const playing = player.state.playing

  const favoriteKeys = useMemo(() => new Set(favorites.map((item) => item.key)), [favorites])

  async function withBusy(action: () => Promise<void>, success?: string): Promise<void> {
    try {
      await action()
      if (success) showToast(success, 'success')
    } catch (cause) {
      showToast(messageOf(cause), 'error')
    }
  }

  async function playList(items: YYTrackRefDTO[], index: number): Promise<void> {
    await withBusy(() => playRefs(items, index, player.playTracks))
  }

  async function saveNickname(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (nickDraft === undefined) return
    await withBusy(async () => {
      await account.updateProfile(nickDraft.trim())
      setNickDraft(undefined)
    }, '昵称已更新')
  }

  async function pickAvatar(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > 480 * 1024) {
      showToast('图片太大了，选一张 480 KB 以内的', 'error')
      return
    }
    setAvatarBusy(true)
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(new Error('读取图片失败'))
        reader.readAsDataURL(file)
      })
      await account.uploadAvatar(dataUrl)
      showToast('头像已更新', 'success')
    } catch (cause) {
      showToast(messageOf(cause), 'error')
    } finally {
      setAvatarBusy(false)
    }
  }

  async function toggleExpand(id: number): Promise<void> {
    if (expanded === id) {
      setExpanded(undefined)
      return
    }
    setExpanded(id)
    setDetailLoading(true)
    try {
      const payload = await account.playlistDetail(id)
      setDetail({ id, tracks: payload.tracks })
    } catch (cause) {
      showToast(messageOf(cause), 'error')
      setDetail(undefined)
    } finally {
      setDetailLoading(false)
    }
  }

  async function createPlaylist(event: FormEvent): Promise<void> {
    event.preventDefault()
    const name = newPlaylist.trim()
    if (!name) return
    await withBusy(async () => {
      await account.createPlaylist(name)
      setNewPlaylist('')
      setCreating(false)
    }, `已创建歌单「${name}」`)
  }

  async function confirmRename(id: number): Promise<void> {
    const name = renameDraft.trim()
    if (!name) return
    await withBusy(async () => {
      await account.renamePlaylist(id, name)
      setRenaming(undefined)
    }, '歌单已改名')
  }

  async function removePlaylist(id: number, name: string): Promise<void> {
    await withBusy(async () => {
      await account.deletePlaylist(id)
      if (expanded === id) setExpanded(undefined)
    }, `已删除歌单「${name}」`)
  }

  /** 加/删之后重新取一次歌单详情：store 的写操作只回 void，不返回新列表。 */
  async function reloadDetail(id: number): Promise<void> {
    const payload = await account.playlistDetail(id)
    setDetail({ id, tracks: payload.tracks })
  }

  /** 把当前正在播放的歌加进歌单（站外曲目也能拿到 source + sourceId）。 */
  async function addCurrent(id: number): Promise<void> {
    await withBusy(async () => {
      const track = await call('account:currentTrack')
      if (!track) throw new Error('现在没有正在播放的歌')
      await account.addToPlaylist(id, [track])
      await reloadDetail(id)
    }, '已加入歌单')
  }

  async function removeFromPlaylist(id: number, item: YYTrackRefDTO): Promise<void> {
    await withBusy(async () => {
      await account.removeFromPlaylist(id, [item])
      await reloadDetail(id)
    }, '已从歌单移除')
  }

  return (
    <div className="me">
      <section className="me__account">
        <button
          type="button"
          className="me__avatar"
          title="换头像"
          aria-label="换头像"
          disabled={avatarBusy}
          onClick={() => fileInput.current?.click()}
        >
          <AccountAvatar src={profile?.avatar} />
        </button>

        <div className="me__id">
          <div className="me__name-row">
            {nickDraft === undefined ? (
              <>
                <span className="me__name">{displayName}</span>
                <button type="button" className="me__link" onClick={() => setNickDraft(profile?.nickname ?? '')}>
                  改昵称
                </button>
              </>
            ) : (
              <form className="me__inline" onSubmit={(event) => void saveNickname(event)}>
                <input
                  value={nickDraft}
                  maxLength={24}
                  autoFocus
                  placeholder="1-24 个字"
                  onChange={(event) => setNickDraft(event.target.value)}
                />
                <button type="submit" className="me__mini me__mini--primary">
                  保存
                </button>
                <button type="button" className="me__mini" onClick={() => setNickDraft(undefined)}>
                  取消
                </button>
              </form>
            )}
          </div>
          {nickDraft === undefined ? <div className="me__meta">{profile?.email}</div> : null}
        </div>

        <div className="me__stats">
          <span>{favorites.length} 首收藏</span>
          <span className="me__dot" />
          <span>{account.playlists.length} 个歌单</span>
        </div>

        <div className="me__actions">
          <button type="button" className="me__mini" disabled={avatarBusy} onClick={() => fileInput.current?.click()}>
            {avatarBusy ? '上传中…' : '换头像'}
          </button>
          <button
            type="button"
            className="me__mini"
            onClick={() =>
              void withBusy(async () => {
                await account.logout()
                navigation.reset({ name: 'home' })
              }, '已退出登录')
            }
          >
            退出登录
          </button>
        </div>

        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(event) => void pickAvatar(event)}
        />
      </section>

      <section className="me__card">
        <header className="me__head">
          <span className="me__head-icon">
            <IconHeartFilled size={15} />
          </span>
          <span className="me__head-title">我喜欢的音乐</span>
          <span className="me__head-count">{favorites.length}</span>
          <div className="me__head-right">
            <button
              type="button"
              className="me__play"
              disabled={favorites.length === 0}
              onClick={() => void playList(favorites, 0)}
            >
              {playing ? <IconPause size={12} /> : <IconPlay size={12} />}
              播放全部
            </button>
          </div>
        </header>

        {favorites.length === 0 ? (
          <div className="me__empty">在搜索、漫游或歌单里点红心，歌就会收到这里。</div>
        ) : (
          <div className="me__rows">
            {favorites.map((item, index) => (
              <div className="me__row" key={item.key}>
                <button type="button" className="me__row-main" onClick={() => void playList(favorites, index)}>
                  <RowArt cover={item.cover} name={item.name} artist={item.artist} />
                  <span className="me__row-text">
                    <span className="me__row-title">{item.name || '未知歌曲'}</span>
                    <span className="me__row-meta">
                      {item.artist || '未知歌手'}
                      {item.album ? ` · ${item.album}` : ''}
                      {item.durationMs ? ` · ${formatDuration(item.durationMs / 1000)}` : ''}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="me__icon"
                  title="取消收藏"
                  aria-label="取消收藏"
                  onClick={() => void withBusy(() => account.toggleFavorite(item), '已取消收藏')}
                >
                  <IconHeartFilled size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="me__card">
        <header className="me__head">
          <span className="me__head-icon">
            <IconQueue size={15} />
          </span>
          <span className="me__head-title">我的歌单</span>
          <span className="me__head-count">{account.playlists.length}</span>
          <div className="me__head-right">
            {creating ? (
              <form className="me__inline" onSubmit={(event) => void createPlaylist(event)}>
                <input
                  value={newPlaylist}
                  maxLength={40}
                  autoFocus
                  placeholder="歌单名字"
                  onChange={(event) => setNewPlaylist(event.target.value)}
                />
                <button type="submit" className="me__mini me__mini--primary" disabled={!newPlaylist.trim()}>
                  创建
                </button>
                <button
                  type="button"
                  className="me__mini"
                  onClick={() => {
                    setCreating(false)
                    setNewPlaylist('')
                  }}
                >
                  取消
                </button>
              </form>
            ) : (
              <button type="button" className="me__mini" onClick={() => setCreating(true)}>
                <IconPlus size={12} />
                新建歌单
              </button>
            )}
          </div>
        </header>

        {account.playlists.length === 0 ? (
          <div className="me__empty">还没有歌单。新建一个，把喜欢的歌按心情分开放。</div>
        ) : (
          <div className="me__rows">
            {account.playlists.map((playlist) => (
              <div className="me__group" key={playlist.id}>
                <div className="me__row">
                  {renaming === playlist.id ? (
                    <form
                      className="me__inline me__inline--grow"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void confirmRename(playlist.id)
                      }}
                    >
                      <input
                        value={renameDraft}
                        maxLength={40}
                        autoFocus
                        onChange={(event) => setRenameDraft(event.target.value)}
                      />
                      <button type="submit" className="me__mini me__mini--primary">
                        保存
                      </button>
                      <button type="button" className="me__mini" onClick={() => setRenaming(undefined)}>
                        取消
                      </button>
                    </form>
                  ) : (
                    <>
                      <button type="button" className="me__row-main" onClick={() => void toggleExpand(playlist.id)}>
                        <span className="me__row-art">
                          <IconQueue size={18} />
                        </span>
                        <span className="me__row-text">
                          <span className="me__row-title">{playlist.name}</span>
                          <span className="me__row-meta">{playlist.count} 首</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="me__icon"
                        title="把正在播的歌加进来"
                        aria-label="把正在播的歌加进来"
                        onClick={() => void addCurrent(playlist.id)}
                      >
                        <IconPlus size={15} />
                      </button>
                      <button
                        type="button"
                        className="me__icon"
                        title="改名"
                        aria-label="改名"
                        onClick={() => {
                          setRenaming(playlist.id)
                          setRenameDraft(playlist.name)
                        }}
                      >
                        <IconPencil size={15} />
                      </button>
                      <button
                        type="button"
                        className="me__icon"
                        title="删除歌单"
                        aria-label="删除歌单"
                        onClick={() => void removePlaylist(playlist.id, playlist.name)}
                      >
                        <IconTrash size={15} />
                      </button>
                    </>
                  )}
                </div>

                {expanded === playlist.id ? (
                  <div className="me__sub">
                    {detailLoading ? (
                      <div className="me__sub-hint">正在加载歌单</div>
                    ) : detail && detail.id === playlist.id && detail.tracks.length > 0 ? (
                      <>
                        <div className="me__sub-bar">
                          <button type="button" className="me__mini" onClick={() => void playList(detail.tracks, 0)}>
                            <IconPlay size={12} />
                            播放全部
                          </button>
                          <button type="button" className="me__mini" onClick={() => void addCurrent(playlist.id)}>
                            把正在播的歌加进来
                          </button>
                        </div>
                        {detail.tracks.map((item, index) => (
                          <div className="me__row" key={item.key}>
                            <button
                              type="button"
                              className="me__row-main"
                              onClick={() => void playList(detail.tracks, index)}
                            >
                              <RowArt cover={item.cover} name={item.name} artist={item.artist} size={16} />
                              <span className="me__row-text">
                                <span className="me__row-title">{item.name || '未知歌曲'}</span>
                                <span className="me__row-meta">{item.artist || '未知歌手'}</span>
                              </span>
                            </button>
                            <button
                              type="button"
                              className="me__icon"
                              title="从歌单移除"
                              aria-label="从歌单移除"
                              onClick={() => void removeFromPlaylist(playlist.id, item)}
                            >
                              <IconTrash size={15} />
                            </button>
                            {favoriteKeys.has(item.key) ? null : (
                              <button
                                type="button"
                                className="me__icon"
                                title="收藏到我喜欢"
                                aria-label="收藏到我喜欢"
                                onClick={() => void withBusy(() => account.toggleFavorite(item), '已收藏')}
                              >
                                <IconHeartFilled size={15} />
                              </button>
                            )}
                          </div>
                        ))}
                      </>
                    ) : (
                      <div className="me__sub-hint">这个歌单还是空的</div>
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {toastNode}
    </div>
  )
}
