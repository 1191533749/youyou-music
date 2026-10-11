/** IPC 级探针：直接触发 search:query，观察后台可播性校验是否广播 player:trackFailed。 */
const keyword = process.argv[2] ?? '谁记心上'
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await evaluate(`
  window.__failed = [];
  window.youyou.on('player:trackFailed', (p) => window.__failed.push({ ...p, t: Date.now() }));
  'ok'
`)

const searchResult = await evaluate(`window.youyou.invoke('search:query', { keywords: ${JSON.stringify(keyword)}, type: 'songs', limit: 30, offset: 0 }).then(r => ({
  ok: r.ok,
  error: r.error,
  count: r.data?.songs?.length,
  songs: (r.data?.songs ?? []).map(s => ({ id: s.id, name: s.name, fee: s.fee, pb: s.playability, reason: s.playabilityReason }))
})).catch(e => ({ throw: String(e) }))`)

console.log(`关键词: ${keyword}`)
console.log(`返回歌曲数: ${searchResult.count}，error: ${searchResult.error ?? '-'}`)
console.log(searchResult.songs.map((s, i) => `  ${i + 1}. [${s.id}] ${s.name} fee=${s.fee} pb=${s.pb} ${s.reason ?? ''}`).join('\n'))

const deadline = Date.now() + 200_000
let last = []
while (Date.now() < deadline) {
  await sleep(5000)
  const failed = await evaluate(`window.__failed`)
  if (failed.length !== last.length) {
    last = failed
    console.log(`[${new Date().toLocaleTimeString()}] trackFailed 累计 ${failed.length} 条：`)
    failed.forEach((f) => console.log(`  id=${f.id} ${f.externalKey ?? ''}`))
  }
  // 有事件且连续 30s 无新增就收尾。
  if (failed.length > 0 && Date.now() - failed[failed.length - 1].t > 30_000) break
}
console.log(`\n最终 trackFailed: ${last.length} 条`)
ws.close()
