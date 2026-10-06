import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NeteaseClient } from '../src/main/netease/client.js'
import { NeteaseAPI, SearchType } from '../src/main/netease/api.js'
import { eapi as encryptEapi, weapi as encryptWeapi } from '../src/main/netease/crypto.js'

describe('weapi / eapi encryption', () => {
  it('produces the expected params payload (golden value)', () => {
    // 固定输入 `{"csrf_token":""}` 的加密结果，钉死报文格式：
    // 任何「看起来无害」的重构如果改动了报文，都会在这里被拦住。
    const { params, encSecKey } = encryptWeapi(JSON.stringify({ csrf_token: '' }))
    expect(params).toBe('Qr3+xvcqvI87MxraEYU1mAu07NV+a6PBgu3w0XKE9lbSwyHfJf5d11gDhTpH92Wv')
    expect(params.length).toBe(64)
    expect(encSecKey.length).toBe(256)
  })

  it('derives the eapi digest over the /api path', () => {
    const { params } = encryptEapi('/api/search/suggest/keyword', JSON.stringify({ s: 'x' }))
    // AES-128-ECB with PKCS#7 always pads, so the ciphertext is block-aligned.
    expect(params).toMatch(/^[0-9A-F]+$/)
    expect(params.length % 32).toBe(0)
  })
})

describe('cookie jar', () => {
  it('binds the session to the MUSIC_U token and persists it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'youyou-cookies-'))
    const client = new NeteaseClient({ cookieDirectory: dir })
    await client.load()
    expect(client.isLoggedIn).toBe(false)

    client.setCookies({ MUSIC_U: 'token-a', __csrf: 'csrf-a' })
    expect(client.isLoggedIn).toBe(true)
    expect(client.authenticationFingerprint).toHaveLength(64)
    expect(client.authenticationCookies()).toEqual({ MUSIC_U: 'token-a', __csrf: 'csrf-a' })

    // A refresh that keeps the same token must not rotate the binding.
    const before = client.authenticationFingerprint
    client.setCookies({ MUSIC_U: 'token-a' }, undefined, true)
    expect(client.authenticationFingerprint).toBe(before)

    // A different token is a different login.
    client.setCookies({ MUSIC_U: 'token-b' })
    expect(client.authenticationFingerprint).not.toBe(before)

    // An epoch guard rejects a write that raced a re-login.
    expect(client.setCookies({ __csrf: 'stale' }, 999)).toBe(false)
    expect(client.cookie('__csrf')).toBe('csrf-a')

    client.clearAuthCookies()
    expect(client.isLoggedIn).toBe(false)
  })

  it('parses the ;; joined cookie string the QR check returns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'youyou-cookies-'))
    const client = new NeteaseClient({ cookieDirectory: dir })
    await client.load()
    client.ingestCookieString('MUSIC_U=abc;; __csrf=def; Path=/;;os=pc')
    expect(client.cookie('MUSIC_U')).toBe('abc')
    expect(client.cookie('__csrf')).toBe('def')
    expect(client.cookie('os')).toBe('pc')
  })
})

describe('live API (network)', () => {
  const makeAPI = (): NeteaseAPI =>
    new NeteaseAPI(new NeteaseClient({ cookieDirectory: mkdtempSync(join(tmpdir(), 'youyou-live-')) }))

  it('fetches a QR login key', async () => {
    const api = makeAPI()
    const unikey = await api.qrKey()
    expect(unikey.length).toBeGreaterThan(10)
    expect(api.qrLoginURL(unikey)).toContain(unikey)
  })

  it('searches songs and normalises the v3 shape', async () => {
    const api = makeAPI()
    const result = await api.search('周杰伦 晴天', SearchType.songs, 5, 0)
    expect(result.songs?.length).toBeGreaterThan(0)
    const first = result.songs![0]
    expect(first.id).toBeGreaterThan(0)
    expect(first.artists.length).toBeGreaterThan(0)
    expect(first.album.name.length).toBeGreaterThan(0)
  })

  it('resolves a song URL request at standard quality', async () => {
    const api = makeAPI()
    const result = await api.search('晴天 周杰伦', SearchType.songs, 3, 0)
    const track = result.songs?.[0]
    expect(track).toBeDefined()
    const urls = await api.songURL([track!.id], 'standard')
    expect(urls.length).toBeGreaterThan(0)
    // 晴天 is a paid track, so an anonymous request legitimately comes back
    // with `url: null`; what matters is that the reply decodes and is keyed by
    // the requested id.
    expect(urls[0].id).toBe(track!.id)
  })

  it('fetches lyrics through the transport ladder', async () => {
    const api = makeAPI()
    const result = await api.search('晴天 周杰伦', SearchType.songs, 1, 0)
    const track = result.songs![0]
    const lyric = await api.lyric(track.id)
    // The weapi lyric endpoints answer anonymously with an empty body, so this
    // also covers the eapi fallback hop.
    expect(typeof lyric.lrc?.lyric).toBe('string')
    expect(lyric.lrc!.lyric!.length).toBeGreaterThan(20)
    expect(lyric.lrc!.lyric!).toContain('[00:')
  })
})
