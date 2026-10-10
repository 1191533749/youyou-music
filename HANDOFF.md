# 交接说明（HANDOFF）

> 给下一个接手这个仓库的人（或下一个 AI 会话）。读完这份文档应当能在不重新侦察的情况下继续推进。

## 1. 这是什么

Windows 桌面音乐客户端（Electron + React + TypeScript，音频后端 mpv），对接网易云音乐账号与接口，
包含在线播放、歌单/专辑/歌手、每日推荐、私人漫游、云盘、桌面歌词、全屏播放页与「一起听」。

- 工程根目录：`E:\deepseek 工作区\kumone-windows`
- 官方网站：<https://yy.ytw.asia>（源码 `website/`，部署在 `/www/wwwroot/yy.ytw.asia`）
- 一起听中继：自有服务器 `/www/wwwroot/YYyinyue`（`wss://yy.ytw.asia/relay`，带连接口令）
- 技术栈：Electron 33 + React 18 + TypeScript 5.7 + electron-vite；音频后端 **mpv**（子进程 + JSON IPC）

## 2. 已经验证过的事实（不要重新怀疑，除非有反证）

| 结论 | 证据 |
|---|---|
| weapi/eapi 报文格式已钉死 | `tests/netease.test.ts` 黄金值；并对真实接口 POST 得到 `code:200` |
| **weapi 通道会对被限流的 IP 返回 200 空体；同一请求走 eapi 一定成功** | `tests/_eapi-probe` 式对照实验（12 个只走 weapi 的接口全部如此）；`api.ts` 的 `weapi()` 因此内建传输降级，`tests/transport-fallback.test.ts` 锁定该行为 |
| 扫码登录可用 | 真实调用 `/login/qrcode/unikey`、`/login/qrcode/client/login` 成功；限流时空体会被翻译成可重试提示 |
| **Electron 33 的 ESM 主进程完全不可用** | 连 `import { app } from 'electron'` 都崩在 `cjsPreparseModuleExports`；因此 `electron.vite.config.ts` 强制 main/preload 输出 CJS，且 package.json **不能**有 `"type": "module"` |
| mpv JSON IPC 在 Windows 命名管道上可用 | `tests/mpv.test.ts` 7 项全过（真实播放测试音频、跳转、音量、设备枚举） |
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
5. **可播放性判定集中在一处**（VIP/付费/无版权/下架），不要另写一套规则。
6. **样式按功能拆文件**：`global.css`（令牌+骨架）、`base.css`（通用+设置）、`home.css`/`library.css`/`detail.css`（各功能）。
   并行开发时不要多人改同一个样式文件——这是当初拆分的原因。

## 5. 当前进度（v0.3.0）

- ✅ 主进程：协议（weapi/eapi + 限流降级）、60+ 接口、mpv 后端、队列/音质阶梯/上报、缓存（按音源归档）、
  桌面歌词窗口（开关双向同步 + **事件广播到全部窗口** + **按行自适配高度** + **透明区点击穿透**）、
  媒体键/托盘/单实例、IPC 注册
- ✅ **受限歌曲自动换源**（`src/main/unblock/`）：官方地址失败或仅剩试听片段时，依次尝试
  站内替代版本 → 汽水音乐 → 酷狗 → 酷我 → QQ；四条件严格匹配（时长±5s、歌名归一化、版本标记、歌手）
- ✅ **多平台登录**（`src/main/accounts/platforms.ts` + `src/main/ipc/auth.ts` 的 `auth:platforms` /
  `auth:platformQRStart` / `auth:platformQRPoll` / `auth:platformLogout` / `auth:platformPlaylists`）：
  登录页底部平台图标切换，网易云沿用原二维码与矩阵，QQ音乐用 `ssl.ptlogin2.qq.com/ptqrshow` 的 PNG 二维码
  以 data URL 直接渲染；登录态存 `<userData>/accounts.json`，与网易云 `cookies.json` 互不影响。
  酷狗扫码接口当前全线 20006，登录搁置（酷狗仍然是一个可用的音源）
