/**
 * 启动诊断。
 *
 * 打包后的应用没有控制台，出问题时「双击没反应」几乎无法定位。设置环境变量
 * `KUMONE_BOOT_LOG=<路径>` 后，主进程会在每个启动里程碑追加一行日志；不设置时
 * 完全空转（没有文件 IO、没有开销）。
 *
 * 用法：
 *   $env:KUMONE_BOOT_LOG="$env:TEMP\youyou-boot.log"; .\YouyouMusic.exe
 * 便携版同样有效：环境变量会传递给外壳解压后的子进程。
 */
import { appendFileSync } from 'node:fs'

const target = process.env.KUMONE_BOOT_LOG

export function bootLog(stage: string): void {
  if (!target) return
  try {
    appendFileSync(target, `${new Date().toISOString()} [${process.pid}] ${stage}\n`)
  } catch {
    // 诊断本身绝不能再制造问题。
  }
}

export const bootLogEnabled = Boolean(target)
