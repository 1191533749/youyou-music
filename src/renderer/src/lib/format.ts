/**
 * Shared presentational helpers.
 *
 * These are deliberately pure functions rather than components: every page
 * needs the same formatting, and a page should not have to import a component
 * just to render "3.2万".
 */
import type { TrackDTO } from '@shared/types'

const CN = true

export function formatPlayCount(count: number): string {
  if (CN) {
    if (count >= 100_000_000) return `${(count / 100_000_000).toFixed(1)}亿`
    if (count >= 10_000) return `${(count / 10_000).toFixed(1)}万`
    return String(count)
  }
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 10_000) return `${(count / 1_000).toFixed(1)}K`
  return String(count)
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function formatLongDuration(seconds: number): string {
  const total = Math.floor(seconds)
  if (total >= 3600) return `${Math.floor(total / 3600)} 小时 ${Math.floor((total % 3600) / 60)} 分钟`
  return `${Math.floor(total / 60)} 分钟`
}

export function formatDate(ms: number): string {
  if (!ms) return ''
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

/** NetEase image CDN resize convention: `<url>?param=<W>y<H>`. */
export function coverUrl(url: string | undefined, size: number): string | undefined {
  if (!url) return undefined
  const https = url.replace(/^http:\/\//, 'https://')
  return `${https}${https.includes('?') ? '&' : '?'}param=${size}y${size}`
}

export function artistLine(track: TrackDTO): string {
  return track.artists.map((artist) => artist.name).join(' / ')
}

export function trackTitle(track: TrackDTO): string {
  return track.transNames[0] ?? track.alias[0] ?? track.name
}

export function isPlayable(track: TrackDTO): boolean {
  return track.playability === 'playable'
}

/** A stable, human-readable key for list rendering when ids repeat. */
export function rowKey(track: TrackDTO, index: number): string {
  return `${track.id}-${index}`
}
