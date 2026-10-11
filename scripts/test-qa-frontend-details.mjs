/**
 * QA: 详情页真机测试 —— 歌手详情 / 专辑详情 / 歌单详情（从搜索页真实点击进入）。
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

const playerSnap = () =>
  cdpEval(
    PORT,
    `(async () => {
      const s = (await window.youyou.invoke('player:state')).data
      return { playing: Boolean(s?.playing), track: s?.track?.name ?? null, queue: s?.queue?.length ?? 0, error: s?.error ?? null }
    })()`
  )

const back = async () => {
  await cdpEval(PORT, `(() => { const b = document.querySelector('.top-row button'); if (!b) return false; b.click(); return true })()`, false)
  await wait(800)
}

async function main() {
  const userData = path.join(os.tmpdir(), 'youyou-qa-details')
  const { child, ready } = await boot({ port: PORT, userData, withRealState: true })
  const monitor = await startConsoleMonitor(PORT)
  try {
    record('实例启动并连上 CDP', ready)
    if (!ready) return

    // ===== 歌手详情 =====
    await clickSidebar(PORT, '搜索')
    await waitFor(PORT, `Boolean(document.querySelector('.search-hero__input'))`, 8_000, '搜索空态')
    await cdpEval(PORT, typeInSearch('周杰伦'))
    await cdpEval(PORT, pressEnter())
    await waitFor(PORT, `document.querySelectorAll('.search__tabs .chip').length === 5`, 10_000, '五页签')
    await cdpEval(PORT, `(() => { const c = [...document.querySelectorAll('.search__tabs .chip')].find((x) => x.textContent.trim() === '歌手'); c?.click(); return true })()`, false)
    const artistListed = await waitFor(PORT, `document.querySelectorAll('.search .grid--artists .card').length > 0`, 90_000, '歌手列表')
    record('搜索出歌手列表', artistListed)
    const artistName = await cdpEval(PORT, `(document.querySelector('.search .grid--artists .card .card__title')?.textContent ?? '').trim()`)
    await cdpEval(PORT, `(() => { const c = document.querySelector('.search .grid--artists .card'); c?.click(); return true })()`, false)
    const artistOpen = await waitFor(PORT, `Boolean(document.querySelector('.detail-kicker'))`, 30_000, '歌手页打开')
    const aHero = await cdpEval(PORT, `({ kicker: document.querySelector('.detail-kicker')?.textContent?.trim() ?? '', title: (document.querySelector('.hero__title')?.textContent ?? '').trim(), hot: document.querySelectorAll('.detail-panel .song-list .song-row').length, albums: document.querySelectorAll('.grid--albums .card').length, similar: document.querySelectorAll('.grid--artists .card').length, descBtn: Boolean(document.querySelector('.detail-desc')) })`)
    record('歌手详情渲染：头像区+热门单曲+专辑+相似歌手', artistOpen && aHero.kicker === '歌手' && aHero.title.length > 0 && aHero.hot > 0 && aHero.albums > 0, `title=${JSON.stringify(aHero.title)} hot=${aHero.hot} albums=${aHero.albums} similar=${aHero.similar}`)
    await screenshot(PORT, 'details-1-artist.png')

    // 播放全部 → 队列；点第 2 行切歌
    await cdpEval(PORT, `(() => { const b = document.querySelector('.detail-panel .section-action') ?? document.querySelector('.detail-panel .button--primary'); if (!b) return false; b.click(); return true })()`, false)
    const aQueue = await waitFor(PORT, `(async () => { const s = (await window.youyou.invoke('player:state')).data; return Boolean(s && s.queue && s.queue.length > 1) })()`, 40_000, '歌手热门单曲播放全部')
    const aps = await playerSnap()
    record('歌手页「播放全部」建立队列', aQueue, `queue=${aps.queue}`)
    const secondName = await cdpEval(PORT, `(document.querySelectorAll('.detail-panel .song-list .song-row .song-row__name')[1]?.textContent ?? '').trim()`)
    await cdpEval(PORT, `(() => { const r = document.querySelectorAll('.detail-panel .song-list .song-row')[1]; if (!r) return false; r.click(); return true })()`, false)
    const aSwitched = await waitFor(PORT, `(async () => { const s = (await window.youyou.invoke('player:state')).data; return Boolean(s && s.track && s.track.name === ${JSON.stringify(secondName)}) })()`, 40_000, '点第二行切歌')
    record('点热门单曲第 2 行切到该曲', aSwitched, `row=${JSON.stringify(secondName)} track=${JSON.stringify((await playerSnap()).track)}`)

    // 专辑分页「加载更多」（有按钮才点）
    const pagerBtn = await cdpEval(PORT, `(() => { const b = document.querySelector('.detail-pager .button'); return Boolean(b && !b.disabled) })()`)
    if (pagerBtn) {
      const beforePager = await cdpEval(PORT, `document.querySelectorAll('.grid--albums .card').length`)
      await cdpEval(PORT, `(() => { document.querySelector('.detail-pager .button').click(); return true })()`, false)
      const pagerOk = await waitFor(PORT, `document.querySelectorAll('.grid--albums .card').length > ${beforePager} || document.querySelector('.detail-pager .button')?.disabled`, 60_000, '专辑加载更多')
      const afterPager = await cdpEval(PORT, `document.querySelectorAll('.grid--albums .card').length`)
      record('歌手页专辑「加载更多」生效', pagerOk, `${beforePager} → ${afterPager}`)
    } else {
      record('歌手页专辑「加载更多」生效', true, '无更多（跳过）')
    }

    // 展开简介
    await cdpEval(PORT, `(() => { const b = document.querySelector('.detail-desc'); if (!b) return false; b.click(); return true })()`, false)
    const introOpen = await waitFor(PORT, `(document.querySelector('.detail-dialog-text')?.textContent ?? '').length > 10`, 10_000, '简介弹窗')
    record('点「展开」显示完整简介弹窗', introOpen)
    await screenshot(PORT, 'details-2-artist-intro.png')
    await cdpEval(PORT, `(() => { const b = document.querySelector('.detail-dialog .button--primary') ?? document.querySelector('.detail-dialog button'); if (!b) return false; b.click(); return true })()`, false)
    await waitFor(PORT, `!document.querySelector('.detail-dialog')`, 8_000, '关闭简介弹窗')

    // 关注切换（真实账号：点两次恢复原状）
    const followBefore = await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.hero__actions .detail-btn')].find((x) => (x.textContent ?? '').includes('关注')); return b?.textContent?.trim() ?? null })()`)
    if (followBefore) {
      await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.hero__actions .detail-btn')].find((x) => (x.textContent ?? '').includes('关注')); b?.click(); return true })()`, false)
      const toastShown = await waitFor(PORT, `Boolean(document.querySelector('.toast'))`, 15_000, '关注后出现 toast')
      const followAfter = await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.hero__actions .detail-btn')].find((x) => (x.textContent ?? '').includes('关注')); return b?.textContent?.trim() ?? null })()`)
      record('点「关注」出现反馈 toast', toastShown, `before=${JSON.stringify(followBefore)} after=${JSON.stringify(followAfter)}`)
      await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.hero__actions .detail-btn')].find((x) => (x.textContent ?? '').includes('关注')); b?.click(); return true })()`, false)
      await waitFor(PORT, `Boolean(document.querySelector('.toast'))`, 15_000, '取消关注 toast')
    } else {
      record('点「关注」出现反馈 toast', false, '未找到关注按钮')
    }

    // 相似歌手 → 点第一个 → 又进歌手页
    await cdpEval(PORT, `(() => { const c = document.querySelector('.grid--artists .card'); if (!c) return false; c.click(); return true })()`, false)
    const similarOpen = await waitFor(PORT, `Boolean(document.querySelector('.detail-kicker'))`, 25_000, '相似歌手详情')
    const simTitle = await cdpEval(PORT, `(document.querySelector('.hero__title')?.textContent ?? '').trim()`)
    record('点相似歌手进其详情页', similarOpen, `title=${JSON.stringify(simTitle)}`)
    await back()
    // 返回后歌手页会重新挂载拉数据（限流风暴时可能很慢），等专辑网格就绪再点，避免点空
    await waitFor(PORT, `document.querySelectorAll('.grid--albums .card').length > 0`, 90_000, '返回后专辑网格就绪')

    // ===== 专辑详情（从歌手页专辑区进）=====
    const albumCardName = await cdpEval(PORT, `(document.querySelector('.grid--albums .card .card__title')?.textContent ?? '').trim()`)
    await cdpEval(PORT, `(() => { const c = document.querySelector('.grid--albums .card'); if (!c) return false; c.click(); return true })()`, false)
    const albumOpen = await waitFor(PORT, `[...document.querySelectorAll('.hero__actions .detail-btn')].some((b) => (b.textContent ?? '').includes('播放全部'))`, 60_000, '专辑页打开')
    const albSnap = await cdpEval(PORT, `({ title: (document.querySelector('.hero__title')?.textContent ?? '').trim(), rows: document.querySelectorAll('.detail-panel .song-list .song-row').length, more: (document.querySelector('.section__more')?.textContent ?? '').trim(), playAll: [...document.querySelectorAll('.hero__actions .detail-btn')].map((b) => b.textContent.trim()) })`)
    record('专辑详情渲染：曲目列表', albumOpen && albSnap.title.length > 0 && albSnap.rows > 0, `title=${JSON.stringify(albSnap.title)} rows=${albSnap.rows} more=${JSON.stringify(albSnap.more)} buttons=${JSON.stringify(albSnap.playAll)}`)
    await screenshot(PORT, 'details-3-album.png')

    await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.hero__actions .detail-btn')].find((x) => (x.textContent ?? '').includes('播放全部')); if (!b) return false; b.click(); return true })()`, false)
    const albQueue = await waitFor(PORT, `(async () => { const s = (await window.youyou.invoke('player:state')).data; return Boolean(s && s.queue && s.queue.length > 1) })()`, 40_000, '专辑播放全部')
    record('专辑「播放全部」建立队列', albQueue, `queue=${(await playerSnap()).queue}`)

    // 收藏专辑（点两次恢复）
    const subBefore = await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.hero__actions .detail-btn')].find((x) => /收藏|取消收藏/.test(x.textContent ?? '')); return b?.textContent?.trim() ?? null })()`)
    if (subBefore) {
      await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.hero__actions .detail-btn')].find((x) => /收藏|取消收藏/.test(x.textContent ?? '')); b?.click(); return true })()`, false)
      const subToast = await waitFor(PORT, `Boolean(document.querySelector('.toast'))`, 15_000, '收藏 toast')
      const subAfter = await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.hero__actions .detail-btn')].find((x) => /收藏|取消收藏/.test(x.textContent ?? '')); return b?.textContent?.trim() ?? null })()`)
      record('专辑收藏按钮有反馈', subToast, `before=${JSON.stringify(subBefore)} after=${JSON.stringify(subAfter)}`)
      await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.hero__actions .detail-btn')].find((x) => /收藏|取消收藏/.test(x.textContent ?? '')); b?.click(); return true })()`, false)
      await waitFor(PORT, `Boolean(document.querySelector('.toast'))`, 15_000, '恢复收藏状态 toast')
    } else {
      record('专辑收藏按钮有反馈', false, '未找到收藏按钮')
    }

    // ===== 歌单详情（从搜索歌单 tab 进）=====
    await back()
    await waitFor(PORT, `Boolean(document.querySelector('.page.search'))`, 10_000, '回到搜索页')
    await cdpEval(PORT, `(() => { const c = [...document.querySelectorAll('.search__tabs .chip')].find((x) => x.textContent.trim() === '歌单'); c?.click(); return true })()`, false)
    let plListed = await waitFor(PORT, `document.querySelectorAll('.search .grid--playlists .card').length > 0`, 90_000, '歌单列表')
    if (!plListed) {
      log('歌单列表 90s 内为空，切换页签后重试一次')
      await cdpEval(PORT, `(() => { const c = [...document.querySelectorAll('.search__tabs .chip')].find((x) => x.textContent.trim() === '歌手'); c?.click(); return true })()`, false)
      await wait(1500)
      await cdpEval(PORT, `(() => { const c = [...document.querySelectorAll('.search__tabs .chip')].find((x) => x.textContent.trim() === '歌单'); c?.click(); return true })()`, false)
      plListed = await waitFor(PORT, `document.querySelectorAll('.search .grid--playlists .card').length > 0`, 90_000, '歌单列表(重试)')
    }
    record('搜索出歌单列表', plListed)
    const plCardName = await cdpEval(PORT, `(document.querySelector('.search .grid--playlists .card .card__title')?.textContent ?? '').trim()`)
    await cdpEval(PORT, `(() => { const c = document.querySelector('.search .grid--playlists .card'); c?.click(); return true })()`, false)
    const plOpen = await waitFor(PORT, `[...document.querySelectorAll('.hero__actions .detail-btn')].some((b) => (b.textContent ?? '').includes('播放全部'))`, 60_000, '歌单页打开')
    const plSnap = await cdpEval(PORT, `({ title: (document.querySelector('.hero__title')?.textContent ?? '').trim(), rows: document.querySelectorAll('.detail-panel .song-list .song-row').length, more: (document.querySelector('.section__more')?.textContent ?? '').trim(), buttons: [...document.querySelectorAll('.hero__actions .detail-btn')].map((b) => b.textContent.trim()) })`)
    record('歌单详情渲染：歌曲列表', plOpen && plSnap.title.length > 0 && plSnap.rows > 0, `title=${JSON.stringify(plSnap.title)} rows=${plSnap.rows} more=${JSON.stringify(plSnap.more)} buttons=${JSON.stringify(plSnap.buttons)}`)
    await screenshot(PORT, 'details-4-playlist.png')

    await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.hero__actions .detail-btn')].find((x) => (x.textContent ?? '').includes('播放全部')); if (!b) return false; b.click(); return true })()`, false)
    const plQueue = await waitFor(PORT, `(async () => { const s = (await window.youyou.invoke('player:state')).data; return Boolean(s && s.queue && s.queue.length > 1) })()`, 40_000, '歌单播放全部')
    record('歌单「播放全部」建立队列', plQueue, `queue=${(await playerSnap()).queue}`)

    // 收藏歌单（点两次恢复）
    const colBefore = await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.hero__actions .detail-btn')].find((x) => /收藏|取消收藏/.test(x.textContent ?? '')); return b?.textContent?.trim() ?? null })()`)
    if (colBefore) {
      await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.hero__actions .detail-btn')].find((x) => /收藏|取消收藏/.test(x.textContent ?? '')); b?.click(); return true })()`, false)
      const colToast = await waitFor(PORT, `Boolean(document.querySelector('.toast'))`, 15_000, '收藏歌单 toast')
      record('歌单收藏按钮有反馈', colToast, `before=${JSON.stringify(colBefore)}`)
      await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.hero__actions .detail-btn')].find((x) => /收藏|取消收藏/.test(x.textContent ?? '')); b?.click(); return true })()`, false)
      await waitFor(PORT, `Boolean(document.querySelector('.toast'))`, 15_000, '恢复歌单收藏 toast')
    } else {
      record('歌单收藏按钮有反馈', false, '未找到收藏按钮')
    }

    const errors = monitor.getErrors()
    record('详情页全程控制台无报错', errors.length === 0, errors.slice(0, 5).map((e) => `${e.type}: ${e.text}`.slice(0, 140)).join(' | '))
  } finally {
    monitor.stop()
    await shutdown({ port: PORT, child })
  }
  finish(results, '详情页存在失败项')
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
