/**
 * 第三方平台登录（QQ音乐）与登录态持久化。
 *
 * 网易云继续用原来的 `cookies.json`；这里只管其它平台，各自一套 cookie，
 * 与网易云的登录互不影响，存在用户数据目录的 `accounts.json`。
 *
 * 扫码登录：先拿到二维码给渲染层，再轮询扫码状态，确认后把 cookie 存下来，
 * 之后就能用该账号取歌单（也顺带解锁该平台音源）。
 *
 * 酷狗的扫码接口当前对所有参数组合都返回「参数错误 20006」，实现先留在这里
 * 但不接入界面；它仍然是一个可用的音源。
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { ACCOUNT_PLATFORMS } from '@shared/types'
import type {
  AccountPlatform,
  ExternalTrackDTO,
  PlatformAccountDTO,
  PlatformPlaylistDTO,
  QRLoginStatus
} from '@shared/types'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

const REQUEST_TIMEOUT_MS = 15_000

// ---------------------------------------------------------------------------
// 最小 cookie 罐
// ---------------------------------------------------------------------------

type CookieJar = Map<string, string>

function absorb(jar: CookieJar, response: Response): void {
  const lines =
    typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  for (const line of lines) {
    const pair = line.split(';')[0] ?? ''
    const index = pair.indexOf('=')
    if (index <= 0) continue
    jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
  }
}

function cookieHeader(jar: CookieJar): string {
  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ')
}

/**
 * 带 cookie 罐的请求：手动跟跳转，每一跳的 Set-Cookie 都收下。
 * QQ 的 `check_sig` 会把正式 cookie 放在重定向链的中间响应里，
 * 交给自动重定向就会丢掉。
 */
