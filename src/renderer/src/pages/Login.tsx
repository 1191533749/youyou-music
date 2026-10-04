/**
 * Login screen.
 *
 * QR first (scan with the phone app), with phone + SMS as the secondary path —
 * the same two options the macOS client offers.
 */
import { useEffect, useMemo, useState } from 'react'
import { useAuthStore } from '../store/auth'
import { call } from '../lib/ipc'
import type { QRLoginStateDTO } from '@shared/types'

interface QRMatrix {
  size: number
  modules: boolean[][]
}

export default function Login(): JSX.Element {
  const auth = useAuthStore()
  const [matrix, setMatrix] = useState<QRMatrix | undefined>()
  const [qrError, setQrError] = useState<string | undefined>()
  const [mode, setMode] = useState<'qr' | 'phone'>('qr')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>()
  const [countdown, setCountdown] = useState(0)

  useEffect(() => {
    void auth.startQR()
    return () => auth.cancelQR()
    // The QR handshake should start exactly once when the screen mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The main process encodes the QR; the renderer only draws the matrix. The
  // encoder lives there because it is the same trusted side that builds the
  // login URL.
  useEffect(() => {
    const url = auth.qr?.url
    if (!url) return
    let cancelled = false
    void call('app:info') // warm the bridge; no data needed
      .catch(() => undefined)
      .then(() => {
        if (cancelled) return
        // The matrix comes from a dedicated channel so the URL never has to be
        // parsed in the renderer.
        return window.kumone
          .invoke('app:qrMatrix', { url })
          .then((result: { ok: boolean; data?: unknown }) => {
            if (cancelled || !result.ok) return
            setMatrix(result.data as QRMatrix)
          })
      })
      .catch((cause) => setQrError(String(cause)))
    return () => {
      cancelled = true
    }
  }, [auth.qr?.url])

  useEffect(() => {
    if (countdown <= 0) return
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [countdown])

  const status = useMemo(() => describeStatus(auth.qr), [auth.qr])

  const sendCode = async (): Promise<void> => {
    setBusy(true)
    setMessage(undefined)
    try {
      await auth.sendSMSCode(phone)
      setCountdown(60)
      setMessage('验证码已发送')
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const submitPhone = async (): Promise<void> => {
    setBusy(true)
    setMessage(undefined)
    try {
      await auth.loginWithSMS(phone, code)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__brand">
          <span className="login__mark">雲</span>
          <h1>Kumone</h1>
          <p>登录网易云音乐账号</p>
        </div>

        <div className="login__tabs">
          <button type="button" className={mode === 'qr' ? 'is-active' : ''} onClick={() => setMode('qr')}>
            扫码登录
          </button>
          <button type="button" className={mode === 'phone' ? 'is-active' : ''} onClick={() => setMode('phone')}>
            手机号登录
          </button>
        </div>

        {mode === 'qr' ? (
          <div className="login__qr">
            <div className="login__qr-frame">
              {matrix ? (
                <div
                  className="qr-grid"
                  style={{ gridTemplateColumns: `repeat(${matrix.size}, 1fr)` }}
                  aria-label="登录二维码"
                >
                  {matrix.modules.flatMap((row, rowIndex) =>
                    row.map((dark, colIndex) => (
                      <span key={`${rowIndex}-${colIndex}`} className={dark ? 'qr-grid__on' : 'qr-grid__off'} />
                    ))
                  )}
                </div>
              ) : (
                <div className="login__qr-placeholder">{qrError ?? '正在获取二维码…'}</div>
              )}
            </div>
            <p className={`login__status login__status--${auth.qr?.status ?? 'waiting'}`}>{status}</p>
            {auth.qr?.status === 'expired' || auth.qr?.status === 'error' ? (
              <button type="button" className="button" onClick={() => void auth.refreshQR()}>
                刷新二维码
              </button>
            ) : (
              <p className="login__hint">打开网易云音乐 App，扫一扫登录</p>
            )}
          </div>
        ) : (
          <div className="login__phone">
            <label>
              手机号
              <input
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="请输入手机号"
              />
            </label>
            <label>
              验证码
              <div className="login__code-row">
                <input
                  type="text"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="短信验证码"
                />
                <button
                  type="button"
                  className="button"
                  disabled={busy || countdown > 0 || phone.length < 5}
                  onClick={() => void sendCode()}
                >
                  {countdown > 0 ? `${countdown}s` : '获取验证码'}
                </button>
              </div>
            </label>
            <button
              type="button"
              className="button button--primary"
              disabled={busy || phone.length < 5 || code.length < 3}
              onClick={() => void submitPhone()}
            >
              登录
            </button>
            <p className="login__hint">
              短信登录接口由网易云限制，失败时可优先使用扫码登录。
            </p>
          </div>
        )}

        {message ? <p className="login__message">{message}</p> : null}
      </div>
    </div>
  )
}

function describeStatus(state: QRLoginStateDTO | undefined): string {
  if (!state) return '正在获取二维码…'
  switch (state.status) {
    case 'waiting':
      return '请使用网易云音乐 App 扫码'
    case 'scanned':
      return state.message ?? '已扫码，请在手机上确认'
    case 'confirmed':
      return `登录成功${state.nickname ? `，欢迎 ${state.nickname}` : ''}`
    case 'expired':
      return state.message ?? '二维码已过期'
    case 'error':
      return state.message ?? '扫码失败'
  }
}
