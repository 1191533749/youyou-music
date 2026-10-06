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
  setRepeat: (mode: RepeatMode) => Promise<void>
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
      setRepeat: (mode) => command('player:setRepeat', { mode }),
      removeAt: (indices) => command('player:removeAt', { indices }),
      clearQueue: () => command('player:clearQueue'),
      setQuality: (quality) => command('player:setQuality', { quality }),
      append: (tracks) => command('player:append', { tracks })
    }),
    [state, command]
  )
}

/**
 * 播放模式：用户只面对**一个**按钮，点击在四种模式之间循环。
 * （用户明确要求不要再出现两个分别管「顺序/随机」和「循环」的按钮。）
 */
export type PlayMode = 'sequential' | 'shuffle' | 'repeatAll' | 'repeatOne'

export const PLAY_MODE_LABELS: Record<PlayMode, string> = {
  sequential: '顺序播放',
  shuffle: '随机播放',
  repeatAll: '循环全部',
  repeatOne: '单曲循环'
}

const PLAY_MODE_ORDER: PlayMode[] = ['sequential', 'shuffle', 'repeatAll', 'repeatOne']

/** 由底层 shuffle/repeat 推出当前展示的播放模式。 */
export function currentPlayMode(shuffle: boolean, repeat: RepeatMode): PlayMode {
  if (shuffle && repeat === 'off') return 'shuffle'
  if (repeat === 'one') return 'repeatOne'
  if (repeat === 'all') return 'repeatAll'
  // shuffle + all/one 的组合在界面上不单列，按循环优先展示
  return 'sequential'
}

export function nextPlayMode(mode: PlayMode): PlayMode {
  const index = PLAY_MODE_ORDER.indexOf(mode)
  return PLAY_MODE_ORDER[(index + 1) % PLAY_MODE_ORDER.length]
}

export function playModeLabel(shuffle: boolean, repeat: RepeatMode): string {
  return PLAY_MODE_LABELS[currentPlayMode(shuffle, repeat)]
}

/** 应用某个播放模式（内部仍落到 shuffle / repeat 两个开关上）。 */
export async function applyPlayMode(store: PlayerStore, mode: PlayMode): Promise<void> {
  switch (mode) {
    case 'shuffle':
      await store.setRepeat('off')
      await store.setShuffle(true)
      return
    case 'repeatAll':
      await store.setShuffle(false)
      await store.setRepeat('all')
      return
    case 'repeatOne':
      await store.setShuffle(false)
      await store.setRepeat('one')
      return
    default:
      await store.setShuffle(false)
      await store.setRepeat('off')
  }
}

/** 点击唯一那个模式按钮：切到下一种模式。 */
export async function cyclePlayMode(store: PlayerStore, shuffle: boolean, repeat: RepeatMode): Promise<void> {
  await applyPlayMode(store, nextPlayMode(currentPlayMode(shuffle, repeat)))
}

/**
 * 循环模式的显示名。
 * 注意不要用「顺序播放」——那是随机开关的关闭态文案，
 * 两个按钮都写「顺序播放」会让用户以为有两个重复的按钮（用户已反馈过）。
 */
export function repeatLabel(mode: RepeatMode): string {
  switch (mode) {
    case 'off':
      return '不循环'
    case 'all':
      return '循环全部'
    case 'one':
      return '单曲循环'
  }
}
