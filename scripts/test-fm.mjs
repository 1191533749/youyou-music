/**
 * 端到端验证「私人漫游全部走汽水音乐、随机播放」。
 *
 * 用法：npx electron-vite build 之后 node scripts/test-fm.mjs
 * 用独立的 userData（不需要登录：汽水免登录直连）。
 */
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9379
const userData = path.join(os.tmpdir(), 'youyou-fm-test')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[fm] ${message}`)

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function cdpEval(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error('未找到页面 target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', reject)
  })
  const value = await new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e9)
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      ws.removeEventListener('message', onMessage)
      const result = message.result
      if (result?.exceptionDetails) {
        resolve({ __exception: result.exceptionDetails.text })
        return
      }
      resolve(result?.result?.value)
    }
    ws.addEventListener('message', onMessage)
    ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true }
      })
    )
  })
  ws.close()
  return value
}

async function waitFor(expression, timeoutMs = 20_000, label = expression) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await cdpEval(expression)
    if (last === true) return true
    await wait(500)
  }
  log(`等待超时: ${label} 最后取值=${JSON.stringify(last)?.slice(0, 200)}`)
  return false
}

const state = () => cdpEval(`(async () => (await window.youyou.invoke('player:state')).data)()`)

const fmSnapshot = () =>
  cdpEval(
    `(() => ({
      title: document.querySelector('.fm__title')?.textContent ?? null,
      artist: document.querySelector('.fm__artist')?.textContent ?? null,
      queue: document.querySelector('.fm__queue')?.textContent ?? null,
      playing: Boolean(document.querySelector('.fm__control--primary')),
      placeholder: document.querySelector('.placeholder')?.textContent ?? null
    }))()`
  )

async function main() {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  const env = { ...process.env, YOYOU_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    stdio: 'ignore',
    env,
    cwd: root,
    detached: true
  })
  child.unref()

  try {
    let ready = false
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await wait(1500)
      try {
        if (await cdpEval(`Boolean(window.youyou)`)) {
          ready = true
          break
        }
      } catch {
        /* 还没起来 */
      }
    }
    if (!ready) {
      record('实例启动', false, '轮询超时')
      return
    }
    record('实例启动并连上 CDP', true)

    // 未登录也能进：漫游页在侧栏里，不需要网易云账号。
    const entered = await cdpEval(
      `(() => {
        const link = [...document.querySelectorAll('.sidebar__link')].find((node) => (node.textContent ?? '').trim() === '私人漫游')
        if (!link) return false
        link.click()
        return true
      })()`
    )
    record('侧栏进入私人漫游', entered)

    const started = await waitFor(
      `Boolean(document.querySelector('.fm__title'))`,
      40_000,
      '漫游曲目出现'
    )
    const first = await fmSnapshot()
    record('漫游开始出曲', started, `title=${JSON.stringify(first.title)} placeholder=${JSON.stringify(first.placeholder)}`)
    record('曲目有歌名与歌手', Boolean(first.title) && Boolean(first.artist), `${first.title} / ${first.artist}`)
    record('显示漫游队列剩余', /漫游队列剩余\s*\d+/.test(first.queue ?? ''), JSON.stringify(first.queue))

    const playing = await waitFor(
      `(async () => {
        const s = (await window.youyou.invoke('player:state')).data
        return Boolean(s && s.playing && s.position > 0.5 && s.servedFrom)
      })()`,
      60_000,
      '漫游出声'
    )
    const snapshot = await state()
    record('漫游出声', playing, `servedFrom=${snapshot?.servedFrom} pos=${snapshot?.position?.toFixed?.(1)}`)
    record('音源是汽水音乐', snapshot?.servedFrom === '汽水音乐', String(snapshot?.servedFrom))
    record('队列来自站外合成曲目', typeof snapshot?.track?.id === 'number' && snapshot.track.id < 0, `id=${snapshot?.track?.id}`)

    // 换两首：曲目必须都是站外合成曲目（漫游由汽水供曲），汽水优先、拿不到才换源。
    const sources = [snapshot?.servedFrom]
    for (const round of [1, 2]) {
      const before = (await state())?.track?.name
      await cdpEval(`(async () => (await window.youyou.invoke('player:next')).data)()`)
      const switched = await waitFor(
        `(async () => {
          const s = (await window.youyou.invoke('player:state')).data
          return Boolean(s && s.playing && s.position > 0.3 && s.servedFrom && s.track && s.track.id < 0 && s.track.name !== ${JSON.stringify(before)})
        })()`,
        60_000,
        `第 ${round} 次换曲出声`
      )
      const now = await state()
      sources.push(now?.servedFrom)
      record(
        `换到第 ${round + 1} 首仍是漫游曲目`,
        switched,
        `${before} → ${now?.track?.name} servedFrom=${now?.servedFrom} id=${now?.track?.id}`
      )
    }
    const qishuiCount = sources.filter((item) => item === '汽水音乐').length
    record(
      '汽水是漫游的主要音源',
      qishuiCount >= 2,
      `来源=${JSON.stringify(sources)}（汽水 ${qishuiCount}/${sources.length}）`
    )

    // 「不喜欢」按钮：站外曲目不该报错，且能换下一首
    const trashWorked = await cdpEval(
      `(() => {
        const button = [...document.querySelectorAll('.fm__control')].find((node) => (node.getAttribute('aria-label') ?? '').includes('不喜欢'))
        if (!button) return false
        button.click()
        return true
      })()`
    )
    record('找到不喜欢按钮', trashWorked)
    const afterTrash = await waitFor(
      `(async () => {
        const s = (await window.youyou.invoke('player:state')).data
        return Boolean(s && s.playing && s.servedFrom === '汽水音乐')
      })()`,
      45_000,
      '不喜欢后继续漫游'
    )
    const toast = await cdpEval(`document.querySelector('.toast')?.textContent ?? null`)
    record('不喜欢后继续漫游且无报错', afterTrash && !/失败/.test(toast ?? ''), `toast=${JSON.stringify(toast)}`)
  } finally {
    try {
      await cdpEval(`window.close()`)
    } catch {
      /* 忽略 */
    }
    spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
  }

  const failed = results.filter((item) => !item.ok)
  log(`结果: ${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
