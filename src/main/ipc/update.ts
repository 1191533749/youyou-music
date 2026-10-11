/**
 * 更新功能的 IPC 面。
 *
 * `update:check` 只读；`update:install` 下载并排定「退出 → 替换/安装 → 重开」，
 * 然后退出应用。开发模式（未打包且没有 YOYOU_UPDATE_URL）下 check 直接返回无更新，
 * 避免每次 npm run dev 都去敲 GitHub。
 *
 * 便携版的备用线路：这类用户多半没有代理、直连 GitHub 不稳，更新（检查/下载）失败时
 * 自动打开官网，让他自己去官网下载最新版；安装版不受影响。
 */
import { app } from 'electron'
import { writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { defineHandler } from './registry.js'
import {
  checkForUpdates,
  downloadAsset,
  applyUpdate,
  isPortableBuild,
  openSiteFallback,
  type UpdateAsset
} from '../update/service.js'

/** 最近一次 check 的完整结果（install 用它选择资产）。 */
let lastCheck: Awaited<ReturnType<typeof checkForUpdates>> | undefined

/** 排障落盘（与 service.ts 同一套约定）：应用退出后没有控制台。 */
function trace(name: string, content: string): void {
  try {
    writeFileSync(path.join(os.tmpdir(), name), content)
  } catch {
    /* ignore */
  }
}

export function registerUpdateHandlers(): void {
  defineHandler('update:check', async () => {
    // 开发模式不打扰；YOYOU_UPDATE_URL 存在时视为有意的联调，放行。
    if (!app.isPackaged && !process.env.YOYOU_UPDATE_URL) {
      return { current: app.getVersion(), updateType: null }
    }
    const result = await checkForUpdates()
    lastCheck = result
    return {
      current: result.current,
      version: result.latest?.version,
      notes: result.latest?.notes,
      updateType: result.updateType
    }
  })

  defineHandler('update:install', async () => {
    trace('youyou-install-start.log', `install invoked at=${new Date().toISOString()}`)
    try {
      if (!lastCheck || lastCheck.assets.length === 0) {
        lastCheck = await checkForUpdates()
      }
      if (!lastCheck || lastCheck.assets.length === 0) {
        trace('youyou-install-start.log', 'no assets available')
        throw new Error('没有可用的更新资产')
      }
      const portable = isPortableBuild()
      const pick: UpdateAsset | undefined =
        lastCheck.assets.find((asset) => (portable ? asset.kind === 'portable' : asset.kind === 'installer')) ??
        lastCheck.assets[0]
      if (!pick) throw new Error('没有可用的更新资产')
      trace('youyou-install-start.log', `picked=${pick.name} portable=${portable}`)
      const localPath = await downloadAsset(pick)
      trace('youyou-install-start.log', `downloaded=${localPath}`)
      applyUpdate(pick, localPath)
    } catch (cause) {
      // 便携版用户在没代理 / 网络波动时拿不到 GitHub：失败就自动打开官网，
      // 让用户自己下载安装包。安装版这条路保持原样。
      await openSiteFallback(String(cause))
      throw cause
    }
  })
}
