/**
 * QA: 发现页真机测试。
 *
 * 覆盖：三页签（热门歌单/精品歌单/热门歌手）、分类 chips、排序切换、
 * 加载更多、听书分类（关键词搜索区块）、点歌单卡进详情、点歌手进歌手页、
 * 切换页签时的静默刷新条、控制台无报错。
 */
import * as path from 'node:path'
import * as os from 'node:os'
import {
  boot,
  shutdown,
  cdpEval,
  waitFor,
  clickSidebar,
  screenshot,
  startConsoleMonitor,
  recordTo,
  finish,
  log,
  wait
} from './test-qa-frontend-lib.mjs'

const PORT = 9391
const results = []
const record = recordTo(results)

const SNAP = `(() => ({
  explore: Boolean(document.querySelector('.page.explore')),
  tabs: [...document.querySelectorAll('.explore > .toolbar:first-of-type .chip')].map((c) => c.textContent.trim()),
  activeTab: document.querySelector('.explore > .toolbar:first-of-type .chip.is-active')?.textContent?.trim() ?? null,
  categories: [...document.querySelectorAll('.explore__filters .chip-row:first-of-type .chip')].map((c) => c.textContent.trim()),
  activeCategory: document.querySelector('.explore__filters .chip-row:first-of-type .chip.is-active')?.textContent?.trim() ?? null,
  orders: [...document.querySelectorAll('.explore__orders .chip')].map((c) => c.textContent.trim()),
  activeOrder: document.querySelector('.explore__orders .chip.is-active')?.textContent?.trim() ?? null,
  playlistCards: document.querySelectorAll('.explore .grid--playlists .card').length,
  artistCards: document.querySelectorAll('.explore .grid--artists .card').length,
  error: (document.querySelector('.explore .page__error')?.textContent ?? '').trim(),
  placeholder: (document.querySelector('.explore .placeholder__title')?.textContent ?? '').trim(),
  refreshing: Boolean(document.querySelector('.explore .refresh-bar')),
  loading: Boolean(document.querySelector('.explore__loading')),
  moreBtn: (document.querySelector('.explore__footer .button')?.textContent ?? '').trim(),
  endHint: (document.querySelector('.explore__end')?.textContent ?? '').trim(),
  audio: Boolean(document.querySelector('.explore__hint')),
  audioSongs: document.querySelectorAll('.explore .song-row').length
}))()`

