/**
 * 设置。
 *
 * 分组：播放、音源、输出设备、桌面歌词、缓存、系统集成、外观（主题 + 皮肤）、背景、
 * 账号、更新、加入群聊、关于。所有控件都直接写回 `settings:update`，由主进程持久化并广播，
 * 因此没有「保存」按钮，也不会出现界面与存储值不一致。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { call, tryCall, useNavigation } from '../lib/contract'
import {
  DEFAULT_SETTINGS,
  DESKTOP_LYRICS_EFFECTS,
  LYRIC_FONTS,
  QUALITY_OPTIONS,
  type AppInfoDTO,
  type AudioDeviceDTO,
  type CacheUsageDTO,
  type DesktopLyricsEffect,
  type LyricFont,
  type SettingsDTO
} from '@shared/types'
import { formatBytes } from '../lib/format'
import { useAuthStore } from '../store/auth'
import { checkForUpdateInteractive } from '../lib/updatePrompt'
import { SKINS, applySkin, readSkin, type SkinId } from '../lib/skin'
import {
  BLUR_MAX,
  BLUR_MIN,
  applyGlassBlur,
  pickWallpaper,
  readGlassBlur,
  removeWallpaper
} from '../lib/appearance'
import { useToast } from '../components/Toast'
import SourceAccount from '../components/SourceAccount'

/** 音源开关的展示信息；与主进程 `AUDIO_SOURCE_NAMES` 保持一致。 */
const SOURCES: Array<{ id: 'qishui' | 'kugou' | 'kuwo' | 'qq'; name: string; hint: string }> = [
  { id: 'qishui', name: '汽水音乐', hint: '抖音曲库，免登录直连，解析最快' },
  { id: 'kugou', name: '酷狗音乐', hint: '站内搜索 + 时长/歌名/歌手严格匹配' },
  { id: 'kuwo', name: '酷我音乐', hint: '站内搜索 + 时长/歌名/歌手严格匹配' },
  { id: 'qq', name: 'QQ音乐', hint: '未登录只能覆盖部分免费歌，登录后更全' }
]

/** 桌面歌词特效的显示名，与桌面歌词窗口共用同一套枚举。 */
const EFFECT_LABELS: Record<DesktopLyricsEffect, string> = {
  classic: '经典',
  gradient: '渐变',
  neon: '霓虹',
  karaoke: '逐字卡拉OK'
}

/** 歌词字体的显示名（都是 Windows 常见已安装字体，切换后肉眼可见）。 */
const LYRIC_FONT_LABELS: Record<LyricFont, string> = {
  default: '现代黑体（默认）',
  rounded: '圆体（幼圆）',
  light: '细黑体（雅黑 Light）',
  kai: '楷体',
  serif: '宋体',
  system: '系统默认'
}

/**
 * 跟手的滑块。
 *
 * 直接在 onChange 里同步写主进程，会让滑块在快速拖动时来回跳动
 * （多次 IPC 响应乱序覆盖，表现为「拖不动」）。这里本地值立刻跟手，
 * 停顿 140ms 才真正落盘一次；松手/失焦时立即落盘，保证不会丢最后一次调整。
 */
function DraftRange({
  value,
  min,
  max,
  label,
  onChange
}: {
  value: number
  min: number
  max: number
  label: string
  onChange: (value: number) => void
}): JSX.Element {
  const [draft, setDraft] = useState<number | undefined>(undefined)
  const timer = useRef<number | undefined>(undefined)
  const shown = draft ?? value

  const schedule = (next: number): void => {
    setDraft(next)
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      setDraft(undefined)
      onChange(next)
    }, 140)
  }

  const flush = (): void => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current)
      timer.current = undefined
    }
    if (draft !== undefined && draft !== value) {
      setDraft(undefined)
      onChange(draft)
    }
  }

  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    },
    []
  )

  return (
    <input
      type="range"
      className="slider"
      min={min}
      max={max}
      value={shown}
      aria-label={label}
      onChange={(event) => schedule(Number(event.target.value))}
      onPointerUp={flush}
      onKeyUp={flush}
      onBlur={flush}
    />
  )
}

