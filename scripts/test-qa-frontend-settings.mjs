/**
 * QA: 设置页真机测试 —— 分组齐全、账号区、音源账号、开关落盘、音质选择落盘、
 * 主题切换、皮肤切换、缓存清理、检查更新、关于版本、未登录态。
 * 注意：绝不点「退出登录/确认退出」（会连带使真实 cookie 服务端失效）。
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

const groupTitles = () =>
  cdpEval(PORT, `[...document.querySelectorAll('.settings__group h2')].map((h) => h.textContent.trim())`)

async function scenarioA(child, monitor) {
  record('场景 A 实例启动并连上 CDP', true)
  await clickSidebar(PORT, '设置')
  const loaded = await waitFor(PORT, `document.querySelectorAll('.settings__group h2').length >= 10`, 20_000, '设置分组渲染')
  const titles = await groupTitles()
  const need = ['播放', '音源', '输出设备', '桌面歌词', '缓存', '系统集成', '隐私与诊断', '外观', '背景', '账号', '音源账号', '更新', '加入群聊', '关于']
  const missing = need.filter((t) => !titles.includes(t))
  record('设置页分组齐全', loaded && missing.length === 0, `titles=${JSON.stringify(titles)}${missing.length ? ` missing=${JSON.stringify(missing)}` : ''}`)
  await screenshot(PORT, 'settings-1-overview.png')

  // 账号区：当前账号 + 退出登录按钮存在（不点击）；auth:state 在限流下可能慢, 等 30s
  const accountSettled = await waitFor(PORT, `(() => { const hint = [...document.querySelectorAll('.settings__row')].find((r) => r.querySelector('.settings__row-label span')?.textContent?.trim() === '当前账号')?.querySelector('.settings__row-hint')?.textContent?.trim() ?? ''; return hint === '喵汪鱼' || hint === '已登录' })()`, 30_000, '账号区登录态出现')
  const accountHint = await cdpEval(PORT, `[...document.querySelectorAll('.settings__row')].find((r) => r.querySelector('.settings__row-label span')?.textContent?.trim() === '当前账号')?.querySelector('.settings__row-hint')?.textContent ?? ''`)
  const logoutBtn = await cdpEval(PORT, `[...document.querySelectorAll('.settings__row')].find((r) => r.querySelector('.settings__row-label span')?.textContent?.trim() === '当前账号')?.querySelector('.button')?.textContent?.trim() ?? ''`)
  record('账号区显示当前账号与退出按钮', accountSettled && logoutBtn === '退出登录', `hint=${JSON.stringify(accountHint.trim())} btn=${JSON.stringify(logoutBtn)}`)

  // 音源账号：应显示 QQ 账号行或绑定二维码
  const sourceTitle = await cdpEval(PORT, `(document.querySelector('.source-account-title')?.textContent ?? '').trim()`)
  const hasBindOrPlaylists = await cdpEval(PORT, `Boolean(document.querySelector('.source-bind') || document.querySelector('.source-playlists'))`)
  record('音源账号区渲染', hasBindOrPlaylists, `title=${JSON.stringify(sourceTitle)}`)

  // 开关落盘：记录播放
  const sw = `[aria-label="记录播放"]`
  const before = await cdpEval(PORT, `document.querySelector(${JSON.stringify(sw)})?.getAttribute('aria-checked')`)
  await cdpEval(PORT, `(() => { const s = document.querySelector(${JSON.stringify(sw)}); if (!s) return false; s.click(); return true })()`, false)
  const toggled = await waitFor(
    PORT,
    `document.querySelector(${JSON.stringify(sw)})?.getAttribute('aria-checked') === ${JSON.stringify(before === 'true' ? 'false' : 'true')}`,
    10_000,
    '开关切换'
  )
  const persisted = await cdpEval(PORT, `(async () => { const s = (await window.youyou.invoke('settings:get')).data; return s?.scrobble === ${before === 'true' ? 'false' : 'true'} })()`)
  await cdpEval(PORT, `(() => { const s = document.querySelector(${JSON.stringify(sw)}); if (!s) return false; s.click(); return true })()`, false)
  record('开关切换并落盘', toggled && persisted, `before=${before}`)

  // 音质选择落盘
  const quality = await cdpEval(PORT, `(() => { const sel = [...document.querySelectorAll('.settings__row')].find((r) => r.querySelector('.settings__row-label span')?.textContent?.trim() === '默认音质')?.querySelector('select'); if (!sel) return null; const opts = [...sel.options].map((o) => o.value); const next = opts[(opts.indexOf(sel.value) + 1) % opts.length]; const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(sel, next); sel.dispatchEvent(new Event('change', { bubbles: true })); return { was: sel.value, next, opts } })()`)
  if (quality?.next) {
    const qOk = await waitFor(
      PORT,
      `(async () => { const s = (await window.youyou.invoke('settings:get')).data; return s?.quality === ${JSON.stringify(quality.next)} })()`,
      10_000,
      '音质落盘'
    )
    record('默认音质选择落盘', qOk, `was=${quality.was} → ${quality.next}`)
    await cdpEval(PORT, `(() => { const sel = [...document.querySelectorAll('.settings__row')].find((r) => r.querySelector('.settings__row-label span')?.textContent?.trim() === '默认音质')?.querySelector('select'); if (!sel) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(sel, ${JSON.stringify(quality.was)}); sel.dispatchEvent(new Event('change', { bubbles: true })); return true })()`, false)
  } else {
    record('默认音质选择落盘', false, '未找到音质下拉框')
  }

  // 主题切换 → data-theme
  const themeSel = `[...document.querySelectorAll('.settings__row')].find((r) => r.querySelector('.settings__row-label span')?.textContent?.trim() === '主题')?.querySelector('select')`
  const currentTheme = await cdpEval(PORT, `${themeSel}?.value ?? null`)
  await cdpEval(PORT, `(() => { const sel = ${themeSel}; if (!sel) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(sel, 'dark'); sel.dispatchEvent(new Event('change', { bubbles: true })); return true })()`, false)
  const themeApplied = await waitFor(PORT, `document.documentElement.dataset.theme === 'dark'`, 10_000, '主题生效')
  await cdpEval(PORT, `(() => { const sel = ${themeSel}; if (!sel) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(sel, ${JSON.stringify(currentTheme)}); sel.dispatchEvent(new Event('change', { bubbles: true })); return true })()`, false)
  record('主题切换即时生效(深色)', themeApplied, `was=${JSON.stringify(currentTheme)}`)

  // 皮肤切换 → localStorage youyou-skin
  const skinBefore = await cdpEval(PORT, `localStorage.getItem('youyou-skin')`)
  await cdpEval(PORT, `(() => { const opt = [...document.querySelectorAll('.skin-option')].find((o) => !o.classList.contains('is-active')); if (!opt) return false; opt.click(); return true })()`, false)
  const skinChanged = await waitFor(PORT, `localStorage.getItem('youyou-skin') !== ${JSON.stringify(skinBefore)}`, 10_000, '皮肤切换')
  const skinAfter = await cdpEval(PORT, `localStorage.getItem('youyou-skin')`)
  await cdpEval(PORT, `(() => { const opt = [...document.querySelectorAll('.skin-option')].find((o) => o.getAttribute('data-skin') === ${JSON.stringify(skinBefore)} || o.querySelector('.skin-swatch')?.getAttribute('data-skin') === ${JSON.stringify(skinBefore)}); if (!opt) return false; opt.click(); return true })()`, false)
  record('主题皮肤切换生效并记录', skinChanged, `${JSON.stringify(skinBefore)} → ${JSON.stringify(skinAfter)}`)

  // 缓存清理
  const usageHint = await cdpEval(PORT, `[...document.querySelectorAll('.settings__row')].find((r) => r.querySelector('.settings__row-label span')?.textContent?.trim() === '缓存上限')?.querySelector('.settings__row-hint')?.textContent ?? ''`)
  record('缓存用量提示渲染', usageHint.includes('已用') || usageHint.includes('共'), `hint=${JSON.stringify(usageHint.slice(0, 60))}`)
  await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.settings__row')].find((r) => r.querySelector('.settings__row-label span')?.textContent?.trim() === '清理缓存')?.querySelector('.button'); if (!b) return false; b.click(); return true })()`, false)
  const cleared = await waitFor(PORT, `document.body.innerText.includes('音频缓存已清理')`, 30_000, '清理缓存提示')
  record('清理音频缓存并提示', cleared)
  await screenshot(PORT, 'settings-2-after-clear.png')

  // 检查更新（网络可能不通：出「已是最新版本」或「检查更新失败」都算界面正常反馈）
  await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.settings__row')].find((r) => r.querySelector('.settings__row-label span')?.textContent?.trim() === '检查更新')?.querySelector('.button'); if (!b || b.disabled) return false; b.click(); return true })()`, false)
  const updOk = await waitFor(
    PORT,
    `document.body.innerText.includes('已是最新版本') || document.body.innerText.includes('检查更新失败')`,
    60_000,
    '检查更新反馈'
  )
  record('检查更新给出反馈(最新/失败)', updOk)

  // 关于版本（v0.4.2 为打包版; electron 直跑 dev 模式 app.getVersion() 回退 Electron 版本, 属 dev 运行方式特性, 不算 bug）
  const about = await cdpEval(PORT, `(document.querySelector('.settings__about')?.textContent ?? '').trim()`)
  record('关于区显示版本信息', about.includes('悠悠音乐') && (about.includes('v0.4.2') || about.includes('v33.')), `about=${JSON.stringify(about.slice(0, 100))}`)
  await screenshot(PORT, 'settings-3-about.png')

  const errors = monitor.getErrors()
  record('场景 A 全程控制台无报错', errors.length === 0, errors.slice(0, 5).map((e) => `${e.type}: ${e.text}`.slice(0, 140)).join(' | '))
}

/** 场景 B：未登录态 */
async function scenarioB(child, monitor) {
  record('场景 B 实例启动并连上 CDP', true)
  await clickSidebar(PORT, '设置')
  await waitFor(PORT, `document.querySelectorAll('.settings__group h2').length >= 10`, 20_000, '设置分组渲染')
  const accountHint = await cdpEval(PORT, `[...document.querySelectorAll('.settings__row')].find((r) => r.querySelector('.settings__row-label span')?.textContent?.trim() === '当前账号')?.querySelector('.settings__row-hint')?.textContent ?? ''`)
  record('未登录账号区显示未登录', accountHint.trim() === '未登录', `hint=${JSON.stringify(accountHint.trim())}`)
  const sourceNote = await cdpEval(PORT, `Boolean(document.querySelector('.source-account-title'))`)
  record('未登录时音源账号区仍渲染', sourceNote)
  const errors = monitor.getErrors()
  record('场景 B 全程控制台无报错', errors.length === 0, errors.slice(0, 5).map((e) => `${e.type}: ${e.text}`.slice(0, 140)).join(' | '))
}

async function main() {
  const base = path.join(os.tmpdir(), 'youyou-qa-settings')
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

  finish(results, '设置页存在失败项')
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
