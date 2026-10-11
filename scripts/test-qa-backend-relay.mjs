/**
 * QA 后端压测：一起听中继（wss://yy.ytw.asia/relay）连接稳定性。
 *
 * 覆盖三件事：
 *  1. 连续 20 次「握手→hello→welcome→主动断开」：统计每次 TCP/TLS（tls.connect
 *     单独测）、WS 握手（time-to-open）、welcome 往返耗时，失败次数与原因分类
 *     （超时 / 拒绝 / 服务端关闭码）。
 *  2. 长连接保持 5 分钟：记录是否被服务端断开（含关闭码/原因）与断开时刻。
 *  3. 输出汇总：成功率、min/avg/p50/p95/max。
 *
 * 用法：
 *   node scripts/test-qa-backend-relay.mjs                     # 全部
 *   node scripts/test-qa-backend-relay.mjs --handshake-only
 *   node scripts/test-qa-backend-relay.mjs --hold-only
 *   node scripts/test-qa-backend-relay.mjs --attempts 40
 * 环境变量：
 *   QA_RELAY_URL     默认 wss://yy.ytw.asia/relay
 *   QA_RELAY_TOKEN   默认 yy-7f3a9c2e51d84b06
 *   QA_RELAY_HOLD_S  长连接秒数，默认 300
 */
import tls from 'node:tls'

const URL_BASE = process.env.QA_RELAY_URL ?? 'wss://yy.ytw.asia/relay'
const TOKEN = process.env.QA_RELAY_TOKEN ?? 'yy-7f3a9c2e51d84b06'
const HOLD_SECONDS = Number(process.env.QA_RELAY_HOLD_S ?? 300)
const attemptsArg = process.argv.indexOf('--attempts')
const ATTEMPTS = Number(
  attemptsArg >= 0
    ? (process.argv[attemptsArg + 1] ?? '').startsWith('--')
      ? 20
      : process.argv[attemptsArg + 1] ?? 20
    : process.argv.find((a) => a.startsWith('--attempts='))?.split('=')[1] ?? 20
)
const ONLY_HANDSHAKE = process.argv.includes('--handshake-only')
const ONLY_HOLD = process.argv.includes('--hold-only')
const HOSTNAME = new URL(URL_BASE).hostname
const PORT = Number(new URL(URL_BASE).port || 443)

const url = TOKEN ? `${URL_BASE}${URL_BASE.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}` : URL_BASE
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const log = (message) => console.log(`[qa-relay] ${message}`)

/** 单独测一次 TCP+TLS 握手（不含 WS 升级），拿真实 TCP/TLS 耗时。 */
function measureTls() {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let socket
    try {
      socket = tls.connect({ host: HOSTNAME, port: PORT, servername: HOSTNAME }, () => {
        const ms = Date.now() - t0
        socket.destroy()
        resolve({ ok: true, ms })
      })
      socket.setTimeout(12_000, () => {
        socket.destroy()
        resolve({ ok: false, ms: Date.now() - t0, reason: 'tls-timeout' })
      })
      socket.on('error', (error) => {
        socket.destroy()
        resolve({ ok: false, ms: Date.now() - t0, reason: `tls-error:${error.code ?? error.message}` })
      })
    } catch (error) {
      resolve({ ok: false, ms: Date.now() - t0, reason: `tls-throw:${error.code ?? error.message}` })
    }
  })
}

/** 一次完整连接：握手 → hello → welcome → 主动断开。 */
function oneAttempt(index) {
  return new Promise((resolve) => {
    const started = Date.now()
    const result = { index, openMs: null, welcomeMs: null, closeCode: null, closeReason: '', failed: null }
    let opened = false
    let welcomed = false
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      if (welcomed) return
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      if (!opened) result.failed = 'handshake-timeout(>12s)'
      else if (!welcomed) result.failed = 'welcome-timeout(>12s)'
      resolve(result)
    }, 12_000)

    ws.addEventListener('open', () => {
      opened = true
      result.openMs = Date.now() - started
      const sentAt = Date.now()
      ws.send(JSON.stringify({ type: 'hello', profile: { uid: `qa-backend-${index}-${Date.now()}`, nickname: 'QA压测' } }))
      ws.addEventListener('message', () => {
        if (welcomed) return
        welcomed = true
        result.welcomeMs = Date.now() - sentAt
        clearTimeout(timer)
        ws.close(1000)
        // close 事件里收尾
      })
    })
    ws.addEventListener('close', (event) => {
      clearTimeout(timer)
      result.closeCode = event.code
      result.closeReason = String(event.reason ?? '')
      if (!opened && result.failed === null) result.failed = `closed-before-open(code=${event.code} reason=${event.reason})`
      if (opened && !welcomed && result.failed === null) result.failed = `closed-before-welcome(code=${event.code} reason=${event.reason})`
      resolve(result)
    })
    ws.addEventListener('error', () => {
      // error 之后一般跟 close，这里只做兜底记录
      if (result.failed === null) result.failed = 'error-event'
    })
  })
}

function stats(values, label) {
  const sorted = [...values].sort((a, b) => a - b)
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null
  return `${label}: n=${values.length} min=${sorted[0]} avg=${Math.round(
    values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1)
  )} p50=${q(50)} p95=${q(95)} max=${sorted[sorted.length - 1]}`
}

