/**
 * 多平台登录的自检：QQ 的扫码链路（取二维码 + 轮询）与登录态落盘。
 *
 * 网易云的扫码由 `auth.ts` 里的原逻辑覆盖。酷狗的 `/v2/qrcode` 现在对
 * 参数矩阵里的每一组都回 `error_code: 20006`（参数错误），拿不到二维码，
 * 所以这里只跑 QQ 与存储两段。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { PlatformAccounts, pollQqQR, startQqQR } from '../src/main/accounts/platforms.js'

describe('第三方平台登录态', () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('能落盘并能重新读回', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'youyou-accounts-'))
    dirs.push(dir)
    const store = new PlatformAccounts(dir)
    await store.load()
    expect(store.list().find((item) => item.platform === 'qq')?.loggedIn).toBe(false)
    expect(store.list().map((item) => item.platform)).toEqual(['qq'])

    await store.put({
      platform: 'qq',
      cookie: 'qqmusic_key=abc; uin=123',
      nickname: '小鱼',
      userId: '123',
      updatedAt: Date.now()
    })

    const reloaded = new PlatformAccounts(dir)
    await reloaded.load()
    const entry = reloaded.list().find((item) => item.platform === 'qq')
    expect(entry?.loggedIn).toBe(true)
    expect(entry?.nickname).toBe('小鱼')
    expect(reloaded.get('qq')?.cookie).toContain('qqmusic_key')

    await reloaded.remove('qq')
    expect(reloaded.get('qq')).toBeUndefined()
  })
})

describe('QQ 扫码登录', () => {
  it('取到的是一张 PNG 二维码，未扫码时轮询报等待', async () => {
    const qr = await startQqQR()
    expect(qr.token.length).toBeGreaterThan(10)
    expect(qr.image?.startsWith('data:image/png;base64,')).toBe(true)
    const bytes = Buffer.from((qr.image ?? '').split(',')[1] ?? '', 'base64')
    expect(bytes.length).toBeGreaterThan(100)
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')

    const poll = await pollQqQR(qr.token)
    expect(poll.status).toBe('waiting')
    expect(poll.session).toBeUndefined()
  }, 30_000)
})
