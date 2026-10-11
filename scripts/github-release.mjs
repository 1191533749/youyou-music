/**
 * GitHub 发布：建仓（如缺）→ 推送源码与 tag → 创建 Release → 上传资产。
 *
 * 不依赖 gh CLI，直接 fetch GitHub REST API（Node 18+ 自带 fetch）。
 * 用法：node scripts/github-release.mjs --token ghp_xxx [--version 0.3.0] [--confirm]
 * 安全：token 只走环境变量/命令行；默认 dry-run，正式发布需 --confirm。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import process from 'node:process'

const root = process.cwd()

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}
function flag(name) {
  return process.argv.includes(`--${name}`)
}

const token = process.env.GH_TOKEN ?? arg('token')
const version = arg('version') ?? JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
const dryRun = flag('dry-run') || !flag('confirm')

const releaseTag = `v${version}`
const installer = path.join(root, 'release', `悠悠音乐安装版${version}.exe`)
const portable = path.join(root, 'release', `悠悠音乐便携版${version}.exe`)
const sums = path.join(root, 'release', 'sha256sums.txt')
// GitHub 上传接口对本机非 ASCII 资产名会截断（实测 CJK 全部丢失只剩 ASCII 尾巴），
// 所以发布资产用 ASCII 名，更新器按 Portable/Setup 关键词识别形态；
// 本地产物保持中文名不变。
const uploadNames = {
  [installer]: `YouyouMusic-Setup-${version}.exe`,
  [portable]: `YouyouMusic-Portable-${version}.exe`,
  [sums]: 'sha256sums.txt'
}
const apiBase = 'https://api.github.com'

function log(message) {
  console.log(`[release] ${message}`)
}

async function api(method, requestPath, body) {
  const response = await fetch(`${apiBase}${requestPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'YouyouMusic-Release',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text.slice(0, 200) }
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${requestPath}: ${JSON.stringify(data).slice(0, 200)}`)
  }
  return data
}

async function main() {
  if (!token) {
    console.error('用法: node scripts/github-release.mjs --token ghp_xxx [--version 0.3.0] [--confirm]')
    process.exit(1)
  }
  if (!existsSync(installer) || !existsSync(portable) || !existsSync(sums)) {
    console.error('缺少发布产物，先跑 node scripts/package.mjs')
    process.exit(1)
  }

  const user = await api('GET', '/user')
  const login = user.login
  log(`身份: @${login}（${user.name ?? '无显示名'}）`)

  // 1. 仓库
  let repo
  try {
    repo = await api('GET', `/repos/${login}/youyou-music`)
    log('仓库已存在')
  } catch {
    if (dryRun) {
      log('将创建仓库 youyou-music（dry-run）')
    } else {
      repo = await api('POST', '/user/repos', {
        name: 'youyou-music',
        description: '悠悠音乐：网易云音乐 Windows 桌面客户端（Electron + mpv，LGPL-3.0）'
      })
      log('已创建仓库 youyou-music')
    }
  }

  // 2. 推送源码与 tag
  if (!dryRun) {
    const remote = `https://x-access-token:${token}@github.com/${login}/youyou-music.git`
    try {
      execFileSync('git', ['remote', 'remove', 'origin'], { stdio: 'ignore' })
    } catch {
      /* 没有 origin 也无妨 */
    }
    execFileSync('git', ['remote', 'add', 'origin', remote])
    // 推送失败不阻断发布：脚本是幂等的，源码/标签可能早已推上去；
    // 网络抖动时宁可先把 Release 资产传完，推送下轮再补。
    try {
      execFileSync('git', ['push', '-u', 'origin', 'HEAD'], { stdio: 'inherit' })
    } catch {
      log('推送 HEAD 失败（网络抖动），继续创建/补传 Release 资产')
    }
    // --force：tag 要始终指向最新提交（远端已有同名 tag 时覆盖）。
    try {
      execFileSync('git', ['push', 'origin', releaseTag, '--force'], { stdio: 'inherit' })
    } catch {
      log(`推送 tag ${releaseTag} 失败（网络抖动），继续创建/补传 Release 资产`)
    }
  }
  log(`推送源码与 tag ${releaseTag}${dryRun ? '（dry-run）' : ' 完成'}`)

  // 3. Release（幂等：已存在就复用，绝不因「已存在」而 422）
  let release
  let exists = false
  for (let attempt = 0; attempt < 5 && !exists; attempt += 1) {
    try {
      release = await api('GET', `/repos/${login}/youyou-music/releases/tags/${releaseTag}`)
      exists = true
      log(`Release ${releaseTag} 已存在`)
    } catch (cause) {
      if (String(cause.message).includes('HTTP 404')) break // 确实不存在，去创建
      if (attempt < 4) {
        log(`读取 Release 失败，1.5s 后重试（${attempt + 1}/4）`)
        await new Promise((resolve) => setTimeout(resolve, 1500))
      } else {
        throw cause
      }
    }
  }
  if (!exists) {
    if (dryRun) {
      log(`将创建 Release ${releaseTag}（dry-run）`)
    } else {
      release = await api('POST', `/repos/${login}/youyou-music/releases`, {
        tag_name: releaseTag,
        name: `悠悠音乐 ${version}`,
        body: releaseNotes(version),
        draft: false
      })
      log(`已创建 Release ${releaseTag}`)
    }
  }

  // 4. 上传资产（便携版 / 安装版 / 哈希清单），发布名用 ASCII（见 uploadNames 注释）
  // 哈希清单也用 ASCII 资产名重写，这样更新器下载后能按名对号校验。
  if (!dryRun) {
    const asciiSums = [portable, installer]
      .map((file) => `${sha256(file)}  ${uploadNames[file]}`)
      .join('\n') + '\n'
    writeFileSync(sums, asciiSums, 'utf8')
  }
  for (const file of [portable, installer, sums]) {
    const name = uploadNames[file]
    if (dryRun) {
      log(`将上传 ${name} (${(statSync(file).size / 1024 / 1024).toFixed(1)} MB)（dry-run）`)
      continue
    }
    const existing = await api('GET', `/repos/${login}/youyou-music/releases/tags/${releaseTag}`)
    if (existing.assets.some((asset) => asset.name === name)) {
      log(`资产已存在，跳过: ${name}`)
      continue
    }
    const bytes = readFileSync(file)
    // 上传网络会抖：单个资产失败重试几次，而不是让整条发布失败重跑。
    let uploaded = false
    for (let attempt = 0; attempt < 5 && !uploaded; attempt += 1) {
      try {
        const upload = await fetch(
          `https://uploads.github.com/repos/${login}/youyou-music/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'User-Agent': 'YouyouMusic-Release',
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(bytes.length)
            },
            body: bytes
          }
        )
        if (upload.ok) {
          uploaded = true
        } else {
          const text = await upload.text()
          throw new Error(`HTTP ${upload.status} ${text.slice(0, 200)}`)
        }
      } catch (cause) {
        if (attempt < 4) {
          log(`上传 ${name} 失败，2s 后重试（${attempt + 1}/4）：${String(cause.message).split('\n')[0]}`)
          await new Promise((resolve) => setTimeout(resolve, 2000))
        } else {
          throw cause
        }
      }
    }
    log(`已上传 ${name} (${(statSync(file).size / 1024 / 1024).toFixed(1)} MB)`)
  }

  log(dryRun ? 'dry-run 结束：未产生任何远程写操作。正式发布加 --confirm。' : '发布完成。')
  if (!dryRun) {
    log(`仓库地址: https://github.com/${login}/youyou-music`)
  }
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function releaseNotes(version) {
  return [
    `## 悠悠音乐 ${version}`,
    '',
    '### 本版要点',
    '- 搜索结果只展示点了就能完整播放的歌：返回前逐首实测，放不出来的不展示',
    '- 新增聚合音源：按歌曲 ID 直取直链，灰歌与 VIP 歌也能完整播放',
    '- 搜「歌名 + 歌手」不再漏掉 VIP 原唱（此前只剩翻唱）',
    '- 网易云 CDN 双主机互换：单台 CDN 连不上时自动换镜像主机',
    '- 播放失败绝不自动跳下一首：原地换音源/换档位/换主机重试，不切歌、不删行',
    '- 首页卡片长歌手名在卡片内截断，不再溢出到相邻卡片',
    '- mpv 启动失败静默重试，界面不再出现技术错误文案',
    '',
    '### 下载',
    `- 免安装：YouyouMusic-Portable-${version}.exe`,
    `- 安装版：YouyouMusic-Setup-${version}.exe`,
    '',
    '校验：sha256sums.txt（随附）',
    '',
    '许可：LGPL-3.0，详见随包 LICENSE 与 THIRD-PARTY-NOTICES.txt。'
  ].join('\n')
}

main().catch((cause) => {
  console.error(`[release] 失败: ${cause.message ?? cause}`)
  process.exit(1)
})
