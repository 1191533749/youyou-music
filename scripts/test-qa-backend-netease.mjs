/**
 * QA 后端压测：网易云接口 —— eapi /cloudsearch/pc 与 weapi 回落的响应时间、
 * 业务错误率、空响应体（限流）率；并对比匿名态 vs 登录态（MUSIC_U cookie）。
 *
 * 加密复刻 src/main/netease/crypto.ts；回落语义对齐 src/main/netease/api.ts：
 * weapi 空响应体 = 被限流 → 同请求换 eapi。
 *
 * 用法：node scripts/test-qa-backend-netease.mjs [--rounds 10]
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createCipheriv, createHash } from 'node:crypto'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const ROUNDS = Number(process.argv.find((a) => a.startsWith('--rounds='))?.split('=')[1] ?? 10)

const QUERIES = ['周杰伦', '晴天 周杰伦', '孤勇者', '海阔天空 Beyond', '平凡之路 朴树']

const log = (message) => console.log(`[qa-netease] ${message}`)

// ---- crypto（复刻 src/main/netease/crypto.ts）----
const WEAPI_PRESET_KEY = '0CoJUm6Qyw8W8jud'
const WEAPI_IV = '0102030405060708'
const WEAPI_SECRET_KEY = 'youyou2026abcDEF'
const WEAPI_ENC_SEC_KEY =
  '1edd7503cb46eb11f8330241d58dd3676768f49ce849209eae7f230b6906fa52' +
  'c00c6b2ae72b14146d0296baa6ae0d79af459b815cb361ecf6b11e5af29754c4' +
  'b6215bf508316542414cb199447280e42aaee64fd4240d298711477b070681a6' +
  '9f1485a8c617efc39013d516ed5a5193cbf0ce69d5a0f06c6a2ee4b91fe40429'
const EAPI_KEY = 'e82ckenh8dichen8'

function aes128(data, key, iv) {
  const cipher = iv
    ? createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'))
    : createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}
function weapiForm(payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8')
  const first = aes128(json, WEAPI_PRESET_KEY, WEAPI_IV)
  return { params: aes128(first, WEAPI_SECRET_KEY, WEAPI_IV).toString('base64'), encSecKey: WEAPI_ENC_SEC_KEY }
}
function eapiForm(apiPath, payload) {
  const text = JSON.stringify(payload)
  const message = `nobody${apiPath}use${text}md5forencrypt`
  const digest = createHash('md5').update(message, 'utf8').digest('hex')
  const data = `${apiPath}-36cd479b6b5-${text}-36cd479b6b5-${digest}`
  return { params: aes128(Buffer.from(data, 'utf8'), EAPI_KEY).toString('hex').toUpperCase() }
}
function encodeForm(fields) {
  return Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
}

async function post(url, form, cookie) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      Referer: 'https://music.163.com',
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: encodeForm(form),
    signal: AbortSignal.timeout(15_000)
  })
  const text = await response.text()
  return { status: response.status, text }
}

/** 一次 eapi /cloudsearch/pc。返回 {ttfb,total,code,message,songCount,empty} */
async function eapiSearch(query, cookie) {
  const header = {
    os: 'pc',
    appver: '3.1.17',
    osver: 'Version 14.0 (Build 23A344)',
    deviceId: 'youyou',
    requestId: String(Math.floor(20_000_000 + Math.random() * 10_000_000)),
    clientSign: '',
    versioncode: '140',
    buildver: String(Math.floor(Date.now() / 1000)),
    resolution: '1920x1080',
    channel: '',
    ...(cookie ? { MUSIC_U: cookie.match(/MUSIC_U=([^;]+)/)?.[1] ?? '' } : {})
  }
  const payload = { s: query, type: 1, limit: 30, offset: 0, total: true, header }
  const t0 = Date.now()
  const { status, text } = await post(
    'https://interface.music.163.com/eapi/cloudsearch/pc',
    eapiForm('/api/cloudsearch/pc', payload),
    cookie
  )
  const total = Date.now() - t0
  if (text.trim() === '') return { ttfb: total, total, code: null, message: '空响应体', songCount: 0, empty: true, httpStatus: status }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    return { ttfb: total, total, code: null, message: '非JSON响应', songCount: 0, empty: false, httpStatus: status }
  }
  return {
    ttfb: total,
    total,
    code: Number(json?.code ?? 0),
    message: String(json?.message ?? json?.msg ?? ''),
    songCount: Number(json?.result?.songCount ?? 0),
    empty: false,
    httpStatus: status
  }
}

/** 一次 weapi /cloudsearch/get/web。 */
async function weapiSearch(query, cookie) {
  const payload = { s: query, type: 1, limit: 30, offset: 0, total: true, csrf_token: '' }
  const t0 = Date.now()
  const { status, text } = await post('https://music.163.com/weapi/cloudsearch/get/web', weapiForm(payload), cookie)
  const total = Date.now() - t0
  if (text.trim() === '') return { ttfb: total, total, code: null, message: '空响应体(疑似限流)', songCount: 0, empty: true, httpStatus: status }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    return { ttfb: total, total, code: null, message: '非JSON响应', songCount: 0, empty: false, httpStatus: status }
  }
  return {
    ttfb: total,
    total,
    code: Number(json?.code ?? 0),
    message: String(json?.message ?? json?.msg ?? ''),
    songCount: Number(json?.result?.songCount ?? 0),
    empty: false,
    httpStatus: status
  }
}

