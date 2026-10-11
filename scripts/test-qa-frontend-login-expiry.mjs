/**
 * QA: 登录页二维码过期路径（后台长轮询，最长 ~9 分钟）。
 *
 * 网易云登录二维码几分钟后过期：验证过期后出现「刷新二维码」按钮、
 * 点击后能拿到新二维码（矩阵必然变化）、状态回到等待扫码、全程无控制台报错。
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

const PORT = 9397
const results = []
const record = recordTo(results)

async function main() {
  const userData = path.join(os.tmpdir(), 'youyou-qa-login-expiry')
  const { child, ready } = await boot({ port: PORT, userData, withRealState: false, waitReady: 24 })
  const monitor = await startConsoleMonitor(PORT)
  try {
    record('实例启动并连上 CDP', ready)
    if (!ready) return
    await clickSidebar(PORT, '我的音乐')
    const qrShown = await waitFor(PORT, `document.querySelectorAll('.qr-grid__on').length > 100`, 20_000, '初始二维码渲染')
    record('初始二维码渲染', qrShown)
    const before = await cdpEval(PORT, `document.querySelectorAll('.qr-grid__on').length`)
    log(`初始二维码黑格数=${before}，开始等待过期（轮询间隔 1.8s，最多等 9 分钟）`)

    // 等「刷新二维码」按钮出现（expired / error 状态都会出这个按钮）
    const expired = await waitFor(
      PORT,
      `[...document.querySelectorAll('.login button')].some((b) => (b.textContent ?? '').includes('刷新二维码'))`,
      540_000,
      '二维码过期出现刷新按钮'
    )
    if (!expired) {
      record('二维码过期后出现刷新按钮', false, '9 分钟仍未过期（可能网易云改长了有效期）')
      return
    }
    const expiredSnap = await cdpEval(
      PORT,
      `(() => ({
        status: (document.querySelector('.login__status')?.textContent ?? '').trim(),
        cls: document.querySelector('.login__status')?.className ?? '',
        cells: document.querySelectorAll('.qr-grid__on').length
      }))()`
    )
    record('过期状态文案正确', expiredSnap.status.includes('过期'), `status=${JSON.stringify(expiredSnap.status)}`)
    await screenshot(PORT, 'login-3-expired.png')

    // 点刷新 → 重新走 startQR → 新矩阵
    await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.login button')].find((x) => (x.textContent ?? '').includes('刷新二维码')); b?.click(); return true })()`, false)
    const refreshed = await waitFor(
      PORT,
      `(() => {
        const hint = document.querySelector('.login__hint')
        const status = document.querySelector('.login__status')?.textContent ?? ''
        return Boolean(hint) && status.includes('扫码')
      })()`,
      20_000,
      '刷新后回到等待扫码'
    )
    // 新矩阵需要两轮 IPC（auth:platformQRStart → app:qrMatrix），轮询等它渲染出来
    const newQr = await waitFor(
      PORT,
      `document.querySelectorAll('.qr-grid__on').length > 100`,
      20_000,
      '刷新后新二维码渲染'
    )
    const after = await cdpEval(PORT, `document.querySelectorAll('.qr-grid__on').length`)
    record('点击刷新后回到等待扫码', refreshed)
    record('刷新后拿到新二维码', newQr && after !== before, `cells ${before}→${after}`)
    await screenshot(PORT, 'login-4-refreshed.png')

    const errors = monitor.getErrors()
    record('过期与刷新全程控制台无报错', errors.length === 0, errors.slice(0, 3).map((e) => `${e.type}: ${e.text}`.slice(0, 150)).join(' | '))
  } finally {
    monitor.stop()
    await shutdown({ port: PORT, child })
  }
  finish(results, '登录过期路径存在失败项')
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
