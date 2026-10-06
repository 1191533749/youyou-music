/**
 * NetEase Cloud Music request encryption (weapi / eapi).
 *
 * 加密参数、填充与编码与线上客户端保持一致，请求可被服务端正常解密；
 * 黄金值回归测试（tests/netease.test.ts）把编码结果钉死，防止后续重构改动报文格式。
 *
 *   weapi — two rounds of AES-128-CBC over the JSON payload, first with the
 *           preset key, then with the client's own secret key. The secret key
 *           is normally RSA-encrypted per request, but since we choose it we
 *           ship a fixed key with its RSA ciphertext precomputed, which avoids
 *           shipping a BigInt implementation.
 *   eapi  — AES-128-ECB over "url + md5 digest + payload" with a fixed key,
 *           hex encoded.
 */
import { createCipheriv, createHash } from 'node:crypto'

const WEAPI_PRESET_KEY = '0CoJUm6Qyw8W8jud'
const WEAPI_IV = '0102030405060708'
/**
 * 本项目自选的 weapi 客户端密钥，以及它用服务端公钥加密后的密文
 * （密文在构建期算好写死，省掉运行时的大整数运算）。
 */
const WEAPI_SECRET_KEY = 'youyou2026abcDEF'
const WEAPI_ENC_SEC_KEY =
  '1edd7503cb46eb11f8330241d58dd3676768f49ce849209eae7f230b6906fa52' +
  'c00c6b2ae72b14146d0296baa6ae0d79af459b815cb361ecf6b11e5af29754c4' +
  'b6215bf508316542414cb199447280e42aaee64fd4240d298711477b070681a6' +
  '9f1485a8c617efc39013d516ed5a5193cbf0ce69d5a0f06c6a2ee4b91fe40429'
const EAPI_KEY = 'e82ckenh8dichen8'

/**
 * AES-128 encryption with PKCS#7 padding. CBC when `iv` is supplied, ECB
 * otherwise — the same AES-128 dispatch.
 */
function aes128(data: Buffer, key: string, iv?: string): Buffer {
  const cipher = iv
    ? createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'))
    : createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

/** Encrypts a JSON payload for a `/weapi/...` endpoint and returns the form fields. */
export function weapi(payload: string | Buffer): Record<string, string> {
  const json = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  const first = aes128(json, WEAPI_PRESET_KEY, WEAPI_IV)
  const second = aes128(first, WEAPI_SECRET_KEY, WEAPI_IV).toString('base64')
  return { params: second, encSecKey: WEAPI_ENC_SEC_KEY }
}

/**
 * Encrypts a JSON payload for an `/eapi/...` endpoint.
 * @param apiPath the internal API path, e.g. `/api/song/enhance/player/url/v1`
 */
export function eapi(apiPath: string, payload: string | Buffer): Record<string, string> {
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload
  const message = `nobody${apiPath}use${text}md5forencrypt`
  const digest = createHash('md5').update(message, 'utf8').digest('hex')
  const data = `${apiPath}-36cd479b6b5-${text}-36cd479b6b5-${digest}`
  const encrypted = aes128(Buffer.from(data, 'utf8'), EAPI_KEY)
  return { params: encrypted.toString('hex').toUpperCase() }
}

/** The eapi header block, matching the values the service expects. */
export function eapiHeader(extra: Record<string, string> = {}): Record<string, string> {
  return {
    os: 'pc',
    appver: '3.1.17',
    osver: 'Version 14.0 (Build 23A344)',
    deviceId: 'youyou',
    requestId: String(Math.floor(20_000_000 + Math.random() * 10_000_000)),
    clientSign: '',
    versioncode: '140',
    buildver: String(Math.floor(Date.now() / 1000)),
    resolution: '1920x1080',
    channel: '',
    ...extra
  }
}

/**
 * `application/x-www-form-urlencoded` body. Uses RFC 3986 percent-encoding
 * (`%20` for spaces, never `+`) to match standard form encoding.
 */
export function encodeForm(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
}
