/**
 * 支付宝「当面付」开通性探针（一次性验证脚本，用完可删）。
 *
 * 用给定的 AppID + 应用私钥调用 alipay.trade.precreate（扫码支付预下单）：
 *  - 返回 qr_code / code=10000 → 当面付已开通，可以落地扫码支付；
 *  - 返回 4xxxx 错误码 → 未签约该产品/权限不足，需要先在支付宝开放平台开通。
 *
 * 私钥从环境变量 ALIPAY_PRIVATE_KEY 读取，绝不写盘、绝不入库。
 * 用法：$env:ALIPAY_PRIVATE_KEY="..."; $env:ALIPAY_APP_ID="..."; node scripts/alipay-probe.mjs
 */
import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'

const appId = process.env.ALIPAY_APP_ID ?? '2019101168266558'
let privateKeyRaw = process.env.ALIPAY_PRIVATE_KEY

// 也支持直接读密钥文件（文件里的字节比聊天里粘贴的更可靠）
if (!privateKeyRaw && process.env.ALIPAY_PRIVATE_KEY_FILE) {
  const text = readFileSync(process.env.ALIPAY_PRIVATE_KEY_FILE, 'utf8')
  const match = text.match(/私钥[:：]?\s*\r?\n?\s*([A-Za-z0-9+/=\s]{500,})/)
  privateKeyRaw = match ? match[1] : text
}

if (!appId || !privateKeyRaw) {
  console.error('缺少 ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY（或 ALIPAY_PRIVATE_KEY_FILE）')
  process.exit(1)
}

function toPEM(key) {
  const cleaned = key.replace(/\s+/g, '').replace(/-----[^-]+-----/g, '')
  // 按 ASN.1 声明长度裁剪，容忍粘贴/文件里多余的尾部空行或字符
  let der = Buffer.from(cleaned, 'base64')
  if (der.length > 4 && der[0] === 0x30) {
    let length = der[1]
    let header = 2
    if (length & 0x80) {
      const count = length & 0x7f
      length = 0
      for (let i = 0; i < count; i += 1) length = (length << 8) | der[2 + i]
      header = 2 + count
    }
    const declared = header + length
    if (declared > 0 && declared <= der.length) der = der.subarray(0, declared)
  }
  const body = der.toString('base64').match(/.{1,64}/g).join('\n')
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`
}

function sign(params, privateKey) {
  const content = Object.keys(params)
    .filter((key) => key !== 'sign' && params[key] !== undefined && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&')
  return createSign('RSA-SHA256').update(content, 'utf8').sign(toPEM(privateKey), 'base64')
}

function timestamp() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

async function main() {
  const outTradeNo = `PROBE${Date.now()}`
  const params = {
    app_id: appId,
    method: 'alipay.trade.precreate',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: timestamp(),
    version: '1.0',
    biz_content: JSON.stringify({
      out_trade_no: outTradeNo,
      total_amount: '0.01',
      subject: '开通性测试（不会真实扣款，未支付即自动失效）'
    })
  }
  params.sign = sign(params, privateKeyRaw)

  const body = new URLSearchParams(params).toString()
  const response = await fetch('https://openapi.alipay.com/gateway.do', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body
  })
  const text = await response.text()
  console.log('HTTP', response.status)
  try {
    const json = JSON.parse(text)
    const payload = json.alipay_trade_precreate_response ?? json
    console.log('code      :', payload.code)
    console.log('msg       :', payload.msg)
    console.log('sub_code  :', payload.sub_code ?? '-')
    console.log('sub_msg   :', payload.sub_msg ?? '-')
    console.log('qr_code   :', payload.qr_code ? `${String(payload.qr_code).slice(0, 80)}...` : '（无）')
    if (payload.code === '10000' && payload.qr_code) {
      console.log('\n结论：当面付可用 —— 可以生成收款码并由我们轮询订单状态确认到账。')
    } else {
      console.log('\n结论：当面付不可用或未开通，需要先在支付宝开放平台开通该产品。')
    }
  } catch {
    console.log(text.slice(0, 400))
  }
}

main().catch((cause) => {
  console.error('探针失败:', cause)
  process.exit(1)
})
