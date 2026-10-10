/**
 * Authentication IPC.
 *
 * Login is QR-first, matching the macOS client: fetch a unikey, render
 * `https://music.163.com/login?codekey=<unikey>` as a QR code, then poll. The
 * poll owns the state machine (800 expired · 801 waiting · 802 scanned · 803
 * success) and absorbs the auth cookies the client's transport already caught.
 */
import { defineHandler } from './registry.js'
import { NeteaseAPIError } from '../netease/client.js'
import { setKnownUID } from '../storage/remoteDaily.js'
import {
  kugouPlaylists,
  pollKugouQR,
  pollQqQR,
  qqPlaylistTracks,
  qqPlaylists,
  startKugouQR,
  startQqQR
} from '../accounts/platforms.js'
import type { AppContext } from '../context.js'
import type {
  PlatformAccountDTO,
  PlatformPlaylistDTO,
  QRLoginStateDTO,
  UserProfileDTO
} from '@shared/types'

/** QR codes are valid for roughly two minutes; the UI shows a countdown. */
const QR_TTL_MS = 120_000

/**
 * 测试钩子（YOYOU_FAKE_QQ_ACCOUNT=1）：真实 QQ 歌单必须扫码登录才拿得到，测试里
 * 直接挂一张公开歌单。曲目与播放仍是真实接口，只有这张歌单本身是固定的。
 */
const FAKE_QQ_PLAYLIST: PlatformPlaylistDTO = { id: '7707261125', name: '公开歌单', trackCount: 0 }

interface Session {
  unikey: string
  startedAt: number
  scanned: boolean
}

let session: Session | undefined

function profileDTO(context: AppContext, profile: {
  userId: number
  nickname: string
  avatarUrl?: string
  backgroundUrl?: string
  signature?: string
  vipType: number
}): UserProfileDTO {
  void context
  return {
    userId: profile.userId,
    nickname: profile.nickname,
    avatarUrl: profile.avatarUrl,
    backgroundUrl: profile.backgroundUrl,
    signature: profile.signature,
    vipType: profile.vipType
  }
}

