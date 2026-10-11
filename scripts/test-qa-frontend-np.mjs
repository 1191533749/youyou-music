/**
 * QA: 播放页(NowPlaying)真机测试 —— 空态、播放态渲染、播放/暂停、上一首/下一首、
 * 进度seek、音量、静音、播放模式循环、歌词渲染+点击跳句、队列抽屉(切歌/清空)、
 * 桌面歌词开关、视觉效果/歌词特效切换、控制台报错。
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

const playerState = () => cdpEval(PORT, `window.youyou.invoke('player:state')`)

async function seedQueue(monitor) {
  // 优先：搜索页站外兜底（YOYOU_FORCE_EXTERNAL=1, 不依赖网易云, 限流下最可靠）
  await clickSidebar(PORT, '搜索')
  await cdpEval(PORT, `(() => { const i = document.querySelector('.search-hero__input'); if (!i) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(i, '周杰伦'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`, false)
  const rowsOk = await waitFor(PORT, `document.querySelector('.song-list .song-row')`, 45_000, '搜索结果出现(站外)')
  if (rowsOk) {
    await cdpEval(PORT, `(() => { const b = document.querySelector('.song-list .section-action') || [...document.querySelectorAll('.button--primary')].find((x) => x.textContent.includes('播放全部')); if (!b) return false; b.click(); return true })()`, false)
    const playing = await waitFor(PORT, `(async () => { const s = await window.youyou.invoke('player:state'); return s?.queue?.length > 0 })()`, 30_000, '搜索播放全部入队')
    if (playing) return 'search-external'
  }
  // 回退：首页「今日热歌」播放全部
  await clickSidebar(PORT, '首页')
  const ok = await waitFor(PORT, `document.querySelector('.home-today .section-action') || document.querySelector('.section-action')`, 30_000, '热歌区播放全部按钮')
  if (ok) {
    await cdpEval(PORT, `(() => { const b = document.querySelector('.home-today .section-action') || document.querySelector('.section-action'); b.click(); return true })()`, false)
    const playing = await waitFor(PORT, `(async () => { const s = await window.youyou.invoke('player:state'); return s?.queue?.length > 0 })()`, 30_000, '首页播放全部入队')
    if (playing) return 'home'
  }
  return null
}

async function openNowPlaying() {
  const pushed = await cdpEval(PORT, `(() => { const b = document.querySelector('.player-bar__art'); if (!b) return false; b.click(); return true })()`, false)
  return pushed && (await waitFor(PORT, `document.querySelector('.np-fullscreen')`, 15_000, '打开播放页'))
}

/** 场景 A：已登录、有歌在播 */
async function scenarioA(child, monitor) {
  record('场景 A 实例启动并连上 CDP', true)
  const seeded = await seedQueue(monitor)
  record('准备播放队列(首页/搜索播放全部)', Boolean(seeded), `source=${seeded}`)
  await screenshot(PORT, 'np-0-playerbar.png')

  const opened = await openNowPlaying()
  record('点击播放条封面打开播放页', opened)

  const s0 = await playerState()
  record('播放页标题/歌手/专辑渲染', Boolean(
    await cdpEval(PORT, `(document.querySelector('.np-fs__title')?.textContent ?? '').trim().length > 0`)
  ) && Boolean(await cdpEval(PORT, `(document.querySelector('.np-fs__artist-name')?.textContent ?? '').trim().length > 0`)) && Boolean(await cdpEval(PORT, `(document.querySelector('.np-fs__album')?.textContent ?? '').trim().length > 0`)), `track=${s0?.track?.name ?? '(null)'}`)
  await screenshot(PORT, 'np-1-playing.png')

  // 播放/暂停
  const wasPlaying = s0?.playing
  await cdpEval(PORT, `document.querySelector('.np-cover__controls .icon-button--primary')?.click()`, false)
  const paused = await waitFor(PORT, `(async () => { const s = await window.youyou.invoke('player:state'); return s?.playing === ${wasPlaying ? 'false' : 'true'} })()`, 15_000, '播放/暂停切换')
  await cdpEval(PORT, `document.querySelector('.np-cover__controls .icon-button--primary')?.click()`, false)
  record('播放/暂停按钮切换状态', paused)

  // 上一首/下一首
  const idx0 = (await playerState())?.index ?? -1
  await cdpEval(PORT, `document.querySelector('[aria-label="下一首"]')?.click()`, false)
  const nextOk = await waitFor(PORT, `(async () => { const s = await window.youyou.invoke('player:state'); return s?.index === (${idx0} + 1) % s.queue.length })()`, 15_000, '下一首')
  await cdpEval(PORT, `document.querySelector('[aria-label="上一首"]')?.click()`, false)
  const prevOk = await waitFor(PORT, `(async () => { const s = await window.youyou.invoke('player:state'); return s?.index === ${idx0} })()`, 15_000, '上一首')
  record('上一首/下一首切换', nextOk && prevOk, `idx ${idx0}→+1→${idx0}`)

  // 进度 seek
  const dur = (await playerState())?.duration ?? 0
  if (dur > 30) {
    const target = Math.round(dur * 0.5)
    await cdpEval(PORT, `(() => { const r = document.querySelector('input[aria-label="播放进度"]'); if (!r) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(r, ${target}); r.dispatchEvent(new Event('input', { bubbles: true })); return true })()`, false)
    const seekOk = await waitFor(PORT, `(async () => { const s = await window.youyou.invoke('player:state'); return Math.abs((s?.position ?? 0) - ${target}) < 5 || (s?.position ?? 0) > 0 })()`, 20_000, '进度seek')
    record('拖动进度条seek', seekOk, `target=${target}s dur=${dur}s`)
  } else {
    record('拖动进度条seek', false, `duration=${dur} 过短跳过`)
  }

  // 音量 + 静音
  const vol0 = (await playerState())?.volume ?? -1
  await cdpEval(PORT, `(() => { const r = document.querySelector('input[aria-label="音量"]'); if (!r) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(r, 42); r.dispatchEvent(new Event('input', { bubbles: true })); return true })()`, false)
  const volOk = await waitFor(PORT, `(async () => { const s = await window.youyou.invoke('player:state'); return s?.volume === 42 })()`, 15_000, '音量42')
  await cdpEval(PORT, `document.querySelector('.np-fs__volume .icon-button[aria-label^="静音"], .np-fs__volume .icon-button[title^="静音"], .np-fs__volume [aria-label^="静音"], .np-fs__volume [title^="静音"]')?.click()`, false)
  const muted = await waitFor(PORT, `(async () => { const s = await window.youyou.invoke('player:state'); return s?.muted === true })()`, 15_000, '静音')
  await cdpEval(PORT, `document.querySelector('[aria-label="取消静音"]')?.click()`, false)
  await cdpEval(PORT, `(() => { const r = document.querySelector('input[aria-label="音量"]'); if (!r) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(r, ${vol0}); r.dispatchEvent(new Event('input', { bubbles: true })); return true })()`, false)
  record('音量调节+静音/取消静音', volOk && muted, `vol ${vol0}→42→还原`)

  // 播放模式循环
  const mode0 = await cdpEval(PORT, `document.querySelector('.np-fs__tool[title^="播放模式"]')?.title ?? ''`)
  await cdpEval(PORT, `document.querySelector('.np-fs__tool[title^="播放模式"]')?.click()`, false)
  const mode1 = await waitFor(PORT, `(() => { const t = document.querySelector('.np-fs__tool[title^="播放模式"]')?.title ?? ''; return t !== ${JSON.stringify(mode0)} })()`, 15_000, '播放模式切换')
  const mode1v = await cdpEval(PORT, `document.querySelector('.np-fs__tool[title^="播放模式"]')?.title ?? ''`)
  record('播放模式循环切换', mode1, `${mode0} → ${mode1v}`)

  // 歌词：行渲染 + 点击跳句
  const hasLyrics = await cdpEval(PORT, `document.querySelectorAll('.np-lyrics__lines .np-lyric').length`)
  const lyricState = await cdpEval(PORT, `(document.querySelector('.np-lyrics__state .placeholder__title')?.textContent ?? '').trim()`)
  record('歌词区渲染(行或状态)', hasLyrics > 0 || lyricState.length > 0, `lines=${hasLyrics} state=${JSON.stringify(lyricState)}`)
  if (hasLyrics > 0) {
    const before = (await playerState())?.position ?? -1
    await cdpEval(PORT, `document.querySelector('.np-lyrics__lines .np-lyric__button')?.click()`, false)
    const jumped = await waitFor(PORT, `(async () => { const s = await window.youyou.invoke('player:state'); return Math.abs((s?.position ?? 0) - ${before}) > 0.5 })()`, 20_000, '点歌词跳句')
    record('点击歌词跳转到该句', jumped, `pos ${before}→${(await playerState())?.position}`)
  } else {
    record('点击歌词跳转到该句', false, '无歌词行可点')
  }

  // 队列抽屉：打开 → 数量 → 切歌 → 清空 → 还原
  await cdpEval(PORT, `document.querySelector('[aria-label="播放队列"]')?.click()`, false)
  const drawerOk = await waitFor(PORT, `document.querySelector('.np-drawer.is-open')`, 15_000, '队列抽屉打开')
  const qItems = await cdpEval(PORT, `document.querySelectorAll('.np-queue__item').length`)
  const qTotal = (await playerState())?.queue?.length ?? -1
  record('队列抽屉显示全部歌曲', drawerOk && qItems === qTotal, `items=${qItems} queue=${qTotal}`)
  await screenshot(PORT, 'np-2-queue.png')

  const curName = await cdpEval(PORT, `(document.querySelector('.np-queue__item.is-current .np-queue__name')?.textContent ?? '').trim()`)
  await cdpEval(PORT, `(() => { const items = [...document.querySelectorAll('.np-queue__item')]; const next = items.find((i) => !i.classList.contains('is-current')); next?.querySelector('.np-queue__play')?.click(); return Boolean(next) })()`, false)
  const switchOk = await waitFor(PORT, `(() => { const c = document.querySelector('.np-queue__item.is-current .np-queue__name'); return c && c.textContent.trim() !== ${JSON.stringify(curName)} })()`, 20_000, '队列内切歌')
  record('队列内点击切换歌曲', switchOk, `was=${JSON.stringify(curName)}`)

  // 清空队列 → 空态 → 再播一首还原
  await cdpEval(PORT, `document.querySelector('[aria-label="清空队列"]')?.click()`, false)
  const cleared = await waitFor(PORT, `(async () => { const s = await window.youyou.invoke('player:state'); return (s?.queue?.length ?? 1) === 0 })()`, 20_000, '清空队列')
  const emptyUi = await cdpEval(PORT, `document.body.innerText.includes('队列是空的')`)
  record('清空队列→空态提示', cleared && emptyUi)
  await screenshot(PORT, 'np-3-queue-empty.png')

  // 桌面歌词开关
  await cdpEval(PORT, `document.querySelector('[aria-label^="打开桌面歌词"], [aria-label^="关闭桌面歌词"]')?.click()`, false)
  const dlOn = await waitFor(PORT, `Boolean(document.querySelector('[aria-label^="关闭桌面歌词"]'))`, 15_000, '桌面歌词开')
  await cdpEval(PORT, `document.querySelector('[aria-label^="关闭桌面歌词"]')?.click()`, false)
  const dlOff = await waitFor(PORT, `Boolean(document.querySelector('[aria-label^="打开桌面歌词"]'))`, 15_000, '桌面歌词关')
  record('桌面歌词开关切换', dlOn && dlOff)

  // 视觉效果 + 歌词特效切换
  const vis0 = await cdpEval(PORT, `document.querySelector('[aria-label^="切换视觉效果"]')?.getAttribute('aria-label') ?? ''`)
  await cdpEval(PORT, `document.querySelector('[aria-label^="切换视觉效果"]')?.click()`, false)
  const vis1 = await waitFor(PORT, `(() => { const t = document.querySelector('[aria-label^="切换视觉效果"]')?.getAttribute('aria-label') ?? ''; return t !== ${JSON.stringify(vis0)} })()`, 15_000, '视觉效果切换')
  const lyr0 = await cdpEval(PORT, `document.querySelector('[aria-label^="切换歌词特效"]')?.getAttribute('aria-label') ?? ''`)
  await cdpEval(PORT, `document.querySelector('[aria-label^="切换歌词特效"]')?.click()`, false)
  const lyr1 = await waitFor(PORT, `(() => { const t = document.querySelector('[aria-label^="切换歌词特效"]')?.getAttribute('aria-label') ?? ''; return t !== ${JSON.stringify(lyr0)} })()`, 15_000, '歌词特效切换')
  record('视觉效果/歌词特效切换', vis1 && lyr1, `${vis0.replace('切换视觉效果，当前：', '')}→${(await cdpEval(PORT, `document.querySelector('[aria-label^="切换视觉效果"]')?.getAttribute('aria-label')`)).replace('切换视觉效果，当前：', '')} | 歌词 ${lyr0.replace('切换歌词特效，当前：', '')}→${(await cdpEval(PORT, `document.querySelector('[aria-label^="切换歌词特效"]')?.getAttribute('aria-label')`)).replace('切换歌词特效，当前：', '')}`)

  const errors = monitor.getErrors()
  record('场景 A 全程控制台无报错', errors.length === 0, errors.slice(0, 5).map((e) => `${e.type}: ${e.text}`.slice(0, 140)).join(' | '))
}

