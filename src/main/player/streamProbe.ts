/**
 * 起播前的音源探测。
 *
 * 背景：灰色曲走第三方换源时，旧实现是「先把 mpv 静音、播放，再轮询 5 × 500ms 读
 * 时长」来判断拿到的是不是版权提示音占位文件。实测第三方流在这个窗口里往往连
 * 时长都还没解析出来（remote 流要等建连 + 缓冲），于是每次都白等满 2.5 秒，
 * 部分源还要再等 mpv 的 network-timeout 十几秒才出声 —— 用户感受就是
 * 「点了歌半天不出声」。
 *
 * 改成播放前先取一次前 96KB：
 *   1. 拿到总字节数就能当场判断提示音（占位文件通常几百 KB，真歌按 64kbps 下限
 *      估也远大于它）；
 *   2. 连不上/超时的源直接跳过，不再让用户干等 mpv 的超时与重连；
 *   3. 顺带把 DNS/TLS 与 CDN 边缘热起来，mpv 首包更快到。
 *
 * 探测拿不到总大小（分块传输）时不作判断，由调用方退回旧时长校验。
 */

const PROBE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

/** 探测只取前 96KB，够读到响应头与首包，又不会浪费带宽。 */
const PROBE_SAMPLE_BYTES = 96 * 1024

/** 首包至少要读到的字节数：太少说明这条流其实没在传数据。 */
const PROBE_MIN_BYTES = 16 * 1024

/**
 * 判断真歌的保守码率下限（字节/秒）：64kbps ≈ 8KB/s。
 * 低于「期望时长 × 该值」的流基本是十几秒的提示音占位文件。
 *
 * 实测校准（8 首周杰伦/林俊杰曲目，第三方源）：总字节数 / 期望时长
 * 全部恰好等于其声明的 320kbps（例如 319 秒 → 12,764,517 字节），
 * 离这条下限有 12 倍余量；而酷我给出的提示音占位文件只有 181,521 字节
 * （269 秒的歌 → 5.4kbps），一眼可辨。所以 64kbps 既不会误伤真歌，
 * 又能当场拦下提示音，不必再让用户等 2.5 秒的时长校验。
 */
const MIN_BYTES_PER_SECOND = 8_000

/** 短于这个时长的曲目不参与体积判定，避免误伤（与旧的时长校验一致）。 */
const NOTICE_MIN_EXPECTED_SECONDS = 120

export interface StreamProbeResult {
  /** 是否拿到了可播放的数据（HTTP 2xx 且首包非空）。 */
  ok: boolean
  status?: number
  /** 该流的完整字节数；源不支持 Range 且不报 content-length 时为 undefined。 */
  totalBytes?: number
  elapsedMS: number
  /** 失败原因（写日志用，不直接给用户看）。 */
  error?: string
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code
    const inner = (cause as { cause?: unknown }).cause
    const innerCode =
      inner instanceof Error ? ((inner as { code?: string }).code ?? undefined) : undefined
    const parts = [cause.message]
    if (code) parts.push(code)
    if (inner instanceof Error && inner.message !== cause.message) parts.push(inner.message)
    if (innerCode) parts.push(innerCode)
    return parts.join(' / ')
  }
  return String(cause)
}

function totalBytesOf(response: Response): number | undefined {
  const contentRange = response.headers.get('content-range')
  if (contentRange) {
    const match = /\/(\d+)\s*$/.exec(contentRange)
    if (match) {
      const value = Number(match[1])
      if (Number.isFinite(value) && value > 0) return value
    }
  }
  // 源忽略 Range 时回 200，此时的 content-length 就是完整大小。
  const contentLength = response.headers.get('content-length')
  if (contentLength && response.status === 200) {
    const value = Number(contentLength)
    if (Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

async function attemptProbe(
  url: string,
  withRange: boolean,
  timeoutMS: number,
  startedAt: number
): Promise<StreamProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMS)
  try {
    const headers: Record<string, string> = { 'User-Agent': PROBE_UA, Accept: '*/*' }
    if (withRange) headers.Range = `bytes=0-${PROBE_SAMPLE_BYTES - 1}`
    const response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' })
    if (!response.ok && response.status !== 206) {
      return {
        ok: false,
        status: response.status,
        elapsedMS: Date.now() - startedAt,
        error: `HTTP ${response.status}`
      }
    }
    const totalBytes = totalBytesOf(response)
    if (!response.body) {
      return { ok: true, status: response.status, totalBytes, elapsedMS: Date.now() - startedAt }
    }
    const reader = response.body.getReader()
    let received = 0
    try {
      while (received < PROBE_MIN_BYTES) {
        const { done, value } = await reader.read()
        if (done) break
        received += value?.byteLength ?? 0
      }
    } finally {
      void reader.cancel().catch(() => undefined)
    }
    const elapsedMS = Date.now() - startedAt
    if (received < PROBE_MIN_BYTES && totalBytes === undefined) {
      return { ok: false, status: response.status, elapsedMS, error: '首包为空' }
    }
    return { ok: true, status: response.status, totalBytes, elapsedMS }
  } catch (cause) {
    return { ok: false, elapsedMS: Date.now() - startedAt, error: describeCause(cause) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 探测一条远程音频流是否可用。
 *
 * 先带 `Range` 取前 96KB；只有底层错误/超时（服务端没答复）才会不带 Range 再试一次，
 * HTTP 层面的拒绝（403/404）直接算失败，省掉第二次往返。
 */
export async function probeStream(url: string, timeoutMS = 5_000): Promise<StreamProbeResult> {
  const startedAt = Date.now()
  const first = await attemptProbe(url, true, timeoutMS, startedAt)
  if (first.ok || first.status !== undefined) return first
  return attemptProbe(url, false, timeoutMS, startedAt)
}

/** 体积判定：明显小于「期望时长 × 64kbps」的流是版权提示音占位文件。 */
export function looksLikeNoticeBySize(
  totalBytes: number | undefined,
  expectedSeconds: number
): boolean {
  if (totalBytes === undefined || !Number.isFinite(totalBytes) || totalBytes <= 0) return false
  if (expectedSeconds < NOTICE_MIN_EXPECTED_SECONDS) return false
  return totalBytes < expectedSeconds * MIN_BYTES_PER_SECOND
}
