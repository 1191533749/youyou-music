/**
 * Desktop lyrics window.
 *
 * A frameless, transparent, always-on-top strip that follows playback: the same
 * feature the macOS client calls 桌面歌词. It renders the current line, its
 * translation, and the next line, and drags the window with `-webkit-app-region`
 * so no IPC is needed for movement.
 */
import { useEffect, useMemo, useState } from 'react'
import { call, onEvent } from '../lib/ipc'
import type { LyricsDTO, PlayerStateDTO } from '@shared/types'
import { activeIndexOf } from '../lib/lyricsUtils'

export default function DesktopLyrics(): JSX.Element {
  const [player, setPlayer] = useState<PlayerStateDTO | undefined>()
  const [lyrics, setLyrics] = useState<LyricsDTO | undefined>()
  const [settings, setSettings] = useState<{ fontSize: number; opacity: number }>({
    fontSize: 28,
    opacity: 0.92
  })

  useEffect(() => {
    void call('player:state').then(setPlayer).catch(() => undefined)
    const offPlayer = onEvent('player:state', setPlayer)
    const offSettings = onEvent('settings:changed', (next) =>
      setSettings({ fontSize: next.desktopLyricsFontSize, opacity: next.desktopLyricsOpacity })
    )
    void call('settings:get')
      .then((current) => setSettings({ fontSize: current.desktopLyricsFontSize, opacity: current.desktopLyricsOpacity }))
      .catch(() => undefined)
    return () => {
      offPlayer()
      offSettings()
    }
  }, [])

  const trackID = player?.track?.id
  useEffect(() => {
    if (!trackID) {
      setLyrics(undefined)
      return
    }
    let cancelled = false
    void call('lyrics:get', { trackID })
      .then((result) => {
        if (!cancelled) setLyrics(result)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [trackID])

  const { current, next } = useMemo(() => {
    if (!lyrics || lyrics.empty) return { current: undefined, next: undefined }
    const index = activeIndexOf(lyrics, player?.position ?? 0)
    return {
      current: index >= 0 ? lyrics.lines[index] : lyrics.lines[0],
      next: index >= 0 ? lyrics.lines[index + 1] : lyrics.lines[1]
    }
  }, [lyrics, player?.position])

  return (
    <div
      className="desktop-lyrics"
      style={{ fontSize: settings.fontSize, opacity: settings.opacity }}
      title="拖动可移动 · 右键任务栏图标可关闭"
    >
      <div className="desktop-lyrics__drag">
        <div className="desktop-lyrics__line">
          {current?.text ?? (player?.track ? '…' : 'Kumone 桌面歌词')}
        </div>
        {current?.translation ? (
          <div className="desktop-lyrics__translation" style={{ fontSize: settings.fontSize * 0.62 }}>
            {current.translation}
          </div>
        ) : null}
        {next?.text ? (
          <div className="desktop-lyrics__next" style={{ fontSize: settings.fontSize * 0.55 }}>
            {next.text}
          </div>
        ) : null}
      </div>
    </div>
  )
}
