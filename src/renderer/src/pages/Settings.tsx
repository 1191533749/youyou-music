/**
 * Settings.
 *
 * One screen, grouped by what the setting affects: playback, cache, output
 * device, desktop lyrics, system integration and about. Every control writes
 * straight through `settings:update`, which persists and broadcasts, so there
 * is no save button and no chance of the UI and the stored value disagreeing.
 */
import { useEffect, useState } from 'react'
import { call } from '../lib/contract'
import {
  QUALITY_OPTIONS,
  type AppInfoDTO,
  type AudioDeviceDTO,
  type CacheUsageDTO,
  type SettingsDTO
} from '@shared/types'
import { formatBytes } from '../lib/format'

export default function Settings(): JSX.Element {
  const [settings, setSettings] = useState<SettingsDTO | undefined>()
  const [info, setInfo] = useState<AppInfoDTO | undefined>()
  const [usage, setUsage] = useState<CacheUsageDTO | undefined>()
  const [devices, setDevices] = useState<AudioDeviceDTO[]>([])
  const [available, setAvailable] = useState<string[]>([])
  const [error, setError] = useState<string | undefined>()
  const [message, setMessage] = useState<string | undefined>()

  useEffect(() => {
    void call('settings:get').then(setSettings).catch((cause) => setError(String(cause)))
    void call('app:info').then(setInfo).catch(() => undefined)
    void call('app:cacheUsage').then(setUsage).catch(() => undefined)
    void call('player:audioDevices').then(setDevices).catch(() => undefined)
    void call('app:entitlements')
      .then((entitlement) => setAvailable(entitlement.available))
      .catch(() => setAvailable([]))
  }, [])

  const patch = async (change: Partial<SettingsDTO>): Promise<void> => {
    setError(undefined)
    try {
      const next = await call('settings:update', change)
      setSettings(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  if (!settings) {
    return (
      <div className="page settings">
        <div className="page__header">
          <h1 className="page__title">设置</h1>
        </div>
        <div className="page__empty">{error ?? '正在读取设置…'}</div>
      </div>
    )
  }

  return (
    <div className="page settings">
      <div className="page__header">
        <h1 className="page__title">设置</h1>
      </div>
      {error ? <div className="page__error">{error}</div> : null}

      <section className="settings__group">
        <h2>播放</h2>
        <p>音质档位与降级策略。无损及更高档位需要黑胶 VIP。</p>
        <div className="settings__row">
          <div className="settings__row-label">
            <span>默认音质</span>
            <span className="settings__row-hint">
              {available.length > 0 ? `当前账号可用：${available.length} 档` : '未登录，仅免费档位可用'}
            </span>
          </div>
          <div className="settings__row-control">
            <select
              value={settings.quality}
              onChange={(event) => void patch({ quality: event.target.value as SettingsDTO['quality'] })}
            >
              {QUALITY_OPTIONS.map((option) => {
                const entitled = available.length === 0 ? !option.vip : available.includes(option.level)
                return (
                  <option key={option.level} value={option.level}>
                    {option.label}
                    {option.vip ? '（VIP）' : ''}
                    {entitled ? '' : ' · 未开通'}
                  </option>
                )
              })}
            </select>
          </div>
        </div>
        <SettingSwitch
          label="自动降级音质"
          hint="请求的档位不可用时，自动尝试较低档位，而不是直接报错"
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
        <div className="settings__row">
          <div className="settings__row-label">
            <span>字号</span>
          </div>
          <div className="settings__row-control">
            <input
              type="range"
              className="slider"
              min={14}
              max={64}
              value={settings.desktopLyricsFontSize}
              onChange={(event) => void patch({ desktopLyricsFontSize: Number(event.target.value) })}
            />
            <span className="settings__row-hint">{settings.desktopLyricsFontSize}px</span>
          </div>
        </div>
        <div className="settings__row">
          <div className="settings__row-label">
            <span>不透明度</span>
          </div>
          <div className="settings__row-control">
            <input
              type="range"
              className="slider"
              min={20}
              max={100}
              value={Math.round(settings.desktopLyricsOpacity * 100)}
              onChange={(event) => void patch({ desktopLyricsOpacity: Number(event.target.value) / 100 })}
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
              更改…
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
        <h2>关于</h2>
        <div className="settings__about">
          <div>
            <strong>雲の音 Kumone · Windows</strong> v{info?.version ?? '—'}
          </div>
          <div>基于 missuo/kumone（LGPL-3.0）的协议与功能二开，音频后端为 mpv。</div>
          <div>
            Electron {info?.electron ?? '—'} · Chromium {info?.chrome?.split('.')[0] ?? '—'} · Node{' '}
            {info?.node ?? '—'}
          </div>
          <div>{info?.mpv ?? '未检测到 mpv'}</div>
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              className="button"
              onClick={() => void call('app:openExternal', { url: 'https://github.com/missuo/kumone' })}
            >
              打开上游仓库
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
  onChange
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (value: boolean) => void
}): JSX.Element {
  return (
    <div className="settings__row">
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
          onClick={() => onChange(!checked)}
        />
      </div>
    </div>
  )
}

function detectSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
