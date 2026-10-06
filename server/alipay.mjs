/**
 * 支付宝当面付（扫码支付）服务端模块。
 *
 * 设计要点：
 *  - 应用私钥只存在于服务器（绝不进客户端），客户端只调用我们自己的中继接口；
 *  - 用 alipay.trade.precreate 预下单拿到 qr_code（客户端渲染成二维码）；
 *  - 回调不可靠/无公网回调域名时，用 alipay.trade.query **轮询**确认到账；
 *  - 充值成功后由中继给用户加余额（余额与订单落盘，重启不丢）。
 *
 * 私钥来源优先级：环境变量 ALIPAY_PRIVATE_KEY → 文件 ALIPAY_PRIVATE_KEY_FILE → data/alipay-key.pem。
 */
import { createSign } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'

const GATEWAY = 'https://openapi.alipay.com/gateway.do'

export function loadPrivateKey(root) {
  const inline = process.env.ALIPAY_PRIVATE_KEY
  if (inline) return normalise(inline)
  const file = process.env.ALIPAY_PRIVATE_KEY_FILE ?? path.join(root, 'data', 'alipay-key.pem')
  if (existsSync(file)) return normalise(readFileSync(file, 'utf8'))
  return undefined
}

/** 统一成 PEM；并做一次 ASN.1 长度裁剪，容忍粘贴时多出的空白/尾部字符。 */
function normalise(key) {
  const cleaned = String(key).replace(/\s+/g, '').replace(/-----[^-]+-----/g, '')
  let der
  try {
    der = Buffer.from(cleaned, 'base64')
  } catch {
    return key
  }
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

function timestamp() {
  const now = new Date(Date.now() + 8 * 3600 * 1000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`
}

export function signParams(params, privateKey) {
  const content = Object.keys(params)
    .filter((key) => key !== 'sign' && params[key] !== undefined && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&')
  return createSign('RSA-SHA256').update(content, 'utf8').sign(privateKey, 'base64')
}

export class Alipay {
  constructor({ appId, privateKey, logger = console }) {
    this.appId = appId
    this.privateKey = privateKey
    this.logger = logger
  }

  get configured() {
    return Boolean(this.appId && this.privateKey)
  }

  async call(method, bizContent) {
    if (!this.configured) throw new Error('支付宝未配置（缺少 AppID 或应用私钥）')
    const params = {
      app_id: this.appId,
      method,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: timestamp(),
      version: '1.0',
      biz_content: JSON.stringify(bizContent)
    }
    params.sign = signParams(params, this.privateKey)
    const response = await fetch(GATEWAY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams(params).toString()
    })
    const json = await response.json()
    const key = `${method.replace(/\./g, '_')}_response`
    return json[key] ?? json
  }

  /** 预下单：返回 { ok, qrCode, raw }。 */
  async precreate({ outTradeNo, amountFen, subject }) {
    const payload = await this.call('alipay.trade.precreate', {
      out_trade_no: outTradeNo,
      total_amount: (amountFen / 100).toFixed(2),
      subject
    })
    const ok = payload?.code === '10000' && Boolean(payload?.qr_code)
    if (!ok) this.logger.warn?.(`支付宝预下单失败: ${payload?.code} ${payload?.sub_msg ?? payload?.msg}`)
    return { ok, qrCode: payload?.qr_code, raw: payload }
  }

  /** 查询订单，用于轮询确认到账。 */
  async query(outTradeNo) {
    const payload = await this.call('alipay.trade.query', { out_trade_no: outTradeNo })
    const paid = payload?.trade_status === 'TRADE_SUCCESS' || payload?.trade_status === 'TRADE_FINISHED'
    return { paid, status: payload?.trade_status, raw: payload }
  }
}
