/**
 * 登录页：扫码优先，手机号登录作为次要路径（与 macOS 版一致）。
 *
 * 二维码由主进程编码，渲染进程只负责把矩阵画成方块。轮询的状态机
 * （800 过期 / 801 等待 / 802 已扫码 / 803 成功）在 auth store 里，
 * 这里只负责呈现与重试。
 */
import { useEffect, useMemo, useState } from 'react'
import { useAuthStore } from '../store/auth'
import { call } from '../lib/ipc'
import { LogoMark } from '../components/Icons'
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
    // 仅在挂载时发起一次握手；轮询与取消由 store 内部管理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 登录地址 → 二维码矩阵。编码放在主进程：那里既是可信侧，也是生成地址的地方。
  useEffect(() => {
    const url = auth.qr?.url
    if (!url) return
    let cancelled = false
    setQrError(undefined)
    void call('app:qrMatrix', { url })
      .then((result) => {
        if (!cancelled) setMatrix(result)
      })
      .catch((cause) => {
        if (!cancelled) setQrError(cause instanceof Error ? cause.message : String(cause))
      })
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
  const needsRefresh = auth.qr?.status === 'expired' || auth.qr?.status === 'error'

  const sendCode = async (): Promise<void> => {
    setBusy(true)
    setMessage(undefined)
    try {
      await auth.sendSMSCode(phone)
      setCountdown(60)
      setMessage('验证码已发送')
    } catch (cause) {
      setMessage(describeLoginError(cause))
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
      setMessage(describeLoginError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <div className="login__card glass">
        <div className="login__brand">
          <LogoMark size={58} />
          <h1>悠悠音乐</h1>
          <p>小鱼の音乐 · 登录网易云音乐账号</p>
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
            {needsRefresh ? (
              <button type="button" className="button button--primary" onClick={() => void auth.refreshQR()}>
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
            <p className="login__hint">短信登录受网易云风控限制，失败时请改用扫码登录。</p>
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

/**
 * 把接口错误翻译成用户能据以行动的话。未识别的错误原样抛出，
 * 因为接口自己的中文提示（例如「验证码错误」）比任何兜底文案都准确。
 */
function describeLoginError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  if (raw.includes('限流')) {
    return `${raw}；若持续失败，请改用扫码登录。`
  }
  return raw
}
