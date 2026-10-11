/**
 * 站外曲目登记表。
 *
 * 站外曲目入队时用的是「合成曲目」：id 是 `${source}:${sourceId}` 的稳定负哈希，
 * 而哈希不可逆。私人漫游这类流程是「主进程先出一批 DTO → 渲染层把**同一批** DTO
 * 回传过来播放」，回传时就只剩负 id 了——这里按负 id 记一份原样曲目，播放端
 * （`player:playFMTracks` / `player:append`）据此认出它们必须走站外队列。
 */
import { toSyntheticTrack, externalTrackID } from './search.js'
import type { ExternalTrackDTO } from '@shared/types'

const byID = new Map<number, ExternalTrackDTO>()
/** 只当缓存用：超过这个规模就按插入顺序丢掉最早的。 */
const LIMIT = 600

export function rememberExternal(item: ExternalTrackDTO): number {
  const trackID = externalTrackID(item)
  byID.set(trackID, item)
  if (byID.size > LIMIT) {
    const oldest = byID.keys().next().value
    if (oldest !== undefined) byID.delete(oldest)
  }
  return trackID
}

export function recallExternal(trackID: number): ExternalTrackDTO | undefined {
  return byID.get(trackID)
}

/** 批量登记并返回等长的合成曲目（id 与登记键一致）。 */
export function rememberExternalTracks(items: ExternalTrackDTO[]): ReturnType<typeof toSyntheticTrack>[] {
  return items.map((item) => {
    rememberExternal(item)
    return toSyntheticTrack(item)
  })
}
