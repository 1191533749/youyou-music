/**
 * 给官方网站拍一张真实渲染截图（本地 file:// 加载，无需起服务器）。
 * 用法：npx electron scripts/shot-website.cjs [输出路径]
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const out = process.argv[2] ?? path.join(process.cwd(), 'website-preview.png')

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1440,
    height: 2400,
    show: false,
    webPreferences: { offscreen: true, sandbox: false }
  })
  await window.loadFile(path.join(process.cwd(), 'website', 'index.html'))
  // 等字体与动效稳定
  await new Promise((resolve) => setTimeout(resolve, 2200))
  const image = await window.webContents.capturePage()
  fs.writeFileSync(out, image.toPNG())
  console.log('已保存截图:', out, fs.statSync(out).size, '字节')
  app.exit(0)
})