async function request(
  url: string,
  jar: CookieJar,
  options: { headers?: Record<string, string>; redirects?: number } = {}
): Promise<Response> {
  const limit = options.redirects ?? 5
  let target = url
  for (let hop = 0; hop <= limit; hop += 1) {
    const response = await fetch(target, {
      headers: {
        'User-Agent': UA,
        ...(jar.size > 0 ? { Cookie: cookieHeader(jar) } : {}),
        ...options.headers
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    absorb(jar, response)
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      target = new URL(location, target).toString()
      continue
    }
    return response
  }
  throw new Error('重定向次数过多')
}

// ---------------------------------------------------------------------------
// 登录态存储
// ---------------------------------------------------------------------------

export interface PlatformSession {
  platform: AccountPlatform
  /** 该平台自己的 cookie，`k=v; k=v`，直接放进请求头。 */
  cookie: string
  nickname?: string
  avatarUrl?: string
  userId?: string
  /** 部分平台另有凭据（酷狗的 token 等）。 */
  extra?: Record<string, string>
  updatedAt: number
}

export class PlatformAccounts {
  private sessions = new Map<AccountPlatform, PlatformSession>()
  private loaded = false

  constructor(private readonly directory: string) {}

  private get file(): string {
    return path.join(this.directory, 'accounts.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as PlatformSession[]
      for (const session of raw) {
        if (session?.platform && typeof session.cookie === 'string') {
          this.sessions.set(session.platform, session)
        }
      }
    } catch {
      // 文件不存在或损坏：当作没登录过
    }
    // 端到端测试钩子：真实 QQ 账号要扫码登录才拿得到，测试里种一个假账号，
    // 让「点歌单 → 取曲目 → 播放」这条链路能在无人值守下跑通。只在显式设了
    // YOYOU_FAKE_QQ_ACCOUNT=1 时生效。
    if (process.env.YOYOU_FAKE_QQ_ACCOUNT === '1' && !this.sessions.has('qq')) {
      this.sessions.set('qq', {
        platform: 'qq',
        cookie: `uin=0; qqmusic_key=${'test'.padEnd(16, '0')}`,
        nickname: '测试账号',
        userId: '0',
        updatedAt: Date.now()
      })
    }
  }

  private async flush(): Promise<void> {
    const payload = [...this.sessions.values()]
    await fs.mkdir(this.directory, { recursive: true }).catch(() => undefined)
    await fs.writeFile(this.file, JSON.stringify(payload, null, 2), 'utf8').catch(() => undefined)
  }

  get(platform: AccountPlatform): PlatformSession | undefined {
    return this.sessions.get(platform)
  }

  async put(session: PlatformSession): Promise<void> {
    this.sessions.set(session.platform, session)
    await this.flush()
  }

  async remove(platform: AccountPlatform): Promise<void> {
    this.sessions.delete(platform)
    await this.flush()
  }

  /** 给界面的登录状态列表（网易云由 auth:state 单独提供）。 */
  list(): PlatformAccountDTO[] {
    return ACCOUNT_PLATFORMS.filter((platform) => platform !== 'netease').map((platform) => {
      const session = this.sessions.get(platform)
      return {
        platform,
        loggedIn: Boolean(session?.cookie),
        nickname: session?.nickname,
        avatarUrl: session?.avatarUrl
      }
    })
  }
}

export interface QRStart {
  token: string
  /** 直接把这段文本渲染成二维码。 */
  url?: string
  /** 或者平台直接给了一张二维码图片（data URL）。 */
  image?: string
}

export interface QRPoll {
  status: QRLoginStatus
  message?: string
  nickname?: string
  avatarUrl?: string
}

// ---------------------------------------------------------------------------
// 酷狗音乐
// ---------------------------------------------------------------------------

const KUGOU_APP_ID = '1005'

/**
 * 酷狗扫码：`/v2/qrcode` 返回一张二维码图片地址，`/v2/qrcode/status` 负责轮询。
 * status 语义（公开实现一致）：0 过期、1 等待扫码、2 待确认、4 确认成功。
 */
export async function startKugouQR(): Promise<QRStart> {
  const jar: CookieJar = new Map()
  const response = await request(
    `https://login-user.kugou.com/v2/qrcode?appid=${KUGOU_APP_ID}&type=1&plat=1&qrcode_txt=`,
    jar
  )
  const payload: any = await response.json()
  const qrcode = String(payload?.data?.qrcode ?? '')
  if (!qrcode) throw new Error('酷狗没有返回二维码')
  return {
    token: qrcode,
    // 接口给的是图片地址，交给界面直接显示
    image: qrcode.startsWith('http') ? qrcode : undefined,
    url: qrcode.startsWith('http') ? undefined : qrcode
  }
}

export async function pollKugouQR(qrcode: string): Promise<QRPoll & { session?: PlatformSession }> {
  const jar: CookieJar = new Map()
  const response = await request(
    `https://login-user.kugou.com/v2/qrcode/status?appid=${KUGOU_APP_ID}&type=1&plat=1&qrcode=${encodeURIComponent(qrcode)}`,
    jar
  )
  const payload: any = await response.json()
  const data = payload?.data ?? {}
  const status = Number(data.status ?? 0)
  if (status === 0) return { status: 'expired', message: '二维码已过期，请刷新' }
  if (status === 1) return { status: 'waiting' }
  if (status === 2) return { status: 'scanned', message: '已扫码，请在手机上确认' }
  if (status !== 4) return { status: 'waiting' }

  // 确认成功：用 token 换长期凭据与用户信息
  const token = String(data.token ?? '')
  const userId = String(data.userid ?? '')
  const extra: Record<string, string> = { token, userid: userId, nickname: String(data.nickname ?? '') }
  const infoJar: CookieJar = new Map(jar)
  let nickname = String(data.nickname ?? '')
  let avatarUrl: string | undefined = typeof data.pic === 'string' ? data.pic : undefined
  try {
    const info = await request(
      `https://login-user.kugou.com/v2/get_userinfo?token=${encodeURIComponent(token)}&userid=${userId}&appid=${KUGOU_APP_ID}&plat=1`,
      infoJar
    )
    const body: any = await info.json()
    nickname = String(body?.data?.nickname ?? nickname)
    avatarUrl = typeof body?.data?.pic === 'string' ? body.data.pic : avatarUrl
  } catch {
    // 拿不到昵称不影响登录
  }
  return {
    status: 'confirmed',
    nickname,
    avatarUrl,
    session: {
      platform: 'kugou',
      cookie: cookieHeader(infoJar),
      nickname,
      avatarUrl,
      userId,
      extra,
      updatedAt: Date.now()
    }
  }
}

export async function kugouPlaylists(session: PlatformSession): Promise<PlatformPlaylistDTO[]> {
  const userId = session.extra?.userid ?? session.userId ?? ''
  const token = session.extra?.token ?? ''
  if (!userId || !token) return []
  const jar: CookieJar = new Map()
  const response = await request(
    `https://mobilecdn.kugou.com/api/v3/user/playlist?page=1&pagesize=50&userid=${encodeURIComponent(userId)}` +
      `&token=${encodeURIComponent(token)}&plat=1&version=8000`,
    jar
  )
  const payload: any = await response.json()
  const info: any[] = Array.isArray(payload?.data?.info) ? payload.data.info : []
  return info
    .map((item) => ({
      id: String(item?.listid ?? item?.specialid ?? ''),
      name: String(item?.list_create_listname ?? item?.listname ?? ''),
      trackCount: Number(item?.songcount ?? item?.count ?? 0),
      coverUrl: typeof item?.imgurl === 'string' && item.imgurl ? item.imgurl.replace('{size}', '240') : undefined
    }))
    .filter((item) => item.id && item.name)
}

// ---------------------------------------------------------------------------
// QQ 音乐
// ---------------------------------------------------------------------------

const QQ_APP_ID = '716027609'
const QQ_DAID = '383'
const QQ_THIRD_AID = '100497308'
const QQ_U1 = 'https://graph.qq.com/oauth2.0/login_jump'

/** QQ 扫码用的 ptqrtoken：hash33(qrsig)。 */
function qqToken(qrsig: string): number {
  let hash = 0
  for (let index = 0; index < qrsig.length; index += 1) {
    hash += (hash << 5) + qrsig.charCodeAt(index)
    hash &= 0x7fffffff
  }
  return hash
}

/** 从 `ptuiCB('0','0','<url>','0','登录成功','昵称')` 里取出参数。 */
function parsePtuiCB(text: string): string[] {
  const match = /ptuiCB\(([^)]*)\)/.exec(text)
  if (!match) return []
  return match[1]
    .split(',')
    .map((part) => part.trim().replace(/^'/, '').replace(/'$/, ''))
}

export async function startQqQR(): Promise<QRStart> {
  const jar: CookieJar = new Map()
  const response = await request(
    `https://ssl.ptlogin2.qq.com/ptqrshow?appid=${QQ_APP_ID}&e=2&l=M&s=3&d=72&v=4&t=${Math.random()}` +
      `&daid=${QQ_DAID}&pt_3rd_aid=${QQ_THIRD_AID}&u1=${encodeURIComponent(QQ_U1)}`,
    jar,
    { headers: { Accept: 'image/*' } }
  )
  const buffer = Buffer.from(await response.arrayBuffer())
  const qrsig = jar.get('qrsig')
  if (!qrsig) throw new Error('QQ 没有返回二维码凭据')
  return {
    token: qrsig,
    image: `data:image/png;base64,${buffer.toString('base64')}`
  }
}

export async function pollQqQR(qrsig: string): Promise<QRPoll & { session?: PlatformSession }> {
  const jar: CookieJar = new Map([['qrsig', qrsig]])
  const response = await request(
    `https://ssl.ptlogin2.qq.com/ptqrlogin?u1=${encodeURIComponent(QQ_U1)}&ptqrtoken=${qqToken(qrsig)}` +
      `&ptredirect=0&h=1&t=1&g=1&from_ui=1&ptlang=2052&action=0-0-${Date.now()}` +
      `&js_ver=10275&js_type=1&login_sig=&pt_uistyle=40&aid=${QQ_APP_ID}&daid=${QQ_DAID}` +
      `&pt_3rd_aid=${QQ_THIRD_AID}&has_onekey=1`,
    jar,
    { headers: { Referer: 'https://xui.ptlogin2.qq.com/' } }
  )
  const text = await response.text()
  const parts = parsePtuiCB(text)
  const code = parts[0] ?? ''
  const nick = parts[5]
  if (code === '65') return { status: 'expired', message: '二维码已过期，请刷新' }
  if (code === '66') return { status: 'waiting' }
  if (code === '67') return { status: 'scanned', message: '已扫码，请在手机上确认', nickname: nick }
  if (code !== '0') return { status: 'waiting' }

  // 登录成功：那把跳转地址跟到底，正式 cookie（qqmusic_key 等）在重定向链里。
  const jump = parts[2]
  if (jump) {
    try {
      await request(jump, jar)
    } catch {
      // 跳转失败仍然可能已经拿到 cookie，下面的判断说了算
    }
  }
  const cookie = cookieHeader(jar)
  if (!/qqmusic_key|qm_keyst|skey|uin=/.test(cookie)) {
    return { status: 'waiting' }
  }
  let nickname = nick
  let avatarUrl: string | undefined
  const session: PlatformSession = {
    platform: 'qq',
    cookie,
    nickname,
    avatarUrl,
    userId: jar.get('uin') ?? '',
    updatedAt: Date.now()
  }
  // 用正式 cookie 换账号资料（顺便确认 cookie 真的能用）
  try {
    const profile = await qqProfile(session)
    nickname = profile.nickname ?? nickname
    avatarUrl = profile.avatarUrl
    session.nickname = nickname
    session.avatarUrl = avatarUrl
  } catch {
    // 资料拿不到不影响登录态
  }
  return { status: 'confirmed', nickname, avatarUrl, session }
}

async function qqProfile(session: PlatformSession): Promise<{ nickname?: string; avatarUrl?: string }> {
  const jar: CookieJar = new Map()
  const response = await request(
    `https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(
      JSON.stringify({
        req_0: { module: 'music.UserInfo.userInfoServer', method: 'GetLoginUserInfo', param: {} },
        comm: { uin: Number(session.userId || 0) || 0, format: 'json', ct: 24, cv: 0 }
      })
    )}`,
    jar,
    { headers: { Cookie: session.cookie, Referer: 'https://y.qq.com/' } }
  )
  const payload: any = await response.json()
  const data = payload?.req_0?.data ?? {}
  const nickname = data?.nickname ?? data?.nick ?? data?.creator?.nick ?? undefined
  const avatarUrl = data?.headurl ?? data?.creator?.headpic ?? undefined
  return { nickname, avatarUrl }
}

export async function qqPlaylists(session: PlatformSession): Promise<PlatformPlaylistDTO[]> {
  const jar: CookieJar = new Map()
  const response = await request(
    `https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(
      JSON.stringify({
        req_0: {
          module: 'music.musicasset.PlaylistBaseRead',
          method: 'GetPlaylistByUin',
          param: { uin: String(session.userId ?? ''), onlyFavor: 1 }
        },
        comm: { uin: Number(session.userId || 0) || 0, format: 'json', ct: 24, cv: 0 }
      })
    )}`,
    jar,
    { headers: { Cookie: session.cookie, Referer: 'https://y.qq.com/' } }
  )
  const payload: any = await response.json()
  const list: any[] = Array.isArray(payload?.req_0?.data?.v_playlist)
    ? payload.req_0.data.v_playlist
    : Array.isArray(payload?.req_0?.data?.playlists)
      ? payload.req_0.data.playlists
      : []
  return list
    .map((item) => ({
      id: String(item?.dissid ?? item?.tid ?? item?.id ?? ''),
      name: String(item?.dissname ?? item?.title ?? ''),
      trackCount: Number(item?.song_cnt ?? item?.songnum ?? 0),
      coverUrl: typeof item?.logo === 'string' && item.logo ? item.logo : undefined
    }))
    .filter((item) => item.id && item.name)
}

/** QQ 专辑封面：`T002R300x300M000<albumMid>.jpg` 是官方相册地址模板。 */
function qqAlbumCover(albumMid: unknown): string | undefined {
  if (typeof albumMid !== 'string' || albumMid.length === 0) return undefined
  return `https://y.qq.com/music/photo_new/T002R300x300M000${albumMid}.jpg`
}

/** 把 `CgiGetDiss` 返回的一首歌映射成站外曲目；字段缺失就返回 undefined 由调用方跳过。 */
export function parseQqPlaylistTrack(song: any): ExternalTrackDTO | undefined {
  const mid = String(song?.mid ?? song?.songmid ?? '').trim()
  const name = String(song?.name ?? song?.title ?? song?.songname ?? '').trim()
  if (!mid || !name) return undefined
  const artists = (Array.isArray(song?.singer) ? song.singer : [])
    .map((singer: any) => singer?.name)
    .filter((value: unknown): value is string => typeof value === 'string' && value.length > 0)
  return {
    source: 'qq',
    sourceId: mid,
    name,
    artists: artists.join(' / ') || '未知歌手',
    album: typeof song?.album?.name === 'string' ? song.album.name : undefined,
    durationMS: Number(song?.interval ?? 0) * 1000,
    coverUrl: qqAlbumCover(song?.album?.mid ?? song?.albummid),
    songMid: mid
  }
}

/** 从 `CgiGetDiss` 的响应里取曲目数组（不同版本可能在 dirinfo 下）。 */
export function parseQqDissSongs(payload: any): any[] {
  const data = payload?.req_0?.data
  if (Array.isArray(data?.songlist)) return data.songlist
  if (Array.isArray(data?.dirinfo?.songlist)) return data.dirinfo.songlist
  return []
}

/**
 * QQ 歌单的曲目列表。
 *
 * 走 `music.srfDissInfo.DissInfo/CgiGetDiss`：`comm` 块不能省（少了会回 `param error`），
 * `disstid` 是数字。公开歌单免登录可读；自己账号的歌单带上 cookie 一起发。
 * 曲目映射成站外曲目（`source: 'qq'`），播放时仍走严格匹配链路，不直接信任平台顺序。
 */
export async function qqPlaylistTracks(
  session: PlatformSession | undefined,
  disstid: string,
  limit = 300
): Promise<ExternalTrackDTO[]> {
  if (!Number(disstid)) return []
  const jar: CookieJar = new Map()
  const pageSize = 100
  const result: ExternalTrackDTO[] = []
  for (let offset = 0; offset < limit; offset += pageSize) {
    const response = await request(
      `https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(
        JSON.stringify({
          req_0: {
            module: 'music.srfDissInfo.DissInfo',
            method: 'CgiGetDiss',
            param: {
              disstid: Number(disstid),
              dirid: 0,
              tag: 1,
              song_begin: offset,
              song_num: pageSize,
              userinfo: 0,
              order: 1,
              onlysonglist: 0,
              enc_host_uin: '',
              platform: 'yqq.json'
            }
          },
          comm: { uin: Number(session?.userId ?? 0) || 0, format: 'json', ct: 24, cv: 0 }
        })
      )}`,
      jar,
      {
        headers: {
          ...(session?.cookie ? { Cookie: session.cookie } : {}),
          Referer: 'https://y.qq.com/'
        }
      }
    )
    const songs = parseQqDissSongs(await response.json())
    if (songs.length === 0) break
    for (const song of songs) {
      const mapped = parseQqPlaylistTrack(song)
      if (mapped) result.push(mapped)
    }
    if (songs.length < pageSize) break
  }
  return result
}

/** 歌单广场里的公开歌单 id（联调用：不登录也能读到曲目）。 */
export async function qqPublicPlaylist(): Promise<{ id: string; name: string } | undefined> {
  const response = await request(
    'https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?picmid=1&rnd=0.1&g_tk=5381&json=1' +
      '&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json' +
      '&needNewCode=0&categoryId=10000000&sortId=5&sin=0&ein=1',
    new Map(),
    { headers: { Referer: 'https://y.qq.com/' } }
  )
  const payload: any = await response.json()
  const first = payload?.data?.list?.[0]
  if (!first?.dissid) return undefined
  return { id: String(first.dissid), name: String(first.dissname ?? '') }
}
