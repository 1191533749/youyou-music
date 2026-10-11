/**
 * bug 猎手 · 路径 7：搜索特殊输入模糊测试。
 * emoji / 单字符 / 超长词(1000字) / 全空格 / 纯符号 / 生僻字 / 控制字符 / URL注入。
 *
 * 关注：崩溃 / 未捕获异常 / toast 报错 / 结果卡死转圈（>8s 不落定才算）。
 * 落定判定用「单曲」页签 .song-row（综合页单曲是卡片网格，无 .song-row）。
 */
import * as path from 'node:path'
import * as os from 'node:os'
import {
  log, wait, launchBugInstance, killInstance, waitReady, cdp, typeSearch, clickNav, goToSongsTab, freshUserData
} from './test-qa-bug-lib.mjs'

const PORT = 9403
const userData = path.join(os.tmpdir(), 'youyou-bug-search')
const results = []
const bugs = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'BUG?'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const report = (pathNo, operation, symptom, severity, evidence) => {
  bugs.push(`路径${pathNo} → ${operation} → ${symptom} → 严重度:${severity}${evidence ? ` | 证据:${evidence}` : ''}`)
  log(`🐛 ${bugs[bugs.length - 1]}`)
}

const CASES = [
  { name: 'emoji', text: '🎵🎧❤️' },
  { name: '单字「爱」', text: '爱' },
  { name: '超长词 1000 字', text: '周杰伦'.repeat(333).slice(0, 1000) },
  { name: '全空格', text: '     ' },
  { name: '纯符号', text: '★☆♪♫→←😀%%%***///' },
  { name: '生僻字', text: '𠀀𠮷囧' },
  { name: '控制字符', text: '\u0000\u0001\u0007' },
  { name: 'URL 注入', text: "https://evil.com/'; DROP TABLE songs;--" }
]

/** 采样一次当前搜索区状态（不依赖 .song-row，用文本证据）。 */
const snapshot = () => cdp(PORT, `(() => {
  const root = document.querySelector('.page-slot:not([hidden])') ?? document
  return {
    rows: root.querySelectorAll('.song-row').length,
    cards: root.querySelectorAll('.grid--albums .card, [class*="card"]').length,
    loadingText: root.querySelector('.search__loading')?.textContent ?? null,
    spinner: Boolean(document.querySelector('.search__loading .spin, .search__loading [class*="spin"]')),
    placeholder: root.querySelector('.placeholder')?.textContent ?? null,
    toast: document.querySelector('.toast')?.textContent ?? null,
    errors: window.__qaErrors.slice(0, 6),
    inputValue: (() => {
      const input = document.querySelector('.search-bar__input')
      return input ? input.value.length : -1
    })()
  }
})()`)

async function main() {
  freshUserData(userData)
  killInstance(userData)
  const inst = await launchBugInstance({ port: PORT, userData, cookie: true, fixture: false })
  try {
    const ready = await waitReady(PORT, 90_000)
    record('实例启动', ready)
    if (!ready) return

    await cdp(PORT, `(window.__qaErrors = [], window.addEventListener('error', (e) => window.__qaErrors.push(String(e.message)), true))`)
    await clickNav(PORT, '搜索')
    await wait(1500)

    for (const c of CASES) {
      const t0 = Date.now()
      const typed = await typeSearch(PORT, c.text)
      await wait(8000) // loading 落定基准（正常词 ~5s，songs 串行等汽水 ~6.4s）
      const snap = await snapshot()
      const v = snap.value ?? {}
      log(`  [${c.name}] ${Date.now() - t0}ms rows=${v.rows} cards=${v.cards} loading=${JSON.stringify(v.loadingText)} placeholder=${JSON.stringify((v.placeholder ?? '').slice(0, 30))} toast=${JSON.stringify(v.toast)} errs=${JSON.stringify(v.errors)} len=${v.inputValue}`)

      record(`搜索「${c.name}」不崩溃不报错`, snap.ok && (v.errors ?? []).length === 0 && !v.toast)
      if (!snap.ok) {
        report(7, `搜索「${c.name}」`, 'CDP 评估失败（渲染层可能已崩）', '崩溃', String(snap.error).slice(0, 160))
        break
      }
      if ((v.errors ?? []).length > 0) {
        report(7, `搜索「${c.name}」`, '渲染层未捕获异常', '崩溃', JSON.stringify(v.errors).slice(0, 160))
      }
      if (v.spinner && v.rows === 0 && v.cards === 0) {
        report(7, `搜索「${c.name}」`, '结果 >8s 仍转圈无落定', '体验差', `${Date.now() - t0}ms 仍 loading`)
      }
      // 全空格/控制字符/超长：要么出结果、要么给出「没有找到」空态、要么 loading 落定，三者有其一即不挂死
      const settled = !v.spinner || v.placeholder || v.rows > 0 || v.cards > 0
      record(`搜索「${c.name}」有落定（不永久转圈）`, Boolean(settled), settled ? '' : `${Date.now() - t0}ms spinner=true rows=${v.rows}`)
      // 清空再下一个
      await typeSearch(PORT, '')
      await wait(600)
    }

    // 实例是否存活
    const alive = await cdp(PORT, `Boolean(window.youyou)`).then((r) => r.ok && r.value === true).catch(() => false)
    record('8 轮特殊输入后实例存活', alive)

    // 恢复正常搜索仍可用（切到单曲页签确认行渲染）
    await typeSearch(PORT, '周杰伦')
    await wait(7000)
    const tab = await goToSongsTab(PORT, 15_000)
    record('特殊输入后正常搜索仍可用', tab.ok && (tab.value?.rows ?? 0) > 0, JSON.stringify(tab.value).slice(0, 120))
  } catch (cause) {
    record('测试执行异常', false, String(cause).slice(0, 200))
  } finally {
    killInstance(userData, inst?.pid ?? 0)
  }

  const failed = results.filter((item) => !item.ok)
  log(`结果: ${results.length - failed.length}/${results.length} 通过，bugs=${bugs.length}`)
  for (const line of bugs) console.log(`REPORT|${line}`)
  if (failed.length > 0 || bugs.length > 0) process.exitCode = 1
}

await main()
