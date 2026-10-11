/** 诊断：当前页面状态 + 直接走 IPC 搜索验证主进程侧行为。 */
const wsUrl = (
  await (
    await fetch('http://127.0.0.1:9436/json/list')
  ).json()
).find((t) => t.type === 'page')?.webSocketDebuggerUrl

const ws = new WebSocket(wsUrl)
let nextId = 1
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
ws.onmessage = (e) => {
  const msg = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString())
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
}
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
await send('Runtime.enable')

const evaluate = async (expression, awaitPromise = true) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) return { EXC: r.exceptionDetails.text }
  return r.result?.value
}

console.log(
  '页面状态:',
  JSON.stringify(
    await evaluate(`(() => ({
      inputValue: [...document.querySelectorAll('input')].map(i => i.value).filter(Boolean),
      songRows: document.querySelectorAll('.song-row').length,
      cards: document.querySelectorAll('.card').length,
      hero: !!document.querySelector('.search-hero'),
      bodyText: document.body.innerText.slice(0, 300)
    }))()`),
    null,
    2
  )
)

console.log(
  'IPC 搜索:',
  JSON.stringify(
    await evaluate(`window.youyou.invoke('search:query', { keywords: '凤凰传奇', type: 'songs', limit: 30, offset: 0 }).then(r => ({
      ok: r.ok,
      songs: r.data?.songs?.length,
      external: r.data?.external?.length,
      songCount: r.data?.songCount,
      error: r.error
    })).catch(e => ({ throw: String(e) }))`),
    null,
    2
  )
)
ws.close()
