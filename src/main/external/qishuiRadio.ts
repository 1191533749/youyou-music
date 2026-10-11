/**
 * 私人漫游的汽水曲池。
 *
 * 用户要求：私人漫游的歌**全部来自汽水音乐**、随机播放（网易云的漫游推荐不再使用）。
 * 汽水没有「个性推荐」接口可白嫖，所以这里用「随机关键词 × 搜索」造随机：
 * 每批抽几个不同风格/热度词去搜，合并去重后打乱，再剔除太短的（试听片段/串烧）。
 *
 * 只做发现层：播放仍然走 `resolveExternalAudio` → `resolveQishuiByID`（有 id 直取，
 * 不再搜索匹配），拿不到再按既有链路换源。
 */
import { searchQishui } from './search.js'
import { qishuiHasFullTrack } from '../unblock/providers.js'
import type { ExternalTrackDTO } from '@shared/types'

/**
 * 随机取词用的词库。
 *
 * 以**歌手名**为主：汽水搜索歌手出来的就是那个人的歌，听起来像电台；
 * 用「热歌」「抖音热歌」这类词搜出来的是一堆标题党合集（实测抽到过
 * 《抖音10亿播放量的热曲》这种），不像歌。风格词只留几个补充口味。
 */
const RADIO_KEYWORDS = [
  '周杰伦',
  '林俊杰',
  '薛之谦',
  '邓紫棋',
  '陈奕迅',
  '李荣浩',
  '毛不易',
  '汪苏泷',
  '许嵩',
  '张杰',
  '周深',
  '王菲',
  '五月天',
  'Beyond',
  '邓丽君',
  '陶喆',
  'Taylor Swift',
  'Ed Sheeran',
  'Maroon 5',
  'Adele',
  '古风',
  '纯音乐',
  '粤语',
  '日语',
  '说唱',
  '轻音乐',
  '摇滚',
  '钢琴'
]

/** 短于这个长度的一律不要：汽水搜索偶尔混进试听片段/铃声。 */
const MIN_DURATION_MS = 60_000
/** 去重表上限，超过就清空重新记，免得听得久了再也搜不到「新」歌。 */
const SEEN_LIMIT = 400

function shuffle<T>(list: T[]): T[] {
  const result = [...list]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    ;[result[index], result[swap]] = [result[swap], result[index]]
  }
  return result
}

/**
 * 取一批随机的汽水曲目。
 *
 * 每首歌都会先向汽水确认「有完整长度的档位」——付费曲只给 30 秒试听，
 * 让它们进队列的结果是漫游一路换源到酷狗/QQ（实测 3 首里只有 1 首真由汽水出声）。
 * 确认过的才返回；没通过的也记进 `seen`，不反复去问。
 *
 * @param count       想要多少首（不足就返回实际确认到的数量）
 * @param seen        跨批次去重表（调用方持有，长生命周期）
 * @param probeBudget 单次最多确认多少个候选（控制首屏等待；池子是在后台慢慢攒厚的）
 */
export async function qishuiRadio(
  count: number,
  seen: Set<string>,
  probeBudget = 30
): Promise<ExternalTrackDTO[]> {
  const keywords = shuffle(RADIO_KEYWORDS).slice(0, 4)
  const batches = await Promise.allSettled(
    keywords.map((keyword) => searchQishui(keyword, Math.max(count, 30)))
  )
  const merged: ExternalTrackDTO[] = []
  const queued = new Set<string>()
  for (const batch of batches) {
    if (batch.status !== 'fulfilled') continue
    for (const item of batch.value) {
      if (!item?.sourceId || !item?.name) continue
      if (!(item.durationMS >= MIN_DURATION_MS)) continue
      if (seen.has(item.sourceId) || queued.has(item.sourceId)) continue
      queued.add(item.sourceId)
      merged.push(item)
    }
  }

  const candidates = shuffle(merged)
  const picked: ExternalTrackDTO[] = []
  const markSeen = (sourceID: string): void => {
    if (seen.size >= SEEN_LIMIT) seen.clear()
    seen.add(sourceID)
  }
  const CHUNK = 8
  for (let index = 0; index < candidates.length && picked.length < count; index += CHUNK) {
    if (index >= probeBudget) break
    const slice = candidates.slice(index, index + CHUNK)
    const checks = await Promise.allSettled(
      slice.map((item) => qishuiHasFullTrack(item.sourceId, item.durationMS))
    )
    checks.forEach((check, offset) => {
      const item = slice[offset]
      markSeen(item.sourceId)
      if (check.status === 'fulfilled' && check.value && picked.length < count) picked.push(item)
    })
  }
  return picked
}
