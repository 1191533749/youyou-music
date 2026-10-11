/**
 * QA 后端补充探针 2：酷我试听文件首帧解析 + 酷狗更多免费歌路径验证。
 * 只读网络探测，无副作用。
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

async function main() {
  // 1) 酷我试听文件首帧解析（孤勇者）
  const kr = await fetch(
    'https://search.kuwo.cn/r.s?&correct=1&vipver=1&stype=comprehensive&encoding=utf8&rformat=json&mobi=1&show_copyright_off=1&searchapi=6&all=' + encodeURIComponent('孤勇者 陈奕迅'),
    { headers: { 'User-Agent': 'okhttp/3.10.0' }, signal: AbortSignal.timeout(12000) }
  )
  const kj = JSON.parse(await kr.text())
  const m = (kj?.content?.[1]?.musicpage?.abslist ?? []).find((s) => (s.SONGNAME ?? '').includes('孤勇者'))
  const rid = String(m.MUSICRID).split('_').pop()
  const ar = await fetch('https://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid=MUSIC_' + rid, {
    headers: { 'User-Agent': 'okhttp/3.10.0' },
    signal: AbortSignal.timeout(12000)
  })
  const aurl = /http[^\s$"]+/.exec(await ar.text())?.[0]
  const g = await fetch(aurl, { signal: AbortSignal.timeout(30000) })
  const buf = Buffer.from(await g.arrayBuffer())
  console.log('KUWO 孤勇者 first 16 bytes:', buf.slice(0, 16).toString('hex'))
  const b1 = buf[1]
  const b2 = buf[2]
  const ver = (b1 >> 3) & 3
  const layer = (b1 >> 1) & 3
  const brIdx = b2 >> 4
  const bitrates = [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
  ]
  const srs = [44100, 48000, 32000]
  const br = bitrates[layer === 3 ? 0 : layer - 1]?.[brIdx]
  const sr = srs[((b2 >> 2) & 3)] * (ver === 2 ? 0.5 : ver === 0 ? 0.25 : 1)
  console.log('ver=' + ver, 'layer=' + layer, 'brIdx=' + brIdx, '-> br=' + br + 'kbps sr=' + sr, 'estDur=' + (buf.length * 8 / (br * 1000)).toFixed(1) + 's', 'size=' + buf.length)
  // 2) 酷狗更多歌
  for (const q of ['漠河舞厅 柳爽', '踏山河 是七叔呢', '飞鸟和蝉 任然']) {
    const ks = await fetch('http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=' + encodeURIComponent(q) + '&page=1&pagesize=5', {
      signal: AbortSignal.timeout(12000)
    })
    const ksj = await ks.json()
    const f = ksj?.data?.info?.[0]
    if (!f) { console.log('KUGOU', q, 'no result'); continue }
    const d = await fetch('https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=' + f.hash, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(12000)
    })
    const dj = await d.json()
    console.log('KUGOU', q, '->', f.songname + '/' + f.singername, 'dur=' + f.duration, 'status=' + dj?.status, 'urlLen=' + (Array.isArray(dj?.url) ? dj.url[0]?.length : String(dj?.url ?? '').length), 'err=' + (dj?.error ?? dj?.err))
  }
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exit(1)
})
