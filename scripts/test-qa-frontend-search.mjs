/**
 * QA: 搜索页真机测试（综合/单曲/歌手/专辑/歌单五个 tab + 空态 + 兜底 + 断数据路径）。
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
  log
} from './test-qa-frontend-lib.mjs'

const PORT = 9391
const results = []
const record = recordTo(results)

const typeInSearch = (selector, text) =>
  `(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(text)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`

const pressEnter = (selector) =>
  `(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) return false
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`

const SNAP = `(() => ({
  hero: Boolean(document.querySelector('.search-hero')),
  heroPlaceholder: document.querySelector('.search-hero__input')?.placeholder ?? null,
  avatarWall: document.querySelectorAll('.avatar-wall__item').length,
  barInput: Boolean(document.querySelector('.search-bar__input')),
  tabs: [...document.querySelectorAll('.search__tabs .chip')].map((c) => c.textContent.trim()),
  activeTab: document.querySelector('.search__tabs .chip.is-active')?.textContent?.trim() ?? null,
  sections: [...document.querySelectorAll('.search .page__section .section__title')].map((s) => s.textContent.trim()),
  songCards: (() => {
    const sec = [...document.querySelectorAll('.search .page__section')].find((s) => s.querySelector('.section__title')?.textContent?.trim() === '单曲')
    return sec ? sec.querySelectorAll('.grid--albums .card').length : 0
  })(),
  songRows: document.querySelectorAll('.search .song-list .song-row:not(.song-row--external)').length,
  externalRows: document.querySelectorAll('.search .song-row--external').length,
  artistCards: document.querySelectorAll('.search .grid--artists .card').length,
  playlistCards: document.querySelectorAll('.search .grid--playlists .card').length,
  error: (document.querySelector('.search .page__error')?.textContent ?? '').trim(),
  placeholder: (document.querySelector('.search .placeholder__title')?.textContent ?? '').trim(),
  loading: Boolean(document.querySelector('.search__loading')),
  refreshing: Boolean(document.querySelector('.search .refresh-bar')),
  moreBtn: (document.querySelector('.search .search__more .button')?.textContent ?? '').trim()
}))()`

const playerSnap = () =>
  cdpEval(
    PORT,
    `(async () => {
      const s = (await window.youyou.invoke('player:state')).data
      return { playing: Boolean(s?.playing), track: s?.track?.name ?? null, queue: s?.queue?.length ?? 0, index: s?.index ?? null, error: s?.error ?? null }
    })()`
  )

/** 场景 A：登录态正常搜索全流程 */
async function scenarioA(child, monitor) {
  record('场景 A 实例启动并连上 CDP', true)
  await clickSidebar(PORT, '搜索')
  const heroOk = await waitFor(PORT, `Boolean(document.querySelector('.search-hero'))`, 8_000, '空态大搜索框出现')
  const heroSnap = await cdpEval(PORT, SNAP)
  record('搜索页空态：大搜索框 + 头像墙', heroOk && heroSnap.heroPlaceholder === '搜索歌曲、歌手', `placeholder=${JSON.stringify(heroSnap.heroPlaceholder)} wall=${heroSnap.avatarWall}`)
  record('空态不显示页签', heroSnap.tabs.length === 0)
  await screenshot(PORT, 'search-1-hero.png')

  // 输入并回车搜索
  await cdpEval(PORT, typeInSearch('.search-hero__input', '周杰伦'))
  await cdpEval(PORT, pressEnter('.search-hero__input'))
  const entered = await waitFor(PORT, `Boolean(document.querySelector('.search-bar__input'))`, 8_000, '进入搜索态')
  const tabsShown = await waitFor(PORT, `document.querySelectorAll('.search__tabs .chip').length === 5`, 8_000, '五个页签出现')
  record('回车后进入搜索态并显示五页签', entered && tabsShown)
  const loaded = await waitFor(
    PORT,
    `document.querySelectorAll('.search .page__section').length >= 3 && !document.querySelector('.search__loading')`,
    90_000,
    '综合结果出现'
  )
  const snap = await cdpEval(PORT, SNAP)
  record('综合页签四个区块出内容', loaded && snap.sections.includes('单曲') && snap.sections.includes('歌手') && snap.sections.includes('专辑') && snap.sections.includes('歌单'), `sections=${JSON.stringify(snap.sections)} songCards=${snap.songCards}`)
  record('综合页签有单曲卡片', snap.songCards > 0, `songCards=${snap.songCards}`)
  await screenshot(PORT, 'search-2-comprehensive.png')

  // 播放全部 → 建队列（只作用于「单曲」区，该区仅含主进程已过滤的可播曲目）
  await cdpEval(PORT, `(() => { const sec = [...document.querySelectorAll('.search .page__section')].find((s) => s.querySelector('.section__title')?.textContent?.trim() === '单曲'); const btn = sec?.querySelector('.section-action'); if (!btn) return false; btn.click(); return true })()`, false)
  const queueBuilt = await waitFor(
    PORT,
    `(async () => { const s = (await window.youyou.invoke('player:state')).data; return Boolean(s && s.queue && s.queue.length > 0) })()`,
    30_000,
    '播放全部建立队列'
  )
  const ps = await playerSnap()
  record('单曲区「播放全部」建立队列', queueBuilt, `queue=${ps.queue}`)

  // 点单曲卡片 → 切歌
  const cardName = await cdpEval(PORT, `(() => { const sec = [...document.querySelectorAll('.search .page__section')].find((s) => s.querySelector('.section__title')?.textContent?.trim() === '单曲'); return (sec?.querySelector('.grid--albums .card .card__title')?.textContent ?? '').trim() })()`)
  await cdpEval(PORT, `(() => { const sec = [...document.querySelectorAll('.search .page__section')].find((s) => s.querySelector('.section__title')?.textContent?.trim() === '单曲'); const c = sec?.querySelector('.grid--albums .card'); if (!c) return false; c.click(); return true })()`, false)
  const switched = await waitFor(
    PORT,
    `(async () => { const s = (await window.youyou.invoke('player:state')).data; return Boolean(s && s.track && s.track.name === ${JSON.stringify(cardName)}) })()`,
    30_000,
    '点卡片切到该曲'
  )
  record('点单曲卡片切到该曲', switched, `card=${JSON.stringify(cardName)} track=${JSON.stringify((await playerSnap()).track)}`)

  // 各页签
  for (const [tab, selector, countExpr] of [
    ['单曲', '.search .song-list .song-row:not(.song-row--external)', 3],
    ['歌手', '.search .grid--artists .card', 1],
    ['专辑', '.search .grid--albums .card', 3],
    ['歌单', '.search .grid--playlists .card', 5]
  ]) {
    await cdpEval(PORT, `(() => { const c = [...document.querySelectorAll('.search__tabs .chip')].find((x) => x.textContent.trim() === ${JSON.stringify(tab)}); c?.click(); return true })()`, false)
    const ok = await waitFor(
      PORT,
      `document.querySelector('.search__tabs .chip.is-active')?.textContent?.trim() === ${JSON.stringify(tab)} && document.querySelectorAll(${JSON.stringify(selector)}).length >= ${countExpr} && !document.querySelector('.search__loading')`,
      90_000,
      `页签「${tab}」出内容`
    )
    const count = await cdpEval(PORT, `document.querySelectorAll(${JSON.stringify(selector)}).length`)
    record(`页签「${tab}」有内容`, ok, `count=${count}`)
    if (tab === '单曲') await screenshot(PORT, 'search-3-songs-tab.png')
  }

  // 歌单页签加载更多（无按钮=结果不足一页，属正常，不算失败）
  const beforeMore = await cdpEval(PORT, `document.querySelectorAll('.search .grid--playlists .card').length`)
  const clickedMore = await cdpEval(PORT, `(() => { const b = document.querySelector('.search .search__more .button'); if (!b || b.disabled) return false; b.click(); return true })()`, false)
  if (clickedMore) {
    const moreOk = await waitFor(PORT, `document.querySelectorAll('.search .grid--playlists .card').length > ${beforeMore}`, 90_000, '加载更多生效')
    let afterMore = '?'
    try {
      afterMore = await cdpEval(PORT, `document.querySelectorAll('.search .grid--playlists .card').length`)
    } catch {
      /* 实例可能已死，交给外层处理 */
    }
    record('歌单页签「加载更多」生效', moreOk, `${beforeMore} → ${afterMore}`)
  } else {
    record('歌单页签「加载更多」', true, `无按钮(结果≤一页, ${beforeMore} 条) — 正常`)
  }

  // 点歌单卡 → 详情 → 返回（观察搜索状态是否保留）
  await cdpEval(PORT, `(() => { const c = document.querySelector('.search .grid--playlists .card'); if (!c) return false; c.click(); return true })()`, false)
  const plOpen = await waitFor(PORT, `Boolean(document.querySelector('.hero__title'))`, 30_000, '歌单详情打开')
  record('点歌单卡进歌单详情页', plOpen)
  await cdpEval(PORT, `(() => { const b = document.querySelector('.top-row button'); if (!b) return false; b.click(); return true })()`, false)
  await waitFor(PORT, `Boolean(document.querySelector('.search-bar__input')) && !Boolean(document.querySelector('.hero__title'))`, 15_000, '返回搜索页')
  const afterBack = await cdpEval(PORT, SNAP)
  record('返回后搜索词与结果保留', Boolean(afterBack.barInput) && (afterBack.songRows > 0 || afterBack.playlistCards > 0 || afterBack.songCards > 0 || afterBack.externalRows > 0 || afterBack.sections.length > 0), `sections=${JSON.stringify(afterBack.sections)} hero=${afterBack.hero}`)
  log(`返回后快照: hero=${afterBack.hero} barInput=${afterBack.barInput} sections=${JSON.stringify(afterBack.sections)}`)

  // 清空按钮 → 空态
  if (afterBack.barInput) {
    await cdpEval(PORT, `(() => { const b = document.querySelector('.search-bar__clear'); if (!b) return false; b.click(); return true })()`, false)
    const cleared = await waitFor(PORT, `Boolean(document.querySelector('.search-hero'))`, 8_000, '清空回到空态')
    record('点「清空」回到空态大搜索框', cleared)
  }

  // 空结果关键词
  await cdpEval(PORT, typeInSearch('.search-hero__input', 'zzqqxxwwyyuu'))
  await cdpEval(PORT, pressEnter('.search-hero__input'))
  const emptySettled = await waitFor(
    PORT,
    `(() => {
      if (document.querySelector('.search__loading')) return false
      const ph = document.querySelector('.search .placeholder__title')
      const ext = document.querySelectorAll('.search .song-row--external').length
      const err = document.querySelector('.search .page__error')
      return Boolean(ph || ext > 0) && !err
    })()`,
    90_000,
    '乱码词出空态或站外兜底'
  )
  const emptySnap = await cdpEval(PORT, SNAP)
  record('乱码关键词：空态或站外兜底、无错误横幅', emptySettled, `placeholder=${JSON.stringify(emptySnap.placeholder)} external=${emptySnap.externalRows}`)
  await screenshot(PORT, 'search-4-empty.png')

  const errors = monitor.getErrors()
  record('场景 A 全程控制台无报错', errors.length === 0, errors.slice(0, 5).map((e) => `${e.type}: ${e.text}`.slice(0, 140)).join(' | '))
}

