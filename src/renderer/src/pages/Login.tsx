/**
 * 登录页：只有网易云扫码。
 *
 * 其它平台（QQ音乐）不再占用登录页——它们只在「设置 → 音源账号」里按需绑定，
 * 主账号始终是网易云，两者互不影响（见 components/SourceAccount.tsx）。
 *
 * 手机号（短信）登录已按用户要求移除：该通道受网易云风控限制，几乎必然失败。
 * 二维码由主进程准备：网易云给的是要编码的地址，主进程编码成矩阵，渲染进程只负责显示。
 */
import { useEffect, useState } from 'react'
import { useAuthStore } from '../store/auth'
import { call } from '../lib/ipc'
import { LogoMark } from '../components/Icons'
import type { QRLoginStateDTO } from '@shared/types'

interface QRMatrix {
  size: number
  modules: boolean[][]
}

const SCAN_HINT = '打开网易云音乐 App，扫一扫登录'

export default function Login(): JSX.Element {
  const auth = useAuthStore()
  const [matrix, setMatrix] = useState<QRMatrix | undefined>()
  const [qrError, setQrError] = useState<string | undefined>()

  useEffect(() => {
    void auth.startQR('netease')
    return () => auth.cancelQR()
    // 仅在挂载时发起一次握手；轮询与取消由 store 内部管理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 登录地址 → 二维码矩阵。编码放在主进程：那里既是可信侧，也是生成地址的地方。
  useEffect(() => {
    const url = auth.qr?.url
    if (!url) {
      setMatrix(undefined)
      return
    }
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

  const status = describeStatus(auth.qr)
  const needsRefresh = auth.qr?.status === 'expired' || auth.qr?.status === 'error'

  return (
    <div className="login">
      <div className="login__card glass">
        <div className="login__brand">
          <LogoMark size={58} />
          <h1>悠悠音乐</h1>
          <p>小鱼の音乐</p>
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
            <p className="login__hint">{SCAN_HINT}</p>
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