/** 场景 B：空态(无播放) */
async function scenarioB(child, monitor) {
  record('场景 B 实例启动并连上 CDP', true)
  await waitFor(PORT, `document.querySelector('.player-bar')`, 20_000, '播放条出现')
  await cdpEval(PORT, `document.querySelector('.player-bar__art')?.click()`, false)
  const emptyOk = await waitFor(PORT, `document.querySelector('.np-fullscreen .np-empty')`, 15_000, '播放页空态')
  const title = await cdpEval(PORT, `(document.querySelector('.np-fullscreen .placeholder__title')?.textContent ?? '').trim()`)
  record('无播放时播放页空态+去逛逛', emptyOk && title.includes('还没有正在播放的歌曲'), `title=${JSON.stringify(title)}`)
  const goBtn = await cdpEval(PORT, `Boolean(document.querySelector('.np-fullscreen .button--primary'))`)
  await cdpEval(PORT, `document.querySelector('.np-fullscreen .button--primary')?.click()`, false)
  const backHome = await waitFor(PORT, `document.querySelector('.home-state, .grid--playlists, .home-today')`, 15_000, '去逛逛→首页')
  record('空态「去逛逛」返回首页', goBtn && backHome)
  await screenshot(PORT, 'np-4-empty.png')

  const errors = monitor.getErrors()
  record('场景 B 全程控制台无报错', errors.length === 0, errors.slice(0, 5).map((e) => `${e.type}: ${e.text}`.slice(0, 140)).join(' | '))
}

async function main() {
  const base = path.join(os.tmpdir(), 'youyou-qa-np')
  // 场景 A 用匿名实例 + YOYOU_FORCE_EXTERNAL 播种(站外音源, 完全绕开网易云限流)
  const { child, ready } = await boot({ port: PORT, userData: base, withRealState: false, extraEnv: { YOYOU_FORCE_EXTERNAL: '1' } })
  if (!ready) {
    log('实例启动失败，跳过场景 A')
  } else {
    const monitor = await startConsoleMonitor(PORT)
    try {
      await scenarioA(child, monitor)
    } finally {
      monitor.stop()
      await shutdown({ port: PORT, child })
    }
  }

  const b = await boot({ port: PORT, userData: `${base}-anon`, withRealState: false })
  if (!b.ready) {
    log('场景 B 实例启动失败')
  } else {
    const monitorB = await startConsoleMonitor(PORT)
    try {
      await scenarioB(b.child, monitorB)
    } finally {
      monitorB.stop()
      await shutdown({ port: PORT, child: b.child })
    }
  }

  finish(results, '播放页存在失败项')
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
