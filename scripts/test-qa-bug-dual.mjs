/**
 * bug 猎手 · 路径 6：双实例同账号互顶（同一 userData 同时启动两个实例）。
 * 期望：第二个实例触发单实例锁 → 唤起第一个实例窗口并干净退出；第一个实例存活可用。
 */
import * as path from 'node:path'
import * as os from 'node:os'
import {
  log, wait, launchBugInstance, killInstance, waitReady, cdp, playerState, freshUserData, waitPortFree
} from './test-qa-bug-lib.mjs'

const PORT_A = 9416
const PORT_B = 9417
const userData = path.join(os.tmpdir(), 'youyou-bug-dual')
const results = []
const bugs = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'BUG?'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const report = (pathNo, operation, symptom, severity, evidence) => {
  bugs.push(`路径${pathNo} → ${operation} → ${symptom} → 严重度:${severity}${evidence ? ` | 证据:${evidence}` : ''}`)
  log(`🐛 ${bugs[bugs.length - 1]}`)
}

async function main() {
  freshUserData(userData)
  killInstance(userData)
  const instA = await launchBugInstance({ port: PORT_A, userData })
  try {
    const ready = await waitReady(PORT_A, 90_000)
    record('实例 A 启动', ready)
    if (!ready) return

    // 实例 A 先出声
    const st = await playerState(PORT_A)
    log(`A 状态: ${JSON.stringify(st.value)?.slice(0, 140)}`)

    // 启动实例 B：同一 userData（cookie:false 不覆盖已种植的 cookie）
    log('== 启动实例 B（同 userData） ==')
    const instB = await launchBugInstance({ port: PORT_B, userData, cookie: false, fixture: false })
    let exitInfo = { code: null, timedOut: false }
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 30_000)
      instB.on('exit', (code, signal) => {
        clearTimeout(timer)
        exitInfo.code = code
        exitInfo.signal = signal
        resolve('exit')
      })
      instB.on('error', (cause) => {
        clearTimeout(timer)
        exitInfo.err = String(cause)
        resolve('error')
      })
    })
    record('实例 B 干净退出（单实例锁）', exited === 'exit' && exitInfo.code === 0, JSON.stringify({ exited, ...exitInfo }))
    if (exited !== 'exit' || exitInfo.code !== 0) {
      report(6, '同 userData 启动第二实例', '第二实例未走单实例锁退出', exited === 'timeout' ? '挂死' : '体验差', JSON.stringify({ exited, ...exitInfo }))
      killInstance(userData, instB?.pid ?? 0)
    }

    // 实例 A 仍存活且可用
    const aliveA = await cdp(PORT_A, `Boolean(window.youyou)`).then((r) => r.ok && r.value === true).catch(() => false)
    record('互顶后实例 A 存活', aliveA)
    if (!aliveA) report(6, '双实例互顶', '第一实例被顶死', '崩溃', 'A CDP 无响应')

    // 互顶后 A 的播放器仍响应
    const st2 = await playerState(PORT_A)
    record('互顶后 A 播放器通道仍响应', st2.ok, JSON.stringify(st2.value ?? st2.error)?.slice(0, 140))
  } catch (cause) {
    record('测试执行异常', false, String(cause).slice(0, 200))
  } finally {
    killInstance(userData, instA?.pid ?? 0)
  }

  const failed = results.filter((item) => !item.ok)
  log(`结果: ${results.length - failed.length}/${results.length} 通过，bugs=${bugs.length}`)
  for (const line of bugs) console.log(`REPORT|${line}`)
  if (failed.length > 0 || bugs.length > 0) process.exitCode = 1
}

await main()
