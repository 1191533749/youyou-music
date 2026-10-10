/**
 * Renderer entry.
 *
 * A query parameter selects which window is being drawn: the main shell, or the
 * frameless always-on-top desktop lyric strip. Keeping one HTML entry for both
 * means one renderer bundle and no duplicated preload wiring.
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import DesktopLyrics from './windows/DesktopLyrics'
import { initGlassBlur, initWallpaper } from './lib/appearance'
import { initSkin } from './lib/skin'
import './styles/global.css'
import './styles/base.css'
import './styles/home.css'
import './styles/library.css'
import './styles/detail.css'
import './styles/together.css'
import './styles/together-gift.css'
import './styles/search-external.css'

const params = new URLSearchParams(window.location.search)
const windowKind = params.get('window') ?? 'main'

// 皮肤在挂载前就写到根节点：第一帧就是用户上次选的那套主色，不会有闪烁。
initSkin()
// 玻璃模糊度同理（本地记录，读取是同步的）。
initGlassBlur()
// 壁纸要问主进程设置，异步恢复；没设过就什么都不做。失败静默，不挡首屏。
void initWallpaper()

if (windowKind === 'lyrics') {
  document.documentElement.classList.add('desktop-lyrics-root')
  document.body.classList.add('desktop-lyrics-body')
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {windowKind === 'lyrics' ? <DesktopLyrics /> : <App />}
  </React.StrictMode>
)