export function registerAuthHandlers(context: AppContext): void {
  defineHandler('auth:state', async () => {
    if (!context.client.isLoggedIn) return { loggedIn: false }
    try {
      const profile = await context.api.userAccount()
      return { loggedIn: true, profile: profile ? profileDTO(context, profile) : undefined }
    } catch {
      // A valid cookie jar with a failing profile call is still a login.
      return { loggedIn: true }
    }
  })

  defineHandler('auth:qrStart', async (): Promise<QRLoginStateDTO> => {
    const unikey = await context.api.qrKey()
    session = { unikey, startedAt: Date.now(), scanned: false }
    return {
      status: 'waiting',
      unikey,
      url: context.api.qrLoginURL(unikey)
    }
  })

  defineHandler('auth:qrPoll', ({ unikey }) => neteasePoll(unikey))

  /** 网易云扫码轮询的主体；第三方平台的轮询走各自的实现。 */
  const neteasePoll = async (unikey: string): Promise<QRLoginStateDTO> => {
    if (!session || session.unikey !== unikey) {
      return { status: 'expired', message: '二维码已失效，请刷新' }
    }
    if (Date.now() - session.startedAt > QR_TTL_MS && !session.scanned) {
      session = undefined
      return { status: 'expired', message: '二维码已过期，请刷新' }
    }

    const response = await context.api.qrCheck(unikey)
    switch (response.code) {
      case 800:
        session = undefined
        return { status: 'expired', message: '二维码已过期，请刷新' }
      case 801:
        return { status: 'waiting', url: context.api.qrLoginURL(unikey), unikey }
      case 802:
        session.scanned = true
        return {
          status: 'scanned',
          url: context.api.qrLoginURL(unikey),
          unikey,
          nickname: response.nickname,
          avatarUrl: response.avatarUrl,
          message: '已扫码，请在手机上确认'
        }
      case 803: {
        if (!context.client.isLoggedIn) {
          // 803 can arrive before the Set-Cookie is applied on a slow hop.
          return { status: 'waiting', url: context.api.qrLoginURL(unikey), unikey }
        }
        session = undefined
        // Fetch the profile and VIP tier right away: the tier decides whether
        // 无损 and Hi-Res are playable. 刚种下 cookie 的这一两秒正是限流高发
        // 窗口（接口偶发空响应），重试几次，别让「已登录但没头像」拖到重启。
        let profile: UserProfileDTO | undefined
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const account = await context.api.userAccount()
            if (account) {
              setKnownUID(account.userId)
              profile = profileDTO(context, account)
              break
            }
          } catch (cause) {
            context.log(`登录后获取账户信息失败(第 ${attempt + 1} 次): ${String(cause)}`)
          }
          await new Promise((resolve) => setTimeout(resolve, 400))
        }
        // 广播一次：侧边栏头像等 auth 订阅方当场刷新，不用等下次事件。
        if (profile) {
          context.emit('auth:changed', { loggedIn: true, profile })
        }
        return { status: 'confirmed', nickname: profile?.nickname ?? response.nickname, profile }
      }
      default:
        return {
          status: 'error',
          message: response.message ?? `未知的扫码状态 (${response.code})`,
          url: context.api.qrLoginURL(unikey)
        }
    }
  }

  defineHandler('auth:qrCancel', () => {
    session = undefined
  })

  defineHandler('auth:profile', async () => {
    if (!context.client.isLoggedIn) return undefined
    const profile = await context.api.userAccount()
    return profile ? profileDTO(context, profile) : undefined
  })

  defineHandler('auth:logout', async () => {
    session = undefined
    await context.api.logout()
    context.lyrics.clear()
    await context.player.clearQueue()
  })

  defineHandler('auth:sendSMSCode', async ({ phone, countryCode }) => {
    if (!/^\d{5,15}$/.test(phone)) {
      throw new NeteaseAPIError('business', { code: -1, message: '手机号格式不正确' })
    }
    await context.api.sendSMSCode(phone, countryCode ?? '86')
  })

  defineHandler('auth:loginCellphone', async ({ phone, captcha, countryCode }) => {
    await context.api.loginCellphone(phone, captcha, countryCode ?? '86')
    try {
      const profile = await context.api.userAccount()
      if (profile) {
        context.emit('auth:changed', { loggedIn: true, profile: profileDTO(context, profile) })
      }
    } catch (cause) {
      context.log(`手机号登录后获取账户信息失败: ${String(cause)}`)
      context.emit('auth:changed', { loggedIn: true })
    }
  })

  // --- 多平台登录（网易云 / 酷狗 / QQ音乐）---

  defineHandler('auth:platforms', async (): Promise<PlatformAccountDTO[]> => [
    { platform: 'netease', loggedIn: context.client.isLoggedIn },
    ...context.accounts.list()
  ])

  defineHandler('auth:platformQRStart', async ({ platform }) => {
    switch (platform) {
      case 'netease': {
        const unikey = await context.api.qrKey()
        session = { unikey, startedAt: Date.now(), scanned: false }
        return { token: unikey, url: context.api.qrLoginURL(unikey) }
      }
      case 'kugou':
        return startKugouQR()
      case 'qq':
        return startQqQR()
    }
  })

  defineHandler('auth:platformQRPoll', async ({ platform, token }): Promise<QRLoginStateDTO> => {
    if (platform === 'netease') return neteasePoll(token)
    const result = platform === 'kugou' ? await pollKugouQR(token) : await pollQqQR(token)
    if (result.session) {
      await context.accounts.put(result.session)
      context.log(`${platform} 登录成功: ${result.nickname ?? ''}`)
    }
    return {
      status: result.status,
      message: result.message,
      nickname: result.nickname,
      avatarUrl: result.avatarUrl
    }
  })

  defineHandler('auth:platformLogout', async ({ platform }) => {
    if (platform === 'netease') {
      session = undefined
      await context.api.logout()
      context.lyrics.clear()
      await context.player.clearQueue()
      return
    }
    await context.accounts.remove(platform)
  })

  defineHandler('auth:platformPlaylists', async ({ platform }) => {
    if (platform === 'netease') return []
    if (platform === 'qq' && process.env.YOYOU_FAKE_QQ_ACCOUNT === '1') return [FAKE_QQ_PLAYLIST]
    const stored = context.accounts.get(platform)
    if (!stored) return []
    try {
      return platform === 'kugou' ? await kugouPlaylists(stored) : await qqPlaylists(stored)
    } catch (cause) {
      context.log(`读取 ${platform} 歌单失败: ${String(cause)}`)
      return []
    }
  })

  /**
   * 平台歌单里的曲目：映射成站外曲目交给渲染层。播放时仍由播放器的解析链路
   * 逐个音源严格匹配，所以这里只负责如实列出歌单内容。
   */
  defineHandler('auth:platformPlaylistTracks', async ({ platform, id }) => {
    if (platform === 'netease') return []
    try {
      return platform === 'kugou' ? [] : await qqPlaylistTracks(context.accounts.get(platform), id)
    } catch (cause) {
      context.log(`读取 ${platform} 歌单曲目失败: ${String(cause)}`)
      return []
    }
  })
}
