/**
 * QA 补充探针：搜索页两个疑点
 *  1) 综合页签「单曲」区点「播放全部」后队列长度到底是多少（疑点：上次只测到 queue=1）
 *  2) 空态头像墙是否最终渲染（上次采样 wall=0，可能是加载慢）
 */
import * as path from 'node:path'
import * as os from 'node:os'
import {
  boot,
  shutdown,
  cdpEval,
  waitFor,
  clickSidebar,
  recordTo,
  finish,
  log,
  wait
} from './test-qa-frontend-lib.mjs'

const PORT = 9391
const results = []
const record = recordTo(results)

const typeInSearch = (text) =>
  `(() => {
    const input = document.querySelector('.search-hero__input')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(text)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`

const pressEnter = () =>
  `(() => {
    const input = document.querySelector('.search-hero__input')
    if (!input) return false
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`

async function main() {
  const userData = path.join(os.tmpdir(), 'youyou-qa-search-queue')
  const { child, ready } = await boot({ port: PORT, userData, withRealState: true })
  try {
    record('实例启动并连上 CDP', ready)
    if (!ready) return
    await clickSidebar(PORT, '搜索')
    await waitFor(PORT, `Boolean(document.querySelector('.search-hero__input'))`, 8_000, '空态出现')
    // 头像墙：最多等 90s
    const wallOk = await waitFor(PORT, `document.querySelectorAll('.avatar-wall__item').length > 0`, 90_000, '头像墙渲染')
    const wallCount = await cdpEval(PORT, `document.querySelectorAll('.avatar-wall__item').length`)
    record('空态头像墙最终渲染出歌手头像', wallOk, `count=${wallCount}`)

    await cdpEval(PORT, typeInSearch('周杰伦'))
    await cdpEval(PORT, pressEnter())
    await waitFor(PORT, `document.querySelectorAll('.search .page__section').length >= 3 && !document.querySelector('.search__loading')`, 90_000, '综合结果')
    // 只统计「单曲」区的卡片（此前误把专辑区卡片一并计入）
    const SECTION_SONG = `[...document.querySelectorAll('.search .page__section')].find((s) => s.querySelector('.section__title')?.textContent?.trim() === '单曲')`
    const cards = await cdpEval(PORT, `(${SECTION_SONG})?.querySelectorAll('.grid--albums .card').length ?? 0`)
    const songNames = await cdpEval(PORT, `[...((${SECTION_SONG})?.querySelectorAll('.grid--albums .card .card__title') ?? [])].map((n) => n.textContent.trim())`)
    log(`单曲区卡片: cards=${cards} names=${JSON.stringify(songNames)}`)
    // 点播放全部，等 12 秒让队列稳定，再读状态
    await cdpEval(PORT, `(() => { const b = (${SECTION_SONG})?.querySelector('.section-action'); if (!b) return false; b.click(); return true })()`, false)
    await wait(12_000)
    const q1 = await cdpEval(PORT, `(async () => { const s = (await window.youyou.invoke('player:state')).data; return { queue: s?.queue?.length ?? 0, track: s?.track?.name ?? null, playing: s?.playing } })()`)
    record('「播放全部」后队列=单曲区卡片数', q1.queue === cards, `cards=${cards} queue=${q1.queue} track=${JSON.stringify(q1.track)} playing=${q1.playing}`)

    // 再点一张卡片，看队列是否被替换成 1（判断卡片点击语义）
    await cdpEval(PORT, `(() => { const c = (${SECTION_SONG})?.querySelector('.grid--albums .card'); if (!c) return false; c.click(); return true })()`, false)
    await wait(8_000)
    const q2 = await cdpEval(PORT, `(async () => { const s = (await window.youyou.invoke('player:state')).data; return { queue: s?.queue?.length ?? 0, index: s?.index, track: s?.track?.name ?? null } })()`)
    log(`点卡片后状态: queue=${q2.queue} index=${q2.index} track=${JSON.stringify(q2.track)}`)
    record('点单曲卡片后队列行为记录', true, `cards=${cards} → queue=${q2.queue}`)
  } finally {
    await shutdown({ port: PORT, child })
  }
  finish(results, '搜索补充探针存在失败项')
}

main().catch(async (cause) => {
  log(`脚本异常: ${cause}`)
  try {
    const { killOnPort } = await import('./test-qa-frontend-lib.mjs')
    killOnPort(PORT)
  } catch {
    /* ignore */
  }
  process.exit(1)
})
