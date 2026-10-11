/**
 * QA: 一起听页面真机测试 —— 未登录门禁、已登录连接态、房间创建/离开、
 * 聊天发送、礼物面板、充值弹窗+支付二维码、找听友面板、控制台报错。
 * 网络依赖 wss://yy.ytw.asia/relay；中继不可达时以 UI 反馈(连接失败/错误提示)记录为环境观察。
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

const PORT = 9398
const results = []
const record = recordTo(results)

/** 场景 A：已登录 */
async function scenarioA(child, monitor) {
  record('场景 A 实例启动并连上 CDP', true)
  await clickSidebar(PORT, '一起听')
  const opened = await waitFor(PORT, `document.querySelector('.together')`, 15_000, '一起听页打开')

  // 连接态面板（nickname 可能因 auth profile 缺失延迟/缺失, 等 30s 再判）
  const meName = await waitFor(
    PORT,
    `(document.querySelector('.together__me-name')?.textContent ?? '').trim().length > 0`,
    30_000,
    '个人信息昵称出现'
  )
    ? (await cdpEval(PORT, `(document.querySelector('.together__me-name')?.textContent ?? '').trim()`))
    : ''
  const hasBalance = await cdpEval(PORT, `Boolean(document.querySelector('.together__balance'))`)
  record('已登录显示个人信息+余额', opened && meName.length > 0 && hasBalance, `name=${JSON.stringify(meName)}`) 

  // 等待中继状态稳定（连接中 → 已连接 或 连接失败）
  const settled = await waitFor(
    PORT,
    `(() => { const s = document.querySelector('.together__status'); const c = s?.className ?? ''; return c.includes('--connected') || c.includes('--error') || c.includes('--disconnected') || (document.querySelector('.together__error')?.textContent ?? '').length > 0 })()`,
    60_000,
    '中继状态稳定'
  )
  const statusCls = await cdpEval(PORT, `document.querySelector('.together__status')?.className ?? ''`)
  const statusText = await cdpEval(PORT, `(document.querySelector('.together__status')?.textContent ?? '').trim()`)
  const errText = await cdpEval(PORT, `(document.querySelector('.together__error')?.textContent ?? '').trim()`)
  const connected = statusCls.includes('--connected')
  record('中继连接状态明确显示', settled, `cls=${statusCls} text=${JSON.stringify(statusText)} err=${JSON.stringify(errText.slice(0, 80))}`)
  await screenshot(PORT, 'together-1-connect.png')

  // 面板齐全
  const hasRooms = await cdpEval(PORT, `Boolean(document.querySelector('.together__panel--rooms'))`)
  const hasFind = await cdpEval(PORT, `document.body.innerText.includes('找听友')`)
  const hasLive = await cdpEval(PORT, `Boolean(document.querySelector('.together__panel--live'))`)
  record('房间/找听友/现场三面板齐全', hasRooms && hasFind && hasLive)

  // 房间列表加载（列表或空提示都算正常反馈）
  const roomState = await cdpEval(PORT, `Boolean(document.querySelector('.together__rooms .together__room') || document.querySelector('.together__panel--rooms .together__empty'))`)
  record('房间列表或空提示渲染', roomState)

  // 找听友：设置条件 + 雷达搜索
  await cdpEval(PORT, `(() => { const inputs = document.querySelectorAll('.together__filter .text-input'); if (inputs.length < 2) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(inputs[0], '男'); inputs[0].dispatchEvent(new Event('input', { bubbles: true })); setter.call(inputs[1], '20'); inputs[1].dispatchEvent(new Event('input', { bubbles: true })); return true })()`, false)
  await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.together__filter .button')].find((x) => x.textContent.includes('雷达搜索')); b?.click(); return Boolean(b) })()`, false)
  const radarFeedback = await waitFor(
    PORT,
    `(() => { const r = document.querySelector('.together__filter .together__notice, .together__panel--rooms ~ *, .together__find-result, .together__notice'); const t = document.body.innerText; return t.includes('正在寻找听友') || t.includes('搜索') && !t.includes('还没有搜到听友') || Boolean(r) })()`,
    25_000,
    '雷达搜索反馈'
  )
  record('雷达搜索有反馈(结果或提示)', radarFeedback)

  if (connected) {
    // 创建房间
    await cdpEval(PORT, `(() => { const i = document.querySelector('.together__create .text-input'); if (!i) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(i, 'QA测试房间' + Date.now() % 1000); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`, false)
    await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.together__create .button')].find((x) => x.textContent.includes('创建房间')); b?.click(); return Boolean(b) })()`, false)
    const created = await waitFor(PORT, `document.querySelector('.together__badge') && document.body.innerText.includes('我是房主')`, 30_000, '创建房间成功')
    record('创建房间→进入现场面板(房主)', created)
    await screenshot(PORT, 'together-2-room.png')

    const hasCompose = await cdpEval(PORT, `Boolean(document.querySelector('.together__compose .text-input'))`)
    const hasGifts = await cdpEval(PORT, `document.querySelectorAll('.together__gift').length > 0`)
    record('聊天输入+礼物面板渲染', hasCompose && hasGifts, `gifts=${await cdpEval(PORT, `document.querySelectorAll('.together__gift').length`)}`)

    // 聊天发送
    const msgText = 'QA消息' + Date.now() % 1000
    await cdpEval(PORT, `(() => { const i = document.querySelector('.together__compose .text-input'); if (!i) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(i, ${JSON.stringify(msgText)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`, false)
    await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.together__compose .button')].find((x) => x.textContent.includes('发送')); b?.click(); return Boolean(b) })()`, false)
    const sent = await waitFor(PORT, `[...document.querySelectorAll('.together__msg.is-mine .together__msg-text')].some((m) => m.textContent.includes(${JSON.stringify(msgText)}))`, 20_000, '消息上屏')
    record('发送聊天消息上屏', sent)

    // 表情快捷发送
    await cdpEval(PORT, `document.querySelector('.together__emoji')?.click()`, false)
    const emojiSent = await waitFor(PORT, `document.querySelectorAll('.together__msg.is-mine .together__msg-emoji').length > 0`, 15_000, '表情消息上屏')
    record('表情快捷发送上屏', emojiSent)

    // 礼物 → 余额足够才有反馈(礼物日志/浮层); 余额不足时按钮禁用是设计行为
    const giftEnabled = await cdpEval(PORT, `[...document.querySelectorAll('.together__gift')].some((g) => !g.disabled)`)
    let giftFeedback = false
    if (giftEnabled) {
      await cdpEval(PORT, `(() => { const g = [...document.querySelectorAll('.together__gift')].find((x) => !x.disabled); g?.click(); return Boolean(g) })()`, false)
      giftFeedback = await waitFor(
        PORT,
        `(document.querySelector('.together__gift-log')?.textContent ?? '').length > 0 || Boolean(document.querySelector('.together__gift-overlay'))`,
        20_000,
        '点礼物有反馈'
      )
    }
    record('点击礼物有反馈(弹窗或提示)', giftEnabled ? giftFeedback : true, giftEnabled ? '' : '余额不足, 礼物按钮全部禁用(设计行为)')
    await cdpEval(PORT, `(() => { const c = [...document.querySelectorAll('.together__dialog-actions .button')].find((x) => x.textContent.includes('取消')); c?.click(); return Boolean(c) })()`, false)
    await waitFor(PORT, `!document.querySelector('.together__modal')`, 10_000, '关闭弹窗')

    // 离开房间
    await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.together__panel--live .button')].find((x) => x.textContent.includes('离开房间')); b?.click(); return Boolean(b) })()`, false)
    const left = await waitFor(PORT, `document.body.innerText.includes('还没有加入房间')`, 20_000, '离开房间')
    record('离开房间→回到空态', left)
  } else {
    record('创建房间→进入现场面板(房主)', false, '中继未连接，跳过房间流程')
    record('发送聊天消息上屏', false, '中继未连接，跳过')
    record('表情快捷发送上屏', false, '中继未连接，跳过')
    record('点击礼物有反馈(弹窗或提示)', false, '中继未连接，跳过')
    record('离开房间→回到空态', false, '中继未连接，跳过')
  }

  // 充值弹窗 + 支付二维码
  await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.together__connect .button')].find((x) => x.textContent.includes('充值')); b?.click(); return Boolean(b) })()`, false)
  const modalOk = await waitFor(PORT, `document.querySelector('.together__modal .together__dialog')`, 40_000, '充值弹窗')
  const modalTitle = await cdpEval(PORT, `(document.querySelector('.together__modal .together__h3')?.textContent ?? '').trim()`)
  const amounts = await cdpEval(PORT, `document.querySelectorAll('.together__amount').length`)
  record('充值弹窗渲染(金额选项)', modalOk && modalTitle.includes('充值余额') && amounts > 0, `title=${JSON.stringify(modalTitle)} amounts=${amounts}`)
  await screenshot(PORT, 'together-3-recharge.png')
  await cdpEval(PORT, `(() => { const b = [...document.querySelectorAll('.together__modal .button')].find((x) => x.textContent.includes('生成收款码') || x.textContent.includes('生成支付二维码')); b?.click(); return Boolean(b) })()`, false)
  const payState = await waitFor(
    PORT,
    `document.querySelector('.together__qr') || document.querySelector('.together__pay') || (document.querySelector('.together__error')?.textContent ?? '').length > 0`,
    40_000,
    '支付二维码或错误'
  )
  const qrRendered = await cdpEval(PORT, `Boolean(document.querySelector('.together__qr .qr-grid'))`)
  record('生成支付二维码(或下单失败提示)', payState, qrRendered ? 'QR 已渲染' : `err=${JSON.stringify((await cdpEval(PORT, `(document.querySelector('.together__error')?.textContent ?? '').trim()`)).slice(0, 80))}`)
  await screenshot(PORT, 'together-4-payqr.png')
  await cdpEval(PORT, `(() => { const c = [...document.querySelectorAll('.together__dialog-actions .button')].find((x) => x.textContent.includes('取消') || x.textContent.includes('关闭')); c?.click(); return Boolean(c) })()`, false)
  await waitFor(PORT, `!document.querySelector('.together__modal')`, 10_000, '关闭充值弹窗')

  const errors = monitor.getErrors()
  record('场景 A 全程控制台无报错', errors.length === 0, errors.slice(0, 5).map((e) => `${e.type}: ${e.text}`.slice(0, 140)).join(' | '))
}

