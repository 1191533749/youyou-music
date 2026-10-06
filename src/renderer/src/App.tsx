/**
 * 应用外壳：玻璃导航、内容区、玻璃播放条，以及背后的光斑背景。
 *
 * 视觉基调是液态玻璃（liquid glass）：整体压在一块柔和的彩色光斑之上，
 * 所有面板都是半透明玻璃片，靠 `backdrop-filter` 做真实模糊，而不是画一个灰色方块。
 * 亮色是主色，深色只是同一套令牌的另一种取值。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
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
import {
  IconCalendar,
  IconClose,
  IconCloud,
  IconCompass,
  IconHome,
  IconLibrary,
  IconRadio,
  IconSearch,
  IconSettings,
  IconUser,
  LogoMark
} from './components/Icons'
import { call, onEvent } from './lib/ipc'
import {
  checkForUpdateInteractive,
  dismissUpdatePrompt,
  installUpdateNow,
  snapshotUpdatePrompt,
  subscribeUpdatePrompt,
  type UpdatePromptState
} from './lib/updatePrompt'
import type { AppInfoDTO } from '@shared/types'

const NAV_ITEMS = [
  { name: 'home', label: '首页', Icon: IconHome },
  { name: 'explore', label: '发现', Icon: IconCompass },
  { name: 'library', label: '我的音乐', Icon: IconLibrary },
  // 搜索不再占侧边栏：每页顶部的搜索框直达搜索页，入口更顺手。
  { name: 'daily', label: '每日推荐', Icon: IconCalendar },
  { name: 'fm', label: '私人漫游', Icon: IconRadio },
  { name: 'cloud', label: '云盘', Icon: IconCloud }
] as const

/**
 * 顶部搜索条：每页可见，回车直达搜索页。
 * 放在内容区顶部并 sticky，滚动内容时依然可用。
 */
function TopSearch(): JSX.Element {
  const navigation = useNavigation()
  const [keywords, setKeywords] = useState('')

  const submit = (): void => {
    const trimmed = keywords.trim()
    if (!trimmed) return
    navigation.push({ name: 'search', keywords: trimmed })
  }

  return (
    <div className="top-search">
      <IconSearch size={16} />
      <input
        type="text"
        className="top-search__input"
        placeholder="搜索音乐、歌手、专辑、歌单"
        value={keywords}
        aria-label="搜索"
        onChange={(event) => setKeywords(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit()
        }}
      />
      {keywords ? (
        <button
          type="button"
          className="top-search__clear"
          aria-label="清空搜索词"
          onClick={() => setKeywords('')}
        >
          <IconClose size={14} />
        </button>
      ) : null}
    </div>
  )
}

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
  const updatePrompt = useUpdatePrompt()

  useEffect(() => {
    // 主进程推来的错误（mpv 缺失、播放被拒）用可关闭的横幅呈现，不弹模态框打断听歌。
    return onEvent('app:error', (payload) => setError(payload.message))
  }, [])

  if (auth.loading) {
    return (
      <>
        <Backdrop />
        <div className="boot">
          <LogoMark size={56} />
          <span>正在启动…</span>
        </div>
      </>
    )
  }

  return (
    <>
      <Backdrop />
      {updatePrompt}
      <div className="app">
        {/* 品牌行直接坐在渐变背景上（不套玻璃面板），
            导航与账号/设置收进下方玻璃卡片，视觉上「悠悠音乐」融进主背景。 */}
        <aside className="sidebar">
          <div className="sidebar__brand">
            <LogoMark size={38} />
            <div>
              <div className="sidebar__brand-name">悠悠音乐</div>
              <div className="sidebar__brand-sub">小鱼の音乐</div>
            </div>
          </div>

          <div className="sidebar__panel glass">
            <nav className="sidebar__nav">
              {NAV_ITEMS.map(({ name, label, Icon }) => (
                <button
                  key={name}
                  type="button"
                  className={`sidebar__link${navigation.route.name === name ? ' is-active' : ''}`}
                  onClick={() => navigation.push({ name } as never)}
                >
                  <Icon size={18} />
                  <span>{label}</span>
                </button>
              ))}
            </nav>

            <div className="sidebar__footer">
              <button
                type="button"
                className={`sidebar__link${navigation.route.name === 'settings' ? ' is-active' : ''}`}
                onClick={() => navigation.push({ name: 'settings' })}
              >
                <IconSettings size={18} />
                <span>设置</span>
              </button>
              {auth.loggedIn ? (
                <button
                  type="button"
                  className="sidebar__account"
                  onClick={() => navigation.push({ name: 'settings' })}
                >
                  {auth.profile?.avatarUrl ? (
                    <img src={auth.profile.avatarUrl} alt="" />
                  ) : (
                    <span className="sidebar__account-fallback">
                      <IconUser size={16} />
                    </span>
                  )}
                  <span className="sidebar__account-name">{auth.profile?.nickname ?? '已登录'}</span>
                </button>
              ) : null}
              {info ? <div className="sidebar__version">v{info.version}</div> : null}
            </div>
          </div>
        </aside>

        <main className="content">
          {error ? (
            <div className="banner banner--error glass">
              <span>{error}</span>
              <button type="button" className="banner__close" onClick={() => setError(undefined)} aria-label="关闭">
                <IconClose size={16} />
              </button>
            </div>
          ) : null}
          <TopSearch />
          <PageRouter authLoggedIn={auth.loggedIn} />
        </main>

        <PlayerBar />
      </div>
    </>
  )
}

