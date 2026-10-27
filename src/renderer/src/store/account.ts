/**
 * 悠悠账号（自建登录）的渲染层状态。
 *
 * 用模块级单例 + useSyncExternalStore，而不是每个组件各持一份 state：
 * 「我的音乐」页、播放条心形、侧栏账号区必须看到同一份登录态，
 * 否则心形会因为各自缓存的数据不同而闪。
 */
import { useSyncExternalStore } from 'react'
import { call } from '../lib/ipc'
import type {
  YYAccountStateDTO,
  YYPlaylistDetailDTO,
  YYProfileDTO,
  YYTrackRefDTO
} from '@shared/types'

interface AccountState extends YYAccountStateDTO {
  loading: boolean
  /** 最近一次操作的错误（登录页用它显示提示）。 */
  error?: string
}

const EMPTY: AccountState = { loggedIn: false, favorites: [], playlists: [], loading: true }

let state: AccountState = EMPTY
const listeners = new Set<() => void>()

function publish(next: AccountState): void {
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function fromServer(payload: YYAccountStateDTO): AccountState {
  return { ...payload, loading: false }
}

function mergeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 启动时拉一次；登录/退出后会再拉。 */
export async function refreshAccount(): Promise<void> {
  try {
    const payload = await call('account:state')
    publish(fromServer(payload))
  } catch (cause) {
    publish({ ...state, loading: false, error: mergeError(cause) })
  }
}

void refreshAccount()

/**
 * 多设备同步轮询：每 10 秒问一次服务器，且只在数据真的变了（revision 不同）时才更新界面。
 * 窗口隐藏时停轮询；重新获得焦点/从后台切回时立刻同步一次，用户一回来看到的就是最新的。
 */
const SYNC_INTERVAL_MS = 10_000
let syncTimer: number | undefined
let syncRevision: string | undefined
let syncInFlight = false

async function syncOnce(force = false): Promise<void> {
  if (syncInFlight || !state.loggedIn) return
  syncInFlight = true
  try {
    const result = await call('account:sync', { revision: force ? undefined : syncRevision })
    if (result.revision) syncRevision = result.revision
    if (result.changed) publish(fromServer(result.state))
  } catch {
    // 网络抖动不打扰用户：下一轮再试。
  } finally {
    syncInFlight = false
  }
}

function startSyncLoop(): void {
  if (syncTimer !== undefined) return
  syncTimer = window.setInterval(() => {
    if (!document.hidden) void syncOnce()
  }, SYNC_INTERVAL_MS)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void syncOnce(true)
  })
  window.addEventListener('focus', () => void syncOnce(true))
}

startSyncLoop()

/** 手动刷新（比如刚登录完）：连 revision 一起丢掉，保证下一次拿全量。 */
export async function refreshAccountNow(): Promise<void> {
  syncRevision = undefined
  await syncOnce(true)
}

type YYPlaylistSummary = YYAccountStateDTO['playlists'][number]

const actions = {
  async requestCode(email: string): Promise<number> {
    const result = await call('account:requestCode', { email })
    return result.ttlSeconds
  },
  async verify(email: string, code: string): Promise<void> {
    try {
      const payload = await call('account:verify', { email, code })
      publish({ ...fromServer(payload), error: undefined })
    } catch (cause) {
      publish({ ...state, error: mergeError(cause) })
      throw cause
    }
  },
  async updateProfile(nickname: string): Promise<void> {
    const profile = await call('account:updateProfile', { nickname })
    publish({ ...state, profile })
  },
  async uploadAvatar(image: string): Promise<void> {
    const profile = await call('account:uploadAvatar', { image })
    publish({ ...state, profile })
  },
  async logout(): Promise<void> {
    await call('account:logout')
    publish({ ...EMPTY, loading: false })
  },
  async toggleFavorite(track: YYTrackRefDTO): Promise<void> {
    const liked = isFavorite(track.source, track.sourceId)
    try {
      const favorites = await call('account:favorite', { track, like: !liked })
      publish({ ...state, favorites })
    } catch (cause) {
      publish({ ...state, error: mergeError(cause) })
      throw cause
    }
  },
  async createPlaylist(name: string): Promise<void> {
    const playlists = await call('account:playlistCreate', { name })
    publish({ ...state, playlists })
  },
  async renamePlaylist(id: number, name: string): Promise<void> {
    const playlists = await call('account:playlistRename', { id, name })
    publish({ ...state, playlists })
  },
  async deletePlaylist(id: number): Promise<void> {
    const playlists = await call('account:playlistDelete', { id })
    publish({ ...state, playlists })
  },
  async addToPlaylist(id: number, tracks: YYTrackRefDTO[]): Promise<void> {
    await call('account:playlistAdd', { id, tracks })
    const playlists = await call('account:state')
    publish({ ...fromServer(playlists) })
  },
  async removeFromPlaylist(id: number, tracks: YYTrackRefDTO[]): Promise<void> {
    await call('account:playlistRemove', { id, tracks })
    const playlists = await call('account:state')
    publish({ ...fromServer(playlists) })
  },
  async playlistDetail(id: number): Promise<YYPlaylistDetailDTO> {
    return call('account:playlistDetail', { id })
  }
}

/** `source:sourceId` 是否在收藏里。 */
export function isFavorite(source: string, sourceId: string | number): boolean {
  const key = `${source}:${sourceId}`
  return state.favorites.some((item) => item.key === key)
}

export interface AccountStore extends AccountState {
  profile?: YYProfileDTO
  requestCode: (email: string) => Promise<number>
  verify: (email: string, code: string) => Promise<void>
  updateProfile: (nickname: string) => Promise<void>
  uploadAvatar: (image: string) => Promise<void>
  logout: () => Promise<void>
  toggleFavorite: (track: YYTrackRefDTO) => Promise<void>
  isFavorite: (source: string, sourceId: string | number) => boolean
  createPlaylist: (name: string) => Promise<void>
  renamePlaylist: (id: number, name: string) => Promise<void>
  deletePlaylist: (id: number) => Promise<void>
  addToPlaylist: (id: number, tracks: YYTrackRefDTO[]) => Promise<void>
  removeFromPlaylist: (id: number, tracks: YYTrackRefDTO[]) => Promise<void>
  playlistDetail: (id: number) => Promise<YYPlaylistDetailDTO>
  refresh: () => Promise<void>
}

export function useAccountStore(): AccountStore {
  const snapshot = useSyncExternalStore(subscribe, () => state)
  return {
    ...snapshot,
    ...actions,
    isFavorite,
    refresh: refreshAccount,
    playlists: snapshot.playlists as YYPlaylistSummary[]
  }
}

/** 收藏列表里点一首歌时用：把引用还原成可播的曲目。 */
export async function playTrackRef(
  item: YYTrackRefDTO,
  playTracks: (tracks: import('@shared/types').TrackDTO[], startIndex?: number) => Promise<void>
): Promise<void> {
  if (item.source === 'netease') {
    const tracks = await call('track:detail', { ids: [Number(item.sourceId)] })
    if (tracks.length === 0) throw new Error('这首歌暂时拿不到详细信息')
    await playTracks(tracks)
    return
  }
  await call('player:playExternalList', {
    items: [
      {
        source: item.source as import('@shared/types').ExternalItemSource,
        sourceId: item.sourceId,
        name: item.name,
        artists: item.artist,
        album: item.album,
        durationMS: item.durationMs ?? 0,
        coverUrl: item.cover
      }
    ]
  })
}
