# 悠悠音乐官方网站（源码）

纯静态站点：一个 HTML + 一个 CSS + 一个 JS，没有构建步骤、没有外部依赖（不引 CDN、不下载字体），
上传到任意静态服务器/网站根目录即可访问。

## 目录

```
website/
├── index.html      # 页面结构
├── styles.css      # 样式（暖橙红渐变 + 液态玻璃 + 深色底，与客户端同款基调）
├── app.js          # 下载链接配置、版本自动同步、滚动动效
├── assets/         # 放图标与截图（可自行替换）
│   ├── icon.png            # 站点图标（可选）
│   ├── shot-home.png       # 截图：首页
│   ├── shot-player.png     # 截图：全屏播放页
│   └── shot-together.png   # 截图：一起听
└── README.md
```

## 改下载链接（两种方式）

1. **自动（默认）**：`app.js` 里 `SITE_CONFIG.autoDetect = true` 时，页面会自动去
   GitHub Releases 取最新版本号与两个资产的下载直链，按钮文案和链接一起更新。
   以后你每次发版都不需要动网站。
2. **手动**：把 `autoDetect` 改成 `false`，并直接改这两行：

   ```js
   installerUrl: 'https://你的地址/悠悠音乐安装版0.3.8.exe',
   portableUrl:  'https://你的地址/悠悠音乐便携版0.3.8.exe',
   version: '0.3.8'
   ```

   也可以保留 `autoDetect = true`，仅在 GitHub 不可达时作为兜底链接。

站点里其它可改项：`github`（项目地址）、`qqGroup`（加群链接）。

## 部署到 yy.ytw.asia

网站根目录已经和「一起听」中继分开，把本目录内容传到网站根目录即可：

```bash
# 本地打包后上传（任选其一）
scp -P <端口> -r website/* root@198.44.179.69:/www/wwwroot/yy.ytw.asia/

# 或在服务器上直接建文件
```

上传后访问 <https://yy.ytw.asia> 即可。中继仍在 `/relay`（`wss://yy.ytw.asia/relay`），
两者互不影响；服务器源码与私钥目录不在网站根下，无法被 HTTP 访问。

## 本地预览

```powershell
cd website
npx serve .        # 或 python -m http.server 8080
```

## 放截图

把客户端截图按下述文件名放进 `assets/`（建议宽度 1600px 左右的 PNG，16:10）：

| 文件名 | 内容 |
|---|---|
| `shot-home.png` | 首页（每日推荐） |
| `shot-player.png` | 全屏播放页 |
| `shot-together.png` | 一起听（雷达） |

还没放图片时占位框会显示成低透明度色块，不会破版。
