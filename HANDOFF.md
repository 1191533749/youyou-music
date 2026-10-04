# 交接说明（HANDOFF）

> 给下一个接手这个仓库的人（或下一个 AI 会话）。读完这份文档应当能在不重新侦察的情况下继续推进。

## 1. 这是什么

把 [missuo/kumone](https://github.com/missuo/kumone)（macOS/iOS 原生 SwiftUI 客户端，**LGPL-3.0**）**二开成 Windows exe**。
上游 81,800 行 Swift 里，`SwiftUI / AVFoundation / CoreAudio / MLX / CarPlay` 在 Windows 上都不存在，
所以「直接编译成 exe」不可行；本项目的路径是**逐行对译协议与业务逻辑，UI 与音频引擎换 Windows 技术栈重写**。

- 工程根目录：`E:\deepseek 工作区\kumone-windows`
- 上游只读参考：`E:\deepseek 工作区\kumone-upstream`（已克隆，勿修改）
- 技术栈：Electron 33 + React 18 + TypeScript 5.7 + electron-vite；音频后端 **mpv**（子进程 + JSON IPC）

## 2. 已经验证过的事实（不要重新怀疑，除非有反证）

| 结论 | 证据 |
|---|---|
| weapi/eapi 加密与上游字节级一致 | `tests/netease.test.ts` 黄金值；并对真实接口 POST 得到 `code:200` |
| **weapi 通道会对被限流的 IP 返回 200 空体；同一请求走 eapi 一定成功** | `tests/_eapi-probe` 式对照实验（12 个只走 weapi 的接口全部如此）；`api.ts` 的 `weapi()` 因此内建传输降级，`tests/transport-fallback.test.ts` 锁定该行为 |
| 扫码登录可用 | 真实调用 `/login/qrcode/unikey`、`/login/qrcode/client/login` 成功；限流时空体会被翻译成可重试提示 |
| **Electron 33 的 ESM 主进程完全不可用** | 连 `import { app } from 'electron'` 都崩在 `cjsPreparseModuleExports`；因此 `electron.vite.config.ts` 强制 main/preload 输出 CJS，且 package.json **不能**有 `"type": "module"` |
| mpv JSON IPC 在 Windows 命名管道上可用 | `tests/mpv.test.ts` 7 项全过（真实播放上游 flac/m4a 测试音频、跳转、音量、设备枚举） |
| 全链路可启动 | `npm run smoke` 打印 15 项 PASS + `SMOKE OK`（含队列→缓存→mpv→位置推进） |
| 打包产物可运行 | `npm run dist` 产出 NSIS + portable；`npm run verify:packaged` 用随包 mpv 真实解码播放 |
| **本机无法解压 winCodeSign** | 该包内含 macOS 符号链接，未开启开发者模式时创建失败并中断打包；已用 `signAndEditExecutable: false` 规避（代价：exe 无自定义图标/版本信息） |

## 3. 怎么跑

```powershell
cd "E:\deepseek 工作区\kumone-windows"
npm install
pwsh -File scripts/fetch-mpv.ps1   # 下载 mpv 到 vendor/mpv（约 120MB，不入库）
npm run dev                        # 开发（自动起 Vite dev server + Electron）
npm run typecheck                  # 主进程 + 渲染进程分别 tsc
npm test                           # 单元 + 真实网络 + 真实 mpv
npm run smoke                      # 真实窗口 + 12 项 IPC 端到端自检，失败退出码非 0
npm run dist                       # NSIS 安装包（未验证）
npm run dist:portable              # 免安装 exe（未验证）
```

`node_modules/electron` 未安装时 `npm run smoke` 会给出可读报错。

## 4. 架构与不变量

```
src/shared/     两侧共享类型与 IPC 契约（唯一真相来源；加通道必须先改 ipc.ts）
src/main/       netease/(crypto,client,api,models,lyrics) audio/mpv.ts player/ storage/ lyrics/ ipc/ media/
src/preload/    contextBridge，只暴露 invoke(channel, req) 与 on(event, fn)，白名单来自 src/shared/ipc.ts
src/renderer/   lib/(contract,ipc,format,hooks,lyricsUtils) store/(player,auth,navigation) components/ pages/ styles/
```

必须遵守的不变量：

1. **渲染进程没有特权。** 不 `fetch` 网易云、不碰文件系统。CSP 里 `connect-src 'self'`，cookie 只在主进程。
2. **IPC 通道先登记再用。** `IPC_INVOKE_CHANNELS` / `IPC_EVENT_NAMES` 是白名单，preload 与 handler 都按它校验；
   `npm run smoke` 里的「IPC 通道全注册」一项会抓出忘记注册的通道。
3. **主进程/preload 输出 CJS，只有渲染进程是 ESM。** 见上表。
4. **音质降级是特性不是兜底。** `player/controller.ts` 的 `QUALITY_LADDER` 逐档下降，并在 UI 上显示「实际」音质。
5. **可播放性判定沿用上游 `playability()`**（VIP/付费/无版权/下架），不要自己另写一套规则。
6. **样式按功能拆文件**：`global.css`（令牌+骨架）、`base.css`（通用+设置）、`home.css`/`library.css`/`detail.css`（各功能）。
   并行开发时不要多人改同一个样式文件——这是当初拆分的原因。

## 5. 当前进度

- ✅ 主进程全部完成并测试通过（协议、60+ 接口、**weapi 限流降级**、mpv 后端、队列/音质/上报、缓存并接入播放路径、桌面歌词窗口、媒体键/托盘/单实例、IPC 注册）
- ✅ 渲染进程全部页面完成（登录、设置、首页、发现、搜索、播放页、歌单/专辑/歌手详情、我的音乐、每日推荐、私人 FM、云盘、排行榜）
- ✅ 打包已验证（NSIS 安装包 + 免安装 exe，含 mpv）

| 任务 | 范围 | 状态 |
|---|---|---|
| task-1 | `pages/Home|Explore|Search|NowPlaying.tsx` + `styles/home.css` | ✅ 完成 |
| task-2 | `pages/Library|DailyPage|FM|Cloud.tsx` + `styles/library.css` | ✅ 完成 |
| task-3 | `pages/PlaylistPage|AlbumPage|ArtistPage.tsx` + `components/Dialog|ContextMenu|Toast.tsx` + `styles/detail.css` | ✅ 完成 |
| Lead 收尾 | 修 `hooks.ts`（usePaged 依赖／useAsync 清数据）、`SongList` 滚动哨兵、`album:detail` 补 artistId/subscribed、应用级 Toast、weapi 传输降级、排行榜页接线 | ✅ 完成 |

收尾验证（顺序固定，全部应通过）：

```powershell
npm run typecheck      # 两个 tsconfig 都要 0 错误
npm test               # 24 项通过
npm run build
npm run smoke          # 15 项 PASS + SMOKE OK
npm run dist           # release/Kumone-Setup-0.1.0.exe + Kumone-Portable-0.1.0.exe
npm run verify:packaged
```

## 6. 已知缺口 / 下一步

1. **exe 无自定义图标与版本信息。** 因为本机解压 winCodeSign 失败而关闭了 `signAndEditExecutable`（见上表）。
   开启 Windows 开发者模式（或管理员跑一次 `npm run dist`）后把它改回 `true`，并补 `build/icon.png`（256×256），
   托盘图标取自同一文件，缺失时退化为 `nativeImage.createEmpty()`。
2. **灰歌解锁（UnblockNeteaseMusic）未实现。** 上游实现了 pyncmd/Kuwo/Kugou 三源替换；
   设置项 `unblockGreyTracks` 已存在但没有消费方。这是上游 README 里的主打功能，值得补。
3. **AutoMix / StemKit（AI 分轨混音）未移植。** 上游用 MLX+Metal，Windows 上需要另找推理后端
   （onnxruntime-node 等），属于独立大工程。上游设计文档在 `docs/automix-*.md`。
4. **歌词罗马音 / 振假名未实现。** 上游用 macOS 的 `CFStringTokenizer` 做日语形态素分析；
   `LyricLine.romaji/furigana` 字段已预留但无生成器（需要 kana→romaji 表 + 分词词典）。
5. **心动模式未接线。** 主进程已有 `track:intelligence` 通道，页面未使用（契约里也没有对应入口）。
6. **封面主色采样退回令牌色。** 网易 CDN 无 CORS 头，渲染进程 canvas 取不到像素；
   若要真采样需在主进程加一个 palette 通道（解码与取色都在主进程）。当前沉浸感由模糊封面 + 渐变蒙层承担。
7. **`electron-updater` 依赖已装但未接线。** `publish: null`，发布源确定后再开。
8. **手机号登录受网易云风控限制**，实测常失败；扫码是主路径，UI 已注明。
9. **队列无「跳到某一首」通道。** 页面用重排队列等价实现；若要更精确，加 `player:jumpTo`。

## 7. 排错手册

| 现象 | 原因与处理 |
|---|---|
| `require is not defined in ES module scope` | package.json 又被加了 `"type": "module"`。去掉它。 |
| `Cannot read properties of undefined (reading 'exports')` in `cjsPreparseModuleExports` | 主进程被当成 ESM 跑了；同上，或 electron.vite.config.ts 的 `format: 'cjs'` 被改掉。 |
| `Cannot read properties of undefined (reading 'requestSingleInstanceLock')` | 环境里残留 `ELECTRON_RUN_AS_NODE=1`（用普通 Node 探测 electron 后常见）。`scripts/smoke.mjs` 已显式剔除它。 |
| 某个进程「启动后立刻退出、无输出」 | 单实例锁：另一个实例还在跑，或上次被强杀留下了锁。关掉所有 Kumone/electron 进程，或用 `KUMONE_USER_DATA` 指向临时目录（smoke 就是这么做的）。 |
| 界面正常但点播放报错 | 没下载 mpv；跑 `scripts/fetch-mpv.ps1`，或设 `KUMONE_MPV` 指向 mpv.exe。 |
| 大量页面空数据 + 「可能正在限流」 | 出口 IP 被网易云限流。传输降级已尽力（weapi→eapi），两者都被限时只能等待或换网络。 |
| 歌词空白但歌在放 | 未登录时歌词接口可能回空响应；确认 `api.lyric()` 的降级链与 `weapi()` 的传输降级没被改坏。 |
| `npm test` 里 netease/fallback 用例失败 | 需要联网；若刚压测过接口可能被限流，稍后重试。 |
| smoke 报「IPC 通道全注册」失败 | 新加了 `ipc.ts` 里的通道但没写 handler；按提示补 `defineHandler`。 |
| 打包 7-Zip「无法创建符号链接」 | 见第 6 节第 1 条。 |

## 8. 协议要点速查

- **weapi**：`POST https://music.163.com/weapi<path>`，form 字段 `params` + `encSecKey`。
  密钥 `0CoJUm6Qyw8W8jud`（预设）+ `kumone2026abcDEF`（自选，RSA 密文已预计算），AES-128-CBC，IV `0102030405060708`。
- **eapi**：`POST https://interface.music.163.com/eapi<path>`，`params` 为
  `AES-128-ECB(url + "-36cd479b6b5-" + json + "-36cd479b6b5-" + md5("nobody"+url+"use"+json+"md5forencrypt"))` 的十六进制大写；
  密钥 `e82ckenh8dichen8`；body 内需带 `header`（含 `os/appver/deviceId/requestId/buildver`）。
- **桌面 cookie**：`os=pc; appver=3.1.17`；weblog 上报额外用 `os=osx`（与上游一致）。
- **登录态**：`MUSIC_U` cookie；客户端用 SHA-256 指纹把它绑定成一个 session binding，配合 authEpoch
  丢弃跨登录的迟到响应与过期 Set-Cookie（`main/netease/client.ts`）。
