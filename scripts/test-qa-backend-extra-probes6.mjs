/**
 * QA 探针 6：eapi /song/detail 核实 5 首 VIP 歌 canonical id + dt（用于矩阵硬编码）。
 */
import { createCipheriv, createHash } from 'node:crypto'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const aes128 = (data, key) => {
  const c = createCipheriv('aes-128-ecb', Buffer.from(key), null)
  return Buffer.concat([c.update(data), c.final()])
}
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
async function main() {
  const cands = [
    ['晴天', '周杰伦', 186016],
    ['告白气球', '周杰伦', 418603077],
    ['稻香', '周杰伦', 185809],
    ['孤勇者', '陈奕迅', 1901371647],
    ['光年之外', 'G.E.M.邓紫棋', 449818741]
  ]
  const ids = cands.map((c) => c[2]).join(',')
  const json = await eapi('/api/song/detail', { ids: `[${ids}]`, c: `[${cands.map(() => '{"id":0}').join(',')}]` })
  const songs = json?.songs ?? []
  for (const [name, artist, id] of cands) {
    const s = songs.find((x) => x?.id === id)
    console.log(name, artist, 'id=' + id, s ? `name=${s.name} ar=${(s.ar ?? []).map((a) => a.name).join('/')} dt=${s.dt} fee=${s.fee}` : 'NOT FOUND')
  }
  // 顺手确认 5 首免费歌 dt
  const freeIds = [3319040235, 2690863733, 1330348068, 1430583016, 1859480252]
  const json2 = await eapi('/api/song/detail', { ids: `[${freeIds.join(',')}]`, c: `[${freeIds.map(() => '{"id":0}').join(',')}]` })
  for (const s of json2?.songs ?? []) {
    console.log('FREE', s.id, s.name, (s.ar ?? []).map((a) => a.name).join('/'), 'dt=' + s.dt, 'fee=' + s.fee)
  }
}
main().catch((error) => {
  console.error('FAIL', error)
  process.exit(1)
})