/** 场景 B：网易云搜索整体失败（YOYOU_FAIL_SEARCH=1）→ 静默兜底不弹错误横幅 */
async function scenarioB(child, monitor) {
  record('场景 B 实例启动并连上 CDP', true)
  await clickSidebar(PORT, '搜索')
  await waitFor(PORT, `Boolean(document.querySelector('.search-hero'))`, 8_000, '空态出现')
  await cdpEval(PORT, typeInSearch('.search-hero__input', '周杰伦'))
  await cdpEval(PORT, pressEnter('.search-hero__input'))
  const settled = await waitFor(
    PORT,
    `(() => {
      if (document.querySelector('.search__loading')) return false
      const ph = document.querySelector('.search .placeholder__title')
      const ext = document.querySelectorAll('.search .song-row--external').length
      const err = document.querySelector('.search .page__error')
      return Boolean(ph || ext > 0) && !err
    })()`,
    90_000,
    '断数据后静默兜底完成'
  )
  const snap = await cdpEval(PORT, SNAP)
  record('网易云搜索失败：不弹错误横幅、走静默兜底', settled, `placeholder=${JSON.stringify(snap.placeholder)} external=${snap.externalRows}`)
  await screenshot(PORT, 'search-5-fail-search.png')
  const errors = monitor.getErrors()
  record('场景 B 全程控制台无报错', errors.length === 0, errors.slice(0, 3).map((e) => `${e.type}: ${e.text}`.slice(0, 140)).join(' | '))
}

