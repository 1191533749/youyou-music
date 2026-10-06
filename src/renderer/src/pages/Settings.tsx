/**
 * 设置。
 *
 * 分五组：播放（音质与换源）、输出设备、桌面歌词、缓存、系统集成、账号。
 * 所有控件都直接写回 `settings:update`，由主进程持久化并广播，
 * 因此没有「保存」按钮，也不会出现界面与存储值不一致。
 */
import { useEffect, useRef, useState } from 'react'
import { call } from '../lib/contract'
import {
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
import { useToast } from '../components/Toast'

/** 音源开关的展示信息；与主进程 `AUDIO_SOURCE_NAMES` 保持一致。 */
const SOURCES: Array<{ id: 'pyncmd' | 'kugou' | 'kuwo'; name: string; hint: string }> = [
  { id: 'pyncmd', name: 'pyncmd', hint: '按网易云歌曲 ID 直取，命中率不高但最精确' },
  { id: 'kugou', name: '酷狗音乐', hint: '站内搜索 + 时长/歌名/歌手严格匹配' },
  { id: 'kuwo', name: '酷我音乐', hint: '站内搜索 + 时长/歌名/歌手严格匹配' }
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
  const [settings, setSettings] = useState<SettingsDTO | undefined>()
  const [info, setInfo] = useState<AppInfoDTO | undefined>()
  const [usage, setUsage] = useState<CacheUsageDTO | undefined>()
  const [devices, setDevices] = useState<AudioDeviceDTO[]>([])
  const [error, setError] = useState<string | undefined>()
  const [message, setMessage] = useState<string | undefined>()
  const [confirmLogout, setConfirmLogout] = useState(false)
  const [checking, setChecking] = useState(false)
  const toast = useToast()
  // 连续快速修改（比如主题切换、开关连点）时，多个 settings:update 的响应可能乱序
  // 到达——旧响应后到会把界面值盖回旧值，表现为「点了没生效」。序号守卫只采纳
  // 最后一次请求的响应。
  const patchSeq = useRef(0)

  useEffect(() => {
    void call('settings:get').then(setSettings).catch((cause) => setError(String(cause)))
    void call('app:info').then(setInfo).catch(() => undefined)
    void call('app:cacheUsage').then(setUsage).catch(() => undefined)
    void call('player:audioDevices').then(setDevices).catch(() => undefined)
  }, [])

  const patch = async (change: Partial<SettingsDTO>): Promise<void> => {
    const seq = ++patchSeq.current
    setError(undefined)
    try {
      const next = await call('settings:update', change)
      if (seq === patchSeq.current) setSettings(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const toggleSource = async (id: 'pyncmd' | 'kugou' | 'kuwo', enabled: boolean): Promise<void> => {
    if (!settings) return
    const current = settings.unblockSources ?? []
    const next = enabled ? [...current, id] : current.filter((item) => item !== id)
    // 保持固定优先级顺序，避免用户勾选顺序影响尝试次序。
    const ordered = SOURCES.map((source) => source.id).filter((source) => next.includes(source))
    await patch({ unblockSources: ordered as SettingsDTO['unblockSources'] })
  }

  if (!settings) {
    return (
      <div className="page settings">
        <div className="page__header">
          <h1 className="page__title">设置</h1>
        </div>
        <div className="page__empty">{error ?? '正在读取设置'}</div>
      </div>
    )
  }

  const enabledSources = settings.unblockSources ?? []

  return (
    <div className="page settings">
      <div className="page__header">
        <h1 className="page__title">设置</h1>
      </div>
      {error ? <div className="page__error">{error}</div> : null}

      <section className="settings__group">
        <h2>播放</h2>
        <p>优先使用更高音质；该档位拿不到时自动降档，绝不播放残缺片段。</p>
        <div className="settings__row">
          <div className="settings__row-label">
            <span>默认音质</span>
            <span className="settings__row-hint">所有档位都可选择，实际以音源能提供的最高档为准</span>
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
          hint="请求的档位拿不到时，依次尝试较低档位，而不是直接报错"
          checked={settings.autoDowngradeQuality}
          onChange={(value) => void patch({ autoDowngradeQuality: value })}
        />
        <SettingSwitch
          label="记录播放"
          hint="向账号上报播放记录，影响最近播放与听歌排行"
          checked={settings.scrobble}
          onChange={(value) => void patch({ scrobble: value })}
        />
      </section>

      <section className="settings__group">
        <h2>音源</h2>
        <p>
          受版权限制、无法从网易云取得完整音频的歌曲，会自动到已启用的音源里找同一首歌
          （时长、歌名、歌手、版本全部匹配），找到后直接播放完整版。
        </p>
        <SettingSwitch
          label="受限歌曲自动换源"
          hint="关闭后，受限歌曲将无法播放"
          checked={settings.unblockGreyTracks}
          onChange={(value) => void patch({ unblockGreyTracks: value })}
        />
        {SOURCES.map((source) => (
          <SettingSwitch
            key={source.id}
            label={source.name}
            hint={source.hint}
            disabled={!settings.unblockGreyTracks}
            checked={enabledSources.includes(source.id)}
            onChange={(value) => void toggleSource(source.id, value)}
          />
        ))}
        {enabledSources.length === 0 ? (
          <p className="settings__row-hint">至少勾选一个音源，否则换源不会生效。</p>
        ) : null}
      </section>

      <section className="settings__group">
        <h2>输出设备</h2>
        <p>音频由 mpv 输出，切换设备会立刻生效。</p>
        <div className="settings__row">
          <div className="settings__row-label">
            <span>播放设备</span>
            <span className="settings__row-hint">
              {info?.mpv ? info.mpv : '未检测到 mpv，播放功能不可用'}
            </span>
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
        <p>置顶悬浮的逐行歌词条，可拖动到任意位置，位置会被记住。</p>
        <SettingSwitch
          label="显示桌面歌词"
          checked={settings.showDesktopLyrics}
          onChange={(value) => void patch({ showDesktopLyrics: value })}
        />
        <SettingSwitch
          label="锁定歌词位置"
          hint="锁定后桌面歌词不可拖动，避免误触移位"
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
        <p>播放过的音频会缓存到本地，再次播放时直接读盘。</p>
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
              onClick={async () => {
                const directory = await call('app:chooseCacheDirectory').catch(() => undefined)
                if (directory) {
                  await patch({ cacheDirectory: directory })
                  setMessage('缓存目录将在下次启动时生效')
                }
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
              onClick={async () => {
                setUsage(await call('app:clearCache', { what: 'audio' }))
                setMessage('音频缓存已清理')
              }}
            >
              清理音频
            </button>
            <button
              type="button"
              className="button"
              onClick={async () => {
                setUsage(await call('app:clearCache', { what: 'all' }))
                setMessage('全部缓存已清理')
              }}
            >
              清理全部
            </button>
          </div>
        </div>
      </section>

      <section className="settings__group">
        <h2>系统集成</h2>
        <p>与 Windows 的交互方式。</p>
        <SettingSwitch
          label="媒体键"
          hint="键盘上的播放/暂停、上一首、下一首按键"
          checked={settings.mediaKeys}
          onChange={(value) => void patch({ mediaKeys: value })}
        />
        <SettingSwitch
          label="托盘图标"
          hint="关闭主窗口后仍在托盘中运行"
          checked={settings.tray}
          onChange={(value) => void patch({ tray: value })}
        />
        <SettingSwitch
          label="关闭时最小化到托盘"
          checked={settings.closeToTray}
          onChange={(value) => void patch({ closeToTray: value })}
        />
        <div className="settings__row">
          <div className="settings__row-label">
            <span>主题</span>
          </div>
          <div className="settings__row-control">
            <select
              value={settings.theme}
              onChange={(event) => {
                const theme = event.target.value as SettingsDTO['theme']
                document.documentElement.dataset.theme = theme === 'system' ? detectSystemTheme() : theme
                void patch({ theme })
              }}
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
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
                    onClick={async () => {
                      setConfirmLogout(false)
                      await auth.logout()
                      setMessage('已退出登录')
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
              <span className="settings__row-hint">在左侧「我的音乐」页面登录</span>
            )}
          </div>
        </div>
      </section>

      <section className="settings__group">
        <h2>更新</h2>
        <p>软件启动时会自动检查；也可以随时在这里手动检查，发现新版本会有 30 秒倒计时自动更新。</p>
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
                  .finally(() => setChecking(false))
              }}
            >
              {checking ? '正在检查…' : '检测更新'}
            </button>
          </div>
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
          <div>bug 反馈：3100878091@qq.com</div>
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

function detectSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
