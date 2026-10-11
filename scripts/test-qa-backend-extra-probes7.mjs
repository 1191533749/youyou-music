/**
 * QA 探针 7：确定最终 10 首歌（5 免费 + 5 VIP）的真实 canonical id/dt，并验证匿名 song/url。
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
  const freeSongs = [
    ['芒种', '音阙诗听'],
    ['少年', '梦然'],
    ['起风了', '买辣椒也用券'],
    ['海底', '一只榴莲'],
    ['踏山河', '是七叔呢'],
    ['稻香', '周杰伦'],
    ['晴天', '周杰伦'],
    ['告白气球', '周杰伦']
  ]
  const found = []
  for (const [name, artist] of freeSongs) {
    const j = await eapi('/api/cloudsearch/pc', { s: `${name} ${artist}`, type: 1, limit: 30, offset: 0, total: true })
    const songs = j?.result?.songs ?? []
    const hit = songs.find((s) => normalize(s?.name ?? '') === normalize(name) && (s.ar ?? []).some((a) => normalize(a?.name ?? '').includes(normalize(artist))))
    console.log(`SEARCH ${name} ${artist}: hit=${hit ? `id=${hit.id} dt=${hit.dt} ar=${hit.ar.map((a) => a.name).join('/')}` : 'NONE'} (top3: ${songs.slice(0, 3).map((s) => `${s.name}/${s.ar?.[0]?.name}/${s.dt}`).join(' | ')})`)
    found.push({ name, artist, id: hit?.id, dt: hit?.dt })
    await wait(400)
  }
  // 对确定 id 的歌做匿名 song/url 验证
  const toCheck = found.filter((f) => f.id)
  for (const f of toCheck) {
    const j = await eapi('/api/song/enhance/player/url/v1', { ids: `[${f.id}]`, level: 'exhigh', encodeType: 'flac' })
    const d = j?.data?.[0]
    console.log(`URL ${f.name}: id=${f.id} dt=${f.dt} code=${j.code} dataCode=${d?.code} fee=${d?.fee} url=${d?.url ? 'YES' : 'none'}`)
    await wait(400)
  }
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exit(1)
})
