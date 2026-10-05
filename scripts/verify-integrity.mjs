/**
 * 诊断：核对 exe 里的 asar 完整性校验值是否与当前 app.asar 匹配。
 *
 * Electron 在 exe 中读到 `INTEGRITY/ELECTRONASAR` 资源后，会重新计算 app.asar 的
 * 哈希并比对；不一致时**静默退出**（退出码 0、无输出）。所以「双击没反应」时
 * 在排除了 `ELECTRON_RUN_AS_NODE` 之后，第二件事就是跑这里。
 *
 * 用法：node scripts/verify-integrity.mjs（需要先完成一次打包）。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const root = process.cwd()
const unpacked = path.join(root, 'release', 'win-unpacked')
const resourcesPath = path.join(unpacked, 'resources')

const { computeData } = require(path.join(root, 'node_modules', 'app-builder-lib', 'out', 'asar', 'integrity.js'))
const expected = await computeData({ resourcesPath, resourcesRelativePath: 'resources' })
console.log('应写入 exe 的校验值:', JSON.stringify(expected))

// 从 exe 里读出实际写入的值
const resedit = require(path.join(root, 'node_modules', 'resedit'))
const { NtExecutable, NtExecutableResource } = resedit
const buffer = readFileSync(path.join(unpacked, 'YouyouMusic.exe'))
const exe = NtExecutable.from(buffer, { ignoreCert: true })
const res = NtExecutableResource.from(exe)
const integrity = res.entries.filter((entry) => String(entry.type) === 'INTEGRITY')
console.log(`exe 内 INTEGRITY 条目数: ${integrity.length}`)
for (const entry of integrity) {
  const raw = entry.bin
  const text = Buffer.isBuffer(raw)
    ? raw.toString('utf8')
    : raw instanceof ArrayBuffer
      ? Buffer.from(raw).toString('utf8')
      : ArrayBuffer.isView(raw)
        ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
        : String(raw)
  console.log(`  id=${entry.id} lang=${entry.lang} codepage=${entry.codepage}`)
  console.log(`  内容=${text}`)
  try {
    const parsed = JSON.parse(text)
    const expectedFlat = Object.values(expected)[0]
    const actualFlat = Array.isArray(parsed) ? parsed[0] : undefined
    console.log(
      `  期望 hash=${expectedFlat?.hash}\n  实际 hash=${actualFlat?.value}\n  一致=${expectedFlat?.hash === actualFlat?.value}`
    )
  } catch (error) {
    console.log(`  解析失败: ${error.message}`)
  }
}
