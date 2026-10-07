# 悠悠音乐 · Windows

官方网站：**<https://yy.ytw.asia>** · 源码与发布：**<https://github.com/1191533749/youyou-music>**

Windows 桌面音乐客户端：**Electron + React + TypeScript** 实现，音频后端为 **mpv**。
账号体系对接网易云音乐（扫码登录），支持在线播放、歌单/专辑/歌手、每日推荐、私人漫游、云盘、
桌面歌词、全屏播放页与「一起听」。

**最新版本 v0.4.1** · 支持 **Windows 10 / 11（64 位）**（Electron 33 已不支持 Windows 7/8/8.1，也没有 32 位产物）

## 预览

<img width="1919" height="1139" alt="1" src="https://github.com/user-attachments/assets/82ffdf0d-0ae7-4402-b62c-ffa9dca49e4e" />
<img width="1919" height="1199" alt="2" src="https://github.com/user-attachments/assets/0f3ba612-d4d5-4ee2-80c5-a82ac0a2ef0e" />
<img width="1919" height="1139" alt="3" src="https://github.com/user-attachments/assets/9106b4fe-02fd-452e-9096-e959317bde83" />
<img width="1919" height="1141" alt="4" src="https://github.com/user-attachments/assets/4b61aecb-4448-4509-8ea0-421b126b5296" />

## 当前状态

| 模块 | 状态 | 说明 |
|---|---|---|
| weapi / eapi 加密 | ✅ 已实测 | 报文格式与线上接口一致，附黄金值回归测试 |
| **weapi 限流自动降级** | ✅ 已实测 | 出口 IP 被限流时 weapi 返回 200 空体；同一请求自动改走 eapi |
| 扫码登录 | ✅ 已实测 | 真实接口验证；含状态机（801/802/803/800）与限流重试 |
| 60+ 网易云接口 | ✅ 已实测 | 搜索、歌单、专辑、歌手、日推、FM、心动模式、云盘、排行榜等，均有回归测试 |
| 歌词解析 | ✅ 已实测 | LRC / 逐字 yrc / 翻译 / 罗马音，两级接口降级 + 传输降级 |
| mpv 音频后端 | ✅ 已实测 | JSON IPC（Windows 命名管道），播放/暂停/跳转/音量/静音/设备枚举 |
| 本地缓存 | ✅ 已实测 | 音频与封面缓存、LRU 淘汰、上限可配；播放优先命中缓存 |
| **完整音源自动匹配** | ✅ 已实测 | 官方拿不到完整音频时自动匹配 pyncmd / 酷狗 / 酷我；严格匹配时长·歌名·歌手·版本，绝不播半截 |
| **站外曲库搜索兜底** | ✅ 已实测 | 网易云搜不到（或返回的全是明显不相关的模糊结果）时，后台静默去汽水音乐 → 酷狗 → 酷我找同一首歌播放；界面上没有任何音源开关、来源标注或结果条数文字 |
| **音质诚实降档** | ✅ 已实测 | 达不到所选音质自动降到可播最高档，并按**真实码率**（mpv `demux-bitrate`）显示实际档位；换源播放时也不会虚报成「母带」 |
| **全屏播放页** | ✅ | 黑胶/胶片/波形/星海四种视觉 + 卡拉OK/渐变放大/淡入淡出/霓虹四种歌词特效（选择持久化） |
| **搜索页** | ✅ 已实测 | 空态是居中的大搜索框 + 歌手头像慢速流动背景；输入后回到顶部输入框 + 综合/单曲/歌手/专辑/歌单；删空内容立刻回到空态 |
| **页面导航** | ✅ 已实测 | 一级页面之间切换不堆栈、不显示「返回」，只在内容页（歌单/专辑/歌手/播放页）出现返回并回到进入它的那一页；已访问页面常驻，切回来不重新加载 |
| 桌面歌词 | ✅ 已实测 | 置顶透明条、按歌词行自适配高度、透明区域点击穿透、位置持久化、四种特效、可切换字体 |
| **一起听** | ✅ 已实测 | 自建公网中继（TLS + 连接口令）：同步播放、聊天与表情、找听友雷达（性别/年龄/地区）、10 种礼物与赠礼动效、余额充值与自动到账；同账号连接自动去重 + 心跳回收死连接 |
| **内置更新** | ✅ 已实测 | 启动检测 GitHub Releases，30 秒倒计时自动更新（可稍后）；便携版下载新 exe 自替换，安装版静默安装，更新后自动重开 |
| 系统集成 | ✅ | 媒体键与 Ctrl+方向键、任务栏缩略图按钮、进度条、托盘、单实例 |
| 界面 | ✅ 全部页面完成 | 液态玻璃 + 暖橙红配色；深色主题独立配色；界面无表情符号装饰 |
| 应用图标 | ✅ 已嵌入 | 红色小鱼图标写入 exe（图标 + 产品名 + 版本信息），安装包同款 |

