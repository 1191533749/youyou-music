/**
 * QA 探针 8：批量找 4 首「搜索可解析 + 匿名 song/url 有地址」的干净免费歌。
 */
import { createCipheriv, createHash } from 'node:crypto'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const aes128 = (data, key) => {
  const c = createCipheriv('aes-128-ecb', Buffer.from(key), null)
  return Buffer.concat([c.update(data), c.final()])
}
const normalize = (v) =>
  String(v).normalize('NFKC').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff]/g, '')
async function eapi(path, payload) {
  const header = {
    os: 'pc', appver: '3.1.17', osver: 'Version 14.0 (Build 23A344)', deviceId: 'youyou',
    requestId: String(Math.floor(2e7 + Math.random() * 1e7)), clientSign: '', versioncode: '140',
    buildver: String(Math.floor(Date.now() / 1000)), resolution: '1920x1080', channel: ''
  }
  const full = { ...payload, header }
  const text = JSON.stringify(full)
  const digest = createHash('md5').update(`nobody${path}use${text}md5forencrypt`).digest('hex')
  const params = aes128(Buffer.from(`${path}-36cd479b6b5-${text}-36cd479b6b5-${digest}`), 'e82ckenh8dichen8').toString('hex').toUpperCase()
  const r = await fetch('https://interface.music.163.com/eapi' + path, {
    method: 'POST',
    headers: { 'User-Agent': UA, Referer: 'https://music.163.com', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'params=' + encodeURIComponent(params),
    signal: AbortSignal.timeout(15000)
  })
  return JSON.parse(await r.text())
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const cands = [
    ['两只蝴蝶', '庞龙'], ['狼爱上羊', '汤潮'], ['你到底爱谁', '刘嘉亮'], ['秋天不回来', '王强'],
    ['等一分钟', '徐誉滕'], ['犯错', '斯琴高丽'], ['被伤过的心还可以爱谁', '六哲'], ['包容', '郑源']
  ]
  for (const [name, artist] of cands) {
    try {
      const j = await eapi('/api/cloudsearch/pc', { s: `${name} ${artist}`, type: 1, limit: 5, offset: 0, total: true })
      const songs = j?.result?.songs ?? []
      const hit = songs.find((s) => normalize(s?.name ?? '') === normalize(name) && (s.ar ?? []).some((a) => normalize(a?.name ?? '').includes(normalize(artist))))
      if (!hit) { console.log(`${name} ${artist}: 无严格命中 (top: ${songs.slice(0, 2).map((s) => `${s.name}/${s.ar?.[0]?.name}`).join(' | ')})`); continue }
      const u = await eapi('/api/song/enhance/player/url/v1', { ids: `[${hit.id}]`, level: 'exhigh', encodeType: 'flac' })
      const d = u?.data?.[0]
      console.log(`${name} ${artist}: id=${hit.id} dt=${hit.dt} fee=${d?.fee} dataCode=${d?.code} url=${d?.url ? 'YES' : 'none'}`)
    } catch (e) {
      console.log(`${name} ${artist}: ERROR ${String(e).slice(0, 80)}`)
    }
    await wait(400)
  }
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exit(1)
})
