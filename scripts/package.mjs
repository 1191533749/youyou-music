/**
 * 打包入口：安装包与免安装版**分开两次**调用 electron-builder，且两次之间清掉
 * 中间目录 `release/win-unpacked`。
 *
 * 为什么要这么绕（都是实测出来的）：
 *  - `electron-builder --win` 一次出两个目标时，产出的免安装版会启动即退
 *    （外壳解压后主程序立刻消失，无日志无报错）；
 *  - 即使拆成两次调用，只要 nsis 先构建过、`win-unpacked` 留在原地，
 *    随后构建的 portable 同样不可用；
 *  - 单独构建 portable（目录干净）则完全正常。
 * 所以流程固定为：nsis → 清 win-unpacked → portable。多花几十秒，换两个产物都可靠。
 *
 * 顺带做产物自检：两个 exe 都在、且 exe 里有 asar 完整性资源（缺了会静默退出）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import * as path from 'node:path'
import process from 'node:process'

const root = process.cwd()
// 直接跑 electron-builder 的 JS 入口：绕过 .cmd 与 shell 引号处理，
// 项目路径里有空格时（本项目就在带空格的工作区下）尤其重要。
const cli = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
const unpacked = path.join(root, 'release', 'win-unpacked')

function run(target) {
  console.log(`\n=== 打包目标：${target} ===`)
  const args = [cli, '--win', target, '--publish', 'never']
  try {
    execFileSync(process.execPath, args, { stdio: 'inherit', cwd: root })
  } catch (error) {
    // 实测偶尔会栽在 7za 压缩那一步（刚写出的 180MB exe 正被杀软扫描，导致共享冲突，
    // 7za 以退出码 2 失败）。这种情况重试一次即可，不值得让整条流水线失败。
    console.warn(`\n[package] ${target} 首次失败，清理后重试一次：${error.message.split('\n')[0]}`)
    rmSync(unpacked, { recursive: true, force: true })
    execFileSync(process.execPath, args, { stdio: 'inherit', cwd: root })
  }
}

function assertArtifact(name) {
  const file = path.join(root, 'release', name)
  if (!existsSync(file)) throw new Error(`缺少产物：${file}`)
  console.log(`OK  ${name}  ${(statSync(file).size / 1024 / 1024).toFixed(1)} MB`)
  return file
}

/** asar 完整性资源是否还在：丢了就会「双击没反应」。 */
function assertIntegrity(exePath) {
  const buffer = readFileSync(exePath)
  const has =
    buffer.includes(Buffer.from('ELECTRONASAR', 'utf16le')) ||
    buffer.includes(Buffer.from('ELECTRONASAR'))
  if (!has) throw new Error(`${path.basename(exePath)} 缺少 asar 完整性资源，启动会静默失败`)
  console.log(`OK  ${path.basename(exePath)} 含 asar 完整性资源`)
}

run('nsis')
// nsis 构建留下的 win-unpacked 会让后续 portable 变成「打不开」的版本，
// 这里先清掉，让 portable 走一次全新的打包。
rmSync(unpacked, { recursive: true, force: true })
run('portable')

const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
// 命名约定见 electron-builder.yml：悠悠音乐安装版<版本>.exe / 悠悠音乐便携版<版本>.exe
// （更新源按「安装版/便携版」关键词匹配资产，命名不能随意改）
assertArtifact(`悠悠音乐安装版${version}.exe`)
assertArtifact(`悠悠音乐便携版${version}.exe`)
assertIntegrity(path.join(unpacked, 'YouyouMusic.exe'))

console.log('\n打包完成，产物在 release/ 目录。')

