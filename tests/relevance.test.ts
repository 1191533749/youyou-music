/**
 * 搜索结果相关性判定测试。
 *
 * 用例取自真实观察：网易云对乱码/随机串也会返回一堆模糊结果。
 */
import { describe, expect, it } from 'vitest'
import { isSearchRelevant, normalizeForMatch } from '../src/renderer/src/lib/relevance.js'

describe('normalizeForMatch', () => {
  it('去掉空白标点并统一大小写', () => {
    expect(normalizeForMatch(' 爱 如 火 ')).toBe('爱如火')
    expect(normalizeForMatch('Jay Chou')).toBe('jaychou')
    expect(normalizeForMatch('七里香（Live）')).toBe('七里香live')
    expect(normalizeForMatch(undefined)).toBe('')
  })
})

describe('isSearchRelevant', () => {
  it('搜到同名歌曲 → 相关', () => {
    expect(isSearchRelevant('爱如火', [{ name: '爱如火', artists: '那艺娜' }])).toBe(true)
  })

  it('歌名带后缀（Live/翻唱）也算相关', () => {
    expect(isSearchRelevant('孤勇者', [{ name: '孤勇者 (Live)', artists: '陈奕迅' }])).toBe(true)
  })

  it('歌手命中 → 相关（按歌手搜索的场景）', () => {
    expect(isSearchRelevant('周杰伦', [{ name: '晴天', artists: '周杰伦' }])).toBe(true)
  })

  it('网易云把长关键词回显到歌手字段 → 不算命中（应去兜底）', () => {
    const echoed = [
      { name: 'Toxic Remix', artists: 'zxcvbnmasdfghjkl', album: 'mix' },
      { name: '降维打击', artists: 'zxcvbnmasdfghjkl', album: 'single' }
    ]
    expect(isSearchRelevant('zxcvbnmasdfghjkl', echoed)).toBe(false)
  })

  it('完全不相干的模糊结果 → 不相关（应该去站外兜底）', () => {
    const fuzzy = [
      { name: '夜曲', artists: '周杰伦', album: '十一月的萧邦' },
      { name: '稻香', artists: '周杰伦', album: '魔杰座' },
      { name: '晴天', artists: '周杰伦', album: '叶惠美' }
    ]
    expect(isSearchRelevant('乌梅子酱抖音版阿巴阿巴', fuzzy)).toBe(false)
  })

  it('空关键词不做兜底（避免空搜索打站外）', () => {
    expect(isSearchRelevant('   ', [])).toBe(true)
    expect(isSearchRelevant('', undefined)).toBe(true)
  })

  it('没有任何结果 → 不相关（触发兜底）', () => {
    expect(isSearchRelevant('爱如火', [])).toBe(false)
    expect(isSearchRelevant('爱如火', undefined)).toBe(false)
  })

  it('只扫描前 N 条：相关结果在很后面也算不相关', () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      name: index === 15 ? '爱如火' : `无关歌曲${index}`,
      artists: '某某'
    }))
    expect(isSearchRelevant('爱如火', items, 10)).toBe(false)
  })

  it('字符覆盖率够高算相关（歌名被拆词时）', () => {
    expect(isSearchRelevant('乌梅子酱', [{ name: '乌梅子酱 (女声版)', artists: '翻唱歌手' }])).toBe(true)
  })
})
