/**
 * 临时探针：把「网易云这条记录」和「各站外源搜到的候选」摆在一起看，
 * 用来判断换源未命中是「平台真没有」还是「我们的严格匹配把它拒了」。
 * 用法：node scripts/_probe-providers.mjs 康定情缘 郎的诱惑
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

async function tryJSON(label, url, headers = {}) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      signal: AbortSignal.timeout(20_000)
    })
    const text = await response.text()
    try {
      return { label, ok: response.ok, data: JSON.parse(text) }
    } catch {
      return { label, ok: response.ok, text: text.slice(0, 160) }
    }
  } catch (cause) {
    return { label, error: cause?.message ?? String(cause) }
  }
}

function normalize(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff]/g, '')
}

async function netease(keyword) {
  const result = await tryJSON(
    'netease',
    `https://music.163.com/api/search/get/web?s=${encodeURIComponent(keyword)}&type=1&limit=6&offset=0`,
    { Referer: 'https://music.163.com/' }
  )
  const songs = result.data?.result?.songs ?? []
  return songs.map((song) => ({
    name: song.name,
    artist: (song.artists ?? []).map((item) => item.name).join('/'),
    sec: Math.round((song.duration ?? 0) / 1000),
    fee: song.fee,
    id: song.id
  }))
}

async function kugou(keyword) {
  const result = await tryJSON(
    'kugou',
    `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(keyword)}&page=1&pagesize=10`
  )
  const info = result.data?.data?.info ?? []
  return info.map((item) => ({
    name: String(item.songname ?? ''),
    artist: String(item.singername ?? ''),
    sec: Number(item.duration ?? 0)
  }))
}

async function kuwo(keyword) {
  const result = await tryJSON(
    'kuwo',
    `https://search.kuwo.cn/r.s?&correct=1&vipver=1&stype=comprehensive&encoding=utf8&rformat=json&mobi=1&show_copyright_off=1&searchapi=6&all=${encodeURIComponent(keyword)}`
  )
  const content = result.data?.content ?? []
  const songs = content[1]?.musicpage?.abslist ?? []
  return songs.map((item) => ({
    name: String(item.SONGNAME ?? ''),
    artist: String(item.ARTIST ?? ''),
    sec: Number(item.DURATION ?? 0)
  }))
}

async function qishui(keyword) {
  const result = await tryJSON(
    'qishui',
    `https://api.qishui.com/luna/pc/search/all?q=${encodeURIComponent(keyword)}&aid=386088`,
    { Referer: 'https://music.douyin.com/' }
  )
  const groups = result.data?.result_groups ?? []
  const group = groups.find((item) => item?.id === 'tracks') ?? groups[0]
  const items = group?.data ?? []
  return items.slice(0, 6).map((item) => {
    const track = item?.entity?.track ?? item?.track ?? {}
    const duration = track.duration ?? track.duration_ms ?? track.plain_duration ?? 0
    const sec = duration > 10_000 ? Math.round(duration / 1000) : Math.round(duration)
    return {
      name: String(track.name ?? ''),
      artist: (track.artists ?? []).map((one) => one.name).join('/'),
      sec,
      id: track.id
    }
  })
}

const keywords = process.argv.slice(2)
if (keywords.length === 0) keywords.push('康定情缘 凤凰传奇')

for (const keyword of keywords) {
  console.log(`\n########## ${keyword}`)
  const reference = await netease(keyword)
  console.log('[网易云]', JSON.stringify(reference, null, 1))
  for (const provider of [kugou, kuwo, qishui]) {
    const rows = await provider(keyword).catch((cause) => [{ error: cause.message }])
    console.log(
      `[${provider.name}]`,
      rows.map((row) => `${row.name}|${row.artist}|${row.sec}s`).join('   ')
    )
  }
  // 把「网易云第一条」当作目标，逐条列出站外候选的匹配结论。
  const target = reference[0]
  if (target) {
    console.log(
      `  → 目标： name=${normalize(target.name)} artist=${normalize(target.artist.split('/')[0])} sec=${target.sec}`
    )
  }
}
