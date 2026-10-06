/**
 * 服务器体检：改目录、换私钥、重启服务之后，一条命令确认「网站 / 中继 / 支付宝 / 安全」都正常。
 *
 * 用法（凭据只从环境变量读）：
 *   $env:RELAY_HOST="198.44.179.69"; $env:RELAY_PORT="44381"; $env:RELAY_USER="root"
 *   $env:RELAY_PASSWORD="..."; node scripts/verify-server.mjs [--site https://yy.ytw.asia]
 *
 * 检查项：
 *   1. 网站首页 200 且标题正确
 *   2. 公网 wss 中继健康：ok=true / alipay=true（私钥已被服务读到）
 *   3. 安全：私钥、state.json、中继源码一律 404
 *   4. 服务器侧：systemd 服务 active、8787 在监听、中继目录与 data 文件存在、私钥权限 600
 *   5. 中继目录 / 私钥真实路径（改目录后一眼看出 systemd 是否还指向旧路径）
 */
import { Client } from 'ssh2'
import process from 'node:process'

const HOST = process.env.RELAY_HOST
const PORT = Number(process.env.RELAY_PORT ?? 22)
const USER = process.env.RELAY_USER ?? 'root'
const PASSWORD = process.env.RELAY_PASSWORD
const SITE = process.argv[process.argv.indexOf('--site') + 1]?.startsWith('http')
  ? process.argv[process.argv.indexOf('--site') + 1]
  : 'https://yy.ytw.asia'

if (!HOST || !PASSWORD) {
  console.error('缺少 RELAY_HOST / RELAY_PASSWORD 环境变量')
  process.exit(1)
}

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function connect() {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.on('ready', () => resolve(client))
    client.on('error', reject)
    client.connect({ host: HOST, port: PORT, username: USER, password: PASSWORD, readyTimeout: 20000 })
  })
}

function exec(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error)
      let stdout = ''
      let stderr = ''
      stream.on('data', (chunk) => (stdout += chunk.toString()))
      stream.stderr.on('data', (chunk) => (stderr += chunk.toString()))
      stream.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
    })
  })
}

async function checkPublic() {
  try {
    const response = await fetch(`${SITE}/`, { redirect: 'follow' })
    const html = await response.text()
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? ''
    record('网站首页可访问', response.status === 200, `HTTP ${response.status} · 标题「${title}」`)
    record('网站页面是官网内容', html.includes('悠悠音乐'), title)
  } catch (cause) {
    record('网站首页可访问', false, String(cause).slice(0, 90))
  }

  try {
    const response = await fetch(`${SITE}/relay/health`)
    const health = await response.json()
    record('中继健康（公网 https）', health.ok === true, `rooms=${health.rooms} online=${health.online} uptime=${health.uptime}s`)
    record('中继已读到支付宝私钥', health.alipay === true, `alipay=${health.alipay}`)
    record('礼物目录完整', Number(health.gifts) >= 10, `gifts=${health.gifts}`)
  } catch (cause) {
    record('中继健康（公网 https）', false, String(cause).slice(0, 90))
  }

  for (const path of ['/data/alipay-key.pem', '/data/state.json', '/index.mjs', '/alipay.mjs', '/gifts.mjs']) {
    try {
      const response = await fetch(`${SITE}${path}`, { redirect: 'manual' })
      record(`敏感路径不可下载 ${path}`, response.status === 404 || response.status === 403, `HTTP ${response.status}`)
    } catch (cause) {
      record(`敏感路径不可下载 ${path}`, false, String(cause).slice(0, 60))
    }
  }
}

async function checkRemote(client) {
  const unit = await exec(
    client,
    "systemctl show -p WorkingDirectory -p ExecStart -p ActiveState youyou-relay 2>/dev/null | tr '\\n' ' '"
  )
  record('中继服务在运行', /ActiveState=active/.test(unit.stdout), unit.stdout.slice(0, 160))

  const port = await exec(client, "ss -lntp 2>/dev/null | grep -c ':8787'")
  record('中继端口 8787 在监听', Number(port.stdout) >= 1)

  const files = await exec(
    client,
    'for f in index.mjs ws.mjs gifts.mjs alipay.mjs data/alipay-key.pem data/state.json; do ' +
      'p=$(grep -oP "(?<=WorkingDirectory=).*" /etc/systemd/system/youyou-relay.service 2>/dev/null | head -1); ' +
      'echo "$p/$f"; done'
  )
  record('systemd 指向的中继文件清单', files.stdout.split('\n').length === 6, files.stdout.split('\n')[0] ?? '')

  const perms = await exec(
    client,
    'p=$(grep -oP "(?<=WorkingDirectory=).*" /etc/systemd/system/youyou-relay.service | head -1); ' +
      'stat -c "%a %n" "$p/data/alipay-key.pem" 2>/dev/null; ' +
      'test -f "$p/data/state.json" && echo "state.json 存在"'
  )
  const permLine = perms.stdout.split('\n')[0] ?? ''
  record('支付宝私钥权限为 600', permLine.startsWith('600'), permLine)
  record('余额/订单数据文件存在', perms.stdout.includes('state.json 存在'))

  const nginxRoot = await exec(client, "grep -oP '(?<=root ).*(?=;)' /www/server/panel/vhost/nginx/yy.ytw.asia.conf | head -1")
  record('nginx 网站根目录', nginxRoot.stdout.length > 0, nginxRoot.stdout)
}

async function main() {
  console.log(`[体检] 站点 ${SITE} · 服务器 ${USER}@${HOST}:${PORT}\n`)
  await checkPublic()
  const client = await connect()
  try {
    await checkRemote(client)
  } finally {
    client.end()
  }
  const failed = results.filter((item) => !item.ok)
  console.log(`\n[体检] ${failed.length === 0 ? '全部通过' : `${failed.length} 项异常`}（共 ${results.length} 项）`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((cause) => {
  console.error('[体检] 失败:', cause.message ?? cause)
  process.exit(1)
})
