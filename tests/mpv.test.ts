/**
 * mpv backend integration test.
 *
 * Runs the real `mpv.exe` over its JSON IPC named pipe and plays a real audio
 * file, because the risky part of this integration is exactly the part a unit
 * test cannot cover: whether Windows named pipes work with `net.connect`, and
 * whether observed properties arrive in the shape the controller expects.
 *
 * Skipped with a clear message when mpv or the fixture is missing, so the suite
 * still runs on a clean checkout.
 */
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MpvController, resolveMpvBinary } from '../src/main/audio/mpv.js'
import type { MpvState } from '../src/main/audio/mpv.js'

const MPV = resolveMpvBinary()
const FIXTURE = path.resolve(
  process.env.YOYOU_FIXTURE ?? path.join(process.cwd(), 'tests', 'fixtures', 'offline.flac')
)
const RUNNABLE = !!MPV && existsSync(FIXTURE)

describe.skipIf(!RUNNABLE)('mpv backend', () => {
  let mpv: MpvController
  const states: MpvState[] = []

  beforeAll(async () => {
    mpv = new MpvController({
      binary: MPV!,
      onState: (state) => states.push(state),
      onLog: () => undefined
    })
    await mpv.start()
  })

  afterAll(async () => {
    await mpv?.stop()
  })

  it('resolves a bundled mpv binary', () => {
    expect(MPV).toBeTruthy()
    expect(existsSync(MPV!)).toBe(true)
  })

  it('reports the audio devices mpv can output to', async () => {
    const devices = await mpv.listAudioDevices()
    expect(devices.length).toBeGreaterThan(0)
    expect(devices[0]).toBe('auto')
  })

  it('plays a local file and advances the position', async () => {
    await mpv.play(FIXTURE, 0)
    await waitFor(() => mpv.currentState.position > 0.5, 15_000)
    const state = mpv.currentState
    expect(state.running).toBe(true)
    expect(state.position).toBeGreaterThan(0.5)
    expect(state.duration).toBeGreaterThan(1)
    expect(state.paused).toBe(false)
  }, 30_000)

  it('pauses, seeks and resumes', async () => {
    await mpv.setPaused(true)
    await waitFor(() => mpv.currentState.paused, 3000)
    expect(mpv.currentState.paused).toBe(true)

    // A relative seek, so the assertion does not depend on the fixture length.
    const before = mpv.currentState.position
    await mpv.seek(before + 1)
    await waitFor(() => mpv.currentState.position > before + 0.5, 5000)
    expect(mpv.currentState.position).toBeGreaterThan(before + 0.5)

    await mpv.setPaused(false)
    await waitFor(() => !mpv.currentState.paused, 3000)
    expect(mpv.currentState.paused).toBe(false)
  }, 30_000)

  it('applies volume and mute', async () => {
    await mpv.setVolume(42)
    await waitFor(() => Math.abs(mpv.currentState.volume - 42) < 0.6, 3000)
    expect(Math.round(mpv.currentState.volume)).toBe(42)

    await mpv.setMuted(true)
    await waitFor(() => mpv.currentState.muted, 3000)
    expect(mpv.currentState.muted).toBe(true)
    await mpv.setMuted(false)
  }, 20_000)

  it('reports the decoded audio format', async () => {
    const info = await mpv.trackInfo()
    expect(info.duration).toBeGreaterThan(1)
    expect(info.audioCodec?.toLowerCase()).toContain('flac')
    expect(info.audioSampleRate).toBeGreaterThan(8000)
  }, 20_000)

  it('stops cleanly', async () => {
    await mpv.unload()
    expect(mpv.currentState.path).toBe('')
  }, 20_000)
})

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`等待条件超时 (${timeoutMs}ms)`)
}
