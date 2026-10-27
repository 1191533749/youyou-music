/**
 * 登录页：邮箱验证码（我们自己的账号）。
 *
 * 为什么不再用网易云扫码：站外曲目没有网易云 id，收藏只能往网易云歌单里塞 id，
 * 天然收不了。自建账号后收藏与歌单都落在我们服务器上，任何音源的歌都能收。
 *
 * 两步：填邮箱 → 收 6 位验证码 → 登录。验证码 10 分钟有效，
 * 登录令牌由服务器签发并在本地加密保存（升级不会掉登录）。
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigation } from '../store/navigation'
import { useAccountStore } from '../store/account'
import { LogoMark } from '../components/Icons'

const EMAIL_KEY = 'youyou.login.email'

export default function Login(): JSX.Element {
  const navigation = useNavigation()
  const account = useAccountStore()

  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState(() => localStorage.getItem(EMAIL_KEY) ?? '')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>()
  const [countdown, setCountdown] = useState(0)
  const codeInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (countdown <= 0) return
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [countdown])

  useEffect(() => {
    if (step === 'code') codeInput.current?.focus()
  }, [step])

  useEffect(() => {
    if (!account.error) return
    setMessage(account.error)
    setBusy(false)
  }, [account.error])

  const emailLooksValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())

  async function sendCode(event?: FormEvent): Promise<void> {
    event?.preventDefault()
    if (!emailLooksValid || busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      await account.requestCode(email.trim())
      localStorage.setItem(EMAIL_KEY, email.trim())
      setStep('code')
      setCountdown(60)
      setMessage('验证码已发送')
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function submitCode(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy || code.trim().length < 6) return
    setBusy(true)
    setMessage(undefined)
    try {
      await account.verify(email.trim(), code.trim())
      navigation.reset({ name: 'library' })
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <div className="login__panel">
        <div className="login__head">
          <LogoMark size={26} />
          <span className="login__brand">悠悠音乐</span>
        </div>

        {step === 'email' ? (
          <form className="login__form" onSubmit={(event) => void sendCode(event)}>
            <h1 className="login__title">登录</h1>
            <label className="login__field">
              <span>邮箱</span>
              <input
                type="email"
                value={email}
                autoFocus
                spellCheck={false}
                placeholder="name@example.com"
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className="login__submit"
              disabled={!emailLooksValid || busy}
            >
              {busy ? '发送中' : '获取验证码'}
            </button>
          </form>
        ) : (
          <form className="login__form" onSubmit={(event) => void submitCode(event)}>
            <h1 className="login__title">验证码</h1>
            <p className="login__mail">{email.trim()}</p>
            <label className="login__field">
              <span>6 位验证码</span>
              <input
                ref={codeInput}
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                onChange={(event) => setCode(event.target.value.replace(/\D+/g, '').slice(0, 6))}
              />
            </label>
            <button type="submit" className="login__submit" disabled={code.trim().length < 6 || busy}>
              {busy ? '登录中' : '登录'}
            </button>
            <div className="login__links">
              <button
                type="button"
                className="login__link"
                onClick={() => void sendCode()}
                disabled={countdown > 0 || busy}
              >
                {countdown > 0 ? `${countdown} 秒后可重发` : '重新发送'}
              </button>
              <button
                type="button"
                className="login__link"
                onClick={() => {
                  setStep('email')
                  setCode('')
                  setMessage(undefined)
                }}
              >
                更换邮箱
              </button>
            </div>
          </form>
        )}

        {message ? <p className="login__note">{message}</p> : null}
      </div>
    </div>
  )
}