- ✅ **音质诚实降档**：达不到所选音质自动降档且不打扰用户；第三方音源码率已知才映射档位（`servedBitrate`）；
  界面不再显示「来自 X」或降档文字（v0.3.0 按用户要求全部去掉）
- ✅ **随机起播**：队列为空时点分类页「播放全部」→ `randomStart: true` → 随机一首立即播放（点行不受影响）
- ✅ **全屏播放页**：四视觉（黑胶黑金/胶片/波形/星海，默认黑胶，localStorage 记忆）+
  四歌词特效（卡拉OK/渐变放大/淡入淡出/霓虹）+ 细进度条/音量/静音 + 右侧队列抽屉 + 纯文字「返回」+ Esc
- ✅ **桌面歌词**：窗口只罩住当前行+翻译；透明区域鼠标穿透（`lyrics:desktopClickThrough`，
  setIgnoreMouseEvents forward）；特效选择移入设置页（`desktopLyricsEffect` 持久化）；入口图标 IconLyrics
- ✅ **我的音乐重做**：顶部渐变用户卡 + 五张区段入口卡网格
- ✅ **搜索居中胶囊条**（每页顶部 sticky）；侧栏品牌行融入主背景渐变（面板只包导航/账号）
- ✅ **深色主题重做**（暖紫黑底、玻璃层次、光斑压暗）+ 设置页序号守卫修复主题切换竞态
- ✅ **全站按钮液态毛玻璃**（.button/.glass-btn/各页 audit）
- ✅ **内置更新**（`src/main/update/service.ts` + `ipc/update.ts` + App 更新对话框）：
  启动检测 → 30 秒倒计时自动更新（可稍后）；便携版下载新版 exe 覆盖自替换，安装版静默安装；更新后自动重开。
  更新源 = GitHub Releases（owner/repo 常量在 service.ts 顶部）；`YOYOU_UPDATE_URL` 可覆盖用于联调
- ✅ 产物命名：`悠悠音乐安装版<版本>.exe` / `悠悠音乐便携版<版本>.exe`（electron-builder.yml artifactName）
- ✅ 本地 git 已提交并打 tag v0.3.0；**尚未推送 GitHub**——GitHub 已停用密码认证，等用户提供 PAT 后
  `git remote add origin <repo>` + push + 创建 Release（资产按「便携版/安装版」关键词匹配）

| 任务 | 范围 | 状态 |
|---|---|---|
| task-1..3 | 全部页面首版 + 玻璃化 + 去 emoji | ✅ 完成 |
| task-4..6 | 手机端视觉对齐（暖橙红/白卡） | ✅ 完成 |
| task-7..9 | 手机端细节 + 清除灰态文案 | ✅ 完成 |
| task-10 | 全屏播放页 + 四视觉 + 四歌词特效 + 符号微调 | ✅ 完成 |
| task-11 | 我的音乐网格卡重做 | ✅ 完成 |
| task-12 | 桌面歌词四特效 + desktopLyricsEffect 持久化 | ✅ 完成 |
| v0.3.0 | 十一项优化（见上） | ✅ 完成，待发布确认 |

