/**
 * 极简 WebSocket 实现（服务端侧，零依赖）。
 *
 * 只实现中继服务需要的部分：握手、文本帧、ping/pong、close、分片累积。
 * 不引入 `ws` 依赖，是因为部署到一台干净服务器时希望「拷贝即可运行」。
 */
import { createHash } from 'node:crypto'

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function acceptKey(key) {
  return createHash('sha1')
    .update(key + MAGIC)
    .digest('base64')
}

/** 把要发送的数据编码成服务端文本帧（不掩码）。 */
export function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const length = data.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, data])
}

export function encodeClose(code = 1000) {
  const body = Buffer.alloc(2)
  body.writeUInt16BE(code, 0)
  return encodeFrame(body, 0x8)
}

/**
 * 把 socket 收到的字节流切成帧。返回 {frames, rest}：
 * frames 是 [{opcode, payload}]，rest 是尚未完整到达的尾巴。
 */
export function decodeFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (cursor + 2 > buffer.length) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break
      length = Number(buffer.readBigUInt64BE(cursor))
      cursor += 8
    }
    let mask
    if (masked) {
      if (cursor + 4 > buffer.length) break
      mask = buffer.subarray(cursor, cursor + 4)
      cursor += 4
    }
    if (cursor + length > buffer.length) break
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length))
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
    }
    frames.push({ fin, opcode, payload })
    offset = cursor + length
  }
  return { frames, rest: buffer.subarray(offset) }
}
