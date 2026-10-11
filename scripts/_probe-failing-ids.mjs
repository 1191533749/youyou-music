// 从用户桌面正在运行的实例（CDP 9436）里捞出失败曲目的 id/name/fee/playability
const PORT = 9436
const TIMEOUT = 60_000

async function getTargetWs() {
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
  const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
  if (!page) throw new Error('no page target: ' + JSON.stringify(list.map((t) => t.url)))
  return page.webSocketDebuggerUrl
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.on('open', () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const mid = ++id
            pending.set(mid, { res, rej })
            ws.send(JSON.stringify({ id: mid, method, params }))
            setTimeout(() => {
              if (pending.delete(mid)) rej(new Error(`cdp timeout: ${method}`))
            }, TIMEOUT)
          })
        },
        close() {
          ws.close()
        }
      })
    )
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
      }
    })
    ws.on('error', reject)
  })
}

const wsUrl = await getTargetWs()
const cdp = await connect(wsUrl)
const evalJS = async (expr) => {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true
  })
  if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails))
  return result.value
}

const WANT = [
  ['周杰伦', ['Try', 'Kung Fu Panda']],
  ['凤凰传奇', ['吉祥如意', '最炫民族风']],
  ['许嵩', ['南山忆', '洛阳纸']]
]

for (const [query, needles] of WANT) {
  const res = await evalJS(`window.youyou.invoke('search:query', { keywords: ${JSON.stringify(query)}, type: 'songs', page: 0, limit: 30 })`)
  const songs = res?.data?.songs ?? []
  console.log(`\n== ${query} (netease=${songs.length}) ==`)
  for (const s of songs) {
    const label = `${s.name} - ${(s.artists ?? []).map((a) => a.name).join('/')}`
    if (needles.some((n) => label.includes(n))) {
      console.log(
        `${s.id} | ${label} | fee=${s.fee} pb=${s.playability} reason=${s.playabilityReason ?? '-'}`
      )
    }
  }
  // external 同名也捞一下
  const ext = res?.data?.external ?? []
  for (const e of ext) {
    if (needles.some((n) => (e.name ?? '').includes(n))) {
      console.log(`ext ${e.source}/${e.sourceId} | ${e.name} - ${(e.artists ?? []).join('/')}`)
    }
  }
}

cdp.close()
console.log('\ndone')
