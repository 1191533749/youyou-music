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

const appId = process.env.ALIPAY_APP_ID
const privateKeyRaw = process.env.ALIPAY_PRIVATE_KEY

if (!appId || !privateKeyRaw) {
  console.error('缺少 ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY 环境变量')
  process.exit(1)
}

function toPEM(key) {
  const body = key.replace(/\s+/g, '').replace(/-----[^-]+-----/g, '')
  const lines = body.match(/.{1,64}/g).join('\n')
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`
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
