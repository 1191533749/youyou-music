/**
 * 端到端验证「QQ音乐歌单 → 曲目 → 真的出声」，入口在 设置 → 音源账号。
 *
 * 用法：npx electron-vite build 之后 node scripts/test-playlist.mjs
 *
 * QQ 歌单要扫码登录才拿得到，所以这里用 YOYOU_FAKE_QQ_ACCOUNT=1 种一个假账号 + 一张
 * 公开歌单（dissid 7707261125）。曲目接口与播放链路都是真实的，只有账号与歌单是固定的。
 */
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import process from 'node:process'

const root = process.cwd()
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9376
const userData = path.join(os.tmpdir(), 'youyou-playlist-test')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[playlist] ${message}`)

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
        resolve({
          __exception: `${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`
        })
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

/** 轮询一段表达式直到它为真。 */
async function waitFor(expression, timeoutMs = 20_000, label = expression) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await cdpEval(expression)
    if (last === true) return true
    await wait(500)
  }
  log(`等待超时: ${label} 最后取值=${JSON.stringify(last)?.slice(0, 300)}`)
  return false
}

const state = () => cdpEval(`(async () => (await window.youyou.invoke('player:state')).data)()`)

/** 侧栏「设置」入口。 */
const openSettings = () =>
  cdpEval(
    `(() => {
      const link = [...document.querySelectorAll('.sidebar__link')].find((node) => (node.textContent ?? '').trim() === '设置')
      if (!link) return false
      link.click()
      return true
    })()`
  )

const sourceSnapshot = () =>
  cdpEval(
    `(() => {
      const rows = [...document.querySelectorAll('.settings__group')]
      const group = rows.find((node) => (node.querySelector('h2')?.textContent ?? '').trim() === '音源账号')
      if (!group) return { found: false }
      return {
        found: true,
        title: group.querySelector('.source-account-title')?.textContent ?? null,
        hint: group.querySelector('.settings__row-hint')?.textContent ?? null,
        button: group.querySelector('.settings__row-control .button')?.textContent ?? null,
        playlists: group.querySelectorAll('.source-playlist').length,
        tracks: group.querySelectorAll('.source-track-name').length,
        bar: group.querySelector('.source-tracks-bar .button')?.textContent ?? null,
        qr: Boolean(group.querySelector('.source-bind img, .source-bind .login__qr-placeholder'))
      }
    })()`
  )

async function main() {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  const env = { ...process.env, YOYOU_USER_DATA: userData, YOYOU_FAKE_QQ_ACCOUNT: '1' }
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

    record('侧栏进入设置页', await openSettings())
    const onSettings = await waitFor(
      `document.querySelectorAll('.settings__group').length > 0`,
      15_000,
      '设置页出现'
    )
    record('设置页出现', onSettings)

    const bound = await waitFor(
      `(() => {
        const group = [...document.querySelectorAll('.settings__group')].find((node) => (node.querySelector('h2')?.textContent ?? '').trim() === '音源账号')
        return Boolean(group && group.querySelector('.source-playlist'))
      })()`,
      25_000,
      '已绑定 QQ 并列出歌单'
    )
    const initial = await sourceSnapshot()
    record('音源账号分组存在', initial.found, `title=${JSON.stringify(initial.title)}`)
    record('显示为已绑定', initial.hint === '测试账号', `hint=${JSON.stringify(initial.hint)}`)
    record('提供解绑入口', initial.button === '解绑', `button=${JSON.stringify(initial.button)}`)
    record('已绑定即列出歌单', bound, `playlists=${initial.playlists}`)
    record('未绑定时不显示二维码', initial.qr === false)

    // 点开歌单 → 曲目从 auth:platformPlaylistTracks 真实取回
    await cdpEval(`(() => { document.querySelector('.source-playlist').click(); return true })()`)
    const skeletonShown = await waitFor(
      `Boolean(document.querySelector('.source-track--skeleton'))`,
      5_000,
      '取曲目时先给占位'
    )
    const trackListed = await waitFor(
      `document.querySelectorAll('.source-track-name').length > 0`,
      30_000,
      '歌单曲目列出'
    )
    const tracks = await cdpEval(
      `(() => {
        const rows = [...document.querySelectorAll('.source-track-list li')]
        const names = [...document.querySelectorAll('.source-track-name')]
        return {
          count: rows.length,
          count2: names.length,
          first: rows[0]?.textContent ?? null,
          bar: document.querySelector('.source-tracks-bar .button')?.textContent ?? null,
          active: Boolean(document.querySelector('.source-playlist--active'))
        }
      })()`
    )
    record('取曲目时先给占位', skeletonShown)
    record('点开歌单列出曲目', trackListed, `count=${tracks.count} first=${JSON.stringify(tracks.first)}`)
    record('歌单行进入展开态', tracks.active)
    record('提供播放全部', tracks.bar === '播放全部', String(tracks.bar))

    // 播放全部：站外队列 → 解析音源 → mpv 出声
    await cdpEval(`(() => { document.querySelector('.source-tracks-bar .button').click(); return true })()`)
    const playing = await waitFor(
      `(async () => {
        const s = (await window.youyou.invoke('player:state')).data
        return Boolean(s && s.playing && s.position > 0.6 && s.servedFrom && !s.error)
      })()`,
      150_000,
      '站外队列播放出声'
    )
    const snapshot = await state()
    record(
      '播放全部后真的出声',
      playing,
      `servedFrom=${snapshot?.servedFrom} pos=${snapshot?.position?.toFixed?.(1)} queue=${snapshot?.queue?.length}`
    )
    record(
      '队列长度等于歌单曲目数',
      Array.isArray(snapshot?.queue) && snapshot.queue.length === tracks.count2,
      `queue=${snapshot?.queue?.length} tracks=${tracks.count2}`
    )
    record(
      '播放的是站外合成曲目',
      typeof snapshot?.track?.id === 'number' && snapshot.track.id < 0,
      `id=${snapshot?.track?.id} name=${snapshot?.track?.name}`
    )

    // 点第三行：应该切到那一首
    const clickedThird = await cdpEval(
      `(() => {
        const rows = [...document.querySelectorAll('.source-track-list li .source-track')]
        if (rows.length < 3) return false
        rows[2].click()
        return true
      })()`
    )
    if (clickedThird) {
      const switched = await waitFor(
        `(async () => {
          const s = (await window.youyou.invoke('player:state')).data
          return Boolean(s && s.index === 2)
        })()`,
        60_000,
        '点第三行切到第三首'
      )
      record('点某一行从那一首开始播', switched, `index=${(await state())?.index}`)
    } else {
      record('点某一行从那一首开始播', false, '歌单曲目不足三首')
    }

    // 解绑：状态回到未绑定，歌单与曲目一起消失（证明绑定状态来自真实数据）
    await cdpEval(`(() => {
      const group = [...document.querySelectorAll('.settings__group')].find((node) => (node.querySelector('h2')?.textContent ?? '').trim() === '音源账号')
      const button = [...group.querySelectorAll('.settings__row-control .button')].find((node) => (node.textContent ?? '').trim() === '解绑')
      if (!button) return false
      button.click()
      return true
    })()`)
    const unbound = await waitFor(
      `(() => {
        const group = [...document.querySelectorAll('.settings__group')].find((node) => (node.querySelector('h2')?.textContent ?? '').trim() === '音源账号')
        if (!group) return false
        const hint = group.querySelector('.settings__row-hint')?.textContent ?? ''
        return hint.trim() === '未绑定' && group.querySelectorAll('.source-playlist').length === 0
      })()`,
      20_000,
      '解绑后回到未绑定'
    )
    const after = await sourceSnapshot()
    record('解绑后回到未绑定', unbound, `hint=${JSON.stringify(after.hint)} button=${JSON.stringify(after.button)}`)
    record('解绑后歌单清空', after.playlists === 0, `playlists=${after.playlists}`)
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
