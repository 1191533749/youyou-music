/**
 * 应用外壳：玻璃导航、内容区、玻璃播放条，以及背后的光斑背景。
 *
 * 视觉基调是液态玻璃（liquid glass）：整体压在一块柔和的彩色光斑之上，
 * 所有面板都是半透明玻璃片，靠 `backdrop-filter` 做真实模糊，而不是画一个灰色方块。
 * 亮色是主色，深色只是同一套令牌的另一种取值。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { NavigationProvider, useNavigation, type Route } from './store/navigation'
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
import Together from './pages/Together'
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
  IconGift,
  IconHome,
  IconLibrary,
  IconMaximize,
  IconMinimize,
  IconRadio,
  IconRestore,
  IconSearch,
  IconSettings,
  IconUser,
  LogoMark
} from './components/Icons'
import { call, onEvent } from './lib/ipc'
import { applyLyricFont } from './lib/fonts'
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
  { name: 'search', label: '搜索', Icon: IconSearch },
  { name: 'library', label: '我的音乐', Icon: IconLibrary },
  { name: 'daily', label: '每日推荐', Icon: IconCalendar },
  { name: 'fm', label: '私人漫游', Icon: IconRadio },
  { name: 'together', label: '一起听', Icon: IconGift },
  { name: 'cloud', label: '云盘', Icon: IconCloud }
] as const

/**
 * 顶部行：只在搜索页显示搜索框，其余页面不显示（用户明确反馈：
 * 每个页面顶部都挂一个搜索框是「多出来的」，只有搜索页需要它）。
 * 详情页的可返回时，这里只保留「返回」按钮。
 */
function TopSearch(): JSX.Element {
  const navigation = useNavigation()
  const [keywords, setKeywords] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const route = navigation.route
  const onSearchPage = route.name === 'search'
  const routeKeywords = route.name === 'search' ? route.keywords : undefined

  // 进到搜索页时把当前搜索词显示出来，否则看起来像是空的。
  useEffect(() => {
    if (routeKeywords !== undefined) setKeywords(routeKeywords)
  }, [routeKeywords])

  // 从侧边栏进来（没有关键词）时自动聚焦，用户可以直接输入。
  useEffect(() => {
    if (route.name === 'search' && route.keywords === undefined) {
      inputRef.current?.focus()
    }
  }, [route])

  const submit = (): void => {
    const trimmed = keywords.trim()
    if (!trimmed) return
    // 已经在搜索页就替换当前搜索（避免返回栈里堆一串搜索历史）。
    if (navigation.route.name === 'search') {
      navigation.replace({ name: 'search', keywords: trimmed })
      return
    }
    navigation.push({ name: 'search', keywords: trimmed })
  }

  if (!onSearchPage) {
    // 非搜索页：不显示搜索框；只在可返回时给「返回」按钮。
    if (!navigation.canGoBack) return <></>
    return (
      <div className="top-row">
        <button
          type="button"
          className="top-row__back"
          onClick={() => navigation.back()}
          aria-label="返回"
        >
          返回
        </button>
      </div>
    )
  }

  return (
    <div className="top-row">
      <button
        type="button"
        className={`top-row__back${navigation.canGoBack ? '' : ' is-hidden'}`}
        onClick={() => navigation.back()}
        aria-label="返回"
        disabled={!navigation.canGoBack}
      >
        返回
      </button>
      <div className="top-search">
        <IconSearch size={16} />
        <input
          ref={inputRef}
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
    </div>
  )
}

function Shell(): JSX.Element {
  const navigation = useNavigation()
  const auth = useAuthStore()
  const player = usePlayerStore()
  const [error, setError] = useState<string | undefined>()
  const [info, setInfo] = useState<AppInfoDTO | undefined>()

  /**
   * 滚动位置记忆：进入歌单/专辑后返回，要回到刚才浏览的位置，
   * 而不是从顶部重新滑动找歌单。键用路由本身（名称+id）拼出来。
   */
  const contentRef = useRef<HTMLElement>(null)
  const scrollPositions = useRef(new Map<string, number>())
  const routeKey = `${navigation.route.name}:${'id' in navigation.route ? navigation.route.id : ''}`
  const previousKey = useRef(routeKey)

  useEffect(() => {
    const element = contentRef.current
    if (!element) return
    // 路由变化：先存下旧页面的位置，再恢复新页面的位置。
    scrollPositions.current.set(previousKey.current, element.scrollTop)
    previousKey.current = routeKey
    element.scrollTop = scrollPositions.current.get(routeKey) ?? 0
  }, [routeKey])

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
      <div className="app-root">
        <TitleBar />
        <div className="app">
          {/* 品牌移到顶部标题栏；侧栏只保留导航与账号。 */}
          <aside className="sidebar">
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

        <main className="content" ref={contentRef}>
          {error ? (
            <div className="banner banner--error glass">
              <span>{error}</span>
              <button type="button" className="banner__close" onClick={() => setError(undefined)} aria-label="关闭">
                <IconClose size={16} />
              </button>
            </div>
          ) : null}
          {navigation.route.name !== 'settings' ? <TopSearch /> : null}
          <PageRouter authLoggedIn={auth.loggedIn} />
        </main>

        <PlayerBar />
        </div>
      </div>
    </>
  )
}