async function handshakePhase() {
  log(`握手压测开始：${ATTEMPTS} 次，目标 ${url}`)
  const results = []
  for (let i = 1; i <= ATTEMPTS; i += 1) {
    const [tlsResult, attempt] = await Promise.all([measureTls(), oneAttempt(i)])
    results.push({ ...attempt, tls: tlsResult })
    const status = attempt.failed ? 'FAIL' : 'OK'
    log(
      `${status} #${i}: tls=${tlsResult.ok ? tlsResult.ms + 'ms' : '失败(' + tlsResult.reason + ')'} ` +
        `open=${attempt.openMs ?? '-'}ms welcome=${attempt.welcomeMs ?? '-'}ms close=${attempt.closeCode} ` +
        `${attempt.failed ? '失败:' + attempt.failed : ''}`
    )
    await wait(400)
  }

  const okList = results.filter((r) => !r.failed)
  const failed = results.filter((r) => r.failed)
  const openMs = okList.map((r) => r.openMs).filter((v) => v !== null)
  const welcomeMs = okList.map((r) => r.welcomeMs).filter((v) => v !== null)
  const tlsMs = results.filter((r) => r.tls.ok).map((r) => r.tls.ms)

  console.log('\n===== 中继握手压测汇总 =====')
  console.log(`成功率: ${okList.length}/${results.length} (${Math.round((okList.length / results.length) * 100)}%)`)
  if (tlsMs.length) console.log(stats(tlsMs, 'TCP+TLS 握手'))
  if (openMs.length) console.log(stats(openMs, 'WS 握手(time-to-open)'))
  if (welcomeMs.length) console.log(stats(welcomeMs, 'welcome 往返'))
  if (failed.length > 0) {
    const byReason = {}
    for (const r of failed) byReason[r.failed] = (byReason[r.failed] ?? 0) + 1
    console.log(`失败 ${failed.length} 次，原因分布: ${JSON.stringify(byReason)}`)
  }
  const closeCodes = {}
  for (const r of results) closeCodes[`${r.closeCode ?? 'none'}`] = (closeCodes[`${r.closeCode ?? 'none'}`] ?? 0) + 1
  console.log(`关闭码分布: ${JSON.stringify(closeCodes)}`)
  const tlsFailures = results.filter((r) => !r.tls.ok)
  if (tlsFailures.length) console.log(`TCP/TLS 单独探测失败 ${tlsFailures.length} 次: ${tlsFailures.map((r) => `#${r.index} ${r.tls.reason}`).join(' | ')}`)
  return { ok: okList.length, total: results.length, openMs, welcomeMs, tlsMs, failed }
}

async function holdPhase() {
  log(`长连接测试开始：保持 ${HOLD_SECONDS} 秒`)
  const started = Date.now()
  const events = []
  const outcome = await new Promise((resolve) => {
    const ws = new WebSocket(url)
    let welcomed = false
    const finish = (kind, detail) => resolve({ kind, detail, elapsedMs: Date.now() - started })
    const watchdog = setTimeout(() => {
      finish('watchdog', '未在 12 秒内完成握手')
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }, 12_000)
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', profile: { uid: `qa-hold-${Date.now()}`, nickname: 'QA长连接' } }))
    })
    ws.addEventListener('message', (event) => {
      let msg
      try {
        msg = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (!welcomed && msg.type === 'welcome') {
        welcomed = true
        clearTimeout(watchdog)
        log(`已握手，开始保持 ${HOLD_SECONDS}s（clientId=${msg.clientId}）`)
      }
      events.push({ type: msg.type, atMs: Date.now() - started })
    })
    ws.addEventListener('close', (event) => {
      if (!welcomed) return
      events.push({ type: `close(code=${event.code} reason=${event.reason})`, atMs: Date.now() - started })
      finish('closed', `code=${event.code} reason=${event.reason}`)
    })
    ws.addEventListener('error', () => {
      events.push({ type: 'error', atMs: Date.now() - started })
    })
    const ticker = setInterval(() => {
      const elapsed = Date.now() - started
      if (elapsed >= HOLD_SECONDS * 1000) {
        clearInterval(ticker)
        clearTimeout(watchdog)
        ws.close(1000)
        finish('completed', `${HOLD_SECONDS}s 保持完成`)
      } else if (elapsed % 60_000 < 2_000) {
        log(`仍在保持中 … ${Math.round(elapsed / 1000)}s / ${HOLD_SECONDS}s`)
      }
    }, 1_000)
    setTimeout(() => {
      // 兜底：ticker 出问题时强制收尾
      if (!welcomed) return
      clearInterval(ticker)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      finish('completed', '兜底完成')
    }, HOLD_SECONDS * 1000 + 10_000)
  })

  console.log('\n===== 中继长连接汇总 =====')
  console.log(`结果: ${outcome.kind} — ${outcome.detail} (${Math.round(outcome.elapsedMs / 1000)}s)`)
  if (outcome.kind === 'closed') {
    console.log('服务端/链路在保持期间断开了连接（这就是「一起听掉线」的直接证据）')
  }
  if (events.length > 3) {
    console.log(`保持期间收到 ${events.length - 1} 条事件（首条 welcome 除外）`)
  }
  return outcome
}

async function main() {
  const results = {}
  if (!ONLY_HOLD) results.handshake = await handshakePhase()
  if (!ONLY_HANDSHAKE) results.hold = await holdPhase()
  log('QA-RELAY DONE')
}

main().catch((error) => {
  console.error('[qa-relay] 异常:', error)
  process.exit(1)
})
