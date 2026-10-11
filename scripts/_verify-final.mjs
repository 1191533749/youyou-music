/** 最终部署验证：桥接可用 → 搜索 → 播放推进 → 观察后台校验是否误伤。 */
const keyword = process.argv[2] ?? '渡情'
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

// 1. 桥接（sandbox:true 后 preload 必须照常工作）
const bridge = await evaluate(`window.youyou ? 'bridge-ok' : 'BRIDGE-MISSING'`)
console.log(`桥接: ${bridge}`)
if (bridge !== 'bridge-ok') process.exit(1)
const info = await evaluate(`window.youyou.invoke('app:info').then(r => ({ ok: r.ok, name: r.data?.name, version: r.data?.version }))`)
console.log(`app:info → ${JSON.stringify(info)}`)

// 2. 订阅 trackFailed + 搜索
await evaluate(`
  window.__failed = [];
  window.youyou.on('player:trackFailed', (p) => window.__failed.push({ ...p, t: Date.now() }));
  'ok'
`)
const search = await evaluate(`window.youyou.invoke('search:query', { keywords: ${JSON.stringify(keyword)}, type: 'songs', limit: 30, offset: 0 }).then(r => ({
  ok: r.ok, count: r.data?.songs?.length,
  first: r.data?.songs?.[0] ?? null
}))`)
console.log(`搜索「${keyword}」→ ${search.count} 首，第一首: ${search.first ? JSON.stringify({ id: search.first.id, name: search.first.name, fee: search.first.fee }) : '无'}`)

// 3. 播第一首，看位置推进
if (search.first) {
  const play = await evaluate(`window.youyou.invoke('player:playTracks', { tracks: ${JSON.stringify([search.first])}, startIndex: 0, playlistID: 'final-verify' }).then(r => ({ ok: r.ok, error: r.error }))`)
  console.log(`playTracks → ${JSON.stringify(play)}`)
  let advanced = false
  for (let i = 0; i < 20 && !advanced; i++) {
    await sleep(1000)
    const st = await evaluate(`window.youyou.invoke('player:state').then(r => ({ pos: r.data?.position, dur: r.data?.duration, playing: r.data?.playing, from: r.data?.servedFrom }))`)
    if (st.pos > 0.5) {
      advanced = true
      console.log(`播放推进: pos=${st.pos.toFixed(1)}s dur=${st.dur ?? 0} from=${st.from ?? '官方'}`)
    }
  }
  console.log(advanced ? 'PLAY OK' : 'PLAY STALLED')
}

// 4. 观察 35s 后台校验（本批应 0 误伤）
await sleep(35_000)
const failed = await evaluate(`window.__failed`)
console.log(`35s 内 trackFailed: ${failed.length} 条 ${failed.length ? JSON.stringify(failed) : ''}`)
ws.close()
