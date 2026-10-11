/**
 * QA 后端压测：音源可用性与速度。
 *
 * 对固定 10 首歌（5 免费 fee=0/8 + 5 VIP fee=1），逐源跑「解析 → HEAD 实测」：
 *   - netease(pyncmd)：eapi /song/enhance/player/url/v1（登录态 MUSIC_U cookie）
 *   - netease-anon：同上但匿名（对照：免费歌应有地址、VIP 无地址）
 *   - qishui / kugou / kuwo：复刻 src/main/unblock/providers.ts 的搜索+严格匹配+换链
 *   - qq-anon / qq-cookie：GetVkeyServer（cookie 来自 %APPDATA%\youyou-music\accounts.json）
 *
 * 10 首歌的 canonical id/dt 已用 eapi /api/v3/song/detail（匿名）核实，直接做 fixture，
 * 不再依赖搜索解析（匿名搜索 top5 会被翻唱淹没，周杰伦原曲根本不出现）。
 * HEAD 实测：状态码 / 首字节耗时 / Content-Length / Content-Type；HEAD 不支持时
 * 用 GET Range: bytes=0-0 替代。酷我 len=181521 标记「疑似 4s 试听占位」。
 * 全程不打印任何 cookie 明文。
 *
 * 用法：node scripts/test-qa-backend-sources.mjs [--only qishui,kuwo]
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createCipheriv, createHash } from 'node:crypto'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const KUWO_UA = 'okhttp/3.10.0'
const QISHUI_AID = '386088'
const REQUEST_TIMEOUT_MS = 12_000
const onlyArg = process.argv.find((a) => a.startsWith('--only'))
const ONLY = onlyArg ? new Set(onlyArg.split('=')[1].split(',')) : null

// 免费 = fee 0/8 且匿名 song/url 实测有地址；VIP = fee=1 且匿名无地址（均经 v3/detail 核实）。
const SONGS = [
  { name: '起风了', artist: '买辣椒也用券', kind: '免费', id: 1330348068, durationMS: 325868, fee: 8 },
  { name: '往后余生', artist: '马良', kind: '免费', id: 557584888, durationMS: 195925, fee: 8 },
  { name: '海底', artist: '一支榴莲', kind: '免费', id: 1430583016, durationMS: 256111, fee: 8 },
  { name: '老鼠爱大米', artist: '杨臣刚', kind: '免费', id: 178734, durationMS: 304173, fee: 0 },
  { name: '两只蝴蝶', artist: '庞龙', kind: '免费', id: 140140, durationMS: 272413, fee: 8 },
  { name: '孤勇者', artist: '陈奕迅', kind: 'VIP', id: 1901371647, durationMS: 256000, fee: 1 },
  { name: '光年之外', artist: 'G.E.M.邓紫棋', kind: 'VIP', id: 449818741, durationMS: 235505, fee: 1 },
  { name: '芒种', artist: '音阙诗听', kind: 'VIP', id: 1369798757, durationMS: 216000, fee: 1 },
  { name: '演员', artist: '薛之谦', kind: 'VIP', id: 32507038, durationMS: 261249, fee: 1 },
  { name: '平凡之路', artist: '朴树', kind: 'VIP', id: 28815250, durationMS: 302119, fee: 1 }
]

const KUWO_TRIAL_LEN = 181521

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(`[qa-sources] ${message}`)
const fmt = (ms) => `${ms}ms`

// ---------------------------------------------------------------------------
// 复刻 providers.ts 的严格匹配器
// ---------------------------------------------------------------------------
const VERSION_MARKERS = ['live', 'remix', '伴奏', 'dj', 'cover', '翻唱', 'instrumental', 'karaoke']
const normalize = (value) =>
  String(value)
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff]/g, '')
const artistNames = (value) =>
  String(value).split(/[/&、,，;；]/).map(normalize).filter((part) => part.length > 0)
function matchesTrack(track, candidate, toleranceMS = 5000) {
  if (!(track.durationMS > 0 && candidate.durationMS > 0)) return false
  if (Math.abs(candidate.durationMS - track.durationMS) > toleranceMS) return false
  if (normalize(candidate.title) !== normalize(track.name)) return false
  const markers = (text) => VERSION_MARKERS.filter((m) => normalize(text).includes(m)).sort().join('|')
  if (markers(track.name) !== markers(candidate.title)) return false
  const expected = normalize(track.artist)
  if (!expected) return false
  return artistNames(candidate.artist).includes(expected)
}

async function fetchJSON(url, headers = {}, ua = USER_AGENT) {
  const response = await fetch(url, {
    headers: { 'User-Agent': ua, ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function fetchText(url, headers = {}, ua = USER_AGENT) {
  const response = await fetch(url, {
    headers: { 'User-Agent': ua, ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

// ---------------------------------------------------------------------------
// 网易云：weapi/eapi 加密（复刻 src/main/netease/crypto.ts）
// ---------------------------------------------------------------------------
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
  const second = aes128(first, WEAPI_SECRET_KEY, WEAPI_IV).toString('base64')
  return { params: second, encSecKey: WEAPI_ENC_SEC_KEY }
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
async function neteasePOST(url, form, cookie) {
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
  if (text.trim() === '') throw new Error('空响应体')
  return JSON.parse(text)
}

// ---------------------------------------------------------------------------
// 各音源解析（复刻 providers.ts）
// ---------------------------------------------------------------------------
async function resolveQishui(track) {
  const payload = await fetchJSON(
    `https://api.qishui.com/luna/pc/search/all?q=${encodeURIComponent(`${track.name} ${track.artist}`)}` +
      `&aid=${QISHUI_AID}&offset=0&limit=20`,
    { Accept: 'application/json', Referer: 'https://music.douyin.com/' }
  )
  const groups = Array.isArray(payload?.result_groups) ? payload.result_groups : []
  const trackGroup = groups.find((g) => g?.id === 'tracks') ?? groups[0]
  const items = Array.isArray(trackGroup?.data) ? trackGroup.data : []
  for (const item of items) {
    const found = item?.entity?.track
    if (!found?.id || !found?.name) continue
    const candidate = {
      title: String(found.name),
      artist: (Array.isArray(found.artists) ? found.artists : []).map((a) => a?.name).filter(Boolean).join('/'),
      durationMS: Number(found.duration ?? 0)
    }
    if (!matchesTrack(track, candidate)) continue
    const detail = await fetchJSON(
      `https://beta-luna.douyin.com/luna/h5/seo_track?track_id=${encodeURIComponent(String(found.id))}&device_platform=web`,
      { Accept: 'application/json', Referer: 'https://music.douyin.com/' }
    )
    const raw = detail?.track_player?.video_model
    let model
    try {
      model = typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch {
      return null
    }
    const list = Array.isArray(model?.video_list) ? model.video_list : []
    const gears = []
    for (const entry of list) {
      const url = typeof entry?.main_url === 'string' ? entry.main_url : entry?.backup_url
      if (typeof url !== 'string' || !url.startsWith('http')) continue
      const meta = entry?.video_meta
      const bitrate = Number(meta?.bitrate ?? 0) || Number(new URL(url).searchParams.get('br') ?? 0) || undefined
      const size = Number(meta?.size ?? 0)
      gears.push({ url, bitrate, durationMS: bitrate && size > 0 ? (size * 8 * 1000) / bitrate : undefined })
    }
    const playable = gears.filter((g) => g.durationMS === undefined || g.durationMS >= track.durationMS * 0.8)
    if (playable.length === 0) return { reason: '只有30s试听' }
    const gear = playable.reduce((a, b) => ((a.bitrate ?? 0) >= (b.bitrate ?? 0) ? a : b))
    return { url: gear.url, bitrate: gear.bitrate }
  }
  return null
}

async function resolveKugou(track) {
  const keyword = encodeURIComponent(`${track.name} ${track.artist}`)
  const search = await fetchJSON(
    `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${keyword}&page=1&pagesize=10`
  )
  const info = Array.isArray(search?.data?.info) ? search.data.info : []
  const match = info.slice(0, 5).find((item) =>
    matchesTrack(track, {
      title: String(item?.songname ?? ''),
      artist: String(item?.singername ?? ''),
      durationMS: Number(item?.duration ?? 0) * 1000
    })
  )
  if (!match) return null
  const detail = await fetchJSON(`https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${String(match.hash)}`)
  const url = Array.isArray(detail?.url) ? detail.url[0] : detail?.url
  if (typeof url !== 'string' || !url.startsWith('http')) return null
  return { url, bitrate: Number(detail?.bitRate ?? 0) > 0 ? Math.round(Number(detail?.bitRate ?? 0) / 1000) : undefined }
}

async function resolveKuwo(track) {
  const keyword = encodeURIComponent(`${track.name} ${track.artist}`)
  const search = await fetchJSON(
    `https://search.kuwo.cn/r.s?&correct=1&vipver=1&stype=comprehensive&encoding=utf8` +
      `&rformat=json&mobi=1&show_copyright_off=1&searchapi=6&all=${keyword}`,
    {},
    KUWO_UA
  )
  const content = Array.isArray(search?.content) ? search.content : []
  const songs = Array.isArray(content[1]?.musicpage?.abslist) ? content[1].musicpage.abslist : []
  const match = songs.slice(0, 5).find((item) =>
    matchesTrack(track, {
      title: String(item?.SONGNAME ?? ''),
      artist: String(item?.ARTIST ?? ''),
      durationMS: Number(item?.DURATION ?? 0) * 1000
    })
  )
  if (!match) return null
  const rid = String(match.MUSICRID ?? '').split('_').pop()
  if (!rid) return null
  const text = await fetchText(
    `https://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid=MUSIC_${rid}`,
    {},
    KUWO_UA
  )
  const found = /http[^\s$"]+/.exec(text)
  if (!found) return null
  return { url: found[0] }
}

async function searchQq(track) {
  const keyword = encodeURIComponent(`${track.name} ${track.artist}`)
  const entries = [
    `https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?w=${keyword}&format=json&p=1&n=10&flag_qc=0`,
    `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=10&w=${keyword}` +
      `&format=json&aggr=1&cr=1&flag_qc=0&platform=yqq.json&needNewCode=0`
  ]
  for (const url of entries) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Referer: 'https://y.qq.com/' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (!response.ok) continue
      let text = await response.text()
      if (!text.trim()) continue
      if (!text.trimStart().startsWith('{')) {
        const open = text.indexOf('(')
        const close = text.lastIndexOf(')')
        if (open >= 0 && close > open) text = text.slice(open + 1, close)
      }
      const payload = JSON.parse(text)
      if (payload?.subcode === -10001 || payload?.retcode === 500) continue
      const songs = Array.isArray(payload?.data?.song?.list) ? payload.data.song.list : []
      const list = []
      for (const song of songs) {
        if (Number(song?.pay?.payplay ?? song?.pay?.pay_play ?? 0) === 1) continue
        const mid = String(song?.songmid ?? song?.mid ?? '')
        const title = String(song?.songname ?? song?.name ?? '')
        if (!mid || !title) continue
        list.push({
          mid,
          title,
          artist: (Array.isArray(song?.singer) ? song.singer : []).map((s) => s?.name).filter(Boolean).join('/'),
          durationMS: Number(song?.interval ?? 0) * 1000
        })
      }
      if (list.length > 0) return list
    } catch {
      /* 换下一个入口 */
    }
  }
  return []
}

