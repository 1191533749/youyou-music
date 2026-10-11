/**
 * QA 后端压测辅助：音源解析细节排查（酷狗/QQ/汽水/酷我的搜索与换链原样回显）。
 * 只读网络调试，无副作用。
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

async function main() {
  // A: 酷狗搜索 孤勇者 陈奕迅
  const kg = await fetch(
    'http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=' +
      encodeURIComponent('孤勇者 陈奕迅') +
      '&page=1&pagesize=10',
    { signal: AbortSignal.timeout(12000) }
  )
  const kgj = await kg.json()
  console.log('KUGOU status', kg.status, 'info.len', kgj?.data?.info?.length)
  for (const it of (kgj?.data?.info ?? []).slice(0, 3)) {
    console.log('  kg:', it.songname, '/', it.singername, 'dur', it.duration, 'hash', it.hash)
  }

  // B: QQ 搜索 孤勇者
  const qq = await fetch(
    'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?w=' + encodeURIComponent('孤勇者 陈奕迅') + '&format=json&p=1&n=10&flag_qc=0',
    { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://y.qq.com/' }, signal: AbortSignal.timeout(12000) }
  )
  const qqj = await qq.json()
  const list = qqj?.data?.song?.list ?? []
  console.log('QQ status', qq.status, 'list.len', list.length)
  for (const s of list.slice(0, 3)) {
    console.log(
      '  qq:', s.songname, '/', (s.singer ?? []).map((x) => x.name).join('/'),
      'interval', s.interval, 'songmid', s.songmid, 'payplay', s.pay?.payplay, 'pay_play', s.pay?.pay_play
    )
  }

  // C: 汽水 孤勇者 gears
  const qs = await fetch(
    'https://api.qishui.com/luna/pc/search/all?q=' + encodeURIComponent('孤勇者 陈奕迅') + '&aid=386088&offset=0&limit=20',
    { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://music.douyin.com/' }, signal: AbortSignal.timeout(12000) }
  )
  const qsj = await qs.json()
  const g = qsj?.result_groups?.find((x) => x?.id === 'tracks') ?? qsj?.result_groups?.[0]
  const first = g?.data?.find((x) => x?.entity?.track?.name)?.entity?.track
  console.log('QISHUI status', qs.status, 'first track:', first?.name, '/', first?.artists?.map((a) => a.name).join('/'), 'id', first?.id, 'dur', first?.duration)
  if (first?.id) {
    const qd = await fetch(
      'https://beta-luna.douyin.com/luna/h5/seo_track?track_id=' + first.id + '&device_platform=web',
      { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://music.douyin.com/' }, signal: AbortSignal.timeout(12000) }
    )
    const qdj = await qd.json()
    const raw = qdj?.track_player?.video_model
    const model = typeof raw === 'string' ? JSON.parse(raw) : raw
    console.log('QISHUI gears:', (model?.video_list ?? []).map((v) => ({ br: v?.video_meta?.bitrate, size: v?.video_meta?.size, host: String(v?.main_url ?? v?.backup_url ?? '').slice(0, 45) })))
  }

  // D: 酷我两首歌的直链与长度对比
  for (const kw of ['孤勇者 陈奕迅', '光年之外 G.E.M.邓紫棋']) {
    const kr = await fetch(
      'https://search.kuwo.cn/r.s?&correct=1&vipver=1&stype=comprehensive&encoding=utf8&rformat=json&mobi=1&show_copyright_off=1&searchapi=6&all=' +
        encodeURIComponent(kw),
      { headers: { 'User-Agent': 'okhttp/3.10.0' }, signal: AbortSignal.timeout(12000) }
    )
    const txt = await kr.text()
    const kj = JSON.parse(txt.replace(/'/g, '"'))
    const songs = kj?.content?.[1]?.musicpage?.abslist ?? []
    const m = songs.find((s) => (s.SONGNAME ?? '').includes(kw.split(' ')[0]))
    if (!m) {
      console.log('KUWO no match for', kw)
      continue
    }
    const rid = String(m.MUSICRID).split('_').pop()
    const ar = await fetch('https://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid=MUSIC_' + rid, {
      headers: { 'User-Agent': 'okhttp/3.10.0' },
      signal: AbortSignal.timeout(12000)
    })
    const aurl = /http[^\s$"]+/.exec(await ar.text())?.[0]
    console.log('KUWO', kw, '->', aurl ? aurl.slice(0, 90) : 'no-url')
    if (aurl) {
      const hr = await fetch(aurl, { method: 'HEAD', signal: AbortSignal.timeout(12000) })
      console.log('  HEAD', hr.status, 'len', hr.headers.get('content-length'), 'type', hr.headers.get('content-type'), 'acceptRanges', hr.headers.get('accept-ranges'))
      const gr = await fetch(aurl, { headers: { Range: 'bytes=0-199999' }, signal: AbortSignal.timeout(12000) })
      const buf = Buffer.from(await gr.arrayBuffer())
      const title = buf.toString('latin1').match(/TIT2[\s\S]{0,100}/)
      console.log('  firstBytes', buf.slice(0, 10).toString('latin1'), 'status', gr.status, 'gotLen', buf.length, 'TIT2?', title?.[0]?.slice(0, 70))
    }
  }
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exit(1)
})