/** 顶部标题栏：无边框窗口自绘，品牌在左、窗口控制按钮在右，背景透明与整体统一。 */
function TitleBar(): JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void call('window:isMaximized').then(setMaximized).catch(() => undefined)
    return onEvent('window:maximized', (payload) => setMaximized(payload.maximized))
  }, [])

  return (
    <div className="titlebar">
      <div className="titlebar__brand">
        <LogoMark size={22} />
        <span className="titlebar__name">悠悠音乐</span>
      </div>
      <div className="titlebar__controls">
        <button type="button" className="titlebar__btn" aria-label="最小化" onClick={() => void call('window:minimize')}>
          <IconMinimize size={15} />
        </button>
        <button
          type="button"
          className="titlebar__btn"
          aria-label={maximized ? '还原' : '最大化'}
          onClick={() => void call('window:toggleMaximize').then(setMaximized)}
        >
          {maximized ? <IconRestore size={14} /> : <IconMaximize size={14} />}
        </button>
        <button type="button" className="titlebar__btn titlebar__btn--close" aria-label="关闭" onClick={() => void call('window:close')}>
          <IconClose size={15} />
        </button>
      </div>
    </div>
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

/**
 * 侧栏一级页面：切来切去**不重新挂载**，回到页面时内容与滚动位置都还在，
 * 不会出现「点一下先转圈、像重新加载了一遍」的感觉。
 *
 * 详情页（歌单/专辑/歌手/搜索/播放页）仍然按路由挂载，因为它们带参数、
 * 且数量不可控（常驻会越堆越多）。
 */
const KEEP_ALIVE_PAGES = [
  'home',
  'explore',
  'library',
  'daily',
  'fm',
  'together',
  'cloud',
  'settings'
] as const

type KeepAliveName = (typeof KEEP_ALIVE_PAGES)[number]

function isKeepAlive(name: string): name is KeepAliveName {
  return (KEEP_ALIVE_PAGES as readonly string[]).includes(name)
}

function renderKeepAlivePage(name: KeepAliveName, authLoggedIn: boolean): JSX.Element {
  switch (name) {
    case 'home':
      return <Home />
    case 'explore':
      return <Explore />
    case 'library':
      return authLoggedIn ? <Library /> : <Login />
    case 'daily':
      return <DailyPage />
    case 'fm':
      return <FM />
    case 'together':
      return <Together />
    case 'cloud':
      return authLoggedIn ? <Cloud /> : <Login />
    case 'settings':
      return <Settings />
  }
}

function PageRouter({ authLoggedIn }: { authLoggedIn: boolean }): JSX.Element {
  const { route } = useNavigation()
  // 已访问过的一级页面按顺序常驻（保持挂载，切回来直接看到原内容）。
  const visited = useRef<KeepAliveName[]>([])
  const active = isKeepAlive(route.name) ? route.name : undefined
  if (active && !visited.current.includes(active)) visited.current.push(active)

  return (
    <>
      {visited.current.map((name) => (
        <div key={name} className="page-slot" hidden={name !== active}>
          {renderKeepAlivePage(name, authLoggedIn)}
        </div>
      ))}

      {!active ? renderDetailPage(route, authLoggedIn) : null}
    </>
  )
}

/** 带参数的页面（详情页等）：按路由正常挂载/卸载。 */
function renderDetailPage(route: Route, authLoggedIn: boolean): JSX.Element {
  switch (route.name) {
    case 'search':
      return <Search initialKeywords={route.keywords} />
    case 'playlist':
      return <PlaylistPage id={route.id} />
    case 'album':
      return <AlbumPage id={route.id} />
    case 'artist':
      return <ArtistPage id={route.id} />
    case 'toplist':
      return <ToplistPage id={route.id} />
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
        applyLyricFont(settings.lyricFont)
      })
      .catch(() => apply())

    const off = onEvent('settings:changed', (settings) => {
      mode = settings.theme
      apply()
      applyLyricFont(settings.lyricFont)
    })
    media.addEventListener('change', apply)
    return () => {
      off()
      media.removeEventListener('change', apply)
    }
  }, [])
}
