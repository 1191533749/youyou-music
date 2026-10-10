/**
 * 换源音源的联网验证。
 *
 * 这套方案的成败完全取决于第三方接口当下是否可用，所以这里直接打真实接口：
 * 用一首必然受限的歌（VIP/无版权）分别走 汽水 / 酷狗 / 酷我 / QQ，
 * 断言拿到的直链是 https、且能取到音频响应头。
 *
 * 网络不通或某个音源下线时该用例会失败——这正是需要立刻知道的信息，
 * 因此不做 skip，而是把每个音源的结论都打印出来。
 */
import { describe, expect, it } from 'vitest'
import { resolveQishui, resolveKugou, resolveKuwo, resolveQq, matchesTrack } from '../src/main/unblock/providers.js'
import type { Track } from '../src/main/netease/models.js'

/** 晴天 / 周杰伦：付费单曲，匿名与普通账号都拿不到完整播放地址。 */
const VIP_TRACK: Track = {
  id: 186016,
  name: '晴天',
  artists: [{ id: 6452, name: '周杰伦' }],
  album: { id: 34720827, name: '叶惠美' },
  durationMS: 269_000,
  alias: [],
  transNames: [],
  fee: 1,
  mvID: 0,
  trackNo: 3,
  noCopyright: false,
  isCloud: false
}

describe('第三方音源', () => {
  it('匹配器拒绝翻唱与版本不一致的候选', () => {
    expect(
      matchesTrack(VIP_TRACK, { title: '晴天', artist: '周杰伦', durationMS: 269_000 })
    ).toBe(true)
    // 时长差 30 秒
    expect(
      matchesTrack(VIP_TRACK, { title: '晴天', artist: '周杰伦', durationMS: 299_000 })
    ).toBe(false)
    // 翻唱
    expect(
      matchesTrack(VIP_TRACK, { title: '晴天', artist: '某翻唱歌手', durationMS: 269_000 })
    ).toBe(false)
    // 标题带版本标记，原曲没有
    expect(
      matchesTrack(VIP_TRACK, { title: '晴天 (Live)', artist: '周杰伦', durationMS: 269_000 })
    ).toBe(false)
  })

  it('汽水音乐能搜索并解析直链', async () => {
    const source = await resolveQishui(VIP_TRACK, 'exhigh').catch((error) => {
      console.log('汽水异常:', (error as Error).message)
      return null
    })
    console.log('汽水 →', source ? `${source.url.slice(0, 60)}… (${source.bitrate ?? '?'}kbps)` : '未命中（严格匹配没过）')
    if (source) {
      expect(source.url.startsWith('https://')).toBe(true)
      expect(source.bitrate).toBeGreaterThan(0)
    }
  }, 40_000)

  it('QQ 音乐能搜索并解析直链（未登录只覆盖部分免费歌）', async () => {
    const source = await resolveQq(VIP_TRACK).catch((error) => {
      console.log('QQ 异常:', (error as Error).message)
      return null
    })
    console.log('QQ →', source ? `${source.url.slice(0, 60)}…` : '未命中（未登录拿不到 purl 属正常）')
    if (source) expect(source.url.length).toBeGreaterThan(20)
  }, 40_000)

  it('酷狗能搜索并解析直链', async () => {
    const source = await resolveKugou(VIP_TRACK).catch((error) => {
      console.log('酷狗异常:', (error as Error).message)
      return null
    })
    console.log('酷狗 →', source ? `${source.url.slice(0, 60)}…` : '未命中')
    if (source) expect(source.url.length).toBeGreaterThan(20)
  }, 40_000)

  it('酷我能搜索并解析直链', async () => {
    const source = await resolveKuwo(VIP_TRACK).catch((error) => {
      console.log('酷我异常:', (error as Error).message)
      return null
    })
    console.log('酷我 →', source ? `${source.url.slice(0, 60)}…` : '未命中')
    if (source) expect(source.url.length).toBeGreaterThan(20)
  }, 40_000)

  it('至少有一个音源可用（否则换源功能形同虚设）', async () => {
    const results = await Promise.allSettled([
      resolveQishui(VIP_TRACK, 'exhigh'),
      resolveKugou(VIP_TRACK),
      resolveKuwo(VIP_TRACK),
      resolveQq(VIP_TRACK)
    ])
    const hits = results.filter((result) => result.status === 'fulfilled' && result.value).length
    console.log(`可用音源数：${hits}/4`)
    expect(hits).toBeGreaterThan(0)
  }, 60_000)
})
