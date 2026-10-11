/**
 * QA 后端补充探针 4：酷我免费歌是否也返回 4s 占位 + QQ vkey 带 cookie 复测。
 */
import fs from 'node:fs'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

async function main() {
  // 1) 酷我免费歌：踏山河 / 芒种
  for (const kw of ['踏山河 是七叔呢', '芒种 音阙诗听']) {
    const kr = await fetch(
      'https://search.kuwo.cn/r.s?&correct=1&vipver=1&stype=comprehensive&encoding=utf8&rformat=json&mobi=1&show_copyright_off=1&searchapi=6&all=' + encodeURIComponent(kw),
      { headers: { 'User-Agent': 'okhttp/3.10.0' }, signal: AbortSignal.timeout(12000) }
    )
    const kj = JSON.parse(await kr.text())
    const songs = kj?.content?.[1]?.musicpage?.abslist ?? []
    const m = songs.find((s) => (s.SONGNAME ?? '').includes(kw.split(' ')[0]))
    if (!m) { console.log('KUWO', kw, 'no match'); continue }
    console.log('KUWO', kw, 'first:', m.SONGNAME, 'rid', String(m.MUSICRID).split('_').pop(), 'payinfo', JSON.stringify(m.payInfo ?? m.pay ?? '').slice(0, 60))
    const rid = String(m.MUSICRID).split('_').pop()
    const ar = await fetch('https://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid=MUSIC_' + rid, {
      headers: { 'User-Agent': 'okhttp/3.10.0' },
      signal: AbortSignal.timeout(12000)
    })
    const aurl = /http[^\s$"]+/.exec(await ar.text())?.[0]
    if (!aurl) { console.log('  no url'); continue }
    const g = await fetch(aurl, { signal: AbortSignal.timeout(30000) })
    const buf = Buffer.from(await g.arrayBuffer())
    console.log('  size=' + buf.length, 'durEst=' + (buf.length / 181521 * 3.9).toFixed(1) + 's(若同码率结构)')
  }
  // 2) QQ vkey 带 cookie：踏山河
  const raw = fs.readFileSync(process.env.APPDATA + '\\youyou-music\\accounts.json', 'utf8')
  const acc = JSON.parse(raw)
  const qq = acc?.platforms?.find((p) => p?.platform === 'qq' || p?.name === 'qq')
  const qqCookie = typeof qq?.cookie === 'string' ? qq.cookie : Object.entries(qq?.cookie ?? {}).map(([k, v]) => `${k}=${v}`).join('; ')
  const r = await fetch(
    'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?w=' + encodeURIComponent('踏山河 是七叔呢') + '&format=json&p=1&n=5&flag_qc=0',
    { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://y.qq.com/' }, signal: AbortSignal.timeout(12000) }
  )
  const rj = await r.json()
  const list = rj?.data?.song?.list ?? []
  const cand = list.find((s) => s.pay?.payplay !== 1) ?? list[0]
  const guid = String(Math.floor(Math.random() * 9e9) + 1e9)
  const data = JSON.stringify({
    req_0: {
      module: 'vkey.GetVkeyServer', method: 'CgiGetVkey',
      param: { guid, songmid: [cand.songmid], songtype: [0], uin: '1191533749', loginflag: 1, platform: '20' }
    }
  })
  const v = await fetch('https://u.y.qq.com/cgi-bin/musics.fcg?format=json&data=' + encodeURIComponent(data), {
    headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/', Cookie: qqCookie },
    signal: AbortSignal.timeout(12000)
  })
  const vj = await v.json()
  const d0 = vj?.req_0?.data
  console.log('QQ vkey with cookie:', cand.songname, 'payplay=' + cand.pay?.payplay, 'code=' + vj?.code, 'subcode=' + d0?.subcode, 'purl=' + (d0?.midurlinfo?.[0]?.purl ? 'YES' : 'none'))
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exit(1)
})
