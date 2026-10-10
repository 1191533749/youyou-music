/**
 * 取证「首页歌手图片加载不出来」：复刻 app 的 weapi→eapi 回退，
 * 直接调 /toplist/artist 拿歌手列表，打印每个歌手的原始字段 + 最终 coverUrl，
 * 再逐个 fetch 看 HTTP 状态/类型/大小，定位是「数据缺 picUrl」还是「CDN 403/404 拦截」。
 *
 * 用法：node scripts/probe-top-artists.mjs [limit]
 */
import { createCipheriv, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const limit = Number(process.argv[2] ?? 14)

// —— 与 src/main/netease/crypto.ts 一致的加密（复制常量，避免 import TS）——
const PRESET = '0CoJUm6Qyw8W8jud'
const IV = '0102030405060708'
const SECRET = 'youyou2026abcDEF'
const EAPI_KEY = 'e82ckenh8dichen8'
const ENC_SEC_KEY =
  '1edd7503cb46eb11f8330241d58dd3676768f49ce849209eae7f230b6906fa52' +
  'c00c6b2ae72b14146d0296baa6ae0d79af459b815cb361ecf6b11e5af29754c4' +
  'b6215bf508316542414cb199447280e42aaee64fd4240d298711477b070681a6' +
  '9f1485a8c617efc39013d516ed5a5193cbf0ce69d5a0f06c6a2ee4b91fe40429'

function aes128(data, key, iv) {
  const cipher = iv
    ? createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'))
    : createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}
function weapi(payload) {
  const json = Buffer.from(payload, 'utf8')
  const first = aes128(json, PRESET, IV)
  const second = aes128(first, SECRET, IV).toString('base64')
  return { params: second, encSecKey: ENC_SEC_KEY }
}
function eapi(apiPath, payload) {
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload
  const message = `nobody${apiPath}use${text}md5forencrypt`
  const digest = createHash('md5').update(message, 'utf8').digest('hex')
  const data = `${apiPath}-36cd479b6b5-${text}-36cd479b6b5-${digest}`
  const encrypted = aes128(Buffer.from(data, 'utf8'), EAPI_KEY)
  return { params: encrypted.toString('hex').toUpperCase() }
}
function eapiHeader(musicU, csrf) {
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
    channel: ''
  }
  if (musicU) header.MUSIC_U = musicU
  if (csrf) header.__csrf = csrf
  return header
}
const encodeForm = (fields) =>
  Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

function coverUrl(url, size) {
  if (!url) return undefined
  const https = url.replace(/^http:\/\//, 'https://')
  return `${https}${https.includes('?') ? '&' : '?'}param=${size}y${size}`
}

function loadCookie() {
  const p = process.env.APPDATA
  const file = join(p ?? join(homedir(), 'AppData', 'Roaming'), 'youyou-music', 'cookies.json')
  let jar = {}
  try {
    jar = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    /* 没 cookie 就匿名 */
  }
  const all = { ...jar, os: 'pc', appver: '3.1.17' }
  return {
    header: Object.entries(all)
      .map(([k, v]) => `${k}=${v}`)
      .join('; '),
    csrf: jar.__csrf ?? '',
    musicU: jar.MUSIC_U ?? ''
  }
}

async function main() {
  const cookie = loadCookie()

  // 1) weapi（与 app 一致）
  let text = ''
  {
    const form = weapi(JSON.stringify({ type: 1, limit, offset: 0, total: true, csrf_token: cookie.csrf }))
    const qs = cookie.csrf ? `?csrf_token=${encodeURIComponent(cookie.csrf)}` : ''
    const res = await fetch(`https://music.163.com/weapi/toplist/artist${qs}`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Referer: 'https://music.163.com',
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie.header
      },
      body: encodeForm(form)
    })
    text = await res.text()
    console.log('# weapi /toplist/artist:', res.status, 'len=', text.length)
  }

  // 2) 空体则回退 eapi（与 app 的 weapi() 包装一致）
  let json
  if (text.trim() !== '') {
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
  }
  if (!json) {
    const apiPath = '/api/toplist/artist'
    const body = { type: 1, limit, offset: 0, total: true, header: eapiHeader(cookie.musicU, cookie.csrf) }
    const form = eapi(apiPath, JSON.stringify(body))
    const res = await fetch('https://interface.music.163.com/eapi/toplist/artist', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Referer: 'https://music.163.com',
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie.header
      },
      body: encodeForm(form)
    })
    text = await res.text()
    console.log('# eapi /toplist/artist:', res.status, 'len=', text.length)
    try {
      json = JSON.parse(text)
    } catch {
      console.error('eapi 非 JSON:', text.slice(0, 300))
      return
    }
  }

  const artists = json?.list?.artists ?? json?.artists ?? []
  console.log('# 歌手数', artists.length, 'code', json?.code)
  for (const a of artists) {
    console.log(
      `\n[${a.name}] id=${a.id}\n  picUrl      = ${a.picUrl ?? '(无)'}\n  img1v1Url   = ${a.img1v1Url ?? '(无)'}\n  cover/avatar= ${a.cover ?? '(无)'} / ${a.avatar ?? '(无)'}\n  albumSize    = ${a.albumSize} musicSize=${a.musicSize}`
    )
  }

  console.log('\n\n# —— 逐个 fetch 最终 coverUrl ——')
  for (const a of artists) {
    const url = coverUrl(a.picUrl, 240)
    const img1v1 = coverUrl(a.img1v1Url, 240)
    for (const [label, u] of [['picUrl', url], ['img1v1', img1v1]]) {
      if (!u) {
        console.log(`[${a.name}] ${label}: (空)`)
        continue
      }
      try {
        const r = await fetch(u, { headers: { 'User-Agent': UA, Referer: 'https://music.163.com' } })
        const len = r.headers.get('content-length') ?? '?'
        console.log(`[${a.name}] ${label}: HTTP ${r.status} type=${r.headers.get('content-type')} len=${len}`)
      } catch (e) {
        console.log(`[${a.name}] ${label}: FETCH ERR ${e.message}`)
      }
    }
  }
}

main().catch((e) => {
  console.error('失败:', e)
  process.exit(1)
})
