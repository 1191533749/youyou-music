/**
 * Navigation.
 *
 * A tiny history stack rather than a router dependency: this is a desktop app
 * with a handful of pages, and the back/forward behaviour a router would give
 * us is exactly what the stack implements.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

export type Route =
  | { name: 'home' }
  | { name: 'explore' }
  | { name: 'library' }
  | { name: 'search'; keywords?: string }
  | { name: 'playlist'; id: number; title?: string }
  | { name: 'album'; id: number; title?: string }
  | { name: 'artist'; id: number; title?: string }
  | { name: 'daily'; date?: string }
  | { name: 'fm' }
  | { name: 'together' }
  | { name: 'toplist'; id: number; title?: string }
  | { name: 'cloud' }
  | { name: 'settings' }
  | { name: 'nowPlaying'; openQueue?: boolean }

export interface NavigationStore {
  route: Route
  stack: Route[]
  push: (route: Route) => void
  replace: (route: Route) => void
  reset: (route: Route) => void
  back: () => void
  canGoBack: boolean
}

const NavigationContext = createContext<NavigationStore | undefined>(undefined)

export function NavigationProvider({ children }: { children: ReactNode }): JSX.Element {
  const [stack, setStack] = useState<Route[]>([{ name: 'home' }])

  const push = useCallback((route: Route) => {
    setStack((current) => [...current, route])
  }, [])

  const replace = useCallback((route: Route) => {
    setStack((current) => [...current.slice(0, -1), route])
  }, [])

  /**
   * 重置成单页栈：侧边栏一级页面之间切换用这个。
   * 这样「返回」只服务于「从内容页回到进入它的那个页面」，
   * 不会一层层退回之前的其它类目。
   */
  const reset = useCallback((route: Route) => {
    setStack([route])
  }, [])

  const back = useCallback(() => {
    setStack((current) => (current.length > 1 ? current.slice(0, -1) : current))
  }, [])

  const value = useMemo<NavigationStore>(
    () => ({
      route: stack[stack.length - 1],
      stack,
      push,
      replace,
      reset,
      back,
      canGoBack: stack.length > 1
    }),
    [stack, push, replace, reset, back]
  )

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>
}

export function useNavigation(): NavigationStore {
  const context = useContext(NavigationContext)
  if (!context) throw new Error('useNavigation 必须在 NavigationProvider 内使用')
  return context
}