async function fetchQqMediaMid(songmid) {
  try {
    const payload = await fetchJSON(
      `https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=${encodeURIComponent(songmid)}` +
        `&platform=yqq&format=json`,
      { Accept: 'application/json', Referer: 'https://y.qq.com/' }
    )
    const mid = payload?.data?.[0]?.file?.media_mid
    return typeof mid === 'string' && mid ? mid : undefined
  } catch {
    return undefined
  }
}

async function fetchQqAudioUrl(songmid, auth) {
  const guid = String(Math.floor(1e9 + Math.random() * 9e9))
  const mediaMid = await fetchQqMediaMid(songmid)
  const cookie = auth?.cookie
  const uin = auth?.uin && auth.uin !== '0' ? auth.uin : '0'
  const plan = mediaMid
    ? [
        { filename: `M500${mediaMid}.mp3`, bitrate: 128, authed: Boolean(cookie) },
        ...(cookie ? [{ filename: `M500${mediaMid}.mp3`, bitrate: 128, authed: false }] : [])
      ]
    : [{ filename: undefined, bitrate: 96, authed: Boolean(cookie) }]
  for (const step of plan) {
    const param = { guid, songmid: [songmid], songtype: [0], uin: step.authed ? uin : '0', loginflag: 1, platform: '20' }
    if (step.filename) param.filename = [step.filename]
    const data = {
      req_0: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param },
      comm: { uin: step.authed ? Number(uin) || 0 : 0, format: 'json', ct: 24, cv: 0 }
    }
    const headers = { Accept: 'application/json', Referer: 'https://y.qq.com/', ...(step.authed && cookie ? { Cookie: cookie } : {}) }
    try {
      const payload = await fetchJSON(
        `https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(JSON.stringify(data))}`,
        headers
      )
      const info = payload?.req_0?.data?.midurlinfo?.[0]
      const purl = typeof info?.purl === 'string' ? info.purl : ''
      if (purl) {
        return { url: purl.startsWith('http') ? purl : `https://ws.stream.qqmusic.qq.com/${purl}`, bitrate: step.bitrate }
      }
    } catch {
      /* 下一档 */
    }
  }
  return null
}