收尾验证（顺序固定，全部应通过；终端里先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`）：

```powershell
npm run typecheck      # 两个 tsconfig 都要 0 错误
npm test               # 127 项通过
npm run build
npm run smoke          # 15 项 PASS + SMOKE OK
npm run dist           # node scripts/package.mjs：安装包 + 免安装版
npm run verify:packaged
```

## 6. 已知缺口 / 下一步

1. **exe 图标与版本信息由 afterPack 钩子写入**（`scripts/after-pack.cjs` + `vendor/rcedit`），
   因为 electron-builder 自带的资源编辑路径要解压含 macOS 符号链接的 winCodeSign 包，
   在本机（未开开发者模式、非管理员）会解压失败。四个音源里 **汽水免登录直连且最快、酷我稳定可用、酷狗对本例歌曲返回「需要付费」、
   pyncmd 已被汽水音乐取代、QQ 未登录只覆盖部分免费歌**——换源覆盖度取决于第三方接口，属于外部依赖。
2. **换源覆盖度有限。** 只有「时长 ±5 秒 + 歌名归一化相同 + 版本标记一致 + 歌手命中」四条全中才采用。
   想提高命中率可以增加音源（Migu / Bilibili 需要各自签名），或对纯音乐/现场版放宽版本判定。
3. **AutoMix / 分轨混音未实现。** 需要另找 Windows 上的推理后端
   （onnxruntime-node 等）。
4. **歌词罗马音 / 振假名未实现。** 需要日语形态素分析（Windows 上可用 MeCab 等）；
   `LyricLine.romaji/furigana` 字段已预留但无生成器。
5. **心动模式未接线。** 主进程已有 `track:intelligence` 通道，页面未使用。
6. **封面主色采样退回令牌色。** 网易 CDN 无 CORS 头，渲染进程 canvas 取不到像素；
   若要真采样需在主进程加 palette 通道。当前沉浸感由模糊封面 + 渐变蒙层承担。
7. **`electron-updater` 依赖已装但未接线。** `publish: null`。
8. **手机号登录受网易云风控限制**，扫码是主路径。
9. **队列无「跳到某一首」通道。** 页面用重排队列等价实现。
10. **数据目录已改名** `%APPDATA%\youyou-music`，启动时会把旧目录 `kumone-windows` 里的
    `cookies.json` / `settings.json` 一次性迁移过来（`migrateLegacyUserData`）；旧目录的缓存不迁移。
11. **酷狗登录搁置。** `/v2/qrcode` 对参数矩阵里的每一组都返回「参数错误 20006」（去掉 `uuid` 变 20010），
    换主机（`login.` / `sso.` / `login.user.`）都不可达，官方 `kguser_min.js` 里也没有 `qrcode` 字样；
    实现留在 `src/main/accounts/platforms.ts` 但未接入界面，酷狗仍作为音源可用。
12. **QQ音乐登录后能取歌单，但还没有把歌单灌进「我的音乐」。** `auth:platformPlaylists` 已返回平台歌单，
    登录页能列出；导入到队列/资料库尚未接线（需要把平台曲目映射成 `TrackDTO`）。

## 7. 排错手册

| 现象 | 原因与处理 |
|---|---|
| **打包版「双击没反应」，进程瞬退（<300ms，退出码 0）** | **首选检查 `ELECTRON_RUN_AS_NODE` 环境变量**：本机的 DSH 会话默认带 `ELECTRON_RUN_AS_NODE=1`，子进程会继承；Electron 在这种模式下当纯 Node 跑，主进程脚本直接崩掉且无输出。用户从资源管理器双击不受影响（没有这个变量）。终端里先 `Remove-Item Env:ELECTRON_RUN_AS_NODE` 再启动/测试。`scripts/smoke.mjs` 已自动剔除。 |
| 打包版静默退出，且确认环境干净 | 查 asar 完整性：`node scripts/verify-integrity.mjs`。rcedit 等工具重写 PE 资源会丢掉 `INTEGRITY/ELECTRONASAR` 块；图标必须用 `scripts/after-pack.cjs`（resedit，保留完整性块并自检）。 |
| `require is not defined in ES module scope` | package.json 又被加了 `"type": "module"`。去掉它。 |
| `Cannot read properties of undefined (reading 'requestSingleInstanceLock')` | 同上（`ELECTRON_RUN_AS_NODE=1` 下 `require('electron')` 返回路径字符串，`app` 为 undefined）。 |
| 界面正常但点播放报错 | 没下载 mpv；跑 `scripts/fetch-mpv.ps1`，或设 `YOYOU_MPV` 指向 mpv.exe。 |
| 大量页面空数据 + 「可能正在限流」 | 出口 IP 被网易云限流。传输降级已尽力（weapi→eapi），两者都被限时只能等待或换网络。 |
| 歌词空白但歌在放 | 未登录时歌词接口可能回空响应；确认 `api.lyric()` 的降级链与 `weapi()` 的传输降级没被改坏。 |
| `npm test` 里 netease/fallback 用例失败 | 需要联网；若刚压测过接口可能被限流，稍后重试。 |
| smoke 报「IPC 通道全注册」失败 | 新加了 `ipc.ts` 里的通道但没写 handler；按提示补 `defineHandler`。 |
| 打包 7-Zip「无法创建符号链接」 | 见第 6 节第 1 条（已用 afterPack 绕开）。 |
| 打包时 7za 退出码 2 | 刚写出的 180MB exe 正被杀软扫描导致共享冲突；`scripts/package.mjs` 会自动清理重试一次。 |
| 便携版「双击没反应」但解包版正常 | 绝大多数情况下就是 `ELECTRON_RUN_AS_NODE`（见第一行）。排除后再看第 6 节的打包流程说明（nsis 与 portable 必须分开构建且中间清理 `win-unpacked`）。 |

## 7b. 启动诊断

设置 `YOYOU_BOOT_LOG=<路径>` 后启动（便携版同样有效，环境变量会传给解压后的子进程），
主进程会在每个启动里程碑追加日志（`src/main/diagnostics.ts` + `src/main/index.ts` 里的 bootLog 埋点）。
未设置时完全零开销。日志为空 = 主进程脚本根本没执行（优先查 ELECTRON_RUN_AS_NODE / asar 完整性）。

## 8. 协议要点速查

- **weapi**：`POST https://music.163.com/weapi<path>`，form 字段 `params` + `encSecKey`。
  密钥 `0CoJUm6Qyw8W8jud`（预设）+ 本项目自选密钥（RSA 密文在构建期算好写死），AES-128-CBC，IV `0102030405060708`。
