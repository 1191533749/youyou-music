/**
 * QA: 私人漫游页真机测试 —— 进入自动起播、出声、切歌、暂停/继续、不喜欢换歌、
 * 队列文案、断数据错误态（未登录/无 cookie 时 track:fm 失败）+ 重试按钮。
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
      return { playing: Boolean(s?.playing), track: s?.track?.name ?? null, id: s?.track?.id ?? null, queue: s?.queue?.length ?? 0, index: s?.index ?? null, position: s?.position ?? 0, error: s?.error ?? null }
    })()`
  )

/** 场景 A：真实登录态完整漫游流程 */
async function scenarioA(child, monitor) {
  record('场景 A 实例启动并连上 CDP', true)
  await clickSidebar(PORT, '私人漫游')
  const picking = await waitFor(
    PORT,
    `Boolean(document.querySelector('.fm .placeholder') || document.querySelector('.fm__title'))`,
    10_000,
    '漫游页出现'
  )
  record('进入漫游页出现挑选中或曲目视图', picking)

  const started = await waitFor(PORT, `Boolean(document.querySelector('.fm__title'))`, 120_000, '漫游自动起播出曲目')
  const title = (await cdpEval(PORT, `(document.querySelector('.fm__title')?.textContent ?? '').trim()`)) || ''
  record('漫游进入即自动起播（曲目视图）', started, `title=${JSON.stringify(title)}`)
  await screenshot(PORT, 'fm-1-playing.png')

  const sounding = await waitFor(
    PORT,
    `(async () => { const s = (await window.youyou.invoke('player:state')).data; return Boolean(s && s.playing && s.position > 0.6 && !s.error) })()`,
    150_000,
    '漫游曲目出声'
  )
  const ps = await playerSnap()
  record('漫游曲目真实出声', sounding, `track=${JSON.stringify(ps.track)} playing=${ps.playing} error=${JSON.stringify(ps.error)}`)

  const queueText = await cdpEval(PORT, `(document.querySelector('.fm__queue')?.textContent ?? '').trim()`)
  record('显示漫游队列剩余文案', queueText.includes('漫游队列剩余'), `text=${JSON.stringify(queueText)}`)

  // 下一首
  const before1 = await playerSnap()
  await cdpEval(PORT, `(() => { const b = document.querySelector('.fm__control[aria-label="下一首"]'); if (!b) return false; b.click(); return true })()`, false)
  const nextOk = await waitFor(
    PORT,
    `(async () => { const s = (await window.youyou.invoke('player:state')).data; return Boolean(s && (s.index !== ${before1.index} || s.track?.id !== ${before1.id})) })()`,
    60_000,
    '下一首切歌'
  )
  const after1 = await playerSnap()
  record('点「下一首」切到下一曲', nextOk, `index ${before1.index}→${after1.index} track ${JSON.stringify(before1.track)}→${JSON.stringify(after1.track)}`)

  // 暂停 / 继续
  const paused = await waitFor(
    PORT,
    `(async () => { const s = (await window.youyou.invoke('player:state')).data; return Boolean(s && s.playing) })()`,
    60_000,
    '先等到播放中'
  )
  if (paused) {
    await cdpEval(PORT, `(() => { const b = document.querySelector('.fm__control--primary'); if (!b) return false; b.click(); return true })()`, false)
    const p1 = await waitFor(PORT, `(async () => { const s = (await window.youyou.invoke('player:state')).data; return Boolean(s && !s.playing) })()`, 15_000, '暂停生效')
    await cdpEval(PORT, `(() => { const b = document.querySelector('.fm__control--primary'); if (!b) return false; b.click(); return true })()`, false)
    const p2 = await waitFor(PORT, `(async () => { const s = (await window.youyou.invoke('player:state')).data; return Boolean(s && s.playing) })()`, 15_000, '继续生效')
    record('漫游页暂停/继续切换', p1 && p2)
  } else {
    record('漫游页暂停/继续切换', false, '前置条件不满足：未处于播放中')
  }

  // 不喜欢 → 换一首 + toast
  const before2 = await playerSnap()
  await cdpEval(PORT, `(() => { const b = document.querySelector('.fm__control[aria-label="不喜欢，换一首"]'); if (!b) return false; b.click(); return true })()`, false)
  const trashOk = await waitFor(
    PORT,
    `(async () => { const s = (await window.youyou.invoke('player:state')).data; return Boolean(s && s.track && s.track.id !== ${before2.id} && document.body.innerText.includes('已记录不喜欢')) })()`,
    60_000,
    '不喜欢换歌 + toast'
  )
  const after2 = await playerSnap()
  record('点「不喜欢」记录并换一首', trashOk, `track ${JSON.stringify(before2.track)}→${JSON.stringify(after2.track)}`)
  await screenshot(PORT, 'fm-2-after-trash.png')

  const errors = monitor.getErrors()
  record('场景 A 全程控制台无报错', errors.length === 0, errors.slice(0, 5).map((e) => `${e.type}: ${e.text}`.slice(0, 140)).join(' | '))
}

/** 场景 B：断数据路径 —— 全新 userData（无 cookie）→ track:fm 失败 → 错误态 + 重试 */
async function scenarioB(child, monitor) {
  record('场景 B 实例启动并连上 CDP', true)
  await clickSidebar(PORT, '私人漫游')
  const failed = await waitFor(
    PORT,
    `(() => {
      const t = document.querySelector('.fm .placeholder__title')
      return Boolean(t && t.textContent.includes('启动失败'))
    })()`,
    60_000,
    '断数据后出启动失败错误态'
  )
  const errText = await cdpEval(PORT, `(document.querySelector('.fm .placeholder')?.textContent ?? '').trim()`)
  record('无登录数据时漫游显示「启动失败」错误态', failed, `text=${JSON.stringify(errText.slice(0, 120))}`)
  await screenshot(PORT, 'fm-3-start-error.png')

  // 点重试：仍失败但不崩溃，界面停留在错误态或挑选中
  await cdpEval(PORT, `(() => { const b = document.querySelector('.fm .placeholder .button'); if (!b) return false; b.click(); return true })()`, false)
  const settled = await waitFor(
    PORT,
    `Boolean(document.querySelector('.fm .placeholder'))`,
    30_000,
    '重试后仍为错误/占位态'
  )
  const retryText = await cdpEval(PORT, `(document.querySelector('.fm .placeholder__title')?.textContent ?? '').trim()`)
  record('点「重试」不崩溃、界面稳定', settled, `title=${JSON.stringify(retryText)}`)

  const errors = monitor.getErrors()
  record('场景 B 全程控制台无报错', errors.length === 0, errors.slice(0, 5).map((e) => `${e.type}: ${e.text}`.slice(0, 140)).join(' | '))
}

async function main() {
  const base = path.join(os.tmpdir(), 'youyou-qa-fm')
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

  finish(results, '私人漫游页存在失败项')
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
