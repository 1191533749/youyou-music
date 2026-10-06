/**
 * 登录页：只保留网易云扫码登录（默认也是唯一方式）。
 *
 * 手机号（短信）登录已按用户要求移除：该通道受网易云风控限制，几乎必然失败。
 * 微信/QQ 扫码登录需要「微信开放平台 / QQ 互联」的 AppID 与 AppSecret（并在平台
 * 后台配置回调域名），没有凭证无法实现——拿到凭证后在此追加按钮即可。
 *
 * 二维码由主进程编码，渲染进程只负责把矩阵画成方块。轮询的状态机
 * （800 过期 / 801 等待 / 802 已扫码 / 803 成功）在 auth store 里。
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

  const status = useMemo(() => describeStatus(auth.qr), [auth.qr])
  const needsRefresh = auth.qr?.status === 'expired' || auth.qr?.status === 'error'

  return (
    <div className="login">
      <div className="login__card glass">
        <div className="login__brand">
          <LogoMark size={58} />
          <h1>悠悠音乐</h1>
          <p>小鱼の音乐 · 登录网易云音乐账号</p>
        </div>

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