export default function Settings(): JSX.Element {
  const auth = useAuthStore()
  const navigation = useNavigation()
  /**
   * 主进程里的设置。读取失败时保持 undefined，界面退到 DEFAULT_SETTINGS 继续渲染：
   * 「settings:get 失败 → 返回一整页错误文案」曾让设置页完全没有控件，用户看到的
   * 就是「提示 Object has been destroyed + 一堆按钮点不动」。宁可显示默认值，
   * 也不吃掉整页。
   */
  const [stored, setStored] = useState<SettingsDTO | undefined>()
  const [settingsError, setSettingsError] = useState<string | undefined>()
  const [info, setInfo] = useState<AppInfoDTO | undefined>()
  const [usage, setUsage] = useState<CacheUsageDTO | undefined>()
  const [devices, setDevices] = useState<AudioDeviceDTO[]>([])
  const [error, setError] = useState<string | undefined>()
  const [message, setMessage] = useState<string | undefined>()
  const [confirmLogout, setConfirmLogout] = useState(false)
  const [checking, setChecking] = useState(false)
  /** 皮肤：整套观感参数（主色 + 玻璃色调 + 底纹），点了立刻换；只记在渲染层。 */
  const [skin, setSkin] = useState<SkinId>(readSkin)
  /** 背景模糊度：0–100 的档位（渲染层记录，localStorage），当场写根节点变量，不走主进程。 */
  const [blur, setBlur] = useState<number>(readGlassBlur)
  /** 选图/清除进行中：壁纸是可选功能，失败只提示一句，不影响其它控件。 */
  const [wallpaperBusy, setWallpaperBusy] = useState(false)
  /**
   * 主题的乐观值。select 的 value 直接绑 settings.theme 时，值要等 IPC 回来才更新，
   * 慢一步就表现成「选了又弹回去」。先用本地草稿让选择立刻成立。
   */
  const [themeDraft, setThemeDraft] = useState<SettingsDTO['theme'] | undefined>()
  /** QQ 群二维码（随包分发的 data URL）。 */
  const [groupImage, setGroupImage] = useState<string | undefined>()
  const toast = useToast()
  // 连续快速修改（比如主题切换、开关连点）时，多个 settings:update 的响应可能乱序
  // 到达——旧响应后到会把界面值盖回旧值，表现为「点了没生效」。序号守卫只采纳
  // 最后一次请求的响应。
  const patchSeq = useRef(0)

  /** 读设置：失败只留一条可重试的提示，不阻断页面。 */
  const loadSettings = useCallback(async (): Promise<void> => {
    try {
      const next = await call('settings:get')
      setStored(next)
      setSettingsError(undefined)
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void loadSettings()
    // 其余读取都是「有则更好」：失败就保持空，绝不因此让整页变成错误页。
    void tryCall('app:info').then(setInfo)
    void tryCall('player:audioDevices').then((value) => setDevices(value ?? []))
    void tryCall('app:qqGroupImage').then(setGroupImage)
  }, [loadSettings])

  /**
   * 缓存用量。设置页是 keep-alive 的（App.tsx 的 KEEP_ALIVE_PAGES）：切走再切回来组件
   * 不会重新挂载，只在挂载时读一次的话，之后播放攒下的缓存永远不会出现在这里 ——
   * 用户看到的就一直是最初那个 0B（音频缓存其实真的落盘了）。所以用量跟着路由走：
   * 每次切回设置页重新读一次。读失败就保留上一次的数字，不把已有用量抹成空。
   */
  const refreshUsage = useCallback(async (): Promise<void> => {
    const next = await tryCall('app:cacheUsage')
    if (next) setUsage(next)
  }, [])

  const routeName = navigation.route.name

  useEffect(() => {
    if (routeName !== 'settings') return
    void refreshUsage()
  }, [refreshUsage, routeName])

  /**
   * 选壁纸：主进程弹系统文件框、把图片存进 userData，渲染层只负责换背景
   * （appearance.pickWallpaper 里已经写好 html[data-wallpaper] 与 --wallpaper）。
   * 用户取消时 { set: false }，什么都不用改；失败只提示一句，不打断设置页。
   */
  const chooseWallpaper = useCallback(async (): Promise<void> => {
    setWallpaperBusy(true)
    try {
      const result = await pickWallpaper()
      if (!result.set) return
      setStored((current) => ({
        ...(current ?? DEFAULT_SETTINGS),
        wallpaperSet: true,
        wallpaperVersion: result.version
      }))
    } catch (cause) {
      toast.show(cause instanceof Error ? cause.message : '选择壁纸失败', 'error')
    } finally {
      setWallpaperBusy(false)
    }
  }, [toast])

  /** 清除壁纸：主进程删掉图片，渲染层同时撤掉背景，回退成皮肤色晕。 */
  const dropWallpaper = useCallback(async (): Promise<void> => {
    setWallpaperBusy(true)
    try {
      await removeWallpaper()
      setStored((current) => ({ ...(current ?? DEFAULT_SETTINGS), wallpaperSet: false }))
    } catch (cause) {
      toast.show(cause instanceof Error ? cause.message : '清除壁纸失败', 'error')
    } finally {
      setWallpaperBusy(false)
    }
  }, [toast])

  /** 模糊度：本地记录 + 立刻写根节点变量；CSS 变量一换，全应用的玻璃当场跟着变。 */
  const changeBlur = (value: number): void => {
    setBlur(applyGlassBlur(value))
  }

  /** 界面一律读它：真值缺失时退到默认值，控件因此永远可用。 */
  const settings = stored ?? DEFAULT_SETTINGS

  /**
   * 写回设置。返回三态而不是抛错，调用方据此决定乐观值是否撤销：
   * 'applied' = 已采用；'stale' = 有更新的请求在飞，交给它收尾；'failed' = 撤销乐观值。
   */
  const patch = async (change: Partial<SettingsDTO>): Promise<'applied' | 'stale' | 'failed'> => {
    const seq = ++patchSeq.current
    setError(undefined)
    try {
      const next = await call('settings:update', change)
      if (seq !== patchSeq.current) return 'stale'
      setStored(next)
      setSettingsError(undefined)
      return 'applied'
    } catch (cause) {
      // 单点失败只在顶部挂一条横幅，页面其余控件照旧可用。
      setError(cause instanceof Error ? cause.message : String(cause))
      return 'failed'
    }
  }

  const toggleSource = async (id: 'qishui' | 'kugou' | 'kuwo' | 'qq', enabled: boolean): Promise<void> => {
    const current = settings.unblockSources ?? []
    const next = enabled ? [...current, id] : current.filter((item) => item !== id)
    // 保持固定优先级顺序，避免用户勾选顺序影响尝试次序。
    const ordered = SOURCES.map((source) => source.id).filter((source) => next.includes(source))
    await patch({ unblockSources: ordered as SettingsDTO['unblockSources'] })
  }

  const enabledSources = settings.unblockSources ?? []

  return (
    <div className="page settings">
      <div className="page__header">
        <h1 className="page__title">设置</h1>
      </div>
      {error ? <div className="page__error">{error}</div> : null}
      {settingsError ? (
        <div className="page__error">
          设置读取失败：{settingsError}（当前显示默认值，改动仍会保存）
          <button type="button" className="button glass-btn" onClick={() => void loadSettings()}>
            重试
          </button>
        </div>
      ) : null}

      <section className="settings__group">
        <h2>播放</h2>
        <div className="settings__row">
          <div className="settings__row-label">
            <span>默认音质</span>
          </div>
          <div className="settings__row-control">
            <select
              value={settings.quality}
              onChange={(event) => void patch({ quality: event.target.value as SettingsDTO['quality'] })}
            >
              {QUALITY_OPTIONS.map((option) => (
                <option key={option.level} value={option.level}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <SettingSwitch
          label="自动降档"
          checked={settings.autoDowngradeQuality}
          onChange={(value) => void patch({ autoDowngradeQuality: value })}
        />
        <SettingSwitch
          label="记录播放"
          checked={settings.scrobble}
          onChange={(value) => void patch({ scrobble: value })}
        />
      </section>

      <section className="settings__group">
        <h2>音源</h2>
        <SettingSwitch
          label="自动匹配完整音源"
          checked={settings.unblockGreyTracks}
          onChange={(value) => void patch({ unblockGreyTracks: value })}
        />
        {SOURCES.map((source) => (
          <SettingSwitch
            key={source.id}
            label={source.name}
            disabled={!settings.unblockGreyTracks}
            checked={enabledSources.includes(source.id)}
            onChange={(value) => void toggleSource(source.id, value)}
          />
        ))}
        {enabledSources.length === 0 ? (
          <p className="settings__row-hint">至少勾选一个音源</p>
        ) : null}
      </section>

      <section className="settings__group">
        <h2>输出设备</h2>
        <div className="settings__row">
          <div className="settings__row-label">
            <span>播放设备</span>
          </div>
          <div className="settings__row-control">
            <select
              value={settings.audioDevice}
              onChange={(event) => void patch({ audioDevice: event.target.value })}
            >
              <option value="">系统默认</option>
              {devices
                .filter((device) => device.id !== 'auto')
                .map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name}
                  </option>
                ))}
            </select>
          </div>
        </div>
      </section>

      <section className="settings__group">
        <h2>桌面歌词</h2>
        <SettingSwitch
          label="显示桌面歌词"
          checked={settings.showDesktopLyrics}
          onChange={(value) => void patch({ showDesktopLyrics: value })}
        />
        <SettingSwitch
          label="锁定歌词位置"
          checked={settings.desktopLyricsLocked}
          onChange={(value) => void patch({ desktopLyricsLocked: value })}
        />
        <div className="settings__row">
          <div className="settings__row-label">
            <span>歌词特效</span>
          </div>
          <div className="settings__row-control">
            <select
              value={settings.desktopLyricsEffect}
              onChange={(event) =>
                void patch({ desktopLyricsEffect: event.target.value as SettingsDTO['desktopLyricsEffect'] })
              }
            >
              {DESKTOP_LYRICS_EFFECTS.map((effect) => (
                <option key={effect} value={effect}>
                  {EFFECT_LABELS[effect]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="settings__row">
          <div className="settings__row-label">
            <span>歌词字体</span>
          </div>
          <div className="settings__row-control">
            <select
              value={settings.lyricFont}
              onChange={(event) => void patch({ lyricFont: event.target.value as SettingsDTO['lyricFont'] })}
            >
              {LYRIC_FONTS.map((font) => (
                <option key={font} value={font}>
                  {LYRIC_FONT_LABELS[font]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="settings__row">
          <div className="settings__row-label">
            <span>字号</span>
          </div>
          <div className="settings__row-control">
            <DraftRange
              value={settings.desktopLyricsFontSize}
              min={14}
              max={64}
              label="桌面歌词字号"
              onChange={(value) => void patch({ desktopLyricsFontSize: value })}
            />
            <span className="settings__row-hint">{settings.desktopLyricsFontSize}px</span>
          </div>
        </div>
        <div className="settings__row">
          <div className="settings__row-label">
            <span>不透明度</span>
          </div>
          <div className="settings__row-control">
            <DraftRange
              value={Math.round(settings.desktopLyricsOpacity * 100)}
              min={20}
              max={100}
              label="桌面歌词不透明度"
              onChange={(value) => void patch({ desktopLyricsOpacity: value / 100 })}
            />
            <span className="settings__row-hint">{Math.round(settings.desktopLyricsOpacity * 100)}%</span>
          </div>
        </div>
      </section>

      <section className="settings__group">
        <h2>缓存</h2>
        <div className="settings__row">
          <div className="settings__row-label">
            <span>缓存目录</span>
            <span className="settings__row-hint">
              {usage?.directory ?? settings.cacheDirectory ?? '默认（应用数据目录）'}
            </span>
          </div>
          <div className="settings__row-control">
            <button
              type="button"
              className="button"
              onClick={() => {
                void (async () => {
                  const directory = await tryCall('app:chooseCacheDirectory')
                  if (!directory) return
                  if ((await patch({ cacheDirectory: directory })) === 'applied') {
                    setMessage('缓存目录将在下次启动时生效')
                  }
                })()
              }}
            >
              更改
            </button>
          </div>
        </div>
        <div className="settings__row">
          <div className="settings__row-label">
            <span>缓存上限</span>
            <span className="settings__row-hint">
              {usage ? `已用 ${formatBytes(usage.audioBytes + usage.imageBytes)}，共 ${usage.trackCount} 首` : ''}
            </span>
          </div>
          <div className="settings__row-control">
            <input
              type="number"
              min={0}
              step={256}
              value={settings.cacheLimitMB}
              onChange={(event) => void patch({ cacheLimitMB: Number(event.target.value) })}
            />
            <span className="settings__row-hint">MB（0 = 不限制）</span>
          </div>
        </div>
        <div className="settings__row">
          <div className="settings__row-label">
            <span>清理缓存</span>
          </div>
          <div className="settings__row-control">
            <button
              type="button"
              className="button"
              onClick={() => {
                void (async () => {
                  try {
                    setUsage(await call('app:clearCache', { what: 'audio' }))
                    setMessage('音频缓存已清理')
                  } catch (cause) {
                    toast.show(cause instanceof Error ? cause.message : '清理缓存失败', 'error')
                  }
                })()
              }}
            >
              清理音频
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                void (async () => {
                  try {
                    setUsage(await call('app:clearCache', { what: 'all' }))
                    setMessage('全部缓存已清理')
                  } catch (cause) {
                    toast.show(cause instanceof Error ? cause.message : '清理缓存失败', 'error')
                  }
                })()
              }}
            >
              清理全部
            </button>
          </div>
        </div>
      </section>

      <section className="settings__group">
        <h2>系统集成</h2>
        <SettingSwitch
          label="媒体键"
          checked={settings.mediaKeys}
          onChange={(value) => void patch({ mediaKeys: value })}
        />
        <SettingSwitch
          label="托盘图标"
          checked={settings.tray}
          onChange={(value) => void patch({ tray: value })}
        />
        <SettingSwitch
          label="关闭时最小化到托盘"
          checked={settings.closeToTray}
          onChange={(value) => void patch({ closeToTray: value })}
        />
        <SettingSwitch
          label="GPU 加速"
          hint="使用显卡加速界面渲染；关闭后改用软件渲染，重启后生效。"
          checked={settings.hardwareAcceleration}
          onChange={(value) => void patch({ hardwareAcceleration: value })}
        />
      </section>

      {/* 隐私与诊断：日志只上报程序自身的异常，不包含歌曲与账号数据。 */}
      <section className="settings__group">
        <h2>隐私与诊断</h2>
        <SettingSwitch
          label="收集日志"
          hint="收集程序异常日志并上传服务器，用于定位问题、改进稳定性（不含歌曲与账号信息）。"
          checked={settings.collectLogs}
          onChange={(value) => void patch({ collectLogs: value })}
        />
      </section>

      {/* 外观：明暗（主题）与主色（皮肤）是两件正交的事 —— 主题写 data-theme，皮肤写
          data-skin + localStorage youyou-skin，两边的 apply 逻辑互不覆盖，所以合成
          一组、上下排开，而不是各占一个分组。 */}
      <section className="settings__group">
        <h2>外观</h2>
        <div className="settings__row">
          <div className="settings__row-label">
            <span>主题</span>
          </div>
          <div className="settings__row-control">
            <select
              value={themeDraft ?? settings.theme}
              onChange={(event) => {
                const theme = event.target.value as SettingsDTO['theme']
                // 主题反馈必须瞬时：先写根节点与本地草稿，再落盘。
                applyTheme(theme)
                setThemeDraft(theme)
                void patch({ theme }).then((outcome) => {
                  if (outcome === 'applied') setThemeDraft(undefined)
                  else if (outcome === 'failed') {
                    // 落盘失败：撤销草稿并把根节点恢复成存储值，避免界面与存储不一致。
                    setThemeDraft(undefined)
                    applyTheme(settings.theme)
                  }
                  // 'stale'：有更新的请求在飞，交给它收尾，草稿先留着。
                })
              }}
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </div>
        </div>
        <div className="settings__row">
          <div className="settings__row-label">
            <span>主题皮肤</span>
          </div>
          <div className="settings__row-control">
            <div className="skin-picker" role="radiogroup" aria-label="主题皮肤">
              {SKINS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  className={`skin-option${item.id === skin ? ' is-active' : ''}`}
                  aria-checked={item.id === skin}
                  aria-label={item.name}
                  title={item.name}
                  onClick={() => setSkin(applySkin(item.id))}
                >
                  <span className="skin-swatch" data-skin={item.id} aria-hidden="true" />
                  <span className="skin-option__name">{item.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* 背景：壁纸（图片存主进程，渲染层用 youyou-wallpaper:// 读）+ 毛玻璃模糊度（本地记录）。 */}
      <section className="settings__group">
        <h2>背景</h2>
        <div className="settings__row">
          <div className="settings__row-label">
            <span>自定义壁纸</span>
          </div>
          <div className="settings__row-control">
            <button
              type="button"
              className="button glass-btn"
              disabled={wallpaperBusy}
              onClick={() => void chooseWallpaper()}
            >
              {settings.wallpaperSet ? '更换图片' : '选择图片'}
            </button>
            {settings.wallpaperSet ? (
              <button
                type="button"
                className="button glass-btn"
                disabled={wallpaperBusy}
                onClick={() => void dropWallpaper()}
              >
                清除壁纸
              </button>
            ) : null}
          </div>
        </div>
        <div className="settings__row">
          <div className="settings__row-label">
            <span>背景模糊度</span>
          </div>
          <div className="settings__row-control">
            <DraftRange value={blur} min={BLUR_MIN} max={BLUR_MAX} label="背景模糊度" onChange={changeBlur} />
            <span className="settings__row-hint">{blur}%</span>
          </div>
        </div>
      </section>

      <section className="settings__group">
        <h2>账号</h2>
        <div className="settings__row">
          <div className="settings__row-label">
            <span>当前账号</span>
            <span className="settings__row-hint">
              {auth.loggedIn ? (auth.profile?.nickname ?? '已登录') : '未登录'}
            </span>
          </div>
          <div className="settings__row-control">
            {auth.loggedIn ? (
              confirmLogout ? (
                <>
                  <button
                    type="button"
                    className="button button--primary"
                    onClick={() => {
                      setConfirmLogout(false)
                      void (async () => {
                        try {
                          await auth.logout()
                          setMessage('已退出登录')
                        } catch (cause) {
                          toast.show(cause instanceof Error ? cause.message : '退出登录失败', 'error')
                        }
                      })()
                    }}
                  >
                    确认退出
                  </button>
                  <button type="button" className="button" onClick={() => setConfirmLogout(false)}>
                    取消
                  </button>
                </>
              ) : (
                <button type="button" className="button" onClick={() => setConfirmLogout(true)}>
                  退出登录
                </button>
              )
            ) : (
              <span className="settings__row-hint">未登录</span>
            )}
          </div>
        </div>
      </section>

      <section className="settings__group">
        <h2>音源账号</h2>
        <SourceAccount />
      </section>

      <section className="settings__group">
        <h2>更新</h2>
        <div className="settings__row">
          <div className="settings__row-label">
            <span>当前版本</span>
            <span className="settings__row-hint">v{info?.version ?? '—'}</span>
          </div>
        </div>
        <div className="settings__row">
          <div className="settings__row-label">
            <span>检查更新</span>
            <span className="settings__row-hint">{checking ? '正在检查…' : ''}</span>
          </div>
          <div className="settings__row-control">
            <button
              type="button"
              className="button glass-btn"
              disabled={checking}
              onClick={() => {
                setChecking(true)
                void checkForUpdateInteractive()
                  .then((outcome) => {
                    if (outcome === 'latest') toast.show(`已是最新版本 v${info?.version ?? ''}`, 'success')
                    else if (outcome === 'error') toast.show('检查更新失败，请稍后再试', 'error')
                    // 'update' 时全局弹窗出现，这里不需要再提示
                  })
                  .catch(() => toast.show('检查更新失败，请稍后再试', 'error'))
                  .finally(() => setChecking(false))
              }}
            >
              {checking ? '正在检查…' : '检测更新'}
            </button>
          </div>
        </div>
      </section>

      <section className="settings__group">
        <h2>加入群聊</h2>
        <div className="settings__group-chat">
          <div className="settings__group-chat-info">
            <div className="settings__group-chat-name">悠悠音乐 bug测试反馈群</div>
            <div className="settings__group-chat-number">群号：169492698</div>
            <button
              type="button"
              className="button button--primary"
              onClick={() =>
                void call('app:openExternal', { url: 'https://qm.qq.com/q/L2I1RApP0o' }).catch((cause) =>
                  setMessage(cause instanceof Error ? cause.message : String(cause))
                )
              }
            >
              加入群聊
            </button>
          </div>
          {groupImage ? (
            <img className="settings__group-chat-qr" src={groupImage} alt="QQ 群二维码" />
          ) : null}
        </div>
      </section>

      <section className="settings__group">
        <h2>关于</h2>
        <div className="settings__about">
          <div>
            <strong>悠悠音乐</strong> v{info?.version ?? '—'}
          </div>
          <div>
            Electron {info?.electron ?? '—'} · Chromium {info?.chrome?.split('.')[0] ?? '—'} · Node{' '}
            {info?.node ?? '—'}
          </div>
          <div>{info?.mpv ?? '未检测到 mpv'}</div>
          <div>开发者：小鱼</div>
          <div>
            官方网站：
            <button
              type="button"
              className="settings__link"
              onClick={() => {
                void call('app:openExternal', { url: 'https://yy.ytw.asia' }).catch(() =>
                  toast.show('打开链接失败', 'error')
                )
              }}
            >
              https://yy.ytw.asia
            </button>
          </div>
          <div>
            项目发布地址：
            <button
              type="button"
              className="settings__link"
              onClick={() => {
                void call('app:openExternal', { url: 'https://github.com/1191533749/youyou-music' }).catch(() =>
                  toast.show('打开链接失败', 'error')
                )
              }}
            >
              https://github.com/1191533749/youyou-music
            </button>
          </div>
        </div>
      </section>

      {message ? <div className="page__empty">{message}</div> : null}
    </div>
  )
}

function SettingSwitch({
  label,
  hint,
  checked,
  disabled,
  onChange
}: {
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}): JSX.Element {
  return (
    <div className={`settings__row${disabled ? ' is-disabled' : ''}`}>
      <div className="settings__row-label">
        <span>{label}</span>
        {hint ? <span className="settings__row-hint">{hint}</span> : null}
      </div>
      <div className="settings__row-control">
        <button
          type="button"
          className={`switch${checked ? ' is-on' : ''}`}
          role="switch"
          aria-checked={checked}
          aria-label={label}
          disabled={disabled}
          onClick={() => onChange(!checked)}
        />
      </div>
    </div>
  )
}

/**
 * 把主题写到根节点。
 *
 * 主题只决定明暗、皮肤只决定主色，两者互不覆盖（见 global.css 顶部的约定）。
 * 抽成函数是因为「选择立刻生效」和「落盘失败后回退」要用同一套换算。
 */
function applyTheme(theme: SettingsDTO['theme']): void {
  document.documentElement.dataset.theme = theme === 'system' ? detectSystemTheme() : theme
}

function detectSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
