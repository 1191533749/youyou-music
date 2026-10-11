/**
 * QA 后端补充探针 3：酷我占位文件逐帧计时长 + QQ 匿名 vkey 免费歌成功路径。
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

const MPEG1_L3 = [
  0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448
]
const MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]

async function main() {
  // 1) 酷我占位文件逐帧计时长
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
  let i = 0
  let frames = 0
  const seenBr = new Set()
  while (i + 4 <= buf.length) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const ver = (buf[i + 1] >> 3) & 3
      const layer = (buf[i + 1] >> 1) & 3
      if (layer !== 1) { i++; continue }
      const brIdx = buf[i + 2] >> 4
      const srIdx = (buf[i + 2] >> 2) & 3
      const table = ver === 3 ? MPEG1_L3 : MPEG2_L3
      const br = table[brIdx]
      const sr = ver === 3 ? [44100, 48000, 32000][srIdx] : [22050, 24000, 16000][srIdx]
      if (!br || !sr) { i++; continue }
      const pad = buf[i + 2] & 2 ? 1 : 0
      const fl = ver === 3 ? Math.floor((144000 * br) / sr) + pad : Math.floor((72000 * br) / sr) + pad
      if (fl < 4) { i++; continue }
      frames++
      seenBr.add(br)
      i += fl
    } else i++
  }
  console.log('KUWO 孤勇者 size=' + buf.length, 'frames=' + frames, 'dur=' + (frames * 0.0261).toFixed(1) + 's(按MPEG1)', 'bitrates=' + [...seenBr].join('/'))
  // 2) QQ 匿名 vkey：芒种/踏山河（先查 payplay）
  for (const q of ['芒种 音阙诗听', '踏山河 是七叔呢']) {
    const r = await fetch(
      'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?w=' + encodeURIComponent(q) + '&format=json&p=1&n=5&flag_qc=0',
      { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://y.qq.com/' }, signal: AbortSignal.timeout(12000) }
    )
    const rj = await r.json()
    const list = rj?.data?.song?.list ?? []
    const cand = list.find((s) => s.pay?.payplay !== 1) ?? list[0]
    console.log('QQ search', q, '->', list.slice(0, 3).map((s) => s.songname + '(' + s.pay?.payplay + ')').join(' | '))
    if (!cand) { console.log('  no candidate'); continue }
    const mid = cand.songmid
    const guid = String(Math.floor(Math.random() * 9e9) + 1e9)
    const data = JSON.stringify({
      req_0: {
        module: 'vkey.GetVkeyServer', method: 'CgiGetVkey',
        param: { guid, songmid: [mid], songtype: [0], uin: '0', loginflag: 1, platform: '20' }
      }
    })
    const v = await fetch('https://u.y.qq.com/cgi-bin/musics.fcg?format=json&data=' + encodeURIComponent(data), {
      headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/' },
      signal: AbortSignal.timeout(12000)
    })
    const vj = await v.json()
    const d0 = vj?.req_0?.data
    console.log('  vkey anon:', cand.songname, 'payplay=' + cand.pay?.payplay, 'code=' + vj?.code, 'subcode=' + d0?.subcode, 'purl=' + ((d0?.midurlinfo?.[0]?.purl ?? d0?.sip?.[0] ?? '') ? 'YES(' + d0.midurlinfo[0].purl.slice(0, 40) + ')' : 'none'), 'sip[0]=' + (d0?.sip?.[0] ?? '-'))
  }
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exit(1)
})
