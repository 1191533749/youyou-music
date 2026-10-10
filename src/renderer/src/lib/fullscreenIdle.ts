/**
 * 真全屏「鼠标空闲就收控件」。
 *
 * 只处理系统级真全屏（F11 / 播放页的「真全屏」按钮，任务栏也被盖住的那种），
 * 不掺和 app 内的全屏播放页。做法是在 `<html>` 上挂 `fullscreen-idle` 类，
 * 由 CSS 负责顶栏 / 底部控制条 / 全局播放条的淡出与禁用点击（detail.css）。
 *
 * 全屏状态来源：主进程广播的 `window:fullscreen`（payload `{ fullscreen: boolean }`）。
 * 订阅仍然包在 try/catch 里 —— 万一事件名还没登记进 preload 白名单
 * （`src/preload/index.ts:39` 对未登记事件直接返回空操作），就按 false 处理，
 * 再由下面的窗口尺寸兜底判断，功能不会因为事件缺失而整体失效。
 */
import { useEffect } from 'react'

/** 挂到 <html> 上的类名，CSS 约定见 styles/detail.css。 */
export const IDLE_CLASS = 'fullscreen-idle'
/** 鼠标停多久算空闲。 */
const IDLE_DELAY_MS = 3000
/** mousemove 节流：够跟手，又不会每像素都清一次定时器。 */
const MOVE_THROTTLE_MS = 120
/** 焦点还留在控件上时不隐藏，否则键盘用户会对着看不见的按钮操作。 */
const CONTROL_SELECTOR = '.np-fs__bar, .np-fs__dock, .player-bar'

interface FullscreenEvent {
  fullscreen?: boolean
}

/** 未登记的通道会返回空哨兵，所以这里按「可能不存在」的方式取桥接。 */
function subscribeFullscreen(listener: (fullscreen: boolean) => void): (() => void) | undefined {
  try {
    const bridge = window.youyou as unknown as {
      on?: (event: string, handler: (payload: unknown) => void) => unknown
    }
    const dispose = bridge?.on?.('window:fullscreen', (payload) => {
      listener(Boolean((payload as FullscreenEvent | undefined)?.fullscreen))
    })
    return typeof dispose === 'function' ? (dispose as () => void) : undefined
  } catch {
    // 桥接还没就绪：当作没有事件，靠下面的尺寸兜底。
    return undefined
  }
}

export function useFullscreenIdle(): void {
  useEffect(() => {
    const root = document.documentElement
    let fullscreen = false
    let receivedEvent = false
    let timer: number | undefined

    const clearTimer = (): void => {
      if (timer === undefined) return
      window.clearTimeout(timer)
      timer = undefined
    }

    const focusInControls = (): boolean => {
      const active = document.activeElement
      return active instanceof HTMLElement && active !== document.body && active.closest(CONTROL_SELECTOR) !== null
    }

    const hide = (): void => {
      timer = undefined
      // 用户正把焦点放在控件里（例如键盘调音量）：先不藏，下个周期再说。
      if (focusInControls()) {
        timer = window.setTimeout(hide, IDLE_DELAY_MS)
        return
      }
      root.classList.add(IDLE_CLASS)
    }

    /** 有任何操作：立刻显示，并重新开始计时。 */
    const wake = (): void => {
      root.classList.remove(IDLE_CLASS)
      clearTimer()
      if (fullscreen) timer = window.setTimeout(hide, IDLE_DELAY_MS)
    }

    const setFullscreen = (next: boolean): void => {
      if (next === fullscreen) return
      fullscreen = next
      if (fullscreen) wake()
      else {
        clearTimer()
        root.classList.remove(IDLE_CLASS)
      }
    }

    const off = subscribeFullscreen((value) => {
      receivedEvent = true
      setFullscreen(value)
    })

    /**
     * 兜底：主进程的事件还没上线时，用窗口尺寸判断是不是真全屏。
     * 窗口是无边框的（src/main/index.ts:106），最大化时高度≈可用高度（扣掉任务栏），
     * 真全屏才等于整块屏幕高度，所以按「两个方向都盖满」判断，宁可漏判不误判。
     *
     * 用户反复强调「真全屏 3 秒必须隐藏」：即使主进程事件整条链路丢了，
     * 视口盖满整屏也必须立刻认作真全屏——所以「视口=全屏」时无条件置 true，
     * 只有视口非全屏时才把判定权交回事件（退出全屏的事件若丢失，mousemove
     * 会唤醒控件，最坏只是多显示几秒，绝不会「该隐藏时不隐藏」）。
     */
    const syncByViewport = (): void => {
      const viewportFull =
        window.innerWidth >= window.screen.width - 1 && window.innerHeight >= window.screen.height - 1
      if (viewportFull) {
        setFullscreen(true)
      } else if (!receivedEvent) {
        setFullscreen(false)
      }
    }

    let lastMove = 0
    const onMouseMove = (): void => {
      const now = Date.now()
      if (now - lastMove < MOVE_THROTTLE_MS) return
      lastMove = now
      wake()
    }
    const onInteraction = (): void => wake()

    syncByViewport()
    const viewportTimer = window.setInterval(syncByViewport, 2000)
    window.addEventListener('resize', syncByViewport)
    window.addEventListener('mousemove', onMouseMove, { passive: true })
    window.addEventListener('mousedown', onInteraction, { passive: true })
    window.addEventListener('keydown', onInteraction)
    window.addEventListener('wheel', onInteraction, { passive: true })

    return () => {
      clearTimer()
      off?.()
      window.clearInterval(viewportTimer)
      window.removeEventListener('resize', syncByViewport)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mousedown', onInteraction)
      window.removeEventListener('keydown', onInteraction)
      window.removeEventListener('wheel', onInteraction)
      root.classList.remove(IDLE_CLASS)
    }
  }, [])
}