## 更新日志

### v0.4.1

- **搜索框只在搜索页**：其余页面不再有搜索框（此前每页顶部都挂一个，搜索页会变成两个）；侧边栏恢复「搜索」入口
- **搜索页空态**：居中的大搜索框 + 多行歌手头像慢速流动背景（不可点、不遮挡输入）；输入内容后隐藏，删空立刻回到空态
- **返回按钮**：一级页面不显示；侧栏切换类目不再堆栈，从内容页返回只回到进入它的那一页，不会退回其它类目
- **音质如实显示**：换源播放时用 mpv 报出的真实码率定档（实测首选「母带」、实际 320kbps → 显示「极高」），不再虚报
- **站外曲库静默兜底**：网易云搜不到或结果明显不相关时自动到汽水/酷狗/酷我找歌，界面无开关、无来源标注、无条数文字；并排除「网易云把关键词回显到歌手字段」造成的假命中
- 每日推荐日期条去掉阴影与毛玻璃灰晕；输出设备显示友好名称（不再是 `wasapi/{GUID}`）
- 一起听：同账号连接去重（旧连接以 4000 关闭且客户端不再自动重连）+ 心跳回收死连接，雷达不再出现多个「自己」

### v0.4.0

- 站外曲库（汽水音乐 / 酷狗 / 酷我）搜索与严格匹配播放；侧栏页面常驻不再重新加载；页内切分类保留旧内容 + 细条静默刷新

### v0.3.9

- 修复充值金额与下单不一致（改金额作废旧订单、金额选择与收款码互斥、越界金额拒绝下单而不是静默改成 1 元）

## 发布与更新

- 产物命名：`悠悠音乐安装版<版本>.exe`（安装版）与 `悠悠音乐便携版<版本>.exe`（免安装）。
- 内置更新从 GitHub Releases 拉取最新版本资产；**新版本只有在仓库所有者确认后才打包发布**。
- 许可文本：`LICENSE` 与 `THIRD-PARTY-NOTICES.txt` 随包分发。

## 快速开始

```powershell
# 1. 安装依赖
npm install

# 2. 下载音频后端与打包工具（各约 32MB / 1.3MB，仓库不提交二进制）
pwsh -File scripts/fetch-mpv.ps1
pwsh -File scripts/fetch-rcedit.ps1

# 3. 生成应用图标（源图 build/icon-source.jpg → build/icon.png + build/icon.ico）
python scripts/make-icon.py

# 4. 开发模式
npm run dev

# 5. 生产构建 + 冒烟自检（无需人工点击，会真实启动窗口并跑一遍 IPC）
npm run build
npm run smoke

# 6. 打包 Windows exe
npm run dist            # NSIS 安装包
npm run dist:portable   # 免安装单文件 exe
npm run verify:packaged # 校验产物布局，并用随包 mpv 真实解码播放
```

## 架构

```
src/
  shared/          主进程与渲染进程共享的类型与 IPC 契约（唯一真相来源）
    types.ts       DTO、设置项、音质档位
    ipc.ts         全部 IPC 通道及其请求/响应类型
  main/            Node 侧：网络、音频、存储、窗口
    netease/       crypto.ts（weapi/eapi）client.ts（cookie jar + 传输）api.ts（60+ 接口）
                   models.ts（容错解码）lyrics.ts（LRC/YRC 解析）
    audio/mpv.ts   mpv 子进程 + JSON IPC（命名管道）
    player/        播放会话：队列、音质阶梯、循环/随机、自动换源、上报
    storage/       设置持久化、音频/封面缓存
    lyrics/        歌词服务（取一次、解析一次、缓存）
    ipc/           每个功能一个模块，经 defineHandler 注册
  preload/         contextBridge 白名单桥接（只暴露 invoke / on）
  renderer/        React 界面
    lib/             运行时契约、中继客户端、点赞覆盖层、字体与地区表
    store/           播放器、登录、导航、一起听四个 store
    components/      SongList、PlayerBar、Radar、GiftOverlay、Dialog、ContextMenu、Toast
    pages/           各页面
    styles/          设计令牌 + 按功能拆分的样式表
server/            一起听公网中继（零依赖 Node，含支付宝当面付与礼物目录）
```

### 几个关键设计决定

- **主进程是唯一的特权方。** 渲染进程没有 Node、没有 `fetch`，所有网络/文件/音频操作都是具名 IPC 通道。
  这样 CSP 与 cookie 都只有一处需要管。
- **音频交给 mpv，不自己解。** mpv 直接输出到 WASAPI，支持 mp3/flac/Hi-Res；本进程只通过 JSON IPC 驱动它。
- **完整音源一律补齐。** 官方接口拿不到完整音频（或只给试听片段）时，依次尝试
  站内替代版本 → pyncmd → 酷狗 → 酷我，只在「时长 ±5 秒、歌名归一化相同、版本标记一致、
  歌手命中」四条全中时才采用；宁可跳过也不播半截或播翻唱。
