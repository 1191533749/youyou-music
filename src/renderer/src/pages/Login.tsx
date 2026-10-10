/**
 * 登录页：默认是网易云的扫码二维码，下面三个平台图标（网易云 / 酷狗 / QQ音乐），
 * 点哪个就用哪个平台登录。已登录的平台展示该账号与它的歌单。
 *
 * 手机号（短信）登录已按用户要求移除：该通道受网易云风控限制，几乎必然失败。
 * 二维码由主进程准备——网易云给的是要编码的地址（主进程编码成矩阵），
 * 酷狗与 QQ 直接给二维码图片，渲染进程只负责显示。
 */
import { useEffect, useMemo, useState } from 'react'
import { useAuthStore } from '../store/auth'
import { call } from '../lib/ipc'
import { LogoMark } from '../components/Icons'
import { IconPlatformKugou, IconPlatformNetease, IconPlatformQq } from '../components/PlatformIcons'
import { ACCOUNT_PLATFORMS } from '@shared/types'
import type { AccountPlatform, QRLoginStateDTO } from '@shared/types'

interface QRMatrix {
  size: number
  modules: boolean[][]
}

const PLATFORM_LABEL: Record<AccountPlatform, string> = {
  netease: '网易云音乐',
  kugou: '酷狗音乐',
  qq: 'QQ音乐'
}

const PLATFORM_ICON: Record<AccountPlatform, (props: { size?: number }) => JSX.Element> = {
  netease: IconPlatformNetease,
  kugou: IconPlatformKugou,
  qq: IconPlatformQq
}

const SCAN_HINT: Record<AccountPlatform, string> = {
  netease: '打开网易云音乐 App，扫一扫登录',
  kugou: '打开酷狗音乐 App，扫一扫登录',
  qq: '打开手机 QQ 或 QQ音乐 App，扫一扫登录'
}

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

  const account = useMemo(
    () => auth.accounts.find((item) => item.platform === auth.platform),
    [auth.accounts, auth.platform]
  )
  const status = useMemo(() => describeStatus(auth.qr, auth.platform), [auth.qr, auth.platform])
  const needsRefresh = auth.qr?.status === 'expired' || auth.qr?.status === 'error'
  const showAccount = auth.platform !== 'netease' && Boolean(account?.loggedIn)

  return (
    <div className="login">
      <div className="login__card glass">
        <div className="login__brand">
          <LogoMark size={58} />
          <h1>悠悠音乐</h1>
          <p>小鱼の音乐</p>
        </div>

        {showAccount ? (
          <div className="login__account">
            <div className="login__account-head">
              {account?.avatarUrl ? (
                <img className="login__account-avatar" src={account.avatarUrl} alt="" />
              ) : (
                <span className="login__account-avatar login__account-avatar--empty" />
              )}
              <div className="login__account-meta">
                <strong>{account?.nickname ?? PLATFORM_LABEL[auth.platform]}</strong>
                <span>{PLATFORM_LABEL[auth.platform]}</span>
              </div>
              <button
                type="button"
                className="button"
                onClick={() => void auth.logoutPlatform(auth.platform)}
              >
                退出登录
              </button>
            </div>

            <div className="login__playlists">
              {auth.playlists.map((item) => (
                <div key={item.id} className="login__playlist">
                  {item.coverUrl ? (
                    <img className="login__playlist-cover" src={item.coverUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="login__playlist-cover login__playlist-cover--empty" />
                  )}
                  <span className="login__playlist-name">{item.name}</span>
                  <span className="login__playlist-count">{item.trackCount}</span>
                </div>
              ))}
              {!auth.playlistsLoading && auth.playlists.length === 0 ? (
                <p className="login__playlists-empty">这个账号还没有歌单</p>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="login__qr">
            <div className="login__qr-frame">
              {auth.qrImage ? (
                <img className="login__qr-image" src={auth.qrImage} alt="登录二维码" />
              ) : matrix ? (
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
              <p className="login__hint">{SCAN_HINT[auth.platform]}</p>
            )}
          </div>
        )}

        <div className="login__platforms">
          {ACCOUNT_PLATFORMS.map((item) => {
            const Icon = PLATFORM_ICON[item]
            const entry = auth.accounts.find((candidate) => candidate.platform === item)
            return (
              <button
                key={item}
                type="button"
                className={`login__platform${auth.platform === item ? ' login__platform--active' : ''}`}
                title={PLATFORM_LABEL[item]}
                aria-label={PLATFORM_LABEL[item]}
                onClick={() => void auth.selectPlatform(item)}
              >
                <Icon size={22} />
                {entry?.loggedIn ? <span className="login__platform-dot" /> : null}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function describeStatus(state: QRLoginStateDTO | undefined, platform: AccountPlatform): string {
  if (!state) return '正在获取二维码…'
  switch (state.status) {
    case 'waiting':
      return `请使用${PLATFORM_LABEL[platform]} App 扫码`
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
