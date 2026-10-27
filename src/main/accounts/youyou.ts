/**
 * 悠悠账号：我们自己的登录 / 收藏 / 自建歌单。
 *
 * 为什么不用网易云账号做身份：站外曲目（汽水 / 酷狗 / 酷我 / QQ）没有网易云 id，
 * 收藏只能往网易云「我喜欢的音乐」里塞 id，天然收不了。改成自建账号后，
 * 收藏与歌单都落在我们自己的服务器上，任何音源的歌都能收。
 *
 * 令牌是服务器签的 `u1.<uid>.<exp>.<sig>`（两年有效），本地用 Electron
 * `safeStorage`（Windows 上是 DPAPI）加密后存 `userData/youyou-account.json`，
 * 所以覆盖安装 / 升级都不会掉登录。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { safeStorage } from 'electron'
import type {
  YYAccountStateDTO,
  YYPlaylistDTO,
  YYPlaylistDetailDTO,
  YYProfileDTO,
  YYTrackRefDTO
} from '@shared/types'

const API_BASE = 'https://yy.ytw.asia/player-api'
/** 服务器下发的 App 密钥（与网页播放器 / iOS 版同一把）。 */
const APP_KEY = 'b9ae8468c1c32ab0e1aa0223807791ef'
const REQUEST_TIMEOUT_MS = 20_000

interface StoredAccount {
  /** 明文令牌（safeStorage 不可用时才用）。 */
  token?: string
  /** safeStorage 加密后的令牌（base64）。 */
  tokenEncrypted?: string
  profile?: YYProfileDTO
  favorites?: YYTrackRefDTO[]
  playlists?: YYPlaylistDTO[]
}

interface ServerEnvelope {
  ok?: boolean
  message?: string
  [key: string]: unknown
}

/** 服务器返回的头像地址是相对路径，客户端统一补成绝对地址。 */
function absoluteAvatar(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  if (/^https?:\/\//i.test(value)) return value
  return `https://yy.ytw.asia${value.startsWith('/') ? '' : '/'}${value}`
}

function asProfile(value: unknown): YYProfileDTO | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const id = Number(raw.id)
  const email = typeof raw.email === 'string' ? raw.email : ''
  if (!Number.isFinite(id) || id <= 0 || !email) return undefined
  return {
    id,
    email,
    nickname: typeof raw.nickname === 'string' ? raw.nickname : '',
    avatar: absoluteAvatar(raw.avatar),
    createdAt: Number(raw.createdAt) || 0
  }
}

function asTrackRef(value: unknown): YYTrackRefDTO | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const source = typeof raw.source === 'string' ? raw.source : ''
  const sourceId = raw.sourceId === undefined || raw.sourceId === null ? '' : String(raw.sourceId)
  if (!source || !sourceId) return undefined
  return {
    key: typeof raw.key === 'string' && raw.key ? raw.key : `${source}:${sourceId}`,
    source,
    sourceId,
    name: typeof raw.name === 'string' ? raw.name : '',
    artist: typeof raw.artist === 'string' ? raw.artist : '',
    album: typeof raw.album === 'string' ? raw.album : undefined,
    cover: typeof raw.cover === 'string' ? raw.cover : undefined,
    durationMs: Number(raw.durationMs) || undefined,
    addedAt: Number(raw.addedAt) || undefined
  }
}

function asPlaylist(value: unknown): YYPlaylistDTO | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const id = Number(raw.id)
  if (!Number.isFinite(id) || id <= 0) return undefined
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : '',
    count: Number(raw.count ?? raw.trackCount) || 0,
    updatedAt: Number(raw.updatedAt) || 0
  }
}

export class YouyouAccount {
  private readonly file: string
  private token?: string
  private profile?: YYProfileDTO
  private favorites: YYTrackRefDTO[] = []

  /** 收藏列表（只读）：主进程的心形状态与 `library:overview` 兜底都要用它。 */
  get favoriteList(): YYTrackRefDTO[] {
    return this.favorites
  }
  private playlists: YYPlaylistDTO[] = []
  private favouritesCache?: YYTrackRefDTO[]

  constructor(
    userDataDir: string,
    private readonly log: (message: string) => void = () => undefined
  ) {
    this.file = join(userDataDir, 'youyou-account.json')
  }

  // MARK: - 本地状态

  load(): void {
    try {
      if (!existsSync(this.file)) return
      const stored = JSON.parse(readFileSync(this.file, 'utf8')) as StoredAccount
      this.token = this.decryptToken(stored) ?? stored.token
      this.profile = asProfile(stored.profile)
      this.favorites = (stored.favorites ?? []).map(asTrackRef).filter(Boolean) as YYTrackRefDTO[]
      this.playlists = (stored.playlists ?? []).map(asPlaylist).filter(Boolean) as YYPlaylistDTO[]
    } catch (cause) {
      this.log(`读取账号缓存失败：${String(cause)}`)
    }
  }