async function main() {
  const userData = path.join(os.tmpdir(), 'youyou-qa-explore')
  const { child, ready } = await boot({ port: PORT, userData, withRealState: true })
  const monitor = await startConsoleMonitor(PORT)
  try {
    record('实例启动并连上 CDP', ready)
    if (!ready) return
    await clickSidebar(PORT, '发现')
    const shown = await waitFor(PORT, `Boolean(document.querySelector('.page.explore'))`, 8_000, '发现页出现')
    record('发现页渲染', shown)

    const first = await waitFor(PORT, `document.querySelectorAll('.explore .grid--playlists .card').length > 0`, 30_000, '默认页签歌单卡加载')
    const snap = await cdpEval(PORT, SNAP)
    record('默认页签（分类歌单）有内容', first && snap.activeTab === '分类歌单' && snap.playlistCards > 0, `tabs=${JSON.stringify(snap.tabs)} active=${JSON.stringify(snap.activeTab)} cards=${snap.playlistCards}`)
    record('分类 chips 存在且默认「全部」', snap.categories.length > 3 && snap.activeCategory === '全部', `categories=${JSON.stringify(snap.categories)}`)
    record('排序 chips 存在且默认最热', snap.orders.length >= 2 && snap.activeOrder === '最热', `orders=${JSON.stringify(snap.orders)} active=${JSON.stringify(snap.activeOrder)}`)
    await screenshot(PORT, 'explore-1-top.png')

    // 分类切换 → 内容刷新（先出现 is-refreshing 网格，再出新卡）
    const category = snap.categories.find((c) => !['全部', '听书', '儿童'].includes(c))
    if (category) {
      await cdpEval(PORT, `(() => { const c = [...document.querySelectorAll('.explore__filters .chip-row:first-of-type .chip')].find((x) => x.textContent.trim() === ${JSON.stringify(category)}); c?.click(); return true })()`, false)
      const catActive = await waitFor(PORT, `document.querySelector('.explore__filters .chip-row:first-of-type .chip.is-active')?.textContent?.trim() === ${JSON.stringify(category)}`, 5_000, '分类选中')
      const catLoaded = await waitFor(PORT, `document.querySelectorAll('.explore .grid--playlists .card').length > 0 && !document.querySelector('.explore__loading')`, 30_000, '新分类内容加载')
      record(`切到分类「${category}」出内容`, catActive && catLoaded, `active=${await cdpEval(PORT, `document.querySelector('.explore__filters .chip-row:first-of-type .chip.is-active')?.textContent?.trim() ?? ''`)}`)
      await screenshot(PORT, `explore-2-cat-${category}.png`)
      // 切回全部
      await cdpEval(PORT, `(() => { const c = [...document.querySelectorAll('.explore__filters .chip-row:first-of-type .chip')].find((x) => x.textContent.trim() === '全部'); c?.click(); return true })()`, false)
      await waitFor(PORT, `document.querySelector('.explore__filters .chip-row:first-of-type .chip.is-active')?.textContent?.trim() === '全部'`, 5_000, '切回全部')
      await waitFor(PORT, `document.querySelectorAll('.explore .grid--playlists .card').length > 0 && !document.querySelector('.explore__loading')`, 30_000, '全部内容恢复')
    } else {
      record('切到分类出内容', false, '未找到可切换分类')
    }

    // 排序切换 最热 → 最新
    await cdpEval(PORT, `(() => { const c = [...document.querySelectorAll('.explore__orders .chip')].find((x) => x.textContent.trim() === '最新'); c?.click(); return true })()`, false)
    const orderSwitched = await waitFor(PORT, `document.querySelector('.explore__orders .chip.is-active')?.textContent?.trim() === '最新'`, 5_000, '排序选中')
    const orderLoaded = await waitFor(PORT, `document.querySelectorAll('.explore .grid--playlists .card').length > 0 && !document.querySelector('.explore__loading')`, 30_000, '新排序内容加载')
    record('切换排序「最新」出内容', orderSwitched && orderLoaded)

    // 加载更多（卡片变多=成功；出现错误横幅=失败有提示, 不算静默吞错; 出现到底提示=真没了）
    const beforeMore = await cdpEval(PORT, `document.querySelectorAll('.explore .grid--playlists .card').length`)
    const hasMoreBtn = await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.explore__footer .button')].find((x) => (x.textContent ?? '').includes('加载更多')); if (!b || b.disabled) return false; b.click(); return true })()`, false)
    if (hasMoreBtn) {
      const moreLoaded = await waitFor(
        PORT,
        `document.querySelectorAll('.explore .grid--playlists .card').length > ${beforeMore} || Boolean(document.querySelector('.explore .page__error')) || Boolean(document.querySelector('.explore__end'))`,
        30_000,
        '加载更多生效'
      )
      const afterSnap = await cdpEval(PORT, SNAP)
      const grew = afterSnap.playlistCards > beforeMore
      const errShown = afterSnap.error.length > 0
      record('点「加载更多」卡片变多', moreLoaded && grew, `${beforeMore} → ${afterSnap.playlistCards}${errShown ? ` 错误横幅=${JSON.stringify(afterSnap.error)}` : ''}${afterSnap.endHint ? ` 底部=${JSON.stringify(afterSnap.endHint)}` : ''}`)
    } else {
      record('点「加载更多」卡片变多', false, `没有可用按钮 beforeMore=${beforeMore}`)
    }

    // 精品歌单页签
    await cdpEval(PORT, `(() => { const c = [...document.querySelectorAll('.explore > .toolbar:first-of-type .chip')].find((x) => x.textContent.trim() === '精品歌单'); c?.click(); return true })()`, false)
    const highLoaded = await waitFor(PORT, `document.querySelector('.explore > .toolbar:first-of-type .chip.is-active')?.textContent?.trim() === '精品歌单' && document.querySelectorAll('.explore .grid--playlists .card').length > 0 && !document.querySelector('.explore__loading')`, 30_000, '精品歌单加载')
    record('「精品歌单」页签有内容', highLoaded)
    await screenshot(PORT, 'explore-3-high.png')

    // 热门歌手页签
    await cdpEval(PORT, `(() => { const c = [...document.querySelectorAll('.explore > .toolbar:first-of-type .chip')].find((x) => x.textContent.trim() === '热门歌手'); c?.click(); return true })()`, false)
    const artistsLoaded = await waitFor(PORT, `document.querySelectorAll('.explore .grid--artists .card').length > 0`, 30_000, '热门歌手加载')
    const artistSnap = await cdpEval(PORT, SNAP)
    record('「热门歌手」页签有内容', artistsLoaded, `cards=${artistSnap.artistCards}`)
    await screenshot(PORT, 'explore-4-artists.png')
    // 点歌手 → 歌手详情 → 返回
    await cdpEval(PORT, `(() => { const c = document.querySelector('.explore .grid--artists .card'); c?.click(); return true })()`, false)
    const artistOpen = await waitFor(PORT, `Boolean(document.querySelector('.detail-kicker'))`, 20_000, '歌手详情打开')
    record('点歌手卡进歌手详情页', artistOpen)
    await cdpEval(PORT, `(() => { const b = document.querySelector('.top-row button'); b?.click(); return true })()`, false)
    await waitFor(PORT, `Boolean(document.querySelector('.page.explore'))`, 10_000, '返回发现页')

    // 听书分类：搜索区块 + 不显示页签/排序
    await cdpEval(PORT, `(() => { const c = [...document.querySelectorAll('.explore__filters .chip-row:first-of-type .chip')].find((x) => x.textContent.trim() === '听书'); c?.click(); return true })()`, false)
    const audioShown = await waitFor(PORT, `Boolean(document.querySelector('.explore__hint')) || document.querySelectorAll('.explore .song-row').length > 0`, 30_000, '听书区块出现')
    const audioSnap = await cdpEval(PORT, SNAP)
    record('「听书」分类切到关键词搜索区块', audioShown, `hint=${JSON.stringify((await cdpEval(PORT, `(document.querySelector('.explore__hint')?.textContent ?? '').trim()`)))} songs=${audioSnap.audioSongs}`)
    const visibleTabs = await cdpEval(PORT, `[...document.querySelectorAll('.explore > .toolbar:first-of-type .chip')].filter((c) => c.offsetParent !== null).length`)
    const visibleOrders = await cdpEval(PORT, `[...document.querySelectorAll('.explore__orders .chip')].filter((c) => c.offsetParent !== null).length`)
    record('听书分类隐藏页签与排序', visibleTabs === 0 && visibleOrders === 0, `可见tabs=${visibleTabs} 可见orders=${visibleOrders}`)
    await screenshot(PORT, 'explore-5-audio.png')
    await cdpEval(PORT, `(() => { const c = [...document.querySelectorAll('.explore__filters .chip-row:first-of-type .chip')].find((x) => x.textContent.trim() === '全部'); c?.click(); return true })()`, false)
    await waitFor(PORT, `document.querySelectorAll('.explore .grid--playlists .card').length > 0 && !document.querySelector('.explore__loading')`, 30_000, '回到全部')

    // 点歌单卡 → 歌单详情
    await cdpEval(PORT, `(() => { const c = document.querySelector('.explore .grid--playlists .card'); c?.click(); return true })()`, false)
    const plOpen = await waitFor(PORT, `Boolean(document.querySelector('.hero__title'))`, 25_000, '歌单详情打开')
    record('点歌单卡进歌单详情页', plOpen, `hero=${JSON.stringify(await cdpEval(PORT, `(document.querySelector('.hero__title')?.textContent ?? '').trim()`))}`)
    await cdpEval(PORT, `(() => { const b = document.querySelector('.top-row button'); b?.click(); return true })()`, false)
    await waitFor(PORT, `Boolean(document.querySelector('.page.explore'))`, 10_000, '返回发现页')

    const errors = monitor.getErrors()
    record('发现页全程控制台无报错', errors.length === 0, errors.slice(0, 5).map((e) => `${e.type}: ${e.text}`.slice(0, 150)).join(' | '))
  } finally {
    monitor.stop()
    await shutdown({ port: PORT, child })
  }
  finish(results, '发现页存在失败项')
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
