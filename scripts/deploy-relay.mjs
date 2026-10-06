/**
 * 把「一起听」中继服务器部署到公网 VPS（SSH + SFTP）。
 *
 * 用法（凭据只从环境变量读，不写盘、不入库）：
 *   $env:RELAY_HOST="198.44.179.69"; $env:RELAY_PORT="44381"; $env:RELAY_USER="root";
 *   $env:RELAY_PASSWORD="..."; $env:ALIPAY_KEY_FILE="C:\Users\ASUS\Desktop\支付宝私钥与公钥.txt";
 *   node scripts/deploy-relay.mjs
 *
 * 做四件事：上传 server/*.mjs → 写 data/alipay-key.pem（权限 600）→ 装 systemd 常驻 →
 * 本地从公网地址请求 /health 验证。
 */
import { Client } from 'ssh2'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

const HOST = process.env.RELAY_HOST
const PORT = Number(process.env.RELAY_PORT ?? 22)
const USER = process.env.RELAY_USER ?? 'root'
const PASSWORD = process.env.RELAY_PASSWORD
const REMOTE_DIR = process.env.RELAY_DIR ?? '/opt/youyou-relay'
const RELAY_PORT = Number(process.env.RELAY_LISTEN_PORT ?? 8787)
const KEY_FILE = process.env.ALIPAY_KEY_FILE

if (!HOST || !PASSWORD) {
  console.error('缺少 RELAY_HOST / RELAY_PASSWORD 环境变量')
  process.exit(1)
}

/** 从「支付宝私钥与公钥.txt」里抽出私钥正文。 */
function readPrivateKey(file) {
  if (!file) return undefined
  const text = readFileSync(file, 'utf8')
  const match = text.match(/私钥[:：]?\s*\r?\n?\s*([A-Za-z0-9+/=\s]{500,})/)
  const body = (match ? match[1] : text).replace(/\s+/g, '')
  const chunks = body.match(/.{1,64}/g).join('\n')
  return `-----BEGIN PRIVATE KEY-----\n${chunks}\n-----END PRIVATE KEY-----\n`
}

const FILES = ['index.mjs', 'ws.mjs', 'gifts.mjs', 'alipay.mjs']

function connect() {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.on('ready', () => resolve(client))
    client.on('error', reject)
    client.connect({ host: HOST, port: PORT, username: USER, password: PASSWORD, readyTimeout: 20000 })
  })
}

function exec(client, command, { allowFailure = false, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error)
      let stdout = ''
      let stderr = ''
      stream.on('data', (chunk) => {
        stdout += chunk.toString()
        if (!quiet) process.stdout.write(chunk)
      })
      stream.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
        if (!quiet) process.stderr.write(chunk)
      })
      stream.on('close', (code) => {
        if (code !== 0 && !allowFailure) return reject(new Error(`${command} 退出码 ${code}: ${stderr.slice(0, 300)}`))
        resolve({ code, stdout, stderr })
      })
    })
  })
}

function upload(client, content, remotePath, mode) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) return reject(error)
      const stream = sftp.createWriteStream(remotePath, { mode })
      stream.on('close', () => {
        sftp.end()
        resolve()
      })
      stream.on('error', reject)
      stream.end(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'))
    })
  })
}

const NODE_VERSION = process.env.RELAY_NODE_VERSION ?? '20.18.3'
const NODE_PREFIX = '/opt/node'

