/**
 * 本地预览服务（带 Range 支持，视频/音频才能正常流式播放）。
 * 只用于预览 website/：node scripts/preview-site.mjs（默认 http://127.0.0.1:8088）
 */
import { createReadStream, stat } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'

const ROOT = join(process.cwd(), 'website')
const PORT = Number(process.env.PORT ?? 8088)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4'
}

createServer((request, response) => {
  const raw = decodeURIComponent((request.url ?? '/').split('?')[0])
  const file = normalize(join(ROOT, raw === '/' ? '/index.html' : raw))
  if (!file.startsWith(ROOT)) {
    response.writeHead(403).end('forbidden')
    return
  }
  stat(file, (error, info) => {
    if (error || !info.isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found')
      return
    }
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
    const range = request.headers.range
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range)
      const start = match && match[1] ? Number(match[1]) : 0
      const end = match && match[2] ? Number(match[2]) : info.size - 1
      response.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${info.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache'
      })
      createReadStream(file, { start, end }).pipe(response)
      return
    }
    response.writeHead(200, {
      'Content-Type': type,
      'Content-Length': info.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache'
    })
    createReadStream(file).pipe(response)
  })
}).listen(PORT, '127.0.0.1', () => {
  console.log(`preview ready: http://127.0.0.1:${PORT}`)
})