- **eapi**：`POST https://interface.music.163.com/eapi<path>`，`params` 为
  `AES-128-ECB(url + "-36cd479b6b5-" + json + "-36cd479b6b5-" + md5("nobody"+url+"use"+json+"md5forencrypt"))` 的十六进制大写；
  密钥 `e82ckenh8dichen8`；body 内需带 `header`（含 `os/appver/deviceId/requestId/buildver`）。
- **桌面 cookie**：`os=pc; appver=3.1.17`；weblog 上报额外用 `os=osx`（沿用客户端惯例）。
- **登录态**：`MUSIC_U` cookie；客户端用 SHA-256 指纹把它绑定成一个 session binding，配合 authEpoch
  丢弃跨登录的迟到响应与过期 Set-Cookie（`main/netease/client.ts`）。

## 8. GitHub 发布与更新通道（v0.3.0 已上线）

> ⛔ **发布审批规则（用户明确要求，最高优先级）**：
> **任何版本在用户本人明确说出「发布」之前，一律不得创建/上传 Release。**
> 允许做的事：本地打包（`scripts/package.mjs`）、装机自检、把便携版放到桌面给用户测试。
> 禁止做的事：`scripts/github-release.mjs --confirm`、`git push` tag 触发发布、把 Release 从预发布改为正式。
> 若已误发：立刻 `PATCH /repos/{owner}/{repo}/releases/{id}` → `{"prerelease": true}`，
> 让 `/releases/latest` 回退到用户已审批的版本（官网与更新器都以 latest 为准），然后如实告知用户。

- 仓库：https://github.com/1191533749/youyou-music （token 由用户提供，发布用 scripts/github-release.mjs --confirm）
- Release 资产用 ASCII 名（GitHub 上传接口会截断非 ASCII 资产名）：YouyouMusic-Portable-<v>.exe / YouyouMusic-Setup-<v>.exe / sha256sums.txt（ASCII 哈希清单）
- 更新器匹配：/便携版|portable/i → portable，否则 installer；下载后按 sha256sums.txt 校验
- 替换脚本经 cmd /c start 启动（本机作业对象会随父进程退出杀子进程，直接 spawn 必死）；脚本 try/catch 必须同行（}; catch 是语法错误）；生成脚本有 PowerShell 解析回归测试
- E2E：scripts/test-update-e2e.mjs（本地假更新源，断言下载哈希/copied=True/relaunched）→ UPDATE-E2E OK
- 本机 git 推送需走代理：git config http.proxy http://127.0.0.1:7897（已写入仓库本地配置）
