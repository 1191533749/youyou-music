/**
 * 网易云音频 CDN 的镜像主机容错（移植自上游 kumone 的 NeteaseCDNHost）：
 * 同一份音频在 `mN.music.126.net` / `mNc.music.126.net` 上都可取，签名在路径
 * 里、不绑主机，于是「这台主机连不上」可以通过换镜像救回来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  alternateNeteaseCDN,
  noteNeteaseCDNHostFailed,
  noteNeteaseCDNHostReachable,
  preferredNeteaseCDN,
  resetNeteaseCDNHosts
} from '../src/main/player/cdnHost.js'

const AUDIO = 'https://m801.music.126.net/20261011/abc123/xyz.mp3?authSecret=deadbeef&vuuid=1'
const TWIN = 'https://m801c.music.126.net/20261011/abc123/xyz.mp3?authSecret=deadbeef&vuuid=1'

beforeEach(() => {
  resetNeteaseCDNHosts()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-11T10:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('网易云 CDN 镜像主机容错', () => {
  it('识别成对主机并只换主机名（路径里的签名与查询串原样保留）', () => {
    expect(alternateNeteaseCDN(AUDIO)).toBe(TWIN)
    expect(alternateNeteaseCDN(TWIN)).toBe(AUDIO)
  })

  it('不是网易云音频 CDN 的地址不动它', () => {
    expect(alternateNeteaseCDN('https://trackercdn.kugou.com/i/v2/?key=x')).toBeUndefined()
    expect(alternateNeteaseCDN('https://m801.music.163.com/a.mp3')).toBeUndefined()
    expect(alternateNeteaseCDN('https://p3.music.126.net/cover.jpg')).toBeUndefined()
    expect(preferredNeteaseCDN('https://trackercdn.kugou.com/i/v2/?key=x')).toBe(
      'https://trackercdn.kugou.com/i/v2/?key=x'
    )
  })

  it('健康时保持原主机；判定不可达后让位给镜像', () => {
    expect(preferredNeteaseCDN(AUDIO)).toBe(AUDIO)
    noteNeteaseCDNHostFailed(AUDIO)
    expect(preferredNeteaseCDN(AUDIO)).toBe(TWIN)
    // 镜像自己坏掉时反过来：坏的那台让位，好的那台照旧。
    noteNeteaseCDNHostFailed(TWIN)
    noteNeteaseCDNHostReachable(AUDIO)
    expect(preferredNeteaseCDN(TWIN)).toBe(AUDIO)
  })

  it('两台都坏时用较近成功过的那台；成功记录会撤销故障判定', () => {
    noteNeteaseCDNHostFailed(AUDIO)
    noteNeteaseCDNHostFailed(TWIN)
    // 都没成功过：保持原样，不做无意义的来回换。
    expect(preferredNeteaseCDN(AUDIO)).toBe(AUDIO)
    vi.setSystemTime(new Date('2026-10-11T10:01:00Z'))
    noteNeteaseCDNHostReachable(TWIN)
    expect(preferredNeteaseCDN(AUDIO)).toBe(TWIN)
    // 成功过就等于撤销故障：镜像不再被优先。
    expect(preferredNeteaseCDN(TWIN)).toBe(TWIN)
  })

  it('故障记忆 10 分钟后过期，两种主机的偏好都能回到正常', () => {
    noteNeteaseCDNHostFailed(AUDIO)
    expect(preferredNeteaseCDN(AUDIO)).toBe(TWIN)
    vi.setSystemTime(new Date('2026-10-11T10:11:00Z'))
    expect(preferredNeteaseCDN(AUDIO)).toBe(AUDIO)
  })
})