async function resolveQq(track, auth) {
  const candidates = await searchQq(track)
  const match = candidates.find((c) => matchesTrack(track, c))
  if (!match) return { reason: candidates.length === 0 ? '搜索无结果(接口可能被限流)' : '无严格匹配' }
  const audio = await fetchQqAudioUrl(match.mid, auth)
  if (!audio) return null
  return { url: audio.url, bitrate: audio.bitrate }
}

// ---------------------------------------------------------------------------
// HEAD / Range 实测
// ---------------------------------------------------------------------------
async function probeURL(url) {
  const t0 = Date.now()
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, ...(url.includes('qqmusic') ? { Referer: 'https://y.qq.com/' } : {}) },
      signal: AbortSignal.timeout(12_000)
    })
    const ttfb = Date.now() - t0
    return {
      status: head.status,
      ttfb,
      len: Number(head.headers.get('content-length') ?? 0),
      type: String(head.headers.get('content-type') ?? '').split(';')[0],
      via: 'HEAD'
    }
  } catch (headError) {
    try {
      const t1 = Date.now()
      const get = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Range: 'bytes=0-0', ...(url.includes('qqmusic') ? { Referer: 'https://y.qq.com/' } : {}) },
        redirect: 'follow',
        signal: AbortSignal.timeout(12_000)
      })
      const ttfb = Date.now() - t1
      void get.body?.cancel().catch(() => undefined)
      return {
        status: get.status,
        ttfb,
        len: Number(get.headers.get('content-length') ?? 0),
        type: String(get.headers.get('content-type') ?? '').split(';')[0],
        via: 'GET-Range',
        headFailed: String(headError.cause?.message ?? headError.message).slice(0, 60)
      }
    } catch (getError) {
      return { status: 0, ttfb: Date.now() - t0, len: 0, type: '', via: 'FAIL', error: String(getError.cause?.message ?? getError.message).slice(0, 80) }
    }
  }
}

