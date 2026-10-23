/**
 * 真全屏「鼠标空闲就收控件」。
 *
 * 只处理系统级真全屏（F11 / 播放页的「真全屏」按钮，任务栏也被盖住的那种），
 * 不掺和 app 内的全屏播放页。做法是在 `<html>` 上挂 `fullscreen-idle` 类，
 * 由 CSS 负责顶栏 / 底部控制条 / 全局播放条的淡出与禁用点击（detail.css）。
 *
 * 全屏状态来源：主进程广播的 `window:fullscreen`（payload `{ fullscreen: boolean }`，
 * 已在 `src/shared/ipc.ts` 的事件白名单里登记）。
 *
 * 早先还按「视口盖满整屏」兜底判断，结果在**最大化窗口 + 任务栏自动隐藏**的电脑上
 * 视口正好等于屏幕尺寸，被误判成真全屏：用户放着不动 3 秒，底部播放条就被收起来了。
 * 既然事件可靠，就只认事件，彻底不再猜尺寸。
 *
 * 只要是真全屏，超时后一定隐藏：不看鼠标停在哪、也不看上一秒点过哪个按钮
 * （焦点仍留在按钮上也不例外），任何鼠标 / 键盘 / 滚轮操作都会立刻唤醒控件。
 */
import { useEffect } from 'react'
import { call } from './ipc'

/** 挂到 <html> 上的类名，CSS 约定见 styles/detail.css。 */
export const IDLE_CLASS = 'fullscreen-idle'
/** 鼠标停多久算空闲。 */
const IDLE_DELAY_MS = 3000
/** mousemove 节流：够跟手，又不会每像素都清一次定时器。 */
const MOVE_THROTTLE_MS = 120

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
    // 桥接还没就绪：当作没有事件（不猜尺寸，宁可这次不隐藏）。
    return undefined
  }
}

export function useFullscreenIdle(): void {
  useEffect(() => {
    const root = document.documentElement
    let fullscreen = false
    let timer: number | undefined

    const clearTimer = (): void => {
      if (timer === undefined) return
      window.clearTimeout(timer)
      timer = undefined
    }

    const hide = async (): Promise<void> => {
      timer = undefined
      // 收起前问一次主进程：窗口此刻是不是真全屏。
      // 只靠事件记状态会在事件丢失/顺序错乱时“以为一直在全屏”，
      // 于是普通最大化窗口里鼠标一停也把播放条收掉（用户实际遇到的那个 bug）。
      const really = await call('window:isFullScreen').catch(() => false)
      if (!really) {
        fullscreen = false
        root.classList.remove(IDLE_CLASS)
        return
      }
      // 真全屏下无条件收起：3 秒无操作必隐藏，不因焦点停在按钮上而推迟。
      root.classList.add(IDLE_CLASS)
    }

    /** 有任何操作：立刻显示，并重新开始计时。 */
    const wake = (): void => {
      root.classList.remove(IDLE_CLASS)
      clearTimer()
      if (fullscreen) timer = window.setTimeout(() => void hide(), IDLE_DELAY_MS)
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

    const off = subscribeFullscreen((value) => setFullscreen(value))

    let lastMove = 0
    const onMouseMove = (): void => {
      const now = Date.now()
      if (now - lastMove < MOVE_THROTTLE_MS) return
      lastMove = now
      wake()
    }
    const onInteraction = (): void => wake()

    window.addEventListener('mousemove', onMouseMove, { passive: true })
    window.addEventListener('mousedown', onInteraction, { passive: true })
    window.addEventListener('keydown', onInteraction)
    window.addEventListener('wheel', onInteraction, { passive: true })

    return () => {
      clearTimer()
      off?.()
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mousedown', onInteraction)
      window.removeEventListener('keydown', onInteraction)
      window.removeEventListener('wheel', onInteraction)
      root.classList.remove(IDLE_CLASS)
    }
  }, [])
}
