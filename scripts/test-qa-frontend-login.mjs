/**
 * QA: 登录页真机测试（独立实例，无 cookie 全新数据目录）。
 *
 * 覆盖：进入登录页、二维码加载占位 → 二维码矩阵渲染、状态文案、
 * 提示文案、控制台无报错、刷新按钮（过期态在 test-qa-frontend-login-expiry.mjs 里跑长轮询）。
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

const SNAP = `(() => ({
  login: Boolean(document.querySelector('.login')),
  placeholder: (document.querySelector('.login__qr-placeholder')?.textContent ?? '').trim(),
  qr: Boolean(document.querySelector('.qr-grid')),
  qrCells: document.querySelectorAll('.qr-grid__on').length,
  status: (document.querySelector('.login__status')?.textContent ?? '').trim(),
  statusCls: document.querySelector('.login__status')?.className ?? '',
  hint: (document.querySelector('.login__hint')?.textContent ?? '').trim(),
  refreshBtn: [...document.querySelectorAll('.login button')].some((b) => (b.textContent ?? '').includes('刷新二维码'))
}))()`

async function main() {
  const userData = path.join(os.tmpdir(), 'youyou-qa-login')
  const { child, ready } = await boot({ port: PORT, userData, withRealState: false })
  const monitor = await startConsoleMonitor(PORT)
  try {
    record('实例启动并连上 CDP', ready)
    if (!ready) return

    // 未登录点「我的音乐」应进入登录页
    const clicked = await clickSidebar(PORT, '我的音乐')
    record('未登录点「我的音乐」进入登录页', clicked)
    const loginShown = await waitFor(PORT, `Boolean(document.querySelector('.login'))`, 8_000, '登录页出现')
    record('登录页渲染', loginShown)

    // 占位 → 二维码矩阵
    await waitFor(PORT, `Boolean(document.querySelector('.login__qr-placeholder'))`, 6_000, '二维码加载占位')
    const loading = await cdpEval(PORT, SNAP)
    record('先显示加载占位', loading.placeholder.length > 0, `text=${JSON.stringify(loading.placeholder)}`)
    await screenshot(PORT, 'login-1-loading.png')

    const qrShown = await waitFor(PORT, `document.querySelectorAll('.qr-grid__on').length > 100`, 15_000, '二维码矩阵渲染')
    const after = await cdpEval(PORT, SNAP)
    record('二维码矩阵渲染出来', qrShown, `cells=${after.qrCells}`)
    record('状态文案为等待扫码', after.status.includes('扫码'), `status=${JSON.stringify(after.status)}`)
    record('等待态显示扫码提示而不是刷新按钮', after.hint.includes('扫一扫') && !after.refreshBtn, `hint=${JSON.stringify(after.hint)}`)
    record('二维码 aria-label 正确', (await cdpEval(PORT, `document.querySelector('.qr-grid')?.getAttribute('aria-label') ?? ''`)) === '登录二维码')
    await screenshot(PORT, 'login-2-qr.png')

    // 状态轮询在工作：poll 每 1.8s 打 auth:platformQRPoll，不会把页面打挂
    await new Promise((r) => setTimeout(r, 4000))
    const later = await cdpEval(PORT, SNAP)
    record('轮询期间二维码不闪烁重建', later.qr && later.qrCells === after.qrCells, `cells ${after.qrCells}→${later.qrCells}`)
    record('轮询期间状态仍为等待', later.status.includes('扫码'), `status=${JSON.stringify(later.status)}`)

    // 控制台错误
    const errors = monitor.getErrors()
    record(
      '登录页控制台无报错',
      errors.length === 0,
      errors.slice(0, 5).map((e) => `${e.type}: ${e.text}`.slice(0, 160)).join(' | ')
    )
  } finally {
    monitor.stop()
    await shutdown({ port: PORT, child })
  }
  finish(results, '登录页存在失败项')
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