// ---------------------------------------------------------------------------
// 数据准备与主流程
// ---------------------------------------------------------------------------
const USERDATA = path.join(process.env.APPDATA ?? '', 'youyou-music')

async function loadAuth() {
  let neteaseCookie = ''
  let qq = undefined
  try {
    const cookiesRaw = JSON.parse(await fs.readFile(path.join(USERDATA, 'cookies.json'), 'utf8'))
    if (cookiesRaw.MUSIC_U) {
      neteaseCookie = Object.entries(cookiesRaw)
        .filter(([k]) => ['MUSIC_U', '__csrf', 'MUSIC_A_T', 'os', 'appver'].includes(k))
        .map(([k, v]) => `${k}=${v}`)
        .join('; ')
      neteaseCookie += '; os=pc; appver=3.1.17'
    }
  } catch {
    /* 未登录 */
  }
  try {
    const accounts = JSON.parse(await fs.readFile(path.join(USERDATA, 'accounts.json'), 'utf8'))
    const session = Array.isArray(accounts) ? accounts.find((a) => a?.platform === 'qq') : undefined
    if (session?.cookie) {
      const uinMatch = /(?:pt2gguin|superuin|uin)=o?0*(\d{5,})/.exec(session.cookie)
      qq = { cookie: session.cookie, uin: uinMatch?.[1] ?? '0' }
    }
  } catch {
    /* 未绑定 */
  }
  return { neteaseCookie, qq }
}

/** QQ 登录态自检：GetLoginUserInfo（只回显 code，不打印任何身份信息）。 */
async function checkQqLogin(qq) {
  if (!qq) return '无绑定 cookie'
  try {
    const reqData = JSON.stringify({
      comm: { ct: 24, cv: 4747474, uin: qq.uin, format: 'json' },
      req: { module: 'music.login.LoginServer', method: 'GetLoginUserInfo', param: {} }
    })
    const payload = await fetchJSON(
      `https://u.y.qq.com/cgi-bin/musics.fcg?format=json&data=${encodeURIComponent(reqData)}`,
      { Accept: 'application/json', Referer: 'https://y.qq.com/', Cookie: qq.cookie }
    )
    return `code=${payload?.req?.code ?? payload?.code}（${payload?.req?.code === 0 ? '有效' : '无效/过期'}）`
  } catch (error) {
    return `检测失败: ${String(error).slice(0, 40)}`
  }
}

