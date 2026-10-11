/**
 * bug 猎手 · 桌面歌词最新版验证（针对 11:12:55 新构建）：
 *  - 构建确认含 desktopLyricsEffect（特效）+ getAllDisplays（坐标钳制）
 *  - settings:get 含 desktopLyricsEffect 默认 classic
 *  - 特效循环 classic→gradient→neon→karaoke 回读/消毒
 *  - 桌面歌词窗口 DOM：特效按钮存在、点击循环、根类名 desktop-lyrics--<effect>
 *  - desktopMove {99999,99999} 被钳制（lead 修复验证）
 *  - desktopResize 极端值不崩
 */
import * as path from 'node:path'
import * as os from 'node:os'
import {
  log, wait, launchBugInstance, killInstance, waitReady, cdp,
  freshUserData, waitPortFree
} from './test-qa-bug-lib.mjs'

const PORT = 9434
const userData = path.join(os.tmpdir(), 'youyou-bug-desktop2')
const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'BUG?'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const invoke = (channel, payload) => `(async () => {
  try { const r = await window.youyou.invoke(${JSON.stringify(channel)}${payload ? `, ${JSON.stringify(payload)}` : ''}); return { error: r?.error ?? null, data: r?.data ?? null } }
  catch (cause) { return { throw: String(cause).slice(0, 160) } }
})()`

/** 对指定 CDP target（按 webSocketDebuggerUrl）执行表达式。 */
async function cdpTarget(wsUrl, expression) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', reject)
  })
  const value = await new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e9)
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      ws.removeEventListener('message', onMessage)
      const result = message.result
      if (result?.exceptionDetails) {
        resolve({ ok: false, error: `${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`.trim() })
        return
      }
      resolve({ ok: true, value: result?.result?.value })
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
  ws.close()
  return value
}

async function pageTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  const list = await res.json()
  return list.filter((t) => t.type === 'page')
}

const EFFECTS = ['classic', 'gradient', 'neon', 'karaoke']

