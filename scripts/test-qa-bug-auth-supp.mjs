/**
 * bug 猎手 · 补充探针：
 *  A. 路径3 登出时队列行为：队列 [A,B] 播放中登出 → 观察是否 ~13s 后自动起播下一首（登出后仍出声）。
 *  B. 路径3 假登录：坏 cookie 冷启动后首次 API 失败，auth:state 是否自动切回未登录。
 *  C. 路径9 clearQueue 后幽灵状态：playing=true track=null，观察 pos 是否冻结（UI 显示播放中但无声）。
 */
import * as path from 'node:path'
import * as os from 'node:os'
import {
  log, wait, launchBugInstance, killInstance, waitReady, cdp, playerState,
  waitPlaying, freshUserData, waitPortFree, plantCachedAudio, plantCookies
} from './test-qa-bug-lib.mjs'

const DTO = (id) => ({ id, name: `样本${id % 1000}`, artists: [{ id: 1, name: 'QA' }], album: { id: 1, name: 'QA专辑' }, durationMS: 120000, alias: [], transNames: [], fee: 0, mvID: 0, noCopyright: false, isCloud: false })

async function scenarioA() {
  const PORT = 9423
  const userData = path.join(os.tmpdir(), 'youyou-bug-auth-supp')
  freshUserData(userData)
  killInstance(userData)
  plantCachedAudio(userData, 999000001)
  plantCachedAudio(userData, 999000002)
  const inst = await launchBugInstance({ port: PORT, userData })
  try {
    await waitReady(PORT, 90_000)
    await cdp(PORT, `(async () => {
      await window.youyou.invoke('player:setQueue', { tracks: ${JSON.stringify([DTO(999000001), DTO(999000002)])}, startIndex: 0 })
      return true
    })()`)
    const played = await waitPlaying(PORT, 30_000)
    log(`A 起播: ${played.state?.track?.name} pos=${played.state?.position?.toFixed(1)}`)
    await cdp(PORT, `(async () => (await window.youyou.invoke('auth:logout')).data)()`)
    const timeline = []
    for (let i = 0; i < 26; i += 1) {
      const st = await playerState(PORT)
      timeline.push({ t: i, playing: st.value?.playing, track: st.value?.track?.name ?? null, pos: Number(st.value?.position ?? 0).toFixed(1) })
      await wait(1000)
    }
    const transitions = []
    for (let i = 1; i < timeline.length; i += 1) {
      if (timeline[i].track !== timeline[i - 1].track) transitions.push(`${timeline[i - 1].track}@${timeline[i - 1].t}s → ${timeline[i].track}@${timeline[i].t}s`)
    }
    const resumed = timeline.find((s) => s.playing === true && s.track !== null && Number(s.pos) > 0)
    log(`A 登出后时间线: ${JSON.stringify(timeline.filter((_, i) => i % 3 === 0))}`)
    log(`A 曲目切换: ${JSON.stringify(transitions)}`)
    log(`A 登出后重新出声: ${JSON.stringify(resumed)}`)
  } finally {
    killInstance(userData, inst?.pid ?? 0)
    await waitPortFree(PORT)
  }
}

async function scenarioB() {
  const PORT = 9424
  const userData = path.join(os.tmpdir(), 'youyou-bug-auth-bad2')
  freshUserData(userData)
  killInstance(userData)
  // 坏 cookie：写一个结构完整但 token 必然无效的 cookies.json
  const { writeFileSync } = await import('node:fs')
  writeFileSync(path.join(userData, 'cookies.json'), JSON.stringify([{ name: 'MUSIC_U', value: 'deadbeef-invalid', domain: '.163.com' }]))
  const inst = await launchBugInstance({ port: PORT, userData, cookie: false })
  try {
    await waitReady(PORT, 90_000)
    const auth1 = await cdp(PORT, `(async () => (await window.youyou.invoke('auth:state')).data)()`)
    // 打一个必须登录的接口
    const api = await cdp(PORT, `(async () => {
      try {
        const r = await Promise.race([
          window.youyou.invoke('search:query', { keywords: '周杰伦', type: 'songs', limit: 3, offset: 0 }),
          new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), 15000))
        ])
        return { timeout: r?.__timeout === true, error: r?.error ?? null, n: r?.data?.songs?.length ?? -1 }
      } catch (cause) { return { throw: String(cause).slice(0, 140) } }
    })()`)
    await wait(2500)
    const auth2 = await cdp(PORT, `(async () => (await window.youyou.invoke('auth:state')).data)()`)
    const gate = await cdp(PORT, `Boolean(document.querySelector('.together__gate'))`)
    log(`B 坏cookie: auth1=${JSON.stringify({ loggedIn: auth1.value?.loggedIn })} api=${JSON.stringify(api.value)} auth2=${JSON.stringify({ loggedIn: auth2.value?.loggedIn })}`)
    log(`B 假登录判定: 初始loggedIn=${auth1.value?.loggedIn} API后仍loggedIn=${auth2.value?.loggedIn}`)
  } finally {
    killInstance(userData, inst?.pid ?? 0)
    await waitPortFree(PORT)
  }
}

async function scenarioC() {
  const PORT = 9425
  const userData = path.join(os.tmpdir(), 'youyou-bug-fm-supp')
  freshUserData(userData)
  killInstance(userData)
  const inst = await launchBugInstance({ port: PORT, userData })
  try {
    await waitReady(PORT, 90_000)
    const fm = await cdp(PORT, `(async () => {
      const r = await window.youyou.invoke('track:fm')
      if (r?.error || !r?.data?.length) return { error: r?.error ?? 'empty', n: 0 }
      await window.youyou.invoke('player:playFMTracks', { tracks: r.data })
      return { n: r.data.length }
    })()`)
    const played = await waitPlaying(PORT, 40_000)
    log(`C 漫游起播: n=${fm.value?.n} name=${played.state?.track?.name}`)
    await cdp(PORT, `(async () => (await window.youyou.invoke('player:clearQueue')).data)()`)
    const timeline = []
    for (let i = 0; i < 6; i += 1) {
      const st = await playerState(PORT)
      timeline.push({ t: i * 2, playing: st.value?.playing, track: st.value?.track?.name ?? null, pos: Number(st.value?.position ?? 0).toFixed(1), queueLen: st.value?.queue?.length ?? -1 })
      await wait(2000)
    }
    log(`C clearQueue 后: ${JSON.stringify(timeline)}`)
  } finally {
    killInstance(userData, inst?.pid ?? 0)
    await waitPortFree(PORT)
  }
}

await scenarioA()
await scenarioB()
await scenarioC()
log('补充探针完成')