/** 用网易云搜索拿每首歌的 canonical id + 时长（weapi 优先，空体/失败回落 eapi）。 */
async function neteaseSearch(payload) {
  try {
    const json = await neteasePOST('https://music.163.com/weapi/cloudsearch/get/web', weapiForm(payload), '')
    if (json?.code === 200) return { json, via: 'weapi' }
  } catch {
    /* 空体或失败：回落 eapi */
  }
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
  const json = await neteasePOST(
    'https://interface.music.163.com/eapi/cloudsearch/pc',
    eapiForm('/api/cloudsearch/pc', { ...payload, header }),
    ''
  )
  return { json, via: 'eapi' }
}

/** 曲目 fixture 直接来自 SONGS（id/dt 已用 eapi v3/song/detail 匿名核实），不再走搜索解析。 */
function resolveNeteaseTracks() {
  for (const song of SONGS) {
    log(`fixture: ${song.name} ${song.artist} id=${song.id} dt=${song.durationMS}ms fee=${song.fee} (${song.kind})`)
  }
  return SONGS.map((song) => ({ ...song }))
}

async function resolveNeteaseURL(track, cookie) {
  for (const level of ['exhigh', 'standard']) {
    const payload = { ids: `[${track.id}]`, level, encodeType: 'flac' }
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
    const json = await neteasePOST(
      'https://interface.music.163.com/eapi/song/enhance/player/url/v1',
      eapiForm('/api/song/enhance/player/url/v1', { ...payload, header }),
      cookie
    )
    if (typeof json?.code === 'number' && json.code !== 200) return { reason: `业务错误 code=${json.code}` }
    const data = Array.isArray(json?.data) ? json.data[0] : undefined
    if (data?.url) return { url: data.url.replace(/^http:/, 'https:'), br: data.br, level, fee: data.fee }
    if (typeof data?.code === 'number' && data.code !== 200) return { reason: `code=${data.code}` }
  }
  return null
}

const results = []
const record = (song, source, kind, detail) => {
  results.push({ song, source, kind, ...detail })
}

