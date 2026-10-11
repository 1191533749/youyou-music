/**
 * 网易云音频 CDN 的镜像主机容错。
 *
 * 网易云的直链签名写在路径里、不绑主机，同一份音频在 `mN.music.126.net` 与
 * `mNc.music.126.net` 两台主机上都可取（实测同一路径两台都是 200，且
 * Content-Length 完全一致）。但有些网络里 `m801` 走的 `166cdn.com` 会解析
 * 超时，而 `m801c` 走的 `163jiasu.com` 正常——于是「恰好被放到 m801 上」的
 * 歌在这类网络上会一直卡在 0:00。上游 kumone 靠 `NeteaseCDNHost.swift`
 * 在这两台主机之间互换来救这些歌，这里是同一套做法的 Windows 版实现。
 *
 * 判定「不可达」的依据是起播时**一个字节都没拿到**（卡在 0:00 被换源），
 * 而不是解码/播放出错，避免把「文件本身有问题」误判成主机故障。
 */

const CDN_SUFFIX = '.music.126.net'

/** 主机被判定不可达后，多久内优先让位给镜像（毫秒）。 */
const UNREACHABLE_TTL_MS = 10 * 60_000

interface HostState {
  /** 最近一次判定不可达的时间戳。 */
  failedAt?: number
  /** 最近一次成功起播（拿到数据）的时间戳。 */
  answeredAt?: number
}

const hosts = new Map<string, HostState>()

function stateOf(host: string): HostState {
  let state = hosts.get(host)
  if (!state) {
    state = {}
    hosts.set(host, state)
  }
  return state
}

/** 主机名 → 镜像主机名；只认网易云音频 CDN 的 `m<数字>[c]` 主机。 */
function twinOf(host: string): string | undefined {
  if (!host.endsWith(CDN_SUFFIX)) return undefined
  const label = host.slice(0, -CDN_SUFFIX.length)
  const match = /^m(\d+)(c?)$/.exec(label)
  if (!match) return undefined
  return `m${match[1]}${match[2] ? '' : 'c'}${CDN_SUFFIX}`
}

function hostOf(url: string): string | undefined {
  const start = url.indexOf('://')
  if (start < 0) return undefined
  const from = start + 3
  const slash = url.indexOf('/', from)
  const authority = slash < 0 ? url.slice(from) : url.slice(from, slash)
  return authority.toLowerCase() || undefined
}

/** 只换主机名，其余（路径里的签名、查询串）原样保留。 */
function swapHost(url: string, host: string): string {
  const start = url.indexOf('://')
  if (start < 0) return url
  const from = start + 3
  const slash = url.indexOf('/', from)
  const rest = slash < 0 ? '' : url.slice(slash)
  return `${url.slice(0, from)}${host}${rest}`
}

function isStale(at: number | undefined, now: number): boolean {
  return at !== undefined && now - at < UNREACHABLE_TTL_MS
}

/** 这台主机的镜像地址；不是网易云音频 CDN 主机时返回 undefined。 */
export function alternateNeteaseCDN(url: string): string | undefined {
  const host = hostOf(url)
  if (!host) return undefined
  const twin = twinOf(host)
  return twin ? swapHost(url, twin) : undefined
}

/**
 * 解析出直链后、交给播放器之前调用：如果这台主机最近连不上、而它的镜像
 * 没被判定过故障，就换成镜像。签名不绑主机，换完仍然是同一份音频。
 */
export function preferredNeteaseCDN(url: string): string {
  const host = hostOf(url)
  if (!host) return url
  const twin = twinOf(host)
  if (!twin) return url
  const now = Date.now()
  const selfBad = isStale(hosts.get(host)?.failedAt, now)
  const twinBad = isStale(hosts.get(twin)?.failedAt, now)
  if (selfBad && !twinBad) return swapHost(url, twin)
  if (twinBad && !selfBad) return url
  if (selfBad && twinBad) {
    // 两台都出过问题：用较近成功过的那台。
    const selfOk = hosts.get(host)?.answeredAt ?? 0
    const twinOk = hosts.get(twin)?.answeredAt ?? 0
    return twinOk > selfOk ? swapHost(url, twin) : url
  }
  return url
}

/** 起播时一个字节都没拿到（卡 0:00）→ 判定这台主机不可达。 */
export function noteNeteaseCDNHostFailed(url: string): void {
  const host = hostOf(url)
  if (!host || !twinOf(host)) return
  stateOf(host).failedAt = Date.now()
}

/** 成功拿到数据 → 记下这台主机是好的，撤销之前的故障判定。 */
export function noteNeteaseCDNHostReachable(url: string): void {
  const host = hostOf(url)
  if (!host || !twinOf(host)) return
  const state = stateOf(host)
  state.answeredAt = Date.now()
  delete state.failedAt
}

/** 仅供测试：清空主机健康记录。 */
export function resetNeteaseCDNHosts(): void {
  hosts.clear()
}
