/**
 * 灰色歌曲换源的调度层。
 *
 * 换源解析的语义：
 * 按 pyncmd → 酷狗 → 酷我 的顺序尝试，跳过本次会话已经失败过的音源，
 * 并把「这次试过哪些」回传给调用方，避免同一首歌反复撞同一个死源。
 */
import {
  AUDIO_SOURCE_IDS,
  AUDIO_SOURCE_NAMES,
  PROVIDERS,
  type AudioSourceID,
  type ResolvedAudioSource
} from './providers.js'
import type { Track } from '../netease/models.js'

export interface UnblockResolution {
  source: ResolvedAudioSource | null
  /** 本次实际尝试过的音源，调用方累积起来用于去重。 */
  attempted: Set<AudioSourceID>
}

export interface UnblockServiceDeps {
  isEnabled: () => boolean
  enabledSources: () => AudioSourceID[]
  log?: (message: string) => void
}

export class UnblockService {
  constructor(private readonly deps: UnblockServiceDeps) {}

  get enabled(): boolean {
    return this.deps.isEnabled() && this.deps.enabledSources().length > 0
  }

  /** 按优先级尝试各音源；任何异常都只记日志，不向上抛。 */
  async resolve(track: Track, attempted: Set<AudioSourceID> = new Set()): Promise<UnblockResolution> {
    const attemptedNow = new Set<AudioSourceID>()
    if (!this.enabled) return { source: null, attempted: attemptedNow }

    const configured = new Set(this.deps.enabledSources())
    // 先按用户配置的顺序（默认 pyncmd → 酷狗 → 酷我），再按固定顺序兜底。
    const order = AUDIO_SOURCE_IDS.filter((id) => configured.has(id))

    for (const id of order) {
      if (attempted.has(id)) continue
      attemptedNow.add(id)
      try {
        const source = await PROVIDERS[id](track)
        if (source) {
          this.deps.log?.(`换源成功：${track.name} 来自 ${AUDIO_SOURCE_NAMES[id]}`)
          return { source, attempted: attemptedNow }
        }
        this.deps.log?.(`换源未命中：${track.name} 在 ${AUDIO_SOURCE_NAMES[id]} 没有匹配结果`)
      } catch (cause) {
        this.deps.log?.(`换源失败：${track.name} @ ${AUDIO_SOURCE_NAMES[id]} — ${describe(cause)}`)
      }
    }
    return { source: null, attempted: attemptedNow }
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export { AUDIO_SOURCE_IDS, AUDIO_SOURCE_NAMES }
export type { AudioSourceID, ResolvedAudioSource }
