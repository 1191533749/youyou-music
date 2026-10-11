/**
 * QA 后端补充探针 5：QQ vkey 忠实复刻 prod（musicu.fcg + comm + media_mid filename），anon vs cookie。
 */
import fs from 'node:fs'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

async function fetchQqMediaMid(songmid) {
  const r = await fetch(
    'https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=' + encodeURIComponent(songmid) + '&platform=yqq&format=json',
    { headers: { Accept: 'application/json', Referer: 'https://y.qq.com/', 'User-Agent': UA }, signal: AbortSignal.timeout(12000) }
  )
  const j = await r.json()
  return j?.data?.[0]?.file?.media_mid
}

async function vkey(songmid, mediaMid, cookie) {
  const guid = String(Math.floor(1e9 + Math.random() * 9e9))
  const authed = Boolean(cookie)
  const uin = authed ? '1191533749' : '0'
  const param = { guid, songmid: [songmid], songtype: [0], uin, loginflag: 1, platform: '20' }
  if (mediaMid) param.filename = ['M500' + mediaMid + '.mp3']
  const data = {
    req_0: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param },
    comm: { uin: authed ? 1191533749 : 0, format: 'json', ct: 24, cv: 0 }
  }
  const headers = authed
    ? { Accept: 'application/json', Referer: 'https://y.qq.com/', 'User-Agent': UA, Cookie: cookie }
    : { Accept: 'application/json', Referer: 'https://y.qq.com/', 'User-Agent': UA }
  const r = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=' + encodeURIComponent(JSON.stringify(data)), {
    headers,
    signal: AbortSignal.timeout(12000)
  })
  const j = await r.json()
  const info = j?.req_0?.data?.midurlinfo?.[0]
  return { code: j?.code, retcode: j?.req_0?.code, purl: info?.purl ? 'YES(' + info.purl.slice(0, 50) + ')' : 'none', err: j?.req_0?.data?.err_msg ?? '' }
}

async function main() {
  const raw = fs.readFileSync(process.env.APPDATA + '\\youyou-music\\accounts.json', 'utf8')
  const acc = JSON.parse(raw)
  const qq = acc?.platforms?.find((p) => p?.platform === 'qq' || p?.name === 'qq')
  const cookie = typeof qq?.cookie === 'string' ? qq.cookie : Object.entries(qq?.cookie ?? {}).map(([k, v]) => `${k}=${v}`).join('; ')

  for (const q of ['踏山河 是七叔呢', '芒种 音阙诗听']) {
    const r = await fetch(
      'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?w=' + encodeURIComponent(q) + '&format=json&p=1&n=5&flag_qc=0',
      { headers: { Accept: 'application/json', Referer: 'https://y.qq.com/', 'User-Agent': UA }, signal: AbortSignal.timeout(12000) }
    )
    const rj = await r.json()
    const list = rj?.data?.song?.list ?? []
    const cand = list.find((s) => s.pay?.payplay !== 1) ?? list[0]
    const mid = cand?.songmid
    console.log('QQ', q, '->', cand?.songname, 'payplay=' + cand?.pay?.payplay, 'songmid=' + mid)
    const mediaMid = await fetchQqMediaMid(mid)
    console.log('  media_mid=', mediaMid)
    console.log('  anon  :', JSON.stringify(await vkey(mid, mediaMid, undefined)))
    console.log('  cookie:', JSON.stringify(await vkey(mid, mediaMid, cookie)))
  }
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exit(1)
})