- **主进程与 preload 输出 CommonJS。** Electron 33 的 ESM 加载器无法 `import` electron 模块本身，
  因此只有渲染进程走 ESM。
- **音质自动降级。** 请求的档位拿不到时按 `jymaster → hires → lossless → exhigh → higher → standard`
  逐档下降，并把「实际播放音质」显示在播放条上，而不是直接报错。
- **一起听自带服务端。** 中继服务零依赖（只用 Node 标准库）部署在自有服务器上，
  客户端走 `wss://` + 连接口令；支付宝应用私钥只存在于服务器，客户端只调用自有接口。

## 测试

```powershell
npm test                 # 单元 + 真实网络 + 真实 mpv 集成测试
npm run smoke            # 启动真实窗口跑端到端自检（含队列 → mpv 播放）
npm run verify:packaged  # 检查打包产物布局，并用随包 mpv 真实解码播放
npm run typecheck        # 主进程与渲染进程分别类型检查

node scripts/test-relay.mjs         # 一起听中继：本地双客户端端到端
node scripts/test-relay-public.mjs  # 一起听中继：公网 wss 端到端（含真实支付宝下单）
node scripts/test-together-ui.mjs   # 一起听页面：真机 UI 集成（连接/建房/聊天/礼物/跟随播放）
node scripts/test-daily-ui.mjs      # 每日推荐页面：真机 UI 集成
node scripts/test-update-e2e.mjs    # 内置更新：下载 → 替换 → 重开
node scripts/test-top-search.mjs    # 搜索框只出现在搜索页（逐页断言）+ 搜索页单输入框
node scripts/test-back-and-quality.mjs  # 返回按钮行为 + 底部音质显示真实档位
node scripts/test-page-keepalive.mjs    # 侧栏页面常驻：切回不重新加载
node scripts/verify-server.mjs      # 线上体检：网站/中继/支付宝/私钥暴露/目录指向（16 项）
node scripts/pull-website.mjs       # 把服务器上的官网拉回工作区（只读 + 哈希校验）
```

- `tests/netease.test.ts` 访问真实网易云接口（二维码、搜索、歌词），需要联网。
- `tests/transport-fallback.test.ts` 锁定 weapi 被限流时的 eapi 降级行为，同样需要联网。
- `tests/mpv.test.ts` 真实启动 mpv 并播放 `tests/fixtures` 里的测试音频。
- `npm run smoke` 会用一个临时 userData 目录，不会读写你的真实登录与设置。

## 常见问题

| 现象 | 处理 |
|---|---|
| 想听的歌（抖音热歌等）在网易云搜不到 | 直接在搜索页搜：网易云没有时会自动去汽水/酷狗/酷我找同一首歌并播放，界面上不会出现音源开关。匹配不到完整音源时会跳过，不播翻唱或片段。 |
| 底部显示的并不是我在设置里选的音质 | 这是如实显示：音源给不到所选档位时会自动降档，并按真实码率显示实际档位（例如首选「母带」、实际 320kbps 时显示「极高」）。 |
| 页面数据全空、提示「网易云可能正在限流」 | 出口 IP 被限流。weapi 与 eapi 都被限时只能稍后重试或换网络。 |
| 二维码一直获取失败 | 同上，接口被限流；代码已做 eapi 二次尝试。 |
| 点播放没声音 | 没下载 mpv：`pwsh -File scripts/fetch-mpv.ps1`，或设 `YOYOU_MPV` 指向 mpv.exe。 |
| 打包时 7-Zip 报「无法创建符号链接」 | 未开启 Windows 开发者模式。当前配置已用 `signAndEditExecutable: false` 规避；开启后可改回 `true`。 |

## 部署一起听中继

见 [server/README.md](server/README.md)：零依赖 Node 服务，支持房间与播放同步、聊天、
找听友、礼物与支付宝当面付充值；用 systemd 常驻，前面挂 TLS 反代后用 `wss://` 接入。

## 版权与许可

- 本项目以 **LGPL-3.0** 发布，见 [LICENSE](LICENSE)。发布 exe 时需一并提供对应源码。
- 第三方组件与许可文本见 [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt)。
- mpv 以 **GPL-2.0-or-later** 发布，作为独立进程被调用（非链接），随包分发时需遵守其许可。
- 本项目是非官方客户端，与网易云音乐无任何关联。

## 仓库与发布

- 官方网站：<https://yy.ytw.asia>（源码在 `website/`，纯静态，含两个版本的下载入口）
- 源码与 Release：<https://github.com/1191533749/youyou-music>
- 内置更新从该仓库的 Releases 拉取；新版本经确认后打包发布。
