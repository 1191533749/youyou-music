/**
 * electron-builder 的 afterPack 钩子：给打包出的主程序写入图标与版本信息。
 *
 * 两个必须绕开的坑：
 *
 * 1. **不能用 electron-builder 自带的 `signAndEditExecutable`。** 那条路径会先解压
 *    winCodeSign 包，包里含 macOS 符号链接；未开启「开发者模式」且非管理员的 Windows
 *    无法创建符号链接，解压报错后整条打包流程中断。
 *
 * 2. **也不能用 rcedit。** electron-builder 会往 exe 里写一个 `INTEGRITY / ELECTRONASAR`
 *    资源（asar 完整性校验），rcedit 重写资源段时会把它丢掉；Electron 校验失败会
 *    **静默退出**（退出码 0、无任何输出），表现为「双击没反应」。所以这里用
 *    electron-builder 自己依赖的 `resedit`：它读取并回写整棵资源树，未知资源原样保留。
 *
 * 写完后自检：原本存在的 INTEGRITY 资源不能丢，否则直接报错，避免产出打不开的包。
 *
 * 附注：中文版本资源本身没有问题——实测「悠悠音乐」可正常写入并启动。
 * 曾经怀疑它导致启动失败，最后查明真凶是环境变量 `ELECTRON_RUN_AS_NODE=1`
 * （详见 src/main/index.ts 顶部与 HANDOFF.md 的排错表）。
 */
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const PRODUCT_NAME = '悠悠音乐'
const COPYRIGHT = 'LGPL-3.0'
const ICON_GROUP_ID = 1
const LANG_EN_US = 1033

function loadResedit(root) {
  // resedit 由 electron-builder 间接安装；从项目目录解析，避免依赖提升位置。
  try {
    return require(require.resolve('resedit', { paths: [root, path.join(root, 'node_modules')] }))
  } catch {
    return undefined
  }
}

/** 统计给定类型的资源条目数量，用于前后一致性检查。 */
function countResources(Resource, NtExecutable, NtExecutableResource, buffer, type) {
  const exe = NtExecutable.from(buffer, { ignoreCert: true })
  const res = NtExecutableResource.from(exe)
  void Resource
  return res.entries.filter((entry) => String(entry.type) === type).length
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  // 排查用开关：KUMONE_SKIP_ICON=1 跳过资源写入，便于对比「写入前/后」的产物差异。
  if (process.env.KUMONE_SKIP_ICON === '1') {
    console.log('[afterPack] 已按 KUMONE_SKIP_ICON=1 跳过图标与版本写入')
    return
  }

  const root = context.packager.projectDir
  const exeName = `${context.packager.appInfo.productFilename}.exe`
  const exePath = path.join(context.appOutDir, exeName)
  const iconPath = path.join(root, 'build', 'icon.ico')

  if (!existsSync(exePath)) {
    console.warn(`[afterPack] 找不到主程序 ${exePath}，跳过资源写入`)
    return
  }

  const resedit = loadResedit(root)
  if (!resedit) {
    console.warn('[afterPack] 无法加载 resedit，跳过图标与版本信息')
    return
  }

  const { NtExecutable, NtExecutableResource, Data, Resource } = resedit
  const version = context.packager.appInfo.version
  const original = readFileSync(exePath)
  const integrityBefore = countResources(Resource, NtExecutable, NtExecutableResource, original, 'INTEGRITY')

  try {
    const exe = NtExecutable.from(original, { ignoreCert: true })
    const res = NtExecutableResource.from(exe)

    // --- 图标 ---
    if (existsSync(iconPath)) {
      const iconFile = Data.IconFile.from(readFileSync(iconPath))
      const groups = Resource.IconGroupEntry.fromEntries(res.entries)
      const target = groups.find((group) => Number(group.id) === ICON_GROUP_ID) ?? groups[0]
      if (target) {
        Resource.IconGroupEntry.replaceIconsForResource(
          res.entries,
          target.id,
          target.lang,
          iconFile.icons.map((item) => item.data)
        )
      } else {
        console.warn('[afterPack] 未找到图标组，保留原图标')
      }
    }

    // --- 版本信息 ---
    const versionInfos = Resource.VersionInfo.fromEntries(res.entries)
    if (versionInfos.length === 1) {
      const info = versionInfos[0]
      const languages = info.getAllLanguagesForStringValues()
      const language = languages[0] ?? { lang: LANG_EN_US, codepage: 1200 }
      info.setStringValues(language, {
        ProductName: PRODUCT_NAME,
        FileDescription: PRODUCT_NAME,
        CompanyName: PRODUCT_NAME,
        LegalCopyright: COPYRIGHT,
        OriginalFilename: exeName,
        InternalName: PRODUCT_NAME
      })
      info.setFileVersion(version, language.lang)
      info.setProductVersion(version, language.lang)
      info.outputToResourceEntries(res.entries)
    } else {
      console.warn(`[afterPack] 版本信息条目数为 ${versionInfos.length}，跳过版本写入`)
    }

    res.outputResource(exe)
    const updated = Buffer.from(exe.generate())

    // --- 自检：完整性资源不能被弄丢 ---
    const integrityAfter = countResources(
      Resource,
      NtExecutable,
      NtExecutableResource,
      updated,
      'INTEGRITY'
    )
    if (integrityBefore > 0 && integrityAfter === 0) {
      throw new Error('asar 完整性资源在写入过程中丢失，生成的 exe 会无法启动')
    }

    writeFileSync(exePath, updated)
    console.log(
      `[afterPack] 已写入图标与版本信息：${exeName} v${version}` +
        `（完整性资源 ${integrityBefore} → ${integrityAfter}）`
    )
  } catch (error) {
    console.error(`[afterPack] 写入资源失败：${error.message}`)
    throw error
  }
}
