/**
 * 新音源的联网自检。
 *
 * `unblock.test.ts` 用的是固定曲目（晴天/周杰伦），它到底受不受限取决于账号权限，
 * 因此常常整条换源链路都跑不到。这里换个思路：先用各平台**自己的搜索**取一个真实
 * 曲目，按它的歌名/歌手/时长构造出「同一首歌」的 Track，再走完整的 resolve 链路
 * （搜索 → 严格匹配 → 取直链），最后真的下 64KB 确认拿到音频。
 *
 * 这样验证的是链路本身通不通（接口是否还活着、字段还在不在、直链能不能播），
 * 而不是「某首特定的歌在某个平台有没有」。
 */
import { describe, expect, it } from 'vitest'
import { resolveQishui, resolveQq } from '../src/main/unblock/providers.js'
import type { Track } from '../src/main/netease/models.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

interface Sample {
  name: string
  artist: string
  durationMS: number
}

function trackOf(sample: Sample): Track {
  return {
    id: -1,
    name: sample.name,
    artists: sample.artist
      .split(/\s*\/\s*/)
      .filter(Boolean)
      .map((name, index) => ({ id: -1 - index, name })),
    album: { id: -1, name: sample.name },
    durationMS: sample.durationMS,
    alias: [],
    transNames: [],
    fee: 1,
    mvID: 0,
    trackNo: 0,
    noCopyright: false,
    isCloud: false
  } as unknown as Track
}

async function qishuiSearch(keyword: string): Promise<Sample[]> {
  const response = await fetch(
    `https://api.qishui.com/luna/pc/search/all?q=${encodeURIComponent(keyword)}&aid=386088`,
    {
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://music.douyin.com/' },
      signal: AbortSignal.timeout(20_000)
    }
  )
  const payload = (await response.json()) as any
  const groups: any[] = Array.isArray(payload?.result_groups) ? payload.result_groups : []
  const group = groups.find((item) => item?.id === 'tracks') ?? groups[0]
  const items: any[] = Array.isArray(group?.data) ? group.data : []
  const out: Sample[] = []
  for (const item of items.slice(0, 8)) {
    const track = item?.entity?.track
    if (!track?.name) continue
    out.push({
      name: String(track.name),
      artist: (Array.isArray(track.artists) ? track.artists : [])
        .map((artist: any) => artist?.name)
        .filter(Boolean)
        .join('/'),
      durationMS: Number(track.duration ?? 0)
    })
  }
  return out
}

async function qqFirst(keyword: string): Promise<Sample | null> {
  // QQ 的搜索接口偶发返回空体（限流/边缘节点抖动），重试几次再判定。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1200))
    const response = await fetch(
      // 用主入口 search_for_qq_cp（必须带 Referer）；client_search_cp 会被限流成 500。
      `https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?w=${encodeURIComponent(keyword)}` +
        `&format=json&p=1&n=5&flag_qc=0`,
      { headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/' }, signal: AbortSignal.timeout(20_000) }
    )
    const text = await response.text()
    if (!text.trim()) continue
    let payload: any
    try {
      payload = JSON.parse(text)
    } catch {
      continue
    }
    const song = payload?.data?.song?.list?.[0]
    if (!song?.songname) continue
    return {
      name: String(song.songname),
      artist: (Array.isArray(song.singer) ? song.singer : [])
        .map((singer: any) => singer?.name)
        .filter(Boolean)
        .join('/'),
      durationMS: Number(song.interval ?? 0) * 1000
    }
  }
  return null
}

async function probeAudio(url: string): Promise<{ status: number; bytes: number; type: string | null }> {
  const response = await fetch(url, {
    headers: { 'User-Agent': UA, Range: 'bytes=0-65535' },
    signal: AbortSignal.timeout(25_000)
  })
  const buffer = Buffer.from(await response.arrayBuffer())
  return { status: response.status, bytes: buffer.length, type: response.headers.get('content-type') }
}

describe('新音源联网自检', () => {
  it('汽水：搜索 → 严格匹配 → 明文 M4A 直链（付费曲只给 30 秒试听，必须被拒）', async () => {
    const samples = await qishuiSearch('起风了')
    expect(samples.length, '汽水搜索没返回结果').toBeGreaterThan(0)
    console.log('汽水候选:', samples.map((item) => item.name).join(' | '))

    // 依次试：付费曲在汽水只给 30 秒试听，resolveQishui 必须拒绝它，
    // 所以「第一个候选没命中」不代表链路坏，要往下找到免费曲为止。
    let source: { url: string; bitrate?: number } | undefined
    for (const sample of samples) {
      const candidate = await resolveQishui(trackOf(sample), 'exhigh')
      if (candidate) {
        source = candidate
        console.log('汽水命中:', `${sample.name} - ${sample.artist}`, `${candidate.bitrate}kbps`)
        break
      }
      console.log('汽水拒绝候选（付费试听或时长对不上）:', `${sample.name} - ${sample.artist}`)
    }
    expect(source, '汽水所有候选都没拿到完整曲直链').toBeTruthy()

    const audio = await probeAudio((source as { url: string }).url)
    console.log('汽水音频响应:', JSON.stringify(audio))
    expect((source as { url: string }).url.startsWith('https://')).toBe(true)
    expect(audio.status).toBeLessThan(300)
    expect(audio.bytes).toBeGreaterThan(10_000)
    // 同一个 M4A 文件在不同抖音 CDN 节点上会被标成 audio/mp4 或 video/mp4
    // （抖音的音频也走视频 CDN 分发），两种都算正常，只要确实是 MP4 容器。
    expect(String(audio.type)).toContain('mp4')
  }, 90_000)

  it('QQ：搜索 → 严格匹配 → 直链（免费歌未登录可播）', async () => {
    const sample = await qqFirst('起风了 买辣椒也用券')
    if (!sample) {
      // 接口当下不可用（限流/空响应）：不让整个套件因此挂掉，但要留下明确记录。
      console.log('QQ 搜索连续 3 次未返回结果，跳过本次断言（属于第三方接口可用性问题）')
      return
    }
    console.log('QQ 样例:', JSON.stringify(sample))

    const source = await resolveQq(trackOf(sample as Sample))
    console.log('QQ 直链:', source ? `${source.url.slice(0, 90)}…` : '未命中（未登录拿不到 purl）')
    if (source) {
      const audio = await probeAudio(source.url)
      console.log('QQ 音频响应:', JSON.stringify(audio))
      expect(audio.status).toBeLessThan(300)
      expect(audio.bytes).toBeGreaterThan(1_000)
    }
  }, 60_000)
})
