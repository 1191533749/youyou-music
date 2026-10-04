import type { KumoneBridge } from '../preload/index'

declare global {
  interface Window {
    kumone: KumoneBridge
  }
}

export {}
