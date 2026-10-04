/**
 * NetEase Cloud Music request encryption (weapi / eapi).
 *
 * Ported verbatim from `Sources/Kumone/Core/API/NeteaseCrypto.swift` of
 * missuo/kumone (LGPL-3.0). The keys, padding and encodings are byte-for-byte
 * the same, so requests produced here are indistinguishable from the macOS
 * client's.
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
const WEAPI_SECRET_KEY = 'kumone2026abcDEF'
const WEAPI_ENC_SEC_KEY =
  '38cef2efdbcc1cfd6a44d81620dae5d23091f50ef27e01a1b1bb7e998e0fde2d' +
  '7ab6002a9e79a3c195f661cbde80e21e6245997b11b54d28407115822f95d447' +
  '7cc06b5a77de46fab6568410abf1229abef81b4c8588f386149010d190bb0b04' +
  'f064be330bd877a4d4b99514febbdb4335b10744b13d9f7ee24d314d6e62cdc9'
const EAPI_KEY = 'e82ckenh8dichen8'

/**
 * AES-128 encryption with PKCS#7 padding. CBC when `iv` is supplied, ECB
 * otherwise — the same dispatch as the Swift `aes128(_:key:cbcIV:)` helper.
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

/** The eapi header block, matching the Swift client's values. */
export function eapiHeader(extra: Record<string, string> = {}): Record<string, string> {
  return {
    os: 'pc',
    appver: '3.1.17',
    osver: 'Version 14.0 (Build 23A344)',
    deviceId: 'kumone',
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
 * (`%20` for spaces, never `+`) to match the Swift `encodeForm` helper.
 */
export function encodeForm(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
}
