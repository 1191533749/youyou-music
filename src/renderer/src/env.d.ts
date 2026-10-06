import type { YouyouBridge } from '../preload/index'

declare global {
  interface Window {
    youyou: YouyouBridge
  }
}

export {}