  private decryptToken(stored: StoredAccount): string | undefined {
    if (!stored.tokenEncrypted) return undefined
    try {
      if (!safeStorage.isEncryptionAvailable()) return undefined
      return safeStorage.decryptString(Buffer.from(stored.tokenEncrypted, 'base64'))
    } catch (cause) {
      this.log(`解密登录令牌失败：${String(cause)}`)
      return undefined
    }
  }

  private persist(): void {
    const stored: StoredAccount = {
      profile: this.profile,
      favorites: this.favorites,
      playlists: this.playlists
    }
    if (this.token) {
      try {
        if (safeStorage.isEncryptionAvailable()) {
          stored.tokenEncrypted = safeStorage.encryptString(this.token).toString('base64')
        } else {
          stored.token = this.token
        }
      } catch (cause) {
        this.log(`加密登录令牌失败，改为明文保存：${String(cause)}`)
        stored.token = this.token
      }
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      writeFileSync(temp, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(temp, this.file)
    } catch (cause) {
      this.log(`保存账号失败：${String(cause)}`)
    }
  }

  state(): YYAccountStateDTO {
    return {
      loggedIn: Boolean(this.token && this.profile),
      profile: this.profile,
      favorites: this.favorites,
      playlists: this.playlists
    }
  }

  get loggedIn(): boolean {
    return Boolean(this.token && this.profile)
  }

  // MARK: - HTTP

  private async request<T extends ServerEnvelope>(
    path: string,
    init: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const headers: Record<string, string> = {
        'x-yy-app': APP_KEY,
        accept: 'application/json'
      }
      if (init.body !== undefined) headers['content-type'] = 'application/json'
      if (this.token) headers['x-yy-auth'] = this.token
      const response = await fetch(`${API_BASE}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal
      })
      const text = await response.text()
      let payload: T
      try {
        payload = JSON.parse(text) as T
      } catch {
        throw new Error(`服务器返回了无法解析的内容（${response.status}）`)
      }
      if (!response.ok || payload.ok === false) {
        if (response.status === 401) {
          // 令牌过期或被吊销：清掉本地登录态，让界面回到登录页。
          this.token = undefined
          this.profile = undefined
          this.persist()
        }
        throw new Error(payload.message || `请求失败（${response.status}）`)
      }
      return payload
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new Error('服务器没有响应，请稍后再试')
      }
      throw cause instanceof Error ? cause : new Error(String(cause))
    } finally {
      clearTimeout(timer)
    }
  }

  // MARK: - 登录

  async requestCode(email: string): Promise<{ ok: boolean; ttlSeconds: number }> {
    const payload = await this.request<ServerEnvelope & { ttlSeconds?: number }>('/auth/code', {
      method: 'POST',
      body: { email }
    })
    return { ok: true, ttlSeconds: Number(payload.ttlSeconds) || 600 }
  }

  async verify(email: string, code: string): Promise<YYAccountStateDTO> {
    const payload = await this.request<ServerEnvelope & { token?: string; profile?: unknown }>(
      '/auth/verify',
      { method: 'POST', body: { email, code } }
    )
    if (typeof payload.token !== 'string' || !payload.token) {
      throw new Error('登录失败：服务器没有返回令牌')
    }
    this.token = payload.token
    this.profile = asProfile(payload.profile)
    this.persist()
    await this.refresh().catch((cause) => this.log(`登录后刷新失败：${String(cause)}`))
    return this.state()
  }

  /**
   * 多设备同步：拿一次「简介 + 收藏 + 歌单」。带上已知 revision 时服务器回 304，
   * 数据没变就不回包、不动界面。
   */
  async sync(
    knownRevision?: string
  ): Promise<{ changed: boolean; revision?: string; state: YYAccountStateDTO }> {
    if (!this.token) return { changed: false, state: this.state() }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const headers: Record<string, string> = {
        'x-yy-app': APP_KEY,
        accept: 'application/json',
        'x-yy-auth': this.token
      }
      if (knownRevision) headers['if-none-match'] = `"${knownRevision}"`
      const response = await fetch(`${API_BASE}/auth/state`, { headers, signal: controller.signal })
      if (response.status === 304) {
        await response.text().catch(() => undefined)
        return { changed: false, state: this.state() }
      }
      const text = await response.text()
      if (response.status === 401) {
        this.token = undefined
        this.profile = undefined
        this.persist()
        throw new Error('请先登录')
      }
      const payload = JSON.parse(text) as ServerEnvelope & {
        revision?: string
        profile?: unknown
        favorites?: unknown[]
        playlists?: unknown[]
      }
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.message || `同步失败（${response.status}）`)
      }
      const profile = asProfile(payload.profile)
      if (profile) this.profile = profile
      this.favorites = (payload.favorites ?? [])
        .map(asTrackRef)
        .filter(Boolean) as YYTrackRefDTO[]
      this.playlists = (payload.playlists ?? []).map(asPlaylist).filter(Boolean) as YYPlaylistDTO[]
      this.persist()
      return {
        changed: true,
        revision: typeof payload.revision === 'string' ? payload.revision : undefined,
        state: this.state()
      }
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new Error('服务器没有响应，请稍后再试')
      }
      throw cause instanceof Error ? cause : new Error(String(cause))
    } finally {
      clearTimeout(timer)
    }
  }

  async refresh(): Promise<YYAccountStateDTO> {
    if (!this.token) return this.state()
    const me = await this.request<ServerEnvelope & { profile?: unknown }>('/auth/me')
    const profile = asProfile(me.profile)
    if (profile) this.profile = profile
    await this.refreshFavorites().catch((cause) => this.log(`读取收藏失败：${String(cause)}`))
    await this.refreshPlaylists().catch((cause) => this.log(`读取歌单失败：${String(cause)}`))
    this.persist()
    return this.state()
  }

  private async refreshFavorites(): Promise<void> {
    if (!this.token) return
    const payload = await this.request<ServerEnvelope & { items?: unknown[] }>('/auth/favorites')
    this.favorites = (payload.items ?? [])
      .map(asTrackRef)
      .filter(Boolean) as YYTrackRefDTO[]
  }

  private async refreshPlaylists(): Promise<void> {
    if (!this.token) return
    const payload = await this.request<ServerEnvelope & { items?: unknown[] }>('/auth/playlists')
    this.playlists = (payload.items ?? [])
      .map(asPlaylist)
      .filter(Boolean) as YYPlaylistDTO[]
  }

  async updateProfile(nickname: string): Promise<YYProfileDTO> {
    const payload = await this.request<ServerEnvelope & { profile?: unknown }>('/auth/profile', {
      method: 'POST',
      body: { nickname }
    })
    const profile = asProfile(payload.profile)
    if (profile) {
      this.profile = profile
      this.persist()
    }
    if (!this.profile) throw new Error('资料更新失败')
    return this.profile
  }

  async uploadAvatar(dataUrl: string): Promise<YYProfileDTO> {
    const payload = await this.request<ServerEnvelope & { profile?: unknown }>('/auth/avatar', {
      method: 'POST',
      body: { image: dataUrl }
    })
    const profile = asProfile(payload.profile)
    if (profile) {
      this.profile = profile
      this.persist()
    }
    if (!this.profile) throw new Error('头像更新失败')
    return this.profile
  }

  async logout(): Promise<void> {
    if (this.token) {
      await this.request('/auth/logout', { method: 'POST' }).catch((cause) =>
        this.log(`退出登录失败（本地已清空）：${String(cause)}`)
      )
    }
    this.token = undefined
    this.profile = undefined
    this.favorites = []
    this.playlists = []
    this.favouritesCache = undefined
    this.persist()
  }

  // MARK: - 收藏

  async toggleFavorite(track: YYTrackRefDTO, like: boolean): Promise<YYTrackRefDTO[]> {
    await this.request('/auth/favorite', { method: 'POST', body: { item: track, like } })
    await this.refreshFavorites()
    this.persist()
    return this.favorites
  }

  /** 已收藏集合（`source:sourceId`），用于给心形上色。 */
  favoriteKeys(): Set<string> {
    if (!this.favouritesCache || this.favouritesCache.length !== this.favorites.length) {
      this.favouritesCache = this.favorites
    }
    return new Set(this.favorites.map((item) => item.key))
  }

  // MARK: - 歌单

  async playlistDetail(id: number): Promise<YYPlaylistDetailDTO> {
    const payload = await this.request<ServerEnvelope & { playlist?: Record<string, unknown> }>(
      `/auth/playlist?id=${encodeURIComponent(String(id))}`
    )
    const raw = payload.playlist ?? {}
    const summary = asPlaylist(raw) ?? { id, name: '', count: 0, updatedAt: 0 }
    const tracks = (Array.isArray(raw.items) ? raw.items : [])
      .map(asTrackRef)
      .filter(Boolean) as YYTrackRefDTO[]
    return { ...summary, count: tracks.length, tracks }
  }

  async playlistCreate(name: string): Promise<YYPlaylistDTO[]> {
    await this.request('/auth/playlist/create', { method: 'POST', body: { name } })
    await this.refreshPlaylists()
    this.persist()
    return this.playlists
  }

  async playlistRename(id: number, name: string): Promise<YYPlaylistDTO[]> {
    await this.request('/auth/playlist/rename', { method: 'POST', body: { id, name } })
    await this.refreshPlaylists()
    this.persist()
    return this.playlists
  }

  async playlistDelete(id: number): Promise<YYPlaylistDTO[]> {
    await this.request('/auth/playlist/delete', { method: 'POST', body: { id } })
    await this.refreshPlaylists()
    this.persist()
    return this.playlists
  }

  async playlistAdd(id: number, tracks: YYTrackRefDTO[]): Promise<YYPlaylistDetailDTO> {
    await this.request('/auth/playlist/tracks', { method: 'POST', body: { id, action: 'add', items: tracks } })
    return this.playlistDetail(id)
  }

  async playlistRemove(id: number, tracks: YYTrackRefDTO[]): Promise<YYPlaylistDetailDTO> {
    await this.request('/auth/playlist/tracks', {
      method: 'POST',
      body: {
        id,
        action: 'del',
        items: tracks.map((item) => ({ source: item.source, sourceId: item.sourceId }))
      }
    })
    return this.playlistDetail(id)
  }
}
