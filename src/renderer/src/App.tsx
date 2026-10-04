/**
 * The application shell: sidebar, page area, player bar.
 *
 * Pages are resolved from the navigation stack; a page that a teammate owns but
 * that is not implemented yet renders `PagePlaceholder` rather than crashing,
 * so the shell stays runnable while the feature set fills in.
 */
import { useEffect, useState } from 'react'
import { NavigationProvider, useNavigation } from './store/navigation'
import { useAuthStore } from './store/auth'
import { usePlayerStore } from './store/player'
import PlayerBar from './components/PlayerBar'
import { AppToastStack } from './components/Toast'
import Login from './pages/Login'
import Home from './pages/Home'
import Explore from './pages/Explore'
import Search from './pages/Search'
import Library from './pages/Library'
import PlaylistPage from './pages/PlaylistPage'
import AlbumPage from './pages/AlbumPage'
import ArtistPage from './pages/ArtistPage'
import DailyPage from './pages/DailyPage'
import FM from './pages/FM'
import ToplistPage from './pages/ToplistPage'
import Cloud from './pages/Cloud'
import Settings from './pages/Settings'
import NowPlaying from './pages/NowPlaying'
import { call, onEvent } from './lib/ipc'
import type { AppInfoDTO } from '@shared/types'

const NAV_ITEMS = [
  { route: { name: 'home' } as const, label: '首页', icon: '🏠' },
  { route: { name: 'explore' } as const, label: '发现', icon: '🧭' },
  { route: { name: 'library' } as const, label: '我的音乐', icon: '📚' },
  { route: { name: 'search' } as const, label: '搜索', icon: '🔍' },
  { route: { name: 'daily' } as const, label: '每日推荐', icon: '📅' },
  { route: { name: 'fm' } as const, label: '私人 FM', icon: '📻' },
  { route: { name: 'cloud' } as const, label: '云盘', icon: '☁️' }
]

function Shell(): JSX.Element {
  const navigation = useNavigation()
  const auth = useAuthStore()
  const player = usePlayerStore()
  const [error, setError] = useState<string | undefined>()
  const [info, setInfo] = useState<AppInfoDTO | undefined>()

  useEffect(() => {
    void call('app:info').then(setInfo).catch(() => undefined)
  }, [])

  useThemeSync()

  useEffect(() => {
    // Errors pushed from the main process (mpv missing, playback refused) are
    // surfaced as a dismissible banner instead of a modal.
    return window.kumone.on('app:error', (payload: { message: string }) => setError(payload.message))
  }, [])

  if (auth.loading) {
    return <div className="boot">正在启动…</div>
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <span className="sidebar__brand-mark">雲</span>
          <div>
            <div className="sidebar__brand-name">Kumone</div>
            <div className="sidebar__brand-sub">雲の音 · Windows</div>
          </div>
        </div>

        <nav className="sidebar__nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.label}
              type="button"
              className={`sidebar__link${navigation.route.name === item.route.name ? ' is-active' : ''}`}
              onClick={() => navigation.push(item.route)}
            >
              <span className="sidebar__icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar__footer">
          <button
            type="button"
            className={`sidebar__link${navigation.route.name === 'settings' ? ' is-active' : ''}`}
            onClick={() => navigation.push({ name: 'settings' })}
          >
            <span className="sidebar__icon">⚙️</span>
            设置
          </button>
          {auth.loggedIn ? (
            <button type="button" className="sidebar__account" onClick={() => navigation.push({ name: 'settings' })}>
              {auth.profile?.avatarUrl ? (
                <img src={auth.profile.avatarUrl} alt="" />
              ) : (
                <span className="sidebar__account-fallback">👤</span>
              )}
              <span className="sidebar__account-name">{auth.profile?.nickname ?? '已登录'}</span>
            </button>
          ) : null}
          {info ? <div className="sidebar__version">v{info.version}</div> : null}
        </div>
      </aside>

      <main className="content">
        {error ? (
          <div className="banner banner--error">
            <span>{error}</span>
            <button type="button" className="banner__close" onClick={() => setError(undefined)}>
              ✕
            </button>
          </div>
        ) : null}
        <PageRouter authLoggedIn={auth.loggedIn} />
      </main>

      <PlayerBar />
    </div>
  )
}

function PageRouter({ authLoggedIn }: { authLoggedIn: boolean }): JSX.Element {
  const { route } = useNavigation()
  switch (route.name) {
    case 'home':
      return <Home />
    case 'explore':
      return <Explore />
    case 'search':
      return <Search initialKeywords={route.keywords} />
    case 'library':
      return authLoggedIn ? <Library /> : <Login />
    case 'playlist':
      return <PlaylistPage id={route.id} />
    case 'album':
      return <AlbumPage id={route.id} />
    case 'artist':
      return <ArtistPage id={route.id} />
    case 'daily':
      return authLoggedIn ? <DailyPage /> : <Login />
    case 'fm':
      return <FM />
    case 'toplist':
      return <PlaylistPage id={route.id} />
    case 'cloud':
      return authLoggedIn ? <Cloud /> : <Login />
    case 'settings':
      return <Settings />
    case 'nowPlaying':
      return <NowPlaying />
    default:
      return <Home />
  }
}

export default function App(): JSX.Element {
  return (
    <NavigationProvider>
      <Shell />
      {/* 应用级提示层：页面在提示消失前被切走时，提示仍然可见。 */}
      <AppToastStack />
    </NavigationProvider>
  )
}

/**
 * Applies the stored theme and keeps following the OS while the setting is
 * "system". Done here rather than per page so switching is instant everywhere,
 * including pages that are not mounted yet.
 */
function useThemeSync(): void {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    let mode: 'system' | 'light' | 'dark' = 'system'

    const apply = (): void => {
      const resolved = mode === 'system' ? (media.matches ? 'dark' : 'light') : mode
      document.documentElement.dataset.theme = resolved
    }

    void call('settings:get')
      .then((settings) => {
        mode = settings.theme
        apply()
      })
      .catch(() => apply())

    const off = onEvent('settings:changed', (settings) => {
      mode = settings.theme
      apply()
    })
    media.addEventListener('change', apply)
    return () => {
      off()
      media.removeEventListener('change', apply)
    }
  }, [])
}
