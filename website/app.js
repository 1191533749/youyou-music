/**
 * 悠悠音乐官方网站 · 下载链接配置与交互
 *
 * 想手动换下载链接：直接改下面 SITE_CONFIG 里的 installerUrl / portableUrl，
 * 并把 autoDetect 设为 false，页面就永远用你写的链接。
 *
 * 保留 autoDetect = true 时：页面会去 GitHub Releases 取最新版本号与资产链接，
 * 自动更新按钮文案与 href；取不到就退回下面的手动配置（所以离线也不会点不动）。
 */
const SITE_CONFIG = {
  /** 当前版本（autoDetect 取不到时显示这个） */
  version: '0.3.8',
  /** 官方下载地址；换成你自己服务器的直链也可以 */
  installerUrl:
    'https://github.com/1191533749/youyou-music/releases/download/v0.3.8/YouyouMusic-Setup-0.3.8.exe',
  portableUrl:
    'https://github.com/1191533749/youyou-music/releases/download/v0.3.8/YouyouMusic-Portable-0.3.8.exe',
  /** 文件大小（只用于按钮下方的说明文字，可留空） */
  installerSize: '',
  portableSize: '',
  github: 'https://github.com/1191533749/youyou-music',
  qqGroup: 'https://qm.qq.com/q/L2I1RApP0o',
  /** 自动从 GitHub Releases 读取最新版本与资产链接 */
  autoDetect: true,
  /** 仓库：owner/repo */
  repo: '1191533749/youyou-music'
}

function formatSize(bytes) {
  if (!bytes) return ''
  const mb = bytes / 1024 / 1024
  return `${mb.toFixed(1)} MB`
}

function setText(id, text) {
  const node = document.getElementById(id)
  if (node) node.textContent = text
}

function setHref(ids, url) {
  for (const id of ids) {
    const node = document.getElementById(id)
    if (node) {
      node.href = url
      node.setAttribute('download', '')
      node.setAttribute('rel', 'noreferrer')
    }
  }
}

function applyVersion(version, installer, portable, installerSize, portableSize) {
  setText('current-version', `v${version}`)
  setText('version-note', '')
  setText('installer-meta', `v${version} · Windows 10/11 · 64 位${installerSize ? ` · ${installerSize}` : ''}`)
  setText('installer-meta-2', `v${version}${installerSize ? ` · ${installerSize}` : ''}`)
  setText('portable-meta-2', `v${version}${portableSize ? ` · ${portableSize}` : ''}`)

  setHref(['download-installer', 'download-installer-2'], installer)
  setHref(['download-portable', 'download-portable-2'], portable)

  for (const id of ['download-installer', 'download-installer-2', 'download-portable', 'download-portable-2']) {
    const node = document.getElementById(id)
    if (node) node.target = '_blank'
  }
}

/** 先按配置渲染一遍，保证即使接口不通页面也是可用状态 */
function applyConfig() {
  applyVersion(
    SITE_CONFIG.version,
    SITE_CONFIG.installerUrl,
    SITE_CONFIG.portableUrl,
    SITE_CONFIG.installerSize,
    SITE_CONFIG.portableSize
  )
  for (const id of ['github-link', 'github-link-2']) {
    const node = document.getElementById(id)
    if (node) node.href = SITE_CONFIG.github
  }
  const qq = document.getElementById('qq-link')
  if (qq) qq.href = SITE_CONFIG.qqGroup
}

/** 从 GitHub Releases 读取最新版本与资产直链（失败就保持配置里的值） */
async function detectLatest() {
  if (!SITE_CONFIG.autoDetect) return
  try {
    const response = await fetch(`https://api.github.com/repos/${SITE_CONFIG.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' }
    })
    if (!response.ok) return
    const release = await response.json()
    const version = String(release.tag_name ?? '').replace(/^v/, '')
    const assets = Array.isArray(release.assets) ? release.assets : []
    const setup = assets.find((asset) => /setup|installer|安装/i.test(asset.name))
    const portable = assets.find((asset) => /portable|便携/i.test(asset.name))
    if (!version || (!setup && !portable)) return
    applyVersion(
      version,
      setup?.browser_download_url ?? SITE_CONFIG.installerUrl,
      portable?.browser_download_url ?? SITE_CONFIG.portableUrl,
      SITE_CONFIG.installerSize || formatSize(setup?.size),
      SITE_CONFIG.portableSize || formatSize(portable?.size)
    )
    setText('version-note', '· 已同步到最新发布')
  } catch {
    // 网络不可用时静默退回手动配置
  }
}

/** 滚动时给导航加一点背景，避免文字压在内容上看不清 */
function setupNav() {
  const nav = document.querySelector('.nav')
  if (!nav) return
  const update = () => nav.classList.toggle('is-scrolled', window.scrollY > 24)
  update()
  window.addEventListener('scroll', update, { passive: true })
}

/** 卡片进入视口时淡入上浮 */
function setupReveal() {
  const targets = document.querySelectorAll('.card, .stat, .shot, .download, .faq details, .radar')
  if (!('IntersectionObserver' in window)) return
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible')
          observer.unobserve(entry.target)
        }
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
  )
  for (const target of targets) observer.observe(target)
}

applyConfig()
setupNav()
setupReveal()
void detectLatest()