function summarize(name, samples) {
  const ttfb = samples.map((s) => s.ttfb)
  const sorted = [...ttfb].sort((a, b) => a - b)
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null
  const ok = samples.filter((s) => s.code === 200)
  const bizErr = samples.filter((s) => s.code !== null && s.code !== 200)
  const empty = samples.filter((s) => s.empty)
  const nonJson = samples.filter((s) => s.message === '非JSON响应')
  const byCode = {}
  for (const s of bizErr) byCode[`${s.code}:${s.message.slice(0, 24)}`] = (byCode[`${s.code}:${s.message.slice(0, 24)}`] ?? 0) + 1
  const avgSongCount = Math.round(ok.reduce((a, s) => a + s.songCount, 0) / Math.max(ok.length, 1))
  console.log(
    `${name}: n=${samples.length} 业务成功 ${ok.length} (${Math.round((ok.length / samples.length) * 100)}%) ` +
      `空体 ${empty.length} 非JSON ${nonJson.length} | 业务错误: ${JSON.stringify(byCode) || '无'} | ` +
      `TTFB min=${sorted[0]} avg=${Math.round(ttfb.reduce((a, b) => a + b, 0) / ttfb.length)} p50=${q(50)} p95=${q(95)} max=${sorted[sorted.length - 1]}ms | ` +
      `平均 songCount=${avgSongCount}`
  )
}

async function loadNeteaseCookie() {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(process.env.APPDATA ?? '', 'youyou-music', 'cookies.json'), 'utf8'))
    if (!raw.MUSIC_U) return ''
    const pairs = Object.entries(raw)
      .filter(([k]) => ['MUSIC_U', '__csrf', 'MUSIC_A_T', 'MUSIC_R_T'].includes(k))
      .map(([k, v]) => `${k}=${v}`)
    return pairs.join('; ') + '; os=pc; appver=3.1.17'
  } catch {
    return ''
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const cookie = await loadNeteaseCookie()
  log(`登录态 cookie: ${cookie ? `有 MUSIC_U（len=${cookie.match(/MUSIC_U=([^;]+)/)?.[1]?.length ?? 0}，不打印值）` : '无（仅匿名态）'}`)

  const weapiSamples = []
  const eapiSamples = []
  const eapiAuthSamples = []

  for (let round = 1; round <= ROUNDS; round += 1) {
    for (const query of QUERIES) {
      // 交错顺序，避免固定先后引入的系统偏差
      const weapiP = weapiSearch(query, '')
      const eapiP = eapiSearch(query, '')
      const eapiAuthP = cookie ? eapiSearch(query, cookie) : Promise.resolve(null)
      const [w, e, ea] = await Promise.all([weapiP, eapiP, eapiAuthP])
      weapiSamples.push(w)
      eapiSamples.push(e)
      if (ea) eapiAuthSamples.push(ea)
      log(
        `r${round} [${query}] weapi code=${w.code} empty=${w.empty} ${w.ttfb}ms | eapi code=${e.code} empty=${e.empty} ${e.ttfb}ms` +
          `${ea ? ` | eapi+登录 code=${ea.code} empty=${ea.empty} ${ea.ttfb}ms` : ''}`
      )
    }
    await wait(400)
  }

  console.log('\n===== 网易云接口汇总（匿名态）=====')
  summarize('weapi /cloudsearch/get/web', weapiSamples)
  summarize('eapi  /cloudsearch/pc', eapiSamples)
  if (eapiAuthSamples.length) {
    console.log('\n===== 登录态 vs 匿名态（eapi /cloudsearch/pc）=====')
    summarize('eapi 登录态', eapiAuthSamples)
    summarize('eapi 匿名态', eapiSamples)
  }

  // weapi 限流专门测试：同一请求连打 15 次，统计空体/业务错误出现频率
  log('\nweapi 连打 15 次（限流复现）…')
  const burst = []
  for (let i = 0; i < 15; i += 1) {
    burst.push(await weapiSearch('周杰伦', ''))
  }
  summarize('weapi 连打15次', burst)

  // 回落验证：weapi 空体时 eapi 是否成功（应用的实际兜底路径）
  const weapiEmpty = burst.filter((s) => s.empty).length
  log(`连打中 weapi 空体 ${weapiEmpty}/15 次`)
  if (weapiEmpty > 0) {
    const fallback = await eapiSearch('周杰伦', '')
    log(`回落验证：同请求换 eapi → code=${fallback.code} songCount=${fallback.songCount} ${fallback.ttfb}ms`)
  }

  log('QA-NETEASE DONE')
}

main().catch((error) => {
  console.error('[qa-netease] 异常:', error)
  process.exit(1)
})
