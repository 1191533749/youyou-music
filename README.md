# 雲の音 Kumone · Windows

基于 [missuo/kumone](https://github.com/missuo/kumone)（macOS/iOS 原生客户端，**LGPL-3.0**）的**协议与功能**，
用 Electron + React + TypeScript 重写的 Windows 桌面客户端，音频后端为 **mpv**。

> ⚠️ 这不是上游仓库的官方移植，也不是把 Swift 代码编译成 exe —— SwiftUI / AVFoundation 在 Windows 上不存在。
> 本项目的做法是：**逐行对译上游的加密协议、接口调用与业务规则**（weapi/eapi 加密、扫码登录、60+ 接口、
> 歌词解析、可播放性判定），UI 与音频引擎按 Windows 的技术栈重新实现。

## 当前状态

| 模块 | 状态 | 说明 |
|---|---|---|
| weapi / eapi 加密 | ✅ 已实测 | 与上游 Swift 实现字节级一致，附黄金值回归测试 |
| **weapi 限流自动降级** | ✅ 已实测 | 出口 IP 被限流时 weapi 返回 200 空体；同一请求改走 eapi 即可成功，已内建传输降级（比上游更健壮） |
| 扫码登录 / 手机号登录 | ✅ 已实测 | 真实接口验证；含状态机（801/802/803/800）与限流重试 |
| 60+ 网易云接口 | ✅ 已实测 | 搜索、歌单、专辑、歌手、日推、FM、心动模式、云盘、排行榜等，均有回归测试 |
| 歌词解析 | ✅ 已移植 | LRC / 逐字 yrc / 翻译 / 罗马音，两级接口降级 + 传输降级 |
| mpv 音频后端 | ✅ 已实测 | JSON IPC（Windows 命名管道），播放/暂停/跳转/音量/静音/设备枚举 |
| 本地缓存 | ✅ 已实测 | 音频与封面缓存、LRU 淘汰、上限可配；播放优先命中缓存 |
| 桌面歌词 | ✅ | 置顶透明条、可拖动、位置持久化 |
| 系统集成 | ✅ | 媒体键、任务栏缩略图按钮、进度条、托盘、单实例 |
| 界面 | ✅ 全部页面完成 | 首页/发现/搜索/播放页/歌单/专辑/歌手/我的音乐/日推/FM/云盘/排行榜/设置/登录 |
| 打包 exe | ✅ 已验证 | NSIS 安装包 + 免安装 exe（各约 113MB，含 mpv）；产物布局与随包 mpv 播放均已自检 |

## 快速开始

```powershell
# 1. 安装依赖
npm install

# 2. 下载 mpv（音频后端，约 32MB，仓库不提交二进制）
pwsh -File scripts/fetch-mpv.ps1

# 3. 开发模式
npm run dev

# 4. 生产构建 + 冒烟自检（无需人工点击，会真实启动窗口并跑一遍 IPC）
npm run build
npm run smoke

# 5. 打包 Windows exe
npm run dist            # NSIS 安装包
npm run dist:portable   # 免安装单文件 exe
```

## 架构

```
src/
  shared/          主进程与渲染进程共享的类型与 IPC 契约（唯一真相来源）
    types.ts       DTO、设置项、音质档位
    ipc.ts         全部 IPC 通道及其请求/响应类型
  main/            Node 侧：网络、音频、存储、窗口
    netease/       crypto.ts（weapi/eapi）client.ts（cookie jar + 传输）api.ts（60+ 接口）
                   models.ts（上游容错解码规则）lyrics.ts（LRC/YRC 解析）
    audio/mpv.ts   mpv 子进程 + JSON IPC（命名管道）
    player/        播放会话：队列、音质阶梯、循环/随机、上报
    storage/       设置持久化、音频/封面缓存
    lyrics/        歌词服务（取一次、解析一次、缓存）
    ipc/           每个功能一个模块，经 defineHandler 注册
  preload/         contextBridge 白名单桥接（只暴露 invoke / on）
  renderer/        React 界面
    lib/contract.ts  冻结的运行时契约（页面只用这里的东西）
    store/           播放器、登录、导航三个 store
    components/      SongList、PlayerBar、Dialog、ContextMenu、Toast
    pages/           各页面
    styles/          设计令牌 + 按功能拆分的样式表
```

### 几个关键设计决定

- **主进程是唯一的特权方。** 渲染进程没有 Node、没有 `fetch`，所有网络/文件/音频操作都是具名 IPC 通道。
  这样 CSP 与 cookie 都只有一处需要管。
- **音频交给 mpv，不自己解。** mpv 直接输出到 WASAPI，支持 mp3/flac/Hi-Res；本进程只通过 JSON IPC 驱动它。
  这与上游「AVFoundation 解码、PlaybackEngine 调度」的分工一致，只是把 AVFoundation 换成了 mpv。
- **主进程与 preload 输出 CommonJS。** Electron 33 的 ESM 加载器无法 `import` electron 模块本身
  （连 `import { app } from 'electron'` 都会在 `cjsPreparseModuleExports` 崩），因此只有渲染进程走 ESM。
- **音质自动降级。** 请求无损但账号未开通时，按 `jymaster → hires → lossless → exhigh → higher → standard`
  逐档下降，并把「实际播放音质」显示在播放条上，而不是直接报错。

## 上游对照

| 上游（Swift） | 本项目（TypeScript） |
|---|---|
| `Core/API/NeteaseCrypto.swift` | `main/netease/crypto.ts` |
| `Core/API/NeteaseClient.swift` | `main/netease/client.ts` |
| `Core/API/NeteaseAPI.swift` | `main/netease/api.ts` |
| `Core/Models/Models.swift`、`Track.swift` | `main/netease/models.ts` |
| `Core/Models/LyricsParser.swift` | `main/netease/lyrics.ts` |
| `Core/Player/Engine/PlaybackEngine.swift` | `main/audio/mpv.ts` + `main/player/controller.ts` |
| `Core/Storage/*` | `main/storage/*` |
| `Features/*`（SwiftUI） | `renderer/src/pages/*`（React） |

## 测试

```powershell
npm test                 # 单元 + 真实网络 + 真实 mpv 集成测试（24 项）
npm run smoke            # 启动真实窗口，跑 15 项端到端自检（含队列→mpv 播放）
npm run verify:packaged  # 检查打包产物布局，并用随包 mpv 真实解码播放
npm run typecheck        # 主进程与渲染进程分别类型检查
```

- `tests/netease.test.ts` 访问真实网易云接口（二维码、搜索、歌词），需要联网。
- `tests/transport-fallback.test.ts` 锁定 weapi 被限流时的 eapi 降级行为，同样需要联网。
- `tests/mpv.test.ts` 真实启动 mpv 并播放上游仓库的测试音频。
- `npm run smoke` 会用一个临时 userData 目录，不会读写你的真实登录与设置。

## 常见问题

| 现象 | 处理 |
|---|---|
| 页面数据全空、提示「网易云可能正在限流」 | 出口 IP 被限流。weapi 与 eapi 都被限时只能稍后重试或换网络。 |
| 二维码一直获取失败 | 同上，接口被限流；代码已做 eapi 二次尝试。 |
| 点播放没声音 | 没下载 mpv：`pwsh -File scripts/fetch-mpv.ps1`，或设 `KUMONE_MPV` 指向 mpv.exe。 |
| 打包时 7-Zip 报「无法创建符号链接」 | 未开启 Windows 开发者模式。当前配置已用 `signAndEditExecutable: false` 规避；开启后可改回 `true` 并恢复 exe 图标与版本信息。 |

## 版权与许可

- 上游 [missuo/kumone](https://github.com/missuo/kumone) 以 **LGPL-3.0** 发布。
- 本项目作为其衍生作品，沿用 **LGPL-3.0**，见 [LICENSE](LICENSE)。发布 exe 时需一并提供对应源码。
- mpv 以 **GPL-2.0-or-later** 发布，作为独立进程被调用（非链接），随包分发时需遵守其许可。
- 本项目是非官方客户端，与网易云音乐无任何关联。
