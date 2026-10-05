/**
 * Player store.
 *
 * The main process owns playback state; the renderer mirrors it. Every command
 * returns the authoritative snapshot, and push events keep it fresh while the
 * user is elsewhere in the app.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { call, onEvent } from '../lib/ipc'
import type { PlayerStateDTO, RepeatMode, TrackDTO } from '@shared/types'

const EMPTY_STATE: PlayerStateDTO = {
  queue: [],
  index: -1,
  playing: false,
  position: 0,
  duration: 0,
  volume: 80,
  muted: false,
  loading: false,
  repeat: 'off',
  shuffle: false,
  quality: 'exhigh'
}

export interface PlayerStore {
  state: PlayerStateDTO
  current?: TrackDTO
  /** Queues `tracks` and starts at `startIndex`. */
  playTracks: (
    tracks: TrackDTO[],
    startIndex?: number,
    options?: { randomStart?: boolean }
  ) => Promise<void>
  toggle: () => Promise<void>
  play: () => Promise<void>
  pause: () => Promise<void>
  next: () => Promise<void>
  previous: () => Promise<void>
  seek: (seconds: number) => Promise<void>
  setVolume: (volume: number) => Promise<void>
  setMuted: (muted: boolean) => Promise<void>
  cycleRepeat: () => Promise<void>
  setShuffle: (shuffle: boolean) => Promise<void>
  removeAt: (indices: number[]) => Promise<void>
  clearQueue: () => Promise<void>
  setQuality: (quality: string) => Promise<void>
  append: (tracks: TrackDTO[]) => Promise<void>
}

export function usePlayerStore(): PlayerStore {
  const [state, setState] = useState<PlayerStateDTO>(EMPTY_STATE)

  useEffect(() => {
    void call('player:state').then(setState).catch(() => undefined)
    return onEvent('player:state', setState)
  }, [])

  const command = useCallback(async (channel: Parameters<typeof call>[0], request?: unknown) => {
    const next = (await call(channel as never, request as never)) as PlayerStateDTO
    setState(next)
  }, [])

  return useMemo<PlayerStore>(
    () => ({
      state,
      current: state.track,
      playTracks: async (tracks, startIndex = 0, options) => {
        await command('player:playTracks', {
          tracks,
          startIndex,
          randomStart: options?.randomStart === true
        })
      },
      toggle: () => command('player:toggle'),
      play: () => command('player:play'),
      pause: () => command('player:pause'),
      next: () => command('player:next'),
      previous: () => command('player:previous'),
      seek: (seconds) => command('player:seek', { seconds }),
      setVolume: (volume) => command('player:setVolume', { volume }),
      setMuted: (muted) => command('player:setMuted', { muted }),
      cycleRepeat: () => command('player:cycleRepeat'),
      setShuffle: (shuffle) => command('player:setShuffle', { shuffle }),
      removeAt: (indices) => command('player:removeAt', { indices }),
      clearQueue: () => command('player:clearQueue'),
      setQuality: (quality) => command('player:setQuality', { quality }),
      append: (tracks) => command('player:append', { tracks })
    }),
    [state, command]
  )
}

export function repeatLabel(mode: RepeatMode): string {
  switch (mode) {
    case 'off':
      return '顺序播放'
    case 'all':
      return '列表循环'
    case 'one':
      return '单曲循环'
  }
}