/** 背景光斑：玻璃面板背后必须有东西可透，否则 blur 看起来只是灰色。 */
function Backdrop(): JSX.Element {
  return (
    <div className="backdrop" aria-hidden>
      <span className="backdrop__blob backdrop__blob--a" />
      <span className="backdrop__blob backdrop__blob--b" />
      <span className="backdrop__blob backdrop__blob--c" />
      <span className="backdrop__blob backdrop__blob--d" />
      <span className="backdrop__grain" />
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
      return <ToplistPage id={route.id} />
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
 * 更新弹窗（唯一实例）：状态来自共享模块 lib/updatePrompt，
 * 启动自动检测与设置页手动检测都会触发它；30 秒倒计时后自动更新。
 */
function UpdatePromptDialog({ update }: { update: UpdatePromptState }): JSX.Element {
  const [remaining, setRemaining] = useState(30)
  const installed = useRef(false)

  useEffect(() => {
    setRemaining(30)
    installed.current = false
  }, [update])

  useEffect(() => {
    if (remaining <= 0) return
    const timer = window.setTimeout(() => setRemaining((n) => n - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [update, remaining])

  useEffect(() => {
    if (remaining > 0 || installed.current) return
    installed.current = true
    void installUpdateNow()
  }, [remaining])

  return createPortal(
    <div className="update-prompt" role="dialog" aria-modal="true" aria-label="发现新版本">
      <div className="update-prompt__card glass">
        <div className="update-prompt__title">发现新版本 v{update.version}</div>
        {update.notes ? <div className="update-prompt__notes">{update.notes.slice(0, 320)}</div> : null}
        <div className="update-prompt__countdown">{remaining} 秒后自动更新</div>
        <div className="update-prompt__actions">
          <button type="button" className="button glass-btn" onClick={dismissUpdatePrompt}>
            稍后更新
          </button>
          <button type="button" className="button button--primary glass-btn" onClick={() => void installUpdateNow()}>
            立即更新
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function useUpdatePrompt(): JSX.Element | null {
  const update = useSyncExternalStore(subscribeUpdatePrompt, snapshotUpdatePrompt)

  // 启动时静默检测一次：有新版本才弹窗，没有就不打扰。
  useEffect(() => {
    void checkForUpdateInteractive()
  }, [])

  if (!update) return null
  return <UpdatePromptDialog update={update} />
}

/**
 * 应用主题并在「跟随系统」时持续跟随。放在这里而不是每个页面里，
 * 切换主题才能立刻作用于已挂载与未挂载的页面。
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
