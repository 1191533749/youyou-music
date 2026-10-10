/**
 * 设置 → 音源账号（QQ音乐）。
 *
 * 主账号始终是网易云：这里只给「想用 QQ音乐 会员权益」的用户一个按需绑定的入口，
 * 登录页不再出现第二个平台。绑一次会把该账号的 cookie 存进 `<userData>/accounts.json`，
 * QQ 音源取地址时带上它——VIP/付费歌才拿得到地址，音质档位跟着设置里的音质走
 * （选到 320kbps 及以上请求 M800，否则 M500）；不绑定就只覆盖免费歌，其余仍由
 * 汽水 / 酷狗 / 酷我兜底。
 */
import { useCallback, useEffect, useState } from 'react'
import { call } from '../lib/ipc'
import { useAuthStore } from '../store/auth'
import { IconPlatformQq } from './PlatformIcons'
import type { ExternalTrackDTO, PlatformPlaylistDTO } from '@shared/types'

export default function SourceAccount(): JSX.Element {
  const auth = useAuthStore()
  const [binding, setBinding] = useState(false)
  const [playlists, setPlaylists] = useState<PlatformPlaylistDTO[]>([])
  const [playlistsLoading, setPlaylistsLoading] = useState(false)
  const [openedId, setOpenedId] = useState<string | undefined>()
  const [tracks, setTracks] = useState<ExternalTrackDTO[]>([])
  const [tracksLoading, setTracksLoading] = useState(false)

  const qq = auth.accounts.find((item) => item.platform === 'qq')
  const bound = Boolean(qq?.loggedIn)
  const status = auth.qr?.status

  // 扫码成功（账号已绑定）后收起二维码；离开设置页时停掉轮询。
  useEffect(() => {
    if (binding && bound) setBinding(false)
  }, [binding, bound])

  useEffect(() => {
    if (!binding) return
    return () => auth.cancelQR()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binding])

  // 已绑定就把歌单取回来（主进程带 cookie 请求）。
  useEffect(() => {
    if (!bound) {
      setPlaylists([])
      setOpenedId(undefined)
      setTracks([])
      return
    }
    let cancelled = false
    setPlaylistsLoading(true)
    void call('auth:platformPlaylists', { platform: 'qq' })
      .then((list) => {
        if (!cancelled) setPlaylists(list)
      })
      .catch(() => {
        if (!cancelled) setPlaylists([])
      })
      .finally(() => {
        if (!cancelled) setPlaylistsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [bound])

  const togglePlaylist = useCallback(
    async (playlist: PlatformPlaylistDTO): Promise<void> => {
      if (openedId === playlist.id) {
        setOpenedId(undefined)
        setTracks([])
        return
      }
      setOpenedId(playlist.id)
      setTracks([])
      setTracksLoading(true)
      try {
        setTracks(await call('auth:platformPlaylistTracks', { platform: 'qq', id: playlist.id }))
      } catch {
        setTracks([])
      } finally {
        setTracksLoading(false)
      }
    },
    [openedId]
  )

  const play = useCallback(
    (startIndex = 0): void => {
      if (tracks.length === 0) return
      void call('player:playExternalList', { items: tracks, startIndex }).catch(() => undefined)
    },
    [tracks]
  )

  return (
    <>
      <div className="settings__row">
        <div className="settings__row-label">
          <span className="source-account-title">
            <IconPlatformQq size={18} />
            QQ音乐
          </span>
          <span className="settings__row-hint">
            {bound ? (qq?.nickname ?? '已绑定') : '未绑定'}
          </span>
        </div>
        <div className="settings__row-control">
          {bound ? (
            <button
              type="button"
              className="button"
              onClick={() => void auth.unbindPlatform('qq')}
            >
              解绑
            </button>
          ) : (
            <button
              type="button"
              className="button glass-btn"
              disabled={binding}
              onClick={() => {
                setBinding(true)
                void auth.startQR('qq')
              }}
            >
              扫码绑定
            </button>
          )}
        </div>
      </div>
      <p className="source-note">如有会员可登录</p>

      {binding && !bound ? (
        <div className="source-bind">
          <div className="login__qr-frame">
            {auth.qrImage ? (
              <img className="login__qr-image" src={auth.qrImage} alt="绑定二维码" />
            ) : (
              <div className="login__qr-placeholder">正在获取二维码…</div>
            )}
          </div>
          <p className="login__status">{bindStatus(status)}</p>
          {status === 'expired' || status === 'error' ? (
            <button type="button" className="button button--primary" onClick={() => void auth.refreshQR()}>
              刷新二维码
            </button>
          ) : null}
        </div>
      ) : null}

      {bound ? (
        <div className="source-playlists">
          {playlists.map((item) => {
            const opened = openedId === item.id
            return (
              <div key={item.id} className="source-playlist-group">
                <button
                  type="button"
                  className={`source-playlist${opened ? ' source-playlist--active' : ''}`}
                  aria-expanded={opened}
                  onClick={() => void togglePlaylist(item)}
                >
                  {item.coverUrl ? (
                    <img className="source-playlist-cover" src={item.coverUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="source-playlist-cover source-playlist-cover--empty" />
                  )}
                  <span className="source-playlist-name">{item.name}</span>
                  <span className="source-playlist-count">{item.trackCount}</span>
                </button>

                {opened ? (
                  <div className="source-tracks">
                    {tracks.length > 0 ? (
                      <div className="source-tracks-bar">
                        <button type="button" className="button button--small" onClick={() => play(0)}>
                          播放全部
                        </button>
                      </div>
                    ) : null}
                    <ul className="source-track-list">
                      {tracksLoading
                        ? [0, 1, 2].map((row) => (
                            <li key={row} className="source-track source-track--skeleton" />
                          ))
                        : tracks.map((track, index) => (
                            <li key={track.sourceId}>
                              <button type="button" className="source-track" onClick={() => play(index)}>
                                <span className="source-track-index">{index + 1}</span>
                                <span className="source-track-name">{track.name}</span>
                                <span className="source-track-artist">{track.artists}</span>
                              </button>
                            </li>
                          ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            )
          })}
          {!playlistsLoading && playlists.length === 0 ? (
            <p className="source-playlists-empty">这个账号还没有歌单</p>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

function bindStatus(status: string | undefined): string {
  switch (status) {
    case 'waiting':
      return '请使用 QQ 扫码'
    case 'scanned':
      return '已扫码，请在手机上确认'
    case 'confirmed':
      return '绑定成功'
    case 'expired':
      return '二维码已过期'
    case 'error':
      return '绑定失败，请重试'
    default:
      return '正在获取二维码…'
  }
}
