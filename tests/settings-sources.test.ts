/**
 * 设置里「第三方音源」列表的兼容与迁移。
 *
 * 音源是分批上线的：老配置文件里不可能人为关掉当时还不存在的音源，所以读到不带
 * `unblockSourcesMigrated` 标记的老配置时要把新音源补上；而用户自己关掉之后
 * （标记已为 true）就不能再被自动打开——否则设置页会「关不掉」。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SettingsStore } from '../src/main/storage/settings.js'
import type { SettingsDTO } from '../src/shared/types.js'

function storeWith(settings: Record<string, unknown>): SettingsStore {
  const dir = mkdtempSync(join(tmpdir(), 'yy-settings-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')
  return new SettingsStore(dir)
}

describe('设置：音源列表迁移', () => {
  it('老配置里没有聚合音源时自动补上，并排在最前（优先级最高）', async () => {
    const store = storeWith({ unblockSources: ['qishui', 'kugou', 'kuwo', 'qq'] })
    const settings = await store.load()
    expect(settings.unblockSources).toEqual(['gdstudio', 'qishui', 'kugou', 'kuwo', 'qq'])
    expect(settings.unblockSourcesMigrated).toBe(true)
  })

  it('用户自己关掉聚合音源后（标记已存在）不会被重新打开', async () => {
    const store = storeWith({
      unblockSources: ['qishui', 'kuwo'],
      unblockSourcesMigrated: true
    })
    const settings = await store.load()
    expect(settings.unblockSources).toEqual(['qishui', 'kuwo'])
  })

  it('迁移后的设置落盘，重启不会再改一次', async () => {
    const store = storeWith({ unblockSources: ['kuwo'] })
    const first = await store.load()
    expect(first.unblockSources).toEqual(['gdstudio', 'kuwo'])
    // 模拟用户随后关掉聚合音源（设置页会把整份设置写回）。
    await store.update({ unblockSources: ['kuwo'] })
    await store.flush()
    const dir = (store as unknown as { directory: string }).directory
    const reopened = new SettingsStore(dir)
    const second = await reopened.load()
    expect(second.unblockSources).toEqual(['kuwo'])
  })

  it('旧名字 pyncmd 迁成聚合音源，未知音源被丢弃', async () => {
    const store = storeWith({ unblockSources: ['pyncmd', 'unknown-source', 'qq'] })
    const settings = await store.load()
    expect(settings.unblockSources).toEqual(['gdstudio', 'qq'])
  })

  it('列表里全是无效值时退回默认音源，不会变成「一个都不启用」', async () => {
    const store = storeWith({ unblockSources: ['nope', 42, null] })
    const settings = await store.load()
    expect(settings.unblockSources.length).toBeGreaterThan(0)
    expect(settings.unblockSources).toContain('gdstudio')
  })

  it('默认设置本身就是完整列表，新装用户不用迁移', () => {
    const store = new SettingsStore(mkdtempSync(join(tmpdir(), 'yy-settings-')))
    const defaults = store.current as SettingsDTO
    expect(defaults.unblockSources).toEqual(['gdstudio', 'qishui', 'kugou', 'kuwo', 'qq'])
    expect(defaults.unblockSourcesMigrated).toBe(true)
  })
})