/** 场景 C：单曲强制站外（YOYOU_FORCE_EXTERNAL=1）→ 站外列表 + 可播放 */
async function scenarioC(child, monitor) {
  record('场景 C 实例启动并连上 CDP', true)
  await clickSidebar(PORT, '搜索')
  await waitFor(PORT, `Boolean(document.querySelector('.search-hero'))`, 8_000, '空态出现')
  await cdpEval(PORT, typeInSearch('.search-hero__input', '周杰伦'))
  await cdpEval(PORT, pressEnter('.search-hero__input'))
  const extShown = await waitFor(
    PORT,
    `document.querySelectorAll('.search .song-row--external').length > 0 && !document.querySelector('.search__loading')`,
    90_000,
    '站外单曲列出'
  )
  const extCount = await cdpEval(PORT, `document.querySelectorAll('.search .song-row--external').length`)
  const firstExt = await cdpEval(PORT, `(document.querySelector('.search .song-row--external .song-row__name')?.textContent ?? '').trim()`)
  record('站外兜底列表出现', extShown, `count=${extCount} first=${JSON.stringify(firstExt)}`)
  await screenshot(PORT, 'search-6-external.png')

  // 点站外行播放按钮 → 出声（行单击不触发播放, 双击或 .song-row__play 才播）
  await cdpEval(PORT, `(() => { const r = document.querySelector('.search .song-row--external .song-row__play'); if (!r || r.disabled) return false; r.click(); return true })()`, false)
  const extPlaying = await waitFor(
    PORT,
    `(async () => {
      const s = (await window.youyou.invoke('player:state')).data
      return Boolean(s && s.track && s.playing && s.position > 0.6 && !s.error)
    })()`,
    120_000,
    '站外曲目出声'
  )
  const ps = await playerSnap()
  record('点站外曲目真的出声', extPlaying, `track=${JSON.stringify(ps.track)} playing=${ps.playing} error=${JSON.stringify(ps.error)}`)
  const errors = monitor.getErrors()
  record('场景 C 全程控制台无报错', errors.length === 0, errors.slice(0, 3).map((e) => `${e.type}: ${e.text}`.slice(0, 140)).join(' | '))
}

async function main() {
  const base = path.join(os.tmpdir(), 'youyou-qa-search')

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

  const b = await boot({ port: PORT, userData: `${base}-fail`, withRealState: true, extraEnv: { YOYOU_FAIL_SEARCH: '1' } })
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

  const c = await boot({ port: PORT, userData: `${base}-external`, withRealState: true, extraEnv: { YOYOU_FORCE_EXTERNAL: '1' } })
  if (!c.ready) {
    log('场景 C 实例启动失败')
  } else {
    const monitorC = await startConsoleMonitor(PORT)
    try {
      try {
        await scenarioC(c.child, monitorC)
      } catch (cause) {
        log(`场景 C 中断: ${cause?.message ?? cause}`)
      }
    } finally {
      monitorC.stop()
      await shutdown({ port: PORT, child: c.child })
    }
  }

  finish(results, '搜索页存在失败项')
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
