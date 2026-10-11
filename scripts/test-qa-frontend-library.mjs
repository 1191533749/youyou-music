/**
 * QA: 我的音乐页真机测试（喜欢的音乐/我的歌单/最近播放 + 新建/删除歌单 + 断数据重试）。
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
const PLAYLIST_NAME = `QA临时歌单${Date.now() % 100000}`

const playerSnap = () =>
  cdpEval(
    PORT,
    `(async () => {
      const s = (await window.youyou.invoke('player:state')).data
      return { playing: Boolean(s?.playing), track: s?.track?.name ?? null, queue: s?.queue?.length ?? 0 }
    })()`
  )

/** 场景 A：登录态我的音乐全流程 */
async function scenarioA(child, monitor) {
  record('场景 A 实例启动并连上 CDP', true)
  await clickSidebar(PORT, '我的音乐')
  const pageShown = await waitFor(PORT, `Boolean(document.querySelector('.page.library'))`, 30_000, '我的音乐页出现')
  const loaded = await waitFor(PORT, `!document.querySelector('.page.library .placeholder') && !document.querySelector('.page.library .page__error')`, 90_000, '音乐库内容加载')
  const hero = await cdpEval(PORT, `({ name: (document.querySelector('.library__hero-name')?.textContent ?? '').trim(), stats: (document.querySelector('.library__hero-stats')?.textContent ?? '').trim() })`)
  record('我的音乐页渲染 + 用户卡', pageShown && loaded && hero.name.length > 0, `name=${JSON.stringify(hero.name)} stats=${JSON.stringify(hero.stats)}`)
  await screenshot(PORT, 'library-1-overview.png')

  // 喜欢的音乐（卡片默认收起, 点「查看全部」展开列表）
  const likedCount = await cdpEval(PORT, `(document.querySelector('.library__card-count')?.textContent ?? '').trim()`)
  await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.library__card--wide .library__link')].find((x) => (x.textContent ?? '').includes('查看全部')); if (!b) return false; b.click(); return true })()`, false)
  const likedRowsShown = await waitFor(
    PORT,
    `document.querySelectorAll('.library__list .song-row').length > 0 && !document.querySelector('.library__hint')`,
    60_000,
    '喜欢的歌曲列表出现'
  )
  const likedListCount = await cdpEval(PORT, `document.querySelectorAll('.library__list .song-row').length`)
  record('喜欢的音乐列表出现', likedRowsShown, `count标签=${JSON.stringify(likedCount)} rows=${likedListCount}`)

  // 播放全部（喜欢）
  await cdpEval(PORT, `(() => { const b = document.querySelector('.library__card--wide .library__round--primary'); if (!b) return false; b.click(); return true })()`, false)
  const likedQueue = await waitFor(PORT, `(async () => { const s = (await window.youyou.invoke('player:state')).data; return Boolean(s && s.queue && s.queue.length > 0 && s.track) })()`, 60_000, '喜欢的音乐播放全部')
  const lp = await playerSnap()
  record('喜欢的音乐「播放全部」出声', likedQueue, `queue=${lp.queue} track=${JSON.stringify(lp.track)}`)
  const likedFull = await cdpEval(PORT, `(async () => { const r = (await window.youyou.invoke('library:overview')).data; return r?.likedTrackIDs?.length ?? -1 })()`)
  record('「播放全部」队列=喜欢的音乐总数', likedQueue && likedFull > 0 ? lp.queue === likedFull : false, `queue=${lp.queue} likedTotal=${likedFull}`)

  // 点一首喜欢的歌 → 切歌
  const likedSongName = await cdpEval(PORT, `(document.querySelectorAll('.library__list .song-row .song-row__name')[1]?.textContent ?? document.querySelectorAll('.library__list .song-row .song-row__name')[0]?.textContent ?? '').trim()`)
  if (likedSongName) {
    await cdpEval(PORT, `(() => { const r = document.querySelectorAll('.library__list .song-row')[1] ?? document.querySelector('.library__list .song-row'); if (!r) return false; r.click(); return true })()`, false)
    const switched = await waitFor(PORT, `(async () => { const s = (await window.youyou.invoke('player:state')).data; return Boolean(s && s.track && s.track.name === ${JSON.stringify(likedSongName)}) })()`, 40_000, '点喜欢列表切歌')
    record('点喜欢的歌切到该曲', switched, `song=${JSON.stringify(likedSongName)} track=${JSON.stringify((await playerSnap()).track)}`)
  } else {
    record('点喜欢的歌切到该曲', false, '喜欢列表无歌可点')
  }

  // 我喜欢的音乐是页内展开, 无独立详情页 — 验证展开/收起往返
  const barShown = await cdpEval(PORT, `Boolean(document.querySelector('.library__list-bar'))`)
  await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.library__card--wide .library__link')].find((x) => (x.textContent ?? '').includes('收起')); if (!b) return false; b.click(); return true })()`, false)
  const collapsed = await waitFor(PORT, `!document.querySelector('.library__list-bar')`, 8_000, '收起喜欢的音乐列表')
  record('喜欢的音乐展开/收起往返', barShown && collapsed)

  // 我的歌单：分组与新建
  const groups = await cdpEval(PORT, `({ created: (document.querySelector('.library__sub-title')?.textContent ?? '').trim(), tiles: document.querySelectorAll('.library-tile').length })`)
  record('我的歌单分组渲染', groups.tiles > 0, `created组=${JSON.stringify(groups.created)} tiles=${groups.tiles}`)
  await cdpEval(PORT, `(() => { const b = document.querySelector('.library__card-tools [title="新建歌单"]') ?? document.querySelector('[title="新建歌单"]'); if (!b) return false; b.click(); return true })()`, false)
  const dialogShown = await waitFor(PORT, `Boolean(document.querySelector('.dialog .text-input'))`, 8_000, '新建歌单弹窗')
  await cdpEval(PORT, `(() => {
    const input = document.querySelector('.dialog .text-input')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(PLAYLIST_NAME)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`, false)
  await wait(400)
  await cdpEval(PORT, `(() => { const b = document.querySelector('.dialog .button--primary'); if (!b) return false; b.click(); return true })()`, false)
  const created = await waitFor(
    PORT,
    `[...document.querySelectorAll('.library-tile')].some((t) => (t.querySelector('.library-tile__title')?.textContent ?? '').trim() === ${JSON.stringify(PLAYLIST_NAME)})`,
    30_000,
    '新建歌单出现在列表'
  )
  const afterCreateCount = await cdpEval(PORT, `document.querySelectorAll('.library-tile').length`)
  record('新建歌单成功且出现在列表', dialogShown && created, `tiles=${groups.tiles} → ${afterCreateCount}`)
  await screenshot(PORT, 'library-2-created.png')

  // 右键新建的歌单 → 删除 → 确认
  const ctxShown = await cdpEval(PORT, `(() => {
    const tile = [...document.querySelectorAll('.library-tile')].find((t) => (t.querySelector('.library-tile__title')?.textContent ?? '').trim() === ${JSON.stringify(PLAYLIST_NAME)})
    if (!tile) return false
    tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 300 }))
    return true
  })()`, false)
  const menuShown = await waitFor(PORT, `[...document.querySelectorAll('button, .context-menu__item')].some((b) => (b.textContent ?? '').includes('删除'))`, 8_000, '右键菜单出现')
  await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('button, .context-menu__item')].find((x) => (x.textContent ?? '').includes('删除')); if (!b) return false; b.click(); return true })()`, false)
  const confirmShown = await waitFor(PORT, `Boolean(document.querySelector('.dialog'))`, 8_000, '删除确认弹窗')
  const confirmText = await cdpEval(PORT, `(document.querySelector('.library__dialog-text')?.textContent ?? '').trim()`)
  await cdpEval(PORT, `(() => { const b = document.querySelector('.dialog .button--primary'); if (!b) return false; b.click(); return true })()`, false)
  const removed = await waitFor(
    PORT,
    `![...document.querySelectorAll('.library-tile')].some((t) => (t.querySelector('.library-tile__title')?.textContent ?? '').trim() === ${JSON.stringify(PLAYLIST_NAME)})`,
    30_000,
    '删除后列表移除'
  )
  const afterDeleteCount = await cdpEval(PORT, `document.querySelectorAll('.library-tile').length`)
  record('右键删除歌单（含确认弹窗）', ctxShown && menuShown && confirmShown && removed, `确认文案=${JSON.stringify(confirmText)} tiles=${afterCreateCount} → ${afterDeleteCount}`)
  await screenshot(PORT, 'library-3-deleted.png')

  // 点歌单 tile 进详情（onClick 在内部 ArtCard 上）
  await cdpEval(PORT, `(() => { const t = document.querySelector('.library-tile .card'); if (!t) return false; t.click(); return true })()`, false)
  const tileDetail = await waitFor(PORT, `Boolean(document.querySelector('.hero__title'))`, 45_000, '点歌单进详情')
  record('点歌单卡片进歌单详情页', tileDetail)
  await cdpEval(PORT, `(() => { const b = document.querySelector('.top-row button'); if (!b) return false; b.click(); return true })()`, false)
  await waitFor(PORT, `Boolean(document.querySelector('.page.library'))`, 10_000, '返回我的音乐')

  // 最近播放
  const recentRows = await cdpEval(PORT, `document.querySelectorAll('.library-recent__row').length`)
  record('最近播放列表渲染', recentRows > 0, `rows=${recentRows}`)
  if (recentRows > 0) {
    const recentName = await cdpEval(PORT, `(document.querySelector('.library-recent__row .song-row__name')?.textContent ?? '').trim()`)
    await cdpEval(PORT, `(() => { const b = document.querySelector('.library-recent__row .song-row__play'); if (!b) return false; b.click(); return true })()`, false)
    const recentPlayed = await waitFor(PORT, `(async () => { const s = (await window.youyou.invoke('player:state')).data; return Boolean(s && s.track && s.track.name === ${JSON.stringify(recentName)}) })()`, 40_000, '点最近播放行切歌')
    record('点最近播放行切到该曲', recentPlayed, `song=${JSON.stringify(recentName)}`)
  } else {
    record('点最近播放行切到该曲', false, '无最近播放记录')
  }

  const errors = monitor.getErrors()
  record('场景 A 全程控制台无报错', errors.length === 0, errors.slice(0, 5).map((e) => `${e.type}: ${e.text}`.slice(0, 140)).join(' | '))
}

/** 场景 B：library:overview 首次失败 → 错误卡 + 重试恢复 */
async function scenarioB(child, monitor) {
  record('场景 B 实例启动并连上 CDP', true)
  await clickSidebar(PORT, '我的音乐')
  const errShown = await waitFor(PORT, `Boolean(document.querySelector('.page.library .page__error'))`, 20_000, '错误卡出现')
  const errText = await cdpEval(PORT, `(document.querySelector('.page.library .page__error')?.textContent ?? '').trim()`)
  record('断数据时出现错误卡', errShown, `文案=${JSON.stringify(errText)}`)
  await screenshot(PORT, 'library-4-error.png')
  await cdpEval(PORT, `(() => { const b = document.querySelector('.page.library .page__error + .button') ?? document.querySelector('.page.library .button'); if (!b) return false; b.click(); return true })()`, false)
  const recovered = await waitFor(PORT, `Boolean(document.querySelector('.page.library')) && !document.querySelector('.page.library .page__error') && !document.querySelector('.page.library .placeholder')`, 60_000, '点重试后恢复')
  record('点「重试」后音乐库恢复', recovered)
  const errors = monitor.getErrors()
  record('场景 B 全程控制台无报错', errors.length === 0, errors.slice(0, 3).map((e) => `${e.type}: ${e.text}`.slice(0, 140)).join(' | '))
}

async function main() {
  const base = path.join(os.tmpdir(), 'youyou-qa-library')
  const { child, ready } = await boot({ port: PORT, userData: base, withRealState: true })
  if (!ready) {
    log('场景 A 实例启动失败')
  } else {
    const monitor = await startConsoleMonitor(PORT)
    try {
      try {
        await scenarioA(child, monitor)
      } catch (cause) {
        log(`场景 A 中断: ${cause?.message ?? cause}`)
      }
    } finally {
      monitor.stop()
      await shutdown({ port: PORT, child })
    }
  }

  const b = await boot({ port: PORT, userData: `${base}-fail`, withRealState: true, extraEnv: { YOYOU_FAIL_LIBRARY: '1' } })
  if (!b.ready) {
    log('场景 B 实例启动失败')
  } else {
    const monitorB = await startConsoleMonitor(PORT)
    try {
      try {
        await scenarioB(b.child, monitorB)
      } catch (cause) {
        log(`场景 B 中断: ${cause?.message ?? cause}`)
      }
    } finally {
      monitorB.stop()
      await shutdown({ port: PORT, child: b.child })
    }
  }

  finish(results, '我的音乐页存在失败项')
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
