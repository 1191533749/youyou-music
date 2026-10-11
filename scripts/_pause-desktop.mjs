// 一次性：暂停当前播放，把桌面还原成「没在放歌」。
const list = await (await fetch('http://127.0.0.1:9436/json/list')).json()
const wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl
const ws = new WebSocket(wsUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
const timer = setTimeout(() => process.exit(1), 8000)
ws.onmessage = (e) => {
  const m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString())
  if (m.id === 1) {
    clearTimeout(timer)
    console.log('pause →', JSON.stringify(m.result?.result?.value))
    ws.close()
    process.exit(0)
  }
}
ws.send(
  JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: {
      expression: "window.youyou.invoke('player:pause').then(r => ({ ok: r.ok }))",
      awaitPromise: true,
      returnByValue: true
    }
  })
)