async function main() {
  freshUserData(userData)
  killInstance(userData)
  const inst = await launchBugInstance({ port: PORT, userData, fixture: false })
  try {
    const ready = await waitReady(PORT, 90_000)
    record('实例启动（11:12 新构建）', ready)
    if (!ready) return

    // 1. settings:get 含特效字段
    const s0 = await cdp(PORT, invoke('settings:get'))
    record('settings:get 含 desktopLyricsEffect（默认 classic）', s0.value?.data?.desktopLyricsEffect === 'classic', JSON.stringify(s0.value?.data?.desktopLyricsEffect))

    // 2. 特效循环切换 + 回读
    let allApplied = true
    const readBack = []
    for (const effect of EFFECTS) {
      await cdp(PORT, invoke('settings:update', { desktopLyricsEffect: effect }))
      await wait(300)
      const s = await cdp(PORT, invoke('settings:get'))
      const got = s.value?.data?.desktopLyricsEffect
      readBack.push(got)
      if (got !== effect) allApplied = false
    }
    record('特效 4 档循环切换全部应用', allApplied, readBack.join('→'))

    // 3. 非法特效值被消毒
    await cdp(PORT, invoke('settings:update', { desktopLyricsEffect: 'disco' }))
    await wait(300)
    const sBad = await cdp(PORT, invoke('settings:get'))
    record('非法特效值被丢弃（保持上一档）', sBad.value?.data?.desktopLyricsEffect === 'karaoke', `got=${sBad.value?.data?.desktopLyricsEffect}`)

    // 4. 打开桌面歌词 → 找到歌词窗口 target（URL 含 ?window=lyrics，src/main/index.ts:203）
    await cdp(PORT, invoke('lyrics:desktopToggle', { visible: true }))
    await wait(1500)
    const pages = await pageTargets(PORT)
    record('桌面歌词独立窗口出现', pages.some((t) => (t.url ?? '').includes('window=lyrics')), `targets=${pages.length}`)
    const lyricsPage = pages.find((t) => (t.url ?? '').includes('window=lyrics')) ?? pages[pages.length - 1]

    // 5. 歌词窗口 DOM：特效按钮（icon-only，靠 aria-label「歌词特效：…」）+ 根类名
    const dom0 = await cdpTarget(lyricsPage.webSocketDebuggerUrl, `(() => {
      const btn = document.querySelector('button[aria-label*="特效"]') ?? null
      return { hasBtn: !!btn, label: btn?.getAttribute('aria-label') ?? null, rootClass: document.querySelector('[class*="desktop-lyrics--"]')?.className ?? null }
    })()`)
    record('歌词窗口有特效切换按钮', dom0.value?.hasBtn === true, `label=${dom0.value?.label} 根类=${dom0.value?.rootClass}`)

    if (dom0.value?.hasBtn) {
      const cycle = []
      for (let i = 0; i < 3; i += 1) {
        await cdpTarget(lyricsPage.webSocketDebuggerUrl, `(() => {
          const btn = document.querySelector('button[aria-label*="特效"]')
          if (!btn) return false
          btn.click()
          return true
        })()`)
        await wait(600)
        const d = await cdpTarget(lyricsPage.webSocketDebuggerUrl, `(() => {
          const btn = document.querySelector('button[aria-label*="特效"]')
          return { label: btn?.getAttribute('aria-label') ?? null, rootClass: document.querySelector('[class*="desktop-lyrics--"]')?.className ?? null }
        })()`)
        cycle.push(d.value)
      }
      const labels = cycle.map((c) => c?.label)
      const distinct = new Set(labels.filter(Boolean))
      record('特效按钮点击循环 3 次（特效逐档切换）', labels.length === 3 && distinct.size === 3, JSON.stringify(labels))
    }

    // 6. desktopMove 大坐标被钳制（lead 修复）
    await cdp(PORT, invoke('lyrics:desktopMove', { x: 99999, y: 99999 }))
    await wait(400)
    const sPos = await cdp(PORT, invoke('settings:get'))
    const stored = sPos.value?.data?.desktopLyricsPosition ?? null
    const clamped = stored && Number.isFinite(stored.x) && Number.isFinite(stored.y) && (stored.x !== 99999 || stored.y !== 99999) && Math.abs(stored.x) < 30000 && Math.abs(stored.y) < 30000
    record('desktopMove{99999,99999} 被钳制到屏幕范围', clamped === true, `存储=${JSON.stringify(stored)}`)

    // 负大坐标
    await cdp(PORT, invoke('lyrics:desktopMove', { x: -99999, y: -99999 }))
    await wait(400)
    const sNeg = await cdp(PORT, invoke('settings:get'))
    const storedNeg = sNeg.value?.data?.desktopLyricsPosition ?? null
    record('desktopMove{-99999,-99999} 被钳制', storedNeg && Math.abs(storedNeg.x) < 30000 && Math.abs(storedNeg.y) < 30000, `存储=${JSON.stringify(storedNeg)}`)

    // 7. desktopResize 极端值
    const r1 = await cdp(PORT, invoke('lyrics:desktopResize', { height: 99999, width: 99999 }))
    const r2 = await cdp(PORT, invoke('lyrics:desktopResize', { height: -500, width: -1 }))
    record('desktopResize 极端值不崩溃', r1.value?.error == null && r2.value?.error == null && !r1.value?.throw && !r2.value?.throw)

    // 8. 关闭桌面歌词（隐藏不销毁为设计：applyLyricsVisibility→hide()；Win32 可见性已在 dlvis 探针证实）
    await cdp(PORT, invoke('lyrics:desktopToggle', { visible: false }))
    await wait(800)
    const sOff = await cdp(PORT, invoke('settings:get'))
    const pagesEnd = await pageTargets(PORT)
    record('关闭后设置落盘（窗口隐藏，销毁与否为设计内）', sOff.value?.data?.showDesktopLyrics === false, `show=${sOff.value?.data?.showDesktopLyrics} targets=${pagesEnd.length}`)

    const alive = await cdp(PORT, `Boolean(window.youyou)`)
    record('实例存活', alive.value === true)
  } catch (cause) {
    record('执行异常', false, String(cause).slice(0, 200))
  } finally {
    killInstance(userData, inst?.pid ?? 0)
    await waitPortFree(PORT)
  }
}

await main()

const failed = results.filter((item) => !item.ok)
log(`结果: ${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) process.exitCode = 1
