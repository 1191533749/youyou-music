/**
 * Auth store: login state, the QR handshake and the profile.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { call, onEvent } from '../lib/ipc'
import type { QRLoginStateDTO, UserProfileDTO } from '@shared/types'

export interface AuthStore {
  loggedIn: boolean
  profile?: UserProfileDTO
  loading: boolean
  qr?: QRLoginStateDTO
  /** Starts a QR login and begins polling until it resolves. */
  startQR: () => Promise<void>
  cancelQR: () => void
  refreshQR: () => Promise<void>
  logout: () => Promise<void>
  loginWithSMS: (phone: string, captcha: string) => Promise<void>
  sendSMSCode: (phone: string) => Promise<void>
}

const POLL_INTERVAL_MS = 1800

export function useAuthStore(): AuthStore {
  const [loggedIn, setLoggedIn] = useState(false)
  const [profile, setProfile] = useState<UserProfileDTO | undefined>()
  const [loading, setLoading] = useState(true)
  const [qr, setQR] = useState<QRLoginStateDTO | undefined>()
  const pollTimer = useRef<number | undefined>(undefined)
  const stopped = useRef(true)

  const stopPolling = useCallback(() => {
    stopped.current = true
    if (pollTimer.current !== undefined) {
      window.clearTimeout(pollTimer.current)
      pollTimer.current = undefined
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
    const off = onEvent('auth:changed', (payload) => {
      setLoggedIn(payload.loggedIn)
      if (payload.profile) setProfile(payload.profile)
      if (!payload.loggedIn) setProfile(undefined)
    })
    return () => {
      off()
      stopPolling()
    }
  }, [stopPolling])

  const poll = useCallback(
    async (unikey: string) => {
      if (stopped.current) return
      try {
        const state = await call('auth:qrPoll', { unikey })
        setQR(state)
        if (state.status === 'confirmed') {
          stopPolling()
          setLoggedIn(true)
          if (state.profile) setProfile(state.profile)
          else {
            const fresh = await call('auth:profile').catch(() => undefined)
            if (fresh) setProfile(fresh)
          }
          return
        }
        if (state.status === 'expired' || state.status === 'error') {
          stopPolling()
          return
        }
      } catch (cause) {
        setQR({
          status: 'error',
          message: cause instanceof Error ? cause.message : String(cause)
        })
        stopPolling()
        return
      }
      pollTimer.current = window.setTimeout(() => void poll(unikey), POLL_INTERVAL_MS)
    },
    [stopPolling]
  )

  const startQR = useCallback(async () => {
    stopPolling()
    stopped.current = false
    setQR({ status: 'waiting' })
    try {
      const state = await call('auth:qrStart')
      setQR(state)
      if (state.unikey) void poll(state.unikey)
    } catch (cause) {
      setQR({ status: 'error', message: cause instanceof Error ? cause.message : String(cause) })
    }
  }, [poll, stopPolling])

  const cancelQR = useCallback(() => {
    stopPolling()
    setQR(undefined)
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
  }, [stopPolling])

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
    () => ({ loggedIn, profile, loading, qr, startQR, cancelQR, refreshQR, logout, loginWithSMS, sendSMSCode }),
    [loggedIn, profile, loading, qr, startQR, cancelQR, refreshQR, logout, loginWithSMS, sendSMSCode]
  )
}