async function main() {
  const auth = await loadAuth()
  log(`登录态: 网易云 ${auth.neteaseCookie ? '有 MUSIC_U' : '无'} | QQ ${auth.qq ? `有 cookie (uin=${auth.qq.uin})` : '无'}（值不打印）`)
  if (auth.qq) log(`QQ 登录态自检(GetLoginUserInfo): ${await checkQqLogin(auth.qq)}`)
  const tracks = resolveNeteaseTracks()

  for (const track of tracks) {
    if (track.id === 0) continue
    log(`--- ${track.name} ${track.artist} (${track.kind}) ---`)

    // netease（登录态，prod 行为）与 netease-anon（匿名对照）
    const neteaseTargets = [
      ['netease', auth.neteaseCookie],
      ['netease-anon', '']
    ]
    for (const [col, cookie] of neteaseTargets) {
      if (ONLY && !ONLY.has(col)) continue
      const t0 = Date.now()
      try {
        const resolved = await resolveNeteaseURL(track, cookie)
        if (!resolved?.url) {
          record(track.name, col, 'resolve-fail', { reason: resolved?.reason ?? '无地址', ms: Date.now() - t0 })
          log(`  ${col} 解析失败: ${resolved?.reason ?? '无地址'}`)
        } else {
          const probe = await probeURL(resolved.url)
          record(track.name, col, probe.status === 200 || probe.status === 206 ? 'ok' : 'head-fail', {
            ...probe,
            resolveMs: Date.now() - t0,
            br: resolved.br,
            level: resolved.level,
            fee: resolved.fee
          })
          log(
            `  ${col} ${probe.status} ${fmt(probe.ttfb)} len=${probe.len} type=${probe.type} (解析${Date.now() - t0}ms br=${resolved.br})`
          )
        }
      } catch (error) {
        record(track.name, col, 'error', { reason: String(error).slice(0, 80), ms: Date.now() - t0 })
        log(`  ${col} 异常: ${String(error).slice(0, 80)}`)
      }
    }

    // 三方音源
    const providers = [
      ['qishui', resolveQishui],
      ['kugou', resolveKugou],
      ['kuwo', resolveKuwo],
      ['qq-anon', (t) => resolveQq(t, undefined)],
      ['qq-cookie', (t) => resolveQq(t, auth.qq)]
    ].filter(([name]) => !ONLY || ONLY.has(name))
    for (const [source, run] of providers) {
      if (source === 'qq-cookie' && !auth.qq) {
        log(`  ${source} 跳过：无绑定 cookie`)
        continue
      }
      const t0 = Date.now()
      try {
        const resolved = await run(track)
        if (!resolved?.url) {
          record(track.name, source, 'resolve-fail', { reason: resolved?.reason ?? '未解析出地址', ms: Date.now() - t0 })
          log(`  ${source} 解析失败(${Date.now() - t0}ms): ${resolved?.reason ?? '未解析出地址'}`)
          continue
        }
        const probe = await probeURL(resolved.url)
        // 酷我付费曲会返回同一个 181521B（~4s）试听占位文件：标记但不改 kind。
        const trialNote =
          source === 'kuwo' && probe.len === KUWO_TRIAL_LEN ? `【疑似4s试听占位 len=${probe.len}】` : ''
        record(track.name, source, probe.status === 200 || probe.status === 206 ? 'ok' : 'head-fail', {
          ...probe,
          resolveMs: Date.now() - t0,
          br: resolved.bitrate,
          trial: Boolean(trialNote)
        })
        log(
          `  ${source} ${probe.status} ${fmt(probe.ttfb)} len=${probe.len} type=${probe.type} (解析${Date.now() - t0}ms br=${resolved.bitrate ?? '-'})${trialNote}`
        )
      } catch (error) {
        record(track.name, source, 'error', { reason: String(error).slice(0, 80), ms: Date.now() - t0 })
        log(`  ${source} 异常: ${String(error).slice(0, 80)}`)
      }
    }
    await wait(300)
  }

  console.log('\n===== 音源压测汇总 =====')
  const sources = ['netease', 'netease-anon', 'qishui', 'kugou', 'kuwo', 'qq-anon', 'qq-cookie']
  for (const source of sources) {
    const rows = results.filter((r) => r.source === source)
    if (rows.length === 0) continue
    const ok = rows.filter((r) => r.kind === 'ok')
    const headFail = rows.filter((r) => r.kind === 'head-fail')
    const resolveFail = rows.filter((r) => r.kind === 'resolve-fail')
    const errors = rows.filter((r) => r.kind === 'error')
    const ttfb = ok.map((r) => r.ttfb)
    const sorted = [...ttfb].sort((a, b) => a - b)
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null
    const avgResolve = Math.round(ok.reduce((a, r) => a + (r.resolveMs ?? 0), 0) / Math.max(ok.length, 1))
    const hotOk = ok.filter((r) => SONGS.find((s) => s.name === r.song)?.kind === '免费').length
    const vip = ok.filter((r) => SONGS.find((s) => s.name === r.song)?.kind === 'VIP').length
    const trial = ok.filter((r) => r.trial).length
    console.log(
      `${source}: 成功 ${ok.length}/${rows.length}（免费 ${hotOk}/5，VIP ${vip}/5${source === 'kuwo' ? `，其中疑似4s试听占位 ${trial}` : ''}）| ` +
        `HEAD失败 ${headFail.length} 解析失败 ${resolveFail.length} 异常 ${errors.length} | ` +
        (ttfb.length
          ? `TTFB min=${sorted[0]} avg=${Math.round(ttfb.reduce((a, b) => a + b, 0) / ttfb.length)} p95=${q(95)} max=${sorted[sorted.length - 1]}ms，解析平均 ${avgResolve}ms`
          : '无成功样本')
    )
    for (const r of resolveFail) console.log(`  · ${source} 解析失败: ${r.song} — ${r.reason}`)
    for (const r of headFail) console.log(`  · ${source} HEAD 失败: ${r.song} — status=${r.status} via=${r.via} error=${r.error ?? ''}`)
    for (const r of errors) console.log(`  · ${source} 异常: ${r.song} — ${r.reason}`)
  }
  log('QA-SOURCES DONE')
}

main().catch((error) => {
  console.error('[qa-sources] 异常:', error)
  process.exit(1)
})
