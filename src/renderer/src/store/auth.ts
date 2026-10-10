/**
 * Auth store: 登录状态、扫码握手与账户信息。
 *
 * 登录支持三个平台（网易云 / 酷狗 / QQ音乐）：默认是网易云的二维码，
 * 切换平台后各自的二维码与轮询都走主进程的 `auth:platform*` 通道。
 * 网易云的扫码状态机（800 过期 / 801 等待 / 802 已扫码 / 803 成功）仍旧不变。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { call, onEvent } from '../lib/ipc'
import type {
  AccountPlatform,
  PlatformAccountDTO,
  PlatformPlaylistDTO,
  QRLoginStateDTO,
  UserProfileDTO
} from '@shared/types'

export interface AuthStore {
  loggedIn: boolean
  profile?: UserProfileDTO
  loading: boolean
  qr?: QRLoginStateDTO
  /** 当前正在登录（或查看）的平台。 */
  platform: AccountPlatform
  /** 平台直接给了二维码图片时用它显示（data URL 或图片地址）。 */
  qrImage?: string
  /** 三个平台的登录状态。 */
  accounts: PlatformAccountDTO[]
  /** 当前平台账号的歌单。 */
  playlists: PlatformPlaylistDTO[]
  playlistsLoading: boolean
  /** 发起某个平台的扫码登录；不传则用当前平台。 */
  startQR: (platform?: AccountPlatform) => Promise<void>
  /** 切换平台：已登录就展示该账号，没登录就出二维码。 */
  selectPlatform: (platform: AccountPlatform) => Promise<void>
  cancelQR: () => void
  refreshQR: () => Promise<void>
  logout: () => Promise<void>
  logoutPlatform: (platform: AccountPlatform) => Promise<void>
  loginWithSMS: (phone: string, captcha: string) => Promise<void>
  sendSMSCode: (phone: string) => Promise<void>
}

const POLL_INTERVAL_MS = 1800