async function ensureNode(client) {
  // 1) 已有可用的 node（>=18）
  const existing = await exec(client, 'node -v 2>/dev/null || true', { quiet: true, allowFailure: true })
  const version = existing.stdout.trim()
  if (version && Number(version.replace('v', '').split('.')[0]) >= 18) {
    console.log(`[deploy] 使用系统 Node ${version}`)
    return 'node'
  }

  // 2) 已解压过的官方包
  const prefixed = await exec(client, `${NODE_PREFIX}/bin/node -v 2>/dev/null || true`, { quiet: true, allowFailure: true })
  if (prefixed.stdout.trim()) {
    console.log(`[deploy] 使用 ${NODE_PREFIX} 下的 Node ${prefixed.stdout.trim()}`)
    return `${NODE_PREFIX}/bin/node`
  }

  // 3) 直接下载官方 Linux 二进制包（不依赖发行版仓库，最稳）
  console.log(`[deploy] 下载官方 Node v${NODE_VERSION} 到 ${NODE_PREFIX} ...`)
  const arch = (await exec(client, 'uname -m', { quiet: true })).stdout.trim()
  const archName = arch === 'aarch64' || arch === 'arm64' ? 'arm64' : 'x64'
  const tarball = `node-v${NODE_VERSION}-linux-${archName}.tar.xz`
  const command = [
    'set -e',
    `mkdir -p ${NODE_PREFIX}`,
    `cd /tmp`,
    `(command -v curl >/dev/null && curl -fsSL -o ${tarball} https://nodejs.org/dist/v${NODE_VERSION}/${tarball}) || ` +
      `(command -v wget >/dev/null && wget -qO ${tarball} https://nodejs.org/dist/v${NODE_VERSION}/${tarball})`,
    `tar -xJf ${tarball} -C ${NODE_PREFIX} --strip-components=1`,
    `${NODE_PREFIX}/bin/node -v`
  ].join(' && ')
  const result = await exec(client, command, { allowFailure: true })
  if (result.code !== 0 || !result.stdout.includes('v')) {
    console.error('[deploy] Node 二进制包安装失败，请手动安装 Node 20+ 后重跑')
    process.exit(1)
  }
  console.log(`[deploy] Node 就绪: ${result.stdout.trim().split('\n').pop()}`)
  return `${NODE_PREFIX}/bin/node`
}

async function main() {
  console.log(`[deploy] 连接 ${USER}@${HOST}:${PORT} ...`)
  const client = await connect()
  console.log('[deploy] 已连接')

  const nodeBin = await ensureNode(client)

  await exec(client, `mkdir -p ${REMOTE_DIR}/data && chmod 700 ${REMOTE_DIR}/data`, { quiet: true })
  for (const file of FILES) {
    const content = readFileSync(path.join(process.cwd(), 'server', file))
    await upload(client, content, `${REMOTE_DIR}/${file}`, 0o644)
    console.log(`[deploy] 上传 ${file} (${content.length} 字节)`)
  }

  const key = readPrivateKey(KEY_FILE)
  if (key) {
    await upload(client, key, `${REMOTE_DIR}/data/alipay-key.pem`, 0o600)
    console.log('[deploy] 已上传支付宝应用私钥（权限 600，仅服务器持有）')
  } else {
    console.log('[deploy] 未提供支付宝私钥：支付功能将不可用（其余功能正常）')
  }

  const unit = `[Unit]
Description=Youyou Music Listen-Together Relay
After=network.target

[Service]
WorkingDirectory=${REMOTE_DIR}
Environment=PORT=${RELAY_PORT}
Environment=ALIPAY_APP_ID=2019101168266558
ExecStart=${nodeBin} ${REMOTE_DIR}/index.mjs
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
`
  await upload(client, unit, '/etc/systemd/system/youyou-relay.service', 0o644)
  await exec(client, 'systemctl daemon-reload && systemctl enable youyou-relay && systemctl restart youyou-relay', {
    quiet: true
  })
  const status = await exec(client, 'systemctl is-active youyou-relay; ss -lntp 2>/dev/null | grep ' + RELAY_PORT + ' || true')
  console.log(`[deploy] 服务状态: ${status.stdout.trim()}`)

  // 放通系统防火墙（云安全组仍需用户在控制台放通）
  await exec(
    client,
    `(command -v ufw >/dev/null && ufw allow ${RELAY_PORT}/tcp) || ` +
      `(command -v firewall-cmd >/dev/null && firewall-cmd --permanent --add-port=${RELAY_PORT}/tcp && firewall-cmd --reload) || true`,
    { allowFailure: true, quiet: true }
  )

  client.end()

  // 从公网验证
  console.log(`[deploy] 从公网请求 http://${HOST}:${RELAY_PORT}/health ...`)
  try {
    const response = await fetch(`http://${HOST}:${RELAY_PORT}/health`)
    const health = await response.json()
    console.log('[deploy] 健康检查:', JSON.stringify(health))
    console.log('[deploy] DEPLOY OK')
  } catch (cause) {
    console.error(`[deploy] 公网访问失败: ${String(cause).slice(0, 160)}`)
    console.error(`[deploy] 服务已启动，请在云厂商控制台的安全组放通 ${RELAY_PORT}/tcp 后重试`)
    process.exit(2)
  }
}

main().catch((cause) => {
  console.error('[deploy] 失败:', cause.message ?? cause)
  process.exit(1)
})
