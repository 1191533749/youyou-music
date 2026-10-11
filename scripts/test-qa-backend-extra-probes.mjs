/**
 * QA 后端补充探针：酷我直链全量下载验时长、QQ cookie 有效性、酷狗免费歌成功路径、eapi 搜索解析排查。
 * 只读网络探测，无副作用。
 */
import fs from 'node:fs'
import { createCipheriv, createHash } from 'node:crypto'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

const aes128 = (data, key) => {
  const c = createCipheriv('aes-128-ecb', Buffer.from(key), null)
  return Buffer.concat([c.update(data), c.final()])
}

async function eapiSearch(q) {
  const header = {
    os: 'pc', appver: '3.1.17', osver: 'Version 14.0 (Build 23A344)', deviceId: 'youyou',
    requestId: String(Math.floor(2e7 + Math.random() * 1e7)), clientSign: '', versioncode: '140',
    buildver: String(Math.floor(Date.now() / 1000)), resolution: '1920x1080', channel: ''
  }
  const payload = { s: q, type: 1, limit: 5, offset: 0, total: true, header }
  const text = JSON.stringify(payload)
  const apiPath = '/api/cloudsearch/pc'
  const digest = createHash('md5').update('nobody' + apiPath + 'use' + text + 'md5forencrypt').digest('hex')
  const params = aes128(Buffer.from(apiPath + '-36cd479b6b5-' + text + '-36cd479b6b5-' + digest), 'e82ckenh8dichen8').toString('hex').toUpperCase()
  const r = await fetch('https://interface.music.163.com/eapi/cloudsearch/pc', {
    method: 'POST',
    headers: { 'User-Agent': UA, Referer: 'https://music.163.com', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'params=' + encodeURIComponent(params),
    signal: AbortSignal.timeout(15000)
  })
  return JSON.parse(await r.text())
}

async function main() {
  // 1) 酷我 4 首直链全量下载，检查真实时长/ID3
  for (const kw of ['孤勇者 陈奕迅', '演员 薛之谦', '光年之外 G.E.M.邓紫棋', '平凡之路 朴树']) {
    try {
      const kr = await fetch(
        'https://search.kuwo.cn/r.s?&correct=1&vipver=1&stype=comprehensive&encoding=utf8&rformat=json&mobi=1&show_copyright_off=1&searchapi=6&all=' + encodeURIComponent(kw),
        { headers: { 'User-Agent': 'okhttp/3.10.0' }, signal: AbortSignal.timeout(12000) }
      )
      const txt = await kr.text()
      let kj
      try { kj = JSON.parse(txt) } catch { kj = JSON.parse(txt.replace(/'/g, '"')) }
      const songs = kj?.content?.[1]?.musicpage?.abslist ?? []
      const m = songs.find((s) => (s.SONGNAME ?? '').includes(kw.split(' ')[0]))
      if (!m) { console.log('KUWO', kw, 'no match'); continue }
      const rid = String(m.MUSICRID).split('_').pop()
      const ar = await fetch('https://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid=MUSIC_' + rid, {
        headers: { 'User-Agent': 'okhttp/3.10.0' },
        signal: AbortSignal.timeout(12000)
      })
      const aurl = /http[^\s$"]+/.exec(await ar.text())?.[0]
      if (!aurl) { console.log('KUWO', kw, 'no url'); continue }
      const g = await fetch(aurl, { signal: AbortSignal.timeout(30000) })
      const buf = Buffer.from(await g.arrayBuffer())
      // 数 MPEG 帧算时长
      let frames = 0
      let i = 0
      let brTotal = 0
      while (i + 4 < buf.length && frames < 50000) {
        if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
          const v = (buf[i + 1] >> 3) & 3
          const l = (buf[i + 2] >> 1) & 3
          const bitrates = [
            [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
            [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
            [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
            [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]
          ]
          const srs = [[44100, 48000, 32000], [22050, 24000, 16000], [11025, 12000, 8000], [11025, 12000, 8000]]
          const br = bitrates[v][l]
          const sr = srs[v][(buf[i + 2] >> 2) & 3]
          if (!br || !sr) break
          frames++
          brTotal += br
          if (v === 3) { i += buf[i + 2] & 2 ? 4 : 2; continue }
          const pad = buf[i + 2] & 2 ? 1 : 0
          const fl = Math.floor((144000 * br) / sr) + pad
          if (fl < 4) break
          i += fl
        } else i++
      }
      const dur = frames > 0 ? (buf.length * 8) / (brTotal / frames) / 1000 : 0
      const id3 = buf.slice(0, 3).toString('latin1')
      const tags = [...new Set(buf.slice(0, 512).toString('latin1').match(/T[A-Z0-9]{3}/g) ?? [])]
      console.log('KUWO', kw, 'size=' + buf.length, 'id3=' + id3, 'frames=' + frames, 'estDur=' + dur.toFixed(1) + 's', 'tags=' + tags.join(','))
    } catch (e) {
      console.log('KUWO', kw, 'ERROR', String(e).slice(0, 120))
    }
  }

  // 2) QQ cookie 有效性：GetLoginUserInfo
  const raw = fs.readFileSync(process.env.APPDATA + '\\youyou-music\\accounts.json', 'utf8')
  const acc = JSON.parse(raw)
  const qq = acc?.platforms?.find((p) => p?.platform === 'qq' || p?.name === 'qq') ?? Object.values(acc ?? {}).find((v) => v && typeof v === 'object' && v.cookie)
  const qqCookie = qq?.cookie ?? ''
  const cookieHeader = typeof qqCookie === 'string' ? qqCookie : Object.entries(qqCookie ?? {}).map(([k, v]) => `${k}=${v}`).join('; ')
  console.log('QQ cookie keys:', cookieHeader.split('; ').map((s) => s.split('=')[0]).join(','))
  const reqData = JSON.stringify({
    comm: { ct: 24, cv: 4747474, uin: '1191533749', format: 'json' },
    req: { module: 'music.login.LoginServer', method: 'GetLoginUserInfo', param: {} }
  })
  const r = await fetch('https://u.y.qq.com/cgi-bin/musics.fcg?format=json&data=' + encodeURIComponent(reqData), {
    headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/', Cookie: cookieHeader },
    signal: AbortSignal.timeout(12000)
  })
  const rj = await r.json()
  console.log('QQ GetLoginUserInfo raw:', JSON.stringify(rj).slice(0, 400))

  // 3) 酷狗免费歌成功路径：芒种
  const ks = await fetch('http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=' + encodeURIComponent('芒种 音阙诗听') + '&page=1&pagesize=5', {
    signal: AbortSignal.timeout(12000)
  })
  const ksj = await ks.json()
  const first = ksj?.data?.info?.[0]
  console.log('KUGOU 芒种 first:', first?.songname, '/', first?.singername, 'dur', first?.duration, 'hash', first?.hash)
  if (first?.hash) {
    const d = await fetch('https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=' + first.hash, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(12000)
    })
    const dj = await d.json()
    console.log('KUGOU 芒种 getSongInfo status=' + dj?.status, 'urlLen=' + (Array.isArray(dj?.url) ? dj.url[0]?.length : String(dj?.url ?? '').length), 'bitRate=' + dj?.bitRate, 'err=' + (dj?.error ?? dj?.err))
  }

  // 4) eapi 搜索：晴天/告白气球/稻香/起风了 解析失败原因
  for (const q of ['晴天 周杰伦', '告白气球 周杰伦', '稻香 周杰伦', '起风了 买辣椒也用券']) {
    const json = await eapiSearch(q)
    const songs = json?.result?.songs ?? []
    console.log('EAPI search', q, '->', songs.map((s) => 'id=' + s.id + ' name=' + s.name + ' ar=' + (s.ar?.[0]?.name ?? '') + ' dt=' + s.dt).join(' | '))
    await new Promise((r2) => setTimeout(r2, 500))
  }
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exit(1)
})
