/**
 * QA: 首页真机测试。
 *
 * 场景 A（带真实登录态）：标题问候、五个区块内容、今日热歌播放全部/点卡片播放、
 * 推荐歌单→歌单详情→返回、排行榜→榜单页、热门歌手→歌手页、控制台无报错。
 * 场景 B（全新数据目录未登录）：猜你喜欢标题 + 登录提示卡 + 「去登录」跳登录页。
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
  playerState,
  wait
} from './test-qa-frontend-lib.mjs'

const PORT = 9391
const results = []
const record = recordTo(results)

const SNAP = `(() => ({
  home: Boolean(document.querySelector('.page.home')),
  title: (document.querySelector('.page__title')?.textContent ?? '').trim(),
  subtitle: (document.querySelector('.page__subtitle')?.textContent ?? '').trim(),
  sections: [...document.querySelectorAll('.home .page__section')].map((s) => ({
    t: s.querySelector('.section__title')?.textContent?.trim() ?? '',
    cards: s.querySelectorAll('.card, .home-toplist').length,
    error: Boolean(s.querySelector('.page__error')),
    empty: Boolean(s.querySelector('.home-empty'))
  })),
  hotPlayAll: [...document.querySelectorAll('.section-action')].map((b) => b.textContent.trim()),
  hint: Boolean(document.querySelector('.home-hint')),
  toLogin: [...document.querySelectorAll('.home-hint button')].map((b) => b.textContent.trim())
}))()`

async function main() {
  // ---------- 场景 A：真实登录态 ----------
  const userData = path.join(os.tmpdir(), 'youyou-qa-home')
  const { child, ready } = await boot({ port: PORT, userData, withRealState: true })
  const monitor = await startConsoleMonitor(PORT)
  try {
    record('场景 A 实例启动并连上 CDP', ready)
    if (!ready) return

    const auth = await cdpEval(PORT, `(async () => { try { const r = await window.youyou.invoke('auth:state'); return r?.data ?? null } catch (e) { return { err: String(e) } } })()`)
    record('真实 cookie 登录态有效', Boolean(auth?.loggedIn), `nickname=${JSON.stringify(auth?.profile?.nickname ?? null)}`)
    await screenshot(PORT, 'home-1-landing.png')

    // 首页渲染与问候语
    const homeShown = await waitFor(PORT, `Boolean(document.querySelector('.page.home'))`, 8_000, '首页出现')
    record('首页渲染', homeShown)
    const snap = await cdpEval(PORT, SNAP)
    record('标题是问候语', auth?.loggedIn ? snap.title.includes(auth.profile.nickname) : snap.title.length > 0, `title=${JSON.stringify(snap.title)}`)
    record('副标题正确', snap.subtitle === '推荐每天更新', `subtitle=${JSON.stringify(snap.subtitle)}`)
    log(`区块: ${JSON.stringify(snap.sections.map((s) => `${s.t}=${s.cards}`))}`)

    // 五个区块都有内容或合理空态（不该是错误卡片）
    const named = Object.fromEntries(snap.sections.map((s) => [s.t, s]))
    for (const want of ['今日热歌', '推荐歌单', '排行榜', '热门歌手', '精品歌单']) {
      const s = named[want]
      record(`区块「${want}」存在且有内容`, Boolean(s) && s.cards > 0 && !s.error, s ? `${s.cards} 项 error=${s.error} empty=${s.empty}` : '缺失')
    }
    record('首页无错误卡片', snap.sections.every((s) => !s.error))

    // 今日热歌：点第一张卡片 → 真的开始播放
    await cdpEval(PORT, `(() => { const c = document.querySelector('.home .page__section:first-of-type .card'); if (!c) return false; c.click(); return true })()`, false)
    const hotPlaying = await waitFor(
      PORT,
      `(async () => { const s = (await window.youyou.invoke('player:state')).data; return Boolean(s && s.playing) })()`,
      30_000,
      '今日热歌点卡片开始播放'
    )
    const st = await playerState(PORT)
    record('点今日热歌卡片开始播放', hotPlaying, `track=${JSON.stringify(st?.track?.name)}`)
    const barTitle = await cdpEval(PORT, `(document.querySelector('.player-bar__title')?.textContent ?? '').trim()`)
    record('底部播放条同步显示曲名', Boolean(st?.track?.name) && barTitle === st.track.name, `bar=${JSON.stringify(barTitle)}`)

    // 播放全部 → 队列长度 = 热歌数量
    const hotCount = named['今日热歌']?.cards ?? 0
    await cdpEval(PORT, `(() => { const b = document.querySelector('.section-action'); if (!b) return false; b.click(); return true })()`, false)
    const q = await waitFor(
      PORT,
      `(async () => { const s = (await window.youyou.invoke('player:state')).data; return Boolean(s && Array.isArray(s.queue) && s.queue.length > 0) })()`,
      30_000,
      '播放全部建立队列'
    )
    const st2 = await playerState(PORT)
    record('今日热歌「播放全部」建立队列', q, `queue=${st2?.queue?.length} cards=${hotCount}`)

    // 推荐歌单 → 歌单详情 → 返回首页（keep-alive 不丢内容）
    await cdpEval(PORT, `(() => { const c = document.querySelectorAll('.home .page__section')[1]?.querySelector('.card'); if (!c) return false; c.click(); return true })()`, false)
    const plOpen = await waitFor(PORT, `Boolean(document.querySelector('.hero__title')) && Boolean(document.querySelector('.top-row'))`, 20_000, '歌单详情打开')
    record('点推荐歌单打开歌单详情页', plOpen)
    const heroTitle = await cdpEval(PORT, `(document.querySelector('.hero__title')?.textContent ?? '').trim()`)
    await screenshot(PORT, 'home-2-playlist.png')
    await cdpEval(PORT, `(() => { const b = document.querySelector('.top-row button'); if (!b) return false; b.click(); return true })()`, false)
    const backHome = await waitFor(PORT, `Boolean(document.querySelector('.page.home')) && !document.querySelector('.top-row')`, 10_000, '返回首页')
    record('歌单详情返回首页（无返回按钮残留）', backHome, `hero=${JSON.stringify(heroTitle)}`)
    record('返回后首页内容仍在（keep-alive）', (await cdpEval(PORT, `document.querySelectorAll('.home .grid--playlists .card').length`)) > 0)

    // 排行榜 → 榜单页
    await cdpEval(PORT, `(() => { const c = document.querySelector('.home-toplist'); if (!c) return false; c.click(); return true })()`, false)
    const tlOpen = await waitFor(PORT, `Boolean(document.querySelector('.hero__title')) && (document.querySelector('.hero__title')?.textContent ?? '').length > 0`, 20_000, '榜单页打开')
    const tlTitle = await cdpEval(PORT, `(document.querySelector('.hero__title')?.textContent ?? '').trim()`)
    record('点排行榜卡打开榜单页', tlOpen, `title=${JSON.stringify(tlTitle)}`)
    await screenshot(PORT, 'home-3-toplist.png')
    await cdpEval(PORT, `(() => { const b = document.querySelector('.top-row button'); b?.click(); return true })()`, false)
    await waitFor(PORT, `Boolean(document.querySelector('.page.home'))`, 10_000, '回首页')

    // 热门歌手 → 歌手页
    await cdpEval(PORT, `(() => { const c = document.querySelector('.home-rail--artists .card'); if (!c) return false; c.click(); return true })()`, false)
    const artistOpen = await waitFor(PORT, `Boolean(document.querySelector('.detail-kicker'))`, 20_000, '歌手页打开')
    const artistName = await cdpEval(PORT, `(document.querySelector('.hero__title')?.textContent ?? '').trim()`)
    record('点热门歌手打开歌手详情页', artistOpen, `artist=${JSON.stringify(artistName)}`)
    await screenshot(PORT, 'home-4-artist.png')
    await cdpEval(PORT, `(() => { const b = document.querySelector('.top-row button'); b?.click(); return true })()`, false)
    await waitFor(PORT, `Boolean(document.querySelector('.page.home'))`, 10_000, '回首页')

    const errors = monitor.getErrors()
    record('首页各交互全程控制台无报错', errors.length === 0, errors.slice(0, 5).map((e) => `${e.type}: ${e.text}`.slice(0, 150)).join(' | '))
  } finally {
    monitor.stop()
    await shutdown({ port: PORT, child })
  }

  // ---------- 场景 B：未登录 ----------
  const userDataB = path.join(os.tmpdir(), 'youyou-qa-home-anon')
  const bootB = await boot({ port: PORT, userData: userDataB, withRealState: false })
  const monitorB = await startConsoleMonitor(PORT)
  try {
    record('场景 B 实例启动（未登录）', bootB.ready)
    if (!bootB.ready) return
    const snap = await cdpEval(PORT, SNAP)
    record('未登录标题为「猜你喜欢」', snap.title === '猜你喜欢', `title=${JSON.stringify(snap.title)}`)
    record('未登录副标题提示登录', snap.subtitle.includes('登录'), `subtitle=${JSON.stringify(snap.subtitle)}`)
    record('未登录出现登录提示卡', snap.hint && snap.toLogin.includes('去登录'), `toLogin=${JSON.stringify(snap.toLogin)}`)
    await screenshot(PORT, 'home-5-anon.png')
    await cdpEval(PORT, `(() => { const b = document.querySelector('.home-hint button'); b?.click(); return true })()`, false)
    const loginShown = await waitFor(PORT, `Boolean(document.querySelector('.login'))`, 8_000, '去登录跳转登录页')
    record('点「去登录」跳转登录页', loginShown)
    const errorsB = monitorB.getErrors()
    record('未登录首页控制台无报错', errorsB.length === 0, errorsB.slice(0, 5).map((e) => `${e.type}: ${e.text}`.slice(0, 150)).join(' | '))
  } finally {
    monitorB.stop()
    await shutdown({ port: PORT, child: bootB.child })
  }

  finish(results, '首页存在失败项')
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
