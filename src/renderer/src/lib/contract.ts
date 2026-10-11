/**
 * The runtime contract the feature pages rely on.
 *
 * These are the pieces the Lead froze before parallel work started: the IPC
 * client, the two stores, the shared formatters and the list/grid components.
 * A page should import from here rather than reaching into a sibling page's
 * internals, so page files stay independently replaceable.
 */

export { call, tryCall, onEvent, IPCError } from './ipc'
export {
  formatPlayCount,
  formatDuration,
  formatLongDuration,
  formatDate,
  formatBytes,
  coverUrl,
  artistLine,
  trackTitle,
  isPlayable
} from './format'
export { activeIndexOf, wordProgress, isEmptyLyrics } from './lyricsUtils'
export { useAsync, usePaged, useDebounced, type AsyncState } from './hooks'
export { usePlayerStore, useFailedTrackIds, useFailedExternalKeys, repeatLabel, type PlayerStore } from '../store/player'
export { useAuthStore, type AuthStore } from '../store/auth'
export { useNavigation, type Route, type NavigationStore } from '../store/navigation'
export { default as SongList, ArtCard } from '../components/SongList'
export type { SongListProps } from '../components/SongList'
export { default as Dialog } from '../components/Dialog'
export { default as ContextMenu, type ContextMenuItem } from '../components/ContextMenu'
export { useToast, type ToastKind } from '../components/Toast'
