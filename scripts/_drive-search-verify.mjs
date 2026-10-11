/**
 * 真机验证「搜索页后台可播性校验」：
 * 1) 通过 CDP 驱动用户桌面实例的 UI（点进搜索页、输入关键词、回车）。
 * 2) 订阅 player:trackFailed，记录后台校验剔除的曲目。
 * 3) 对比校验前后的 .song-row 数量，证明播不了的歌从列表里消失了。
 *
 * 用法：node scripts/_drive-search-verify.mjs <关键词> [WS_URL]
 */
const keyword = process.argv[2] ?? '凤凰传奇'
const wsUrl =
  process.argv[3] ??
  (
    await (
      await fetch('http://127.0.0.1:9436/json/list')
    ).json()
  ).find((t) => t.type === 'page')?.webSocketDebuggerUrl

if (!wsUrl) {
  console.error('未找到 CDP 页面 target')
  process.exit(1)
}
console.log('WS:', wsUrl)
console.log('关键词:', keyword)

const ws = new WebSocket(wsUrl)
let nextId = 1
const pending = new Map()

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

ws.onmessage = (e) => {
  const msg = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString())
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(`${msg.error.code} ${msg.error.message}`))
    else resolve(msg.result)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function evaluate(expression, awaitPromise = true) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise
  })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result?.value
}

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
await send('Runtime.enable')

// 1) 装监听：后台校验剔除的曲目 id 全记录在 window.__failed。
await evaluate(`
  window.__failed = [];
  window.youyou.on('player:trackFailed', (p) => window.__failed.push({ ...p, t: Date.now() }));
  'ok'
`)
console.log('[1/5] 已装 player:trackFailed 监听')

// 2) 点侧边栏「搜索」进入搜索页，再切到「单曲」页签（行渲染为 .song-row）。
const navOk = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '搜索')
  if (!btn) return 'no-search-button'
  btn.click()
  return 'clicked'
})()`)
console.log('[2/5] 导航:', navOk)
await sleep(1500)
const tabOk = await evaluate(`(() => {
  const tab = [...document.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '单曲')
  if (!tab) return 'no-tab'
  tab.click()
  return 'clicked'
})()`)
console.log('[2.5/5] 单曲页签:', tabOk)
await sleep(800)

// 3) 在可见的文本输入框输入关键词并回车。
const typed = await evaluate(`(async () => {
  const input = [...document.querySelectorAll('input')]
    .find(i => (i.type === 'text' || !i.type) && !!(i.offsetWidth || i.offsetHeight))
  if (!input) return 'no-input'
  input.focus()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, ${JSON.stringify(keyword)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 150))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  return 'submitted'
})()`)
console.log('[3/5] 输入并回车:', typed)

// 4) 等结果行出现，马上快照「校验前」的列表（校验是后台串行的，第一条失败要几秒后才到）。
//    若落在综合页签（歌曲渲染成卡片），补点一次「单曲」页签。
let rows = []
for (let i = 0; i < 40; i++) {
  rows = await evaluate(`[...document.querySelectorAll('.song-row__name')].map(el => el.textContent.trim())`)
  if (rows.length > 0) break
  if (i === 12) {
    await evaluate(`(() => {
      const tab = [...document.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '单曲')
      tab?.click()
      return 'retry-tab'
    })()`)
  }
  await sleep(1000)
}
const before = rows.slice()
console.log(`[4/5] 结果行已出现：${rows.length} 行`)
console.log(before.map((n, i) => `  ${i + 1}. ${n}`).join('\n'))

// 5) 轮询到校验完成（或超时），记录行数变化与剔除事件。
const deadline = Date.now() + 240_000
let failed = []
let lastCount = rows.length
let stableSince = Date.now()
while (Date.now() < deadline) {
  await sleep(5000)
  rows = await evaluate(`[...document.querySelectorAll('.song-row__name')].map(el => el.textContent.trim())`)
  failed = await evaluate(`window.__failed`)
  if (rows.length !== lastCount) {
    console.log(`  [${new Date().toLocaleTimeString()}] 行数变化 ${lastCount} -> ${rows.length}`)
    lastCount = rows.length
    stableSince = Date.now()
  }
  // 行数连续 45s 不动就收尾（校验串行 + 1s 间隔，单条最坏 20s 超时）。
  if (Date.now() - stableSince > 45_000) break
}

const after = rows
const hidden = before.filter((n) => !after.includes(n))
console.log('\n===== 结果 =====')
console.log(`校验前行数: ${before.length}`)
console.log(`校验后行数: ${after.length}`)
console.log(`被隐藏: ${hidden.length} 行`)
hidden.forEach((n) => console.log(`  - ${n}`))
console.log(`trackFailed 事件: ${failed.length} 条`)
failed.forEach((f) => console.log(`  id=${f.id} ${f.externalKey ?? ''} @ ${new Date(f.t).toLocaleTimeString()}`))
ws.close()
