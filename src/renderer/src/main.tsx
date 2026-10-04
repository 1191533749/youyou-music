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
import './styles/global.css'
import './styles/base.css'
import './styles/home.css'
import './styles/library.css'
import './styles/detail.css'

const params = new URLSearchParams(window.location.search)
const windowKind = params.get('window') ?? 'main'

if (windowKind === 'lyrics') {
  document.documentElement.classList.add('desktop-lyrics-root')
  document.body.classList.add('desktop-lyrics-body')
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {windowKind === 'lyrics' ? <DesktopLyrics /> : <App />}
  </React.StrictMode>
)
