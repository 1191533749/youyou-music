/**
 * 搜索结果相关性判定。
 *
 * 起因：网易云的搜索接口极其「宽容」——实测连 36 位随机字符串都能返回结果，
 * 且会把关键词原样回显到每行的「歌手」字段（歌名各不相同、歌手=关键词），
 * 所以「返回了结果」不等于「搜到了这首歌」。如果只看条数或把歌手字段算命中，
 * 抖音热歌这种网易云没有的歌会让用户看到一屏风马牛不相及的结果，站外兜底永不触发。
 *
 * 规则（故意保守：宁可去站外兜底，也不拿模糊结果糊弄用户）：
 *  - 歌名 / 专辑：包含关键词，或关键词字符覆盖率 ≥ 60% → 相关
 *  - 歌手：包含关键词**且关键词 ≤ 12 个字符** → 相关（保留"搜歌手名"的场景；
 *    长串关键词出现在歌手字段一律视为网易云的回显，不算）
 */

/** 单条结果里参与比对的字段。 */
export interface RelevanceItem {
  name?: string
  artists?: string
  album?: string
}

const DEFAULT_SCAN_LIMIT = 10
/** 关键词字符覆盖率阈值：达到这个比例就认为沾边。 */
const COVERAGE_THRESHOLD = 0.6
/** 超过这个长度的关键词，歌手字段的命中不再算数（防回显）。 */
const ARTIST_HIT_MAX_LENGTH = 12

/** 归一化：去掉空白与常见标点、转小写、全角转半角，便于包含比较。 */
export function normalizeForMatch(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text
    .replace(/[\uff01-\uff5e]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[·・\-_—–()（）[\]【】{}<>《》「」『』,，.。!！?？:：;；'"“”‘’/\\|+*&^%$#@~`]/g, '')
}

/** 关键词里出现过的不重复字符。 */
function uniqueChars(text: string): string[] {
  return [...new Set([...text])]
}

/**
 * 网易云返回的这批结果，是否真的和关键词相关。
 *
 * - 关键词为空 → 相关（不做兜底，避免空搜索触发站外请求）
 * - 前 N 条里任一歌名/专辑包含关键词 → 相关
 * - 否则歌名/专辑字符覆盖率 ≥ 60% → 相关
 * - 关键词较短时，歌手包含关键词也算相关
 * - 都不满足 → 不相关（调用方应去站外音源兜底）
 */
export function isSearchRelevant(
  keyword: string,
  items: readonly RelevanceItem[] | undefined,
  scanLimit = DEFAULT_SCAN_LIMIT
): boolean {
  const normalizedKeyword = normalizeForMatch(keyword)
  if (normalizedKeyword.length === 0) return true
  if (!items || items.length === 0) return false

  const keywordChars = uniqueChars(normalizedKeyword)
  const artistHitAllowed = normalizedKeyword.length <= ARTIST_HIT_MAX_LENGTH

  for (const item of items.slice(0, scanLimit)) {
    // 歌名/专辑：包含命中，或覆盖率达标。
    const nameAlbum = normalizeForMatch(`${item?.name ?? ''}${item?.album ?? ''}`)
    if (nameAlbum.includes(normalizedKeyword)) return true
    if (nameAlbum.length > 0) {
      const hit = keywordChars.filter((char) => nameAlbum.includes(char)).length
      if (hit / keywordChars.length >= COVERAGE_THRESHOLD) return true
    }
    // 歌手：只有关键词较短时才认（长串一律视为网易云回显）。
    if (artistHitAllowed && normalizeForMatch(item?.artists ?? '').includes(normalizedKeyword)) return true
  }
  return false
}
