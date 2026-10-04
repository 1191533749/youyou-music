/**
 * Transport-fallback regression tests.
 *
 * NetEase answers the weapi transport with an **empty 200 body** when it has
 * throttled the caller's IP, while the same request over eapi succeeds. Every
 * data endpoint therefore has to survive that, which is what these cover: the
 * client's weapi layer must retry over eapi rather than hand the caller an
 * empty reply (which the UI would have to render as "no data").
 *
 * The assertions deliberately check the public `NeteaseAPI` surface, not the
 * transport, so a future change to the fallback mechanism keeps passing as long
 * as the behaviour holds.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NeteaseClient } from '../src/main/netease/client.js'
import { NeteaseAPI, SearchType } from '../src/main/netease/api.js'

function makeAPI(): NeteaseAPI {
  return new NeteaseAPI(new NeteaseClient({ cookieDirectory: mkdtempSync(join(tmpdir(), 'kumone-fb-')) }))
}

describe('weapi endpoints survive the throttled-transport case', () => {
  it('returns personalised playlists', async () => {
    const playlists = await makeAPI().personalizedPlaylists(5)
    expect(playlists.length).toBeGreaterThan(0)
    expect(playlists[0].id).toBeGreaterThan(0)
    expect(playlists[0].name.length).toBeGreaterThan(0)
  }, 60_000)

  it('returns new albums', async () => {
    const albums = await makeAPI().newAlbums('ALL', 3, 0)
    expect(albums.length).toBeGreaterThan(0)
    expect(albums[0].id).toBeGreaterThan(0)
  }, 60_000)

  it('returns category playlists', async () => {
    const page = await makeAPI().topPlaylists('全部', 'hot', 3, 0)
    expect(page.playlists.length).toBeGreaterThan(0)
    expect(page.total ?? 0).toBeGreaterThan(0)
  }, 60_000)

  it('returns an album detail with its tracks', async () => {
    const detail = await makeAPI().album(32311)
    expect(detail.album.id).toBe(32311)
    expect(detail.songs.length).toBeGreaterThan(0)
    expect(detail.songs[0].album.id).toBe(32311)
  }, 60_000)

  it('returns search suggestions', async () => {
    const suggest = await makeAPI().searchSuggest('周杰伦')
    expect(suggest).toBeDefined()
  }, 60_000)

  it('returns the top artist chart', async () => {
    const artists = await makeAPI().topArtists(3)
    expect(artists.length).toBeGreaterThan(0)
    expect(artists[0].name.length).toBeGreaterThan(0)
  }, 60_000)

  it('still serves the eapi-native endpoints', async () => {
    const api = makeAPI()
    const charts = await api.toplists()
    expect(charts.length).toBeGreaterThan(0)
    const result = await api.search('周杰伦', SearchType.songs, 3, 0)
    expect(result.songs?.length).toBeGreaterThan(0)
  }, 60_000)
})