/** 场景 B：未登录 */
async function scenarioB(child, monitor) {
  record('场景 B 实例启动并连上 CDP', true)
  await clickSidebar(PORT, '一起听')
  const gate = await waitFor(PORT, `document.querySelector('.together__gate')`, 40_000, '一起听门禁')
  const gateTitle = await cdpEval(PORT, `(document.querySelector('.together__gate-title')?.textContent ?? '').trim()`)
  const hasGoLogin = await cdpEval(PORT, `Boolean(document.querySelector('.together__gate .button--primary'))`)
  record('未登录门禁+去登录按钮', gate && gateTitle.includes('登录后才能使用一起听') && hasGoLogin, `title=${JSON.stringify(gateTitle)}`)
  await cdpEval(PORT, `document.querySelector('.together__gate .button--primary')?.click()`, false)
  const toLogin = await waitFor(PORT, `document.querySelector('.login__card')`, 40_000, '去登录→登录页')
  record('门禁「去登录」跳登录页', toLogin)
  await screenshot(PORT, 'together-5-gate.png')

  const errors = monitor.getErrors()
  record('场景 B 全程控制台无报错', errors.length === 0, errors.slice(0, 5).map((e) => `${e.type}: ${e.text}`.slice(0, 140)).join(' | '))
}

async function main() {
  const base = path.join(os.tmpdir(), 'youyou-qa-together')
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

  finish(results, '一起听页存在失败项')
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