export function useAuthStore(): AuthStore {
  const [loggedIn, setLoggedIn] = useState(false)
  const [profile, setProfile] = useState<UserProfileDTO | undefined>()
  const [loading, setLoading] = useState(true)
  const [qr, setQR] = useState<QRLoginStateDTO | undefined>()
  const [platform, setPlatform] = useState<AccountPlatform>('netease')
  const [qrImage, setQrImage] = useState<string | undefined>()
  const [accounts, setAccounts] = useState<PlatformAccountDTO[]>([])
  const [playlists, setPlaylists] = useState<PlatformPlaylistDTO[]>([])
  const [playlistsLoading, setPlaylistsLoading] = useState(false)
  const pollTimer = useRef<number | undefined>(undefined)
  const stopped = useRef(true)
  const current = useRef<AccountPlatform>('netease')
  /** Consecutive poll failures; a lone hiccup must not abort the handshake. */
  const failures = useRef(0)

  const stopPolling = useCallback(() => {
    stopped.current = true
    if (pollTimer.current !== undefined) {
      window.clearTimeout(pollTimer.current)
      pollTimer.current = undefined
    }
  }, [])

  const refreshAccounts = useCallback(async (): Promise<PlatformAccountDTO[]> => {
    const list = await call('auth:platforms').catch(() => [])
    setAccounts(list)
    return list
  }, [])

  const loadPlaylists = useCallback(async (target: AccountPlatform) => {
    if (target === 'netease') {
      setPlaylists([])
      return
    }
    setPlaylistsLoading(true)
    try {
      setPlaylists(await call('auth:platformPlaylists', { platform: target }))
    } catch {
      setPlaylists([])
    } finally {
      setPlaylistsLoading(false)
    }
  }, [])

  useEffect(() => {
    void call('auth:state')
      .then((state) => {
        setLoggedIn(state.loggedIn)
        setProfile(state.profile)
      })
      .catch(() => undefined)
      .finally(() => setLoading(false))
    void refreshAccounts()
    const off = onEvent('auth:changed', (payload) => {
      setLoggedIn(payload.loggedIn)
      if (payload.profile) setProfile(payload.profile)
      if (!payload.loggedIn) setProfile(undefined)
    })
    return () => {
      off()
      stopPolling()
    }
  }, [refreshAccounts, stopPolling])

  const poll = useCallback(
    async (target: AccountPlatform, token: string) => {
      if (stopped.current) return
      try {
        const state = await call('auth:platformQRPoll', { platform: target, token })
        failures.current = 0
        setQR(state)
        if (state.status === 'confirmed') {
          stopPolling()
          if (target === 'netease') {
            setLoggedIn(true)
            if (state.profile) {
              setProfile(state.profile)
            } else {
              // 主进程 803 已重试过账户接口；这里再兜一轮，别把
              // 「已登录但没头像」留到下次重启（用户明确反馈过）。
              for (let attempt = 0; attempt < 3; attempt += 1) {
                const fresh = await call('auth:profile').catch(() => undefined)
                if (fresh) {
                  setProfile(fresh)
                  break
                }
                await new Promise((resolve) => setTimeout(resolve, 600))
              }
            }
          } else {
            await refreshAccounts()
            await loadPlaylists(target)
          }
          return
        }
        if (state.status === 'expired' || state.status === 'error') {
          stopPolling()
          return
        }
      } catch (cause) {
        // A single failed poll is usually a transient network hiccup; giving up
        // on it would strand the user on "请使用 App 扫码" forever. Three in a
        // row is a real failure.
        failures.current += 1
        if (failures.current >= 3) {
          setQR({
            status: 'error',
            message: cause instanceof Error ? cause.message : String(cause)
          })
          stopPolling()
          return
        }
      }
      pollTimer.current = window.setTimeout(() => void poll(target, token), POLL_INTERVAL_MS)
    },
    [loadPlaylists, refreshAccounts, stopPolling]
  )

  const startQR = useCallback(
    async (next?: AccountPlatform) => {
      const target = next ?? current.current
      current.current = target
      setPlatform(target)
      stopPolling()
      stopped.current = false
      failures.current = 0
      setQR({ status: 'waiting' })
      setQrImage(undefined)
      setPlaylists([])
      try {
        const start = await call('auth:platformQRStart', { platform: target })
        setQR({ status: 'waiting', url: start.url, image: start.image })
        setQrImage(start.image)
        void poll(target, start.token)
      } catch (cause) {
        setQR({ status: 'error', message: cause instanceof Error ? cause.message : String(cause) })
      }
    },
    [poll, stopPolling]
  )

  const selectPlatform = useCallback(
    async (target: AccountPlatform) => {
      current.current = target
      setPlatform(target)
      stopPolling()
      setQR(undefined)
      setQrImage(undefined)
      setPlaylists([])
      const list = await refreshAccounts()
      const entry = list.find((item) => item.platform === target)
      if (target === 'netease') {
        if (!entry?.loggedIn) await startQR('netease')
        return
      }
      if (entry?.loggedIn) {
        await loadPlaylists(target)
        return
      }
      await startQR(target)
    },
    [loadPlaylists, refreshAccounts, startQR, stopPolling]
  )

  const cancelQR = useCallback(() => {
    stopPolling()
    setQR(undefined)
    setQrImage(undefined)
    void call('auth:qrCancel').catch(() => undefined)
  }, [stopPolling])

  const refreshQR = useCallback(async () => {
    await call('auth:qrCancel').catch(() => undefined)
    await startQR()
  }, [startQR])

  const logout = useCallback(async () => {
    stopPolling()
    await call('auth:logout')
    setLoggedIn(false)
    setProfile(undefined)
    setQR(undefined)
    setQrImage(undefined)
  }, [stopPolling])

  const logoutPlatform = useCallback(
    async (target: AccountPlatform) => {
      stopPolling()
      await call('auth:platformLogout', { platform: target }).catch(() => undefined)
      if (target === 'netease') {
        setLoggedIn(false)
        setProfile(undefined)
      }
      setPlaylists([])
      await refreshAccounts()
      await startQR(target)
    },
    [refreshAccounts, startQR, stopPolling]
  )

  const sendSMSCode = useCallback(async (phone: string) => {
    await call('auth:sendSMSCode', { phone })
  }, [])

  const loginWithSMS = useCallback(async (phone: string, captcha: string) => {
    await call('auth:loginCellphone', { phone, captcha })
    const state = await call('auth:state')
    setLoggedIn(state.loggedIn)
    setProfile(state.profile)
  }, [])

  return useMemo(
    () => ({
      loggedIn,
      profile,
      loading,
      qr,
      platform,
      qrImage,
      accounts,
      playlists,
      playlistsLoading,
      startQR,
      selectPlatform,
      cancelQR,
      refreshQR,
      logout,
      logoutPlatform,
      loginWithSMS,
      sendSMSCode
    }),
    [
      loggedIn,
      profile,
      loading,
      qr,
      platform,
      qrImage,
      accounts,
      playlists,
      playlistsLoading,
      startQR,
      selectPlatform,
      cancelQR,
      refreshQR,
      logout,
      logoutPlatform,
      loginWithSMS,
      sendSMSCode
    ]
  )
}
