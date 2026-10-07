/**
 * 把服务器上的官网目录拉回工作区（以服务器为准）。
 *
 * 用法：
 *   $env:RELAY_HOST="..."; $env:RELAY_PORT="..."; $env:RELAY_USER="root"; $env:RELAY_PASSWORD="..."
 *   node scripts/pull-website.mjs [远端目录] [本地目录]
 * 默认：远端 /www/wwwroot/youyouyy → 本地 website/
 *
 * 拉取后会逐个文件比对 SHA-256，确认本地与线上完全一致（只读：不修改服务器）。
 */
import { Client } from 'ssh2'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import process from 'node:process'

const HOST = process.env.RELAY_HOST
const PORT = Number(process.env.RELAY_PORT ?? 22)
const USER = process.env.RELAY_USER ?? 'root'
const PASSWORD = process.env.RELAY_PASSWORD
const REMOTE = process.argv[2] ?? '/www/wwwroot/youyouyy'
const LOCAL = process.argv[3] ?? 'website'

/** 不拉取的目录/文件：站点里放的安装包镜像体积很大，没必要进工作区。 */
const SKIP_PATTERNS = [/^xz\//, /^downloads?\//, /\.(exe|msi|zip|7z|rar|tar\.gz)$/i]
/** 单个文件超过这个大小也跳过（默认 20MB），避免误拉大文件。 */
const MAX_FILE_BYTES = Number(process.env.PULL_MAX_BYTES ?? 20 * 1024 * 1024)

function shouldSkip(relative, size) {
  if (SKIP_PATTERNS.some((pattern) => pattern.test(relative))) return '按规则排除'
  if (size > MAX_FILE_BYTES) return `超过 ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)}MB`
  return undefined
}

if (!HOST || !PASSWORD) {
  console.error('缺少 RELAY_HOST / RELAY_PASSWORD 环境变量')
  process.exit(1)
}

/** 连接并返回 { client, sftp, exec } 三个工具 */
async function connect() {
  const client = new Client()
  await new Promise((resolve, reject) => {
    client.on('ready', resolve)
    client.on('error', reject)
    client.connect({ host: HOST, port: PORT, username: USER, password: PASSWORD, readyTimeout: 20000 })
  })
  const sftp = await new Promise((resolve, reject) => client.sftp((error, s) => (error ? reject(error) : resolve(s))))
  const exec = (command) =>
    new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) return reject(error)
        let stdout = ''
        let stderr = ''
        stream.on('data', (chunk) => (stdout += chunk.toString()))
        stream.stderr.on('data', (chunk) => (stderr += chunk.toString()))
        stream.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
      })
    })
  return { client, sftp, exec }
}

function readRemoteFile(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const stream = sftp.createReadStream(remotePath)
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

async function main() {
  console.log(`[拉取] ${USER}@${HOST}:${PORT} ${REMOTE} → ${LOCAL}`)
  const { client, sftp, exec } = await connect()
  try {
    // 远端文件清单（相对路径 + 字节数 + sha256）
    const listing = await exec(
      `cd ${REMOTE} && find . -type f -printf '%P\\t%s\\n' | sort && echo '---HASHES---' && find . -type f -exec sha256sum {} + | sed 's#\\./##'`
    )
    const [listPart, hashPart = ''] = listing.stdout.split('---HASHES---')
    const files = listPart
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [relative, size] = line.split('\t')
        return { relative, size: Number(size) }
      })

    const remoteHashes = new Map()
    for (const line of hashPart.trim().split('\n')) {
      const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim())
      if (match) remoteHashes.set(match[2].replace(/^\.\//, ''), match[1])
    }

    console.log(`[拉取] 远端共 ${files.length} 个文件：`)
    const skipped = []
    const wanted = []
    for (const file of files) {
      const reason = shouldSkip(file.relative, file.size)
      if (reason) {
        skipped.push({ ...file, reason })
        continue
      }
      wanted.push(file)
      console.log(`   ${file.relative}  ${(file.size / 1024).toFixed(1)} KB`)
    }
    if (skipped.length > 0) {
      console.log('[拉取] 已跳过（仍保留在服务器上，未做任何改动）：')
      for (const file of skipped) {
        console.log(`   ${file.relative}  ${(file.size / 1024 / 1024).toFixed(1)} MB — ${file.reason}`)
      }
    }

    let downloaded = 0
    let mismatched = 0
    for (const file of wanted) {
      const target = path.join(LOCAL, file.relative)
      mkdirSync(path.dirname(target), { recursive: true })
      const data = await readRemoteFile(sftp, `${REMOTE}/${file.relative}`)
      writeFileSync(target, data)
      const localHash = createHash('sha256').update(readFileSync(target)).digest('hex')
      const remoteHash = remoteHashes.get(file.relative)
      const ok = remoteHash ? localHash === remoteHash : data.length === file.size
      if (ok) downloaded += 1
      else {
        mismatched += 1
        console.log(`   ✗ 校验不一致: ${file.relative}`)
      }
    }

    console.log(
      `\n[拉取] 完成：${downloaded}/${wanted.length} 个文件已落盘并校验一致${mismatched ? `，${mismatched} 个不一致` : ''}` +
        `${skipped.length ? `；跳过 ${skipped.length} 个大文件` : ''}`
    )
    console.log(`[拉取] 本地目录：${path.resolve(LOCAL)}（服务器未做任何修改）`)
  } finally {
    client.end()
  }
}

main().catch((cause) => {
  console.error('[拉取] 失败:', cause.message ?? cause)
  process.exit(1)
})
