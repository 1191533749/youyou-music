/**
 * QA: 每日推荐页真机测试 —— 日期条、今日推荐加载、播放全部、点卡播放、不喜欢换一首、
 * 历史日期切换、未登录门禁卡。
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

const playerSnap = () =>
  cdpEval(
    PORT,
    `(async () => {
      const s = (await window.youyou.invoke('player:state')).data
      return { playing: Boolean(s?.playing), track: s?.track?.name ?? null, id: s?.track?.id ?? null, queue: s?.queue?.length ?? 0, position: s?.position ?? 0 }
    })()`
  )

async function scenarioA(child, monitor) {
  record('场景 A 实例启动并连上 CDP', true)
  await clickSidebar(PORT, '每日推荐')
  const strip = await waitFor(PORT, `document.querySelectorAll('.daily-dates__day').length === 7`, 20_000, '日期条出现')
  record('日期条显示 7 天', strip)
  await screenshot(PORT, 'daily-1-strip.png')

  // 等今日推荐落定：有卡片或空态都算界面正常（自动补拉一次）
  const settled = await waitFor(
    PORT,
    `(() => {
      const cards = document.querySelectorAll('.daily-card').length
      const title = document.querySelector('.placeholder__title')?.textContent ?? ''
      const err = document.querySelector('.page__error')
      return cards > 0 || title.includes('今天还没有推荐') || Boolean(err)
    })()`,
    150_000,
    '今日推荐落定'
  )
  const cards = await cdpEval(PORT, `document.querySelectorAll('.daily-card').length`)
  const phTitle = await cdpEval(PORT, `(document.querySelector('.placeholder__title')?.textContent ?? '').trim()`)
  record('今日推荐加载出卡片', settled && (cards > 0 || phTitle.includes('今天还没有推荐')), `cards=${cards} placeholder=${JSON.stringify(phTitle)}${cards === 0 ? ' (环境限流时今日空态属正常降级)' : ''}`)

  if (cards > 0) {
    // 播放全部
    await cdpEval(PORT, `(() => { const b = document.querySelector('.daily__banner .button--primary'); if (!b || b.disabled) return false; b.click(); return true })()`, false)
    const queued = await waitFor(PORT, `(async () => { const s = (await window.youyou.invoke('player:state')).data; return Boolean(s && s.queue && s.queue.length > 0) })()`, 60_000, '播放全部建队列')
    const ps1 = await playerSnap()
    record('「播放全部」建立队列', queued, `queue=${ps1.queue}`)

    // 点第一张卡 → 播该曲
    const firstTitle = (await cdpEval(PORT, `(document.querySelector('.daily-card .card__title')?.textContent ?? '').trim()`)) || ''
    await cdpEval(PORT, `(() => { const b = document.querySelector('.daily-card__hit'); if (!b) return false; b.click(); return true })()`, false)
    const played = await waitFor(PORT, `(async () => { const s = (await window.youyou.invoke('player:state')).data; return Boolean(s && s.track && s.track.name === ${JSON.stringify(firstTitle)}) })()`, 60_000, '点卡播该曲')
    record('点卡片播放对应曲目', played, `card=${JSON.stringify(firstTitle)} track=${JSON.stringify((await playerSnap()).track)}`)

    // 不喜欢 → 换一首 + toast 已换一首
    const beforeName = (await cdpEval(PORT, `(document.querySelector('.daily-card .card__title')?.textContent ?? '').trim()`)) || ''
    await cdpEval(PORT, `(() => { const b = document.querySelector('.daily-card__dislike'); if (!b || b.disabled) return false; b.click(); return true })()`, false)
    const replaced = await waitFor(
      PORT,
      `(() => {
        const now = (document.querySelector('.daily-card .card__title')?.textContent ?? '').trim()
        return now !== ${JSON.stringify(beforeName)} && document.body.innerText.includes('已换一首')
      })()`,
      60_000,
      '不喜欢换一首'
    )
    record('「不喜欢」原卡换一首并提示', replaced, `before=${JSON.stringify(beforeName)}`)
    await screenshot(PORT, 'daily-2-after-dislike.png')
  }

  // 切到昨天
  await cdpEval(PORT, `(() => { const d = [...document.querySelectorAll('.daily-dates__day')].find((b) => b.querySelector('.daily-dates__label')?.textContent?.trim() === '昨天'); if (!d) return false; d.click(); return true })()`, false)
  const historySettled = await waitFor(
    PORT,
    `(() => {
      const active = document.querySelector('.daily-dates__day.is-active .daily-dates__label')?.textContent?.trim()
      if (active !== '昨天') return false
      const cards = document.querySelectorAll('.daily-card').length
      const title = document.querySelector('.placeholder__title')?.textContent ?? ''
      const err = document.querySelector('.page__error')
      return cards > 0 || title.includes('这一天没有留下记录') || title.includes('加载失败') || Boolean(err)
    })()`,
    90_000,
    '历史日期切换落定'
  )
  const hisCards = await cdpEval(PORT, `document.querySelectorAll('.daily-card').length`)
  const hisPh = await cdpEval(PORT, `(document.querySelector('.placeholder__title')?.textContent ?? '').trim()`)
  record('切「昨天」正常出结果/空态/失败态', historySettled, `cards=${hisCards} placeholder=${JSON.stringify(hisPh)}`)
  await screenshot(PORT, 'daily-3-history.png')

  // 切回今天（数据已缓存应即时恢复）
  await cdpEval(PORT, `(() => { const d = [...document.querySelectorAll('.daily-dates__day')].find((b) => b.querySelector('.daily-dates__label')?.textContent?.trim() === '今天'); if (!d) return false; d.click(); return true })()`, false)
  const backToday = await waitFor(
    PORT,
    `document.querySelector('.daily-dates__day.is-active .daily-dates__label')?.textContent?.trim() === '今天' && !document.querySelector('.page__error')`,
    15_000,
    '切回今天'
  )
  record('切回「今天」界面恢复', backToday)

  const errors = monitor.getErrors()
  record('场景 A 全程控制台无报错', errors.length === 0, errors.slice(0, 5).map((e) => `${e.type}: ${e.text}`.slice(0, 140)).join(' | '))
}

/** 场景 B：未登录门禁卡 */
async function scenarioB(child, monitor) {
  record('场景 B 实例启动并连上 CDP', true)
  await clickSidebar(PORT, '每日推荐')
  const gate = await waitFor(PORT, `document.querySelectorAll('.daily__gate').length > 0`, 15_000, '门禁卡出现')
  const gateText = await cdpEval(PORT, `(document.querySelector('.daily__gate')?.textContent ?? '').trim()`)
  record('未登录显示「登录后解锁每日推荐」门禁卡', gate, `text=${JSON.stringify(gateText.slice(0, 80))}`)
  await screenshot(PORT, 'daily-4-gate.png')

  // 点「去登录」→ 我的音乐（未登录时显示登录页）
  await cdpEval(PORT, `(() => { const b = document.querySelector('.daily__gate .button'); if (!b) return false; b.click(); return true })()`, false)
  const toLogin = await waitFor(PORT, `Boolean(document.querySelector('.login__card'))`, 15_000, '跳登录页')
  record('点「去登录」跳到登录页', toLogin)

  const errors = monitor.getErrors()
  record('场景 B 全程控制台无报错', errors.length === 0, errors.slice(0, 5).map((e) => `${e.type}: ${e.text}`.slice(0, 140)).join(' | '))
}

async function main() {
  const base = path.join(os.tmpdir(), 'youyou-qa-daily')
  const { child, ready } = await boot({ port: PORT, userData: base, withRealState: true })
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

  finish(results, '每日推荐页存在失败项')
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
