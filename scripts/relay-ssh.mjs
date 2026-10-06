/**
 * 远程运维小工具：在已部署的中继服务器上执行命令（SSH）。
 *
 * 凭据只从环境变量读：
 *   $env:RELAY_HOST / RELAY_PORT / RELAY_USER / RELAY_PASSWORD
 *   $env:RELAY_CMD="要执行的命令"      （多条用 ; 或 && 串联）
 *
 * 用法示例：
 *   $env:RELAY_CMD="ls -la /www/wwwroot/YYyinyue"; node scripts/relay-ssh.mjs
 */
import { Client } from 'ssh2'
import process from 'node:process'

const HOST = process.env.RELAY_HOST
const PORT = Number(process.env.RELAY_PORT ?? 22)
const USER = process.env.RELAY_USER ?? 'root'
const PASSWORD = process.env.RELAY_PASSWORD
const COMMAND = process.env.RELAY_CMD

if (!HOST || !PASSWORD || !COMMAND) {
  console.error('缺少 RELAY_HOST / RELAY_PASSWORD / RELAY_CMD')
  process.exit(1)
}

const client = new Client()
client.on('ready', () => {
  client.exec(COMMAND, (error, stream) => {
    if (error) {
      console.error('执行失败:', error.message)
      client.end()
      process.exit(1)
    }
    stream.on('data', (chunk) => process.stdout.write(chunk))
    stream.stderr.on('data', (chunk) => process.stderr.write(chunk))
    stream.on('close', (code) => {
      client.end()
      process.exit(code ?? 0)
    })
  })
})
client.on('error', (error) => {
  console.error('连接失败:', error.message)
  process.exit(1)
})
client.connect({ host: HOST, port: PORT, username: USER, password: PASSWORD, readyTimeout: 20000 })
