/**
 * GitHub 发布自动化：建仓（如缺）→ 推送源码与 tag → 创建 Release → 上传两个 exe。
 *
 * 只在用户授权后运行：
 *   node scripts/github-release.mjs --token ghp_xxx --version 0.3.0 [--dry-run]
 *
 * 安全性：
 *  - token 只进环境变量与命令行，绝不写盘、绝不进 git；
 *  - 默认 dry-run 打印将要执行的动作，不产生任何网络写操作；
 *  - 正式运行需要显式传 --confirm。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
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
const apiBase = 'https://api.github.com'

function gh(requestPath, options = {}) {
  const args = ['api', '--method', options.method ?? 'GET', `${apiBase}${requestPath}`]
  if (options.fields) {
    for (const [key, value] of Object.entries(options.fields)) {
      args.push('--field', `${key}=${value}`)
    }
  }
  return execFileSync('gh', args, {
    env: { ...process.env, GH_TOKEN: token, GH_ENTERPRISE_TOKEN: token },
    stdio: 'pipe',
    encoding: 'utf8'
  })
}

function log(message) {
  console.log(`[release] ${message}`)
}

if (!token) {
  console.error('用法: node scripts/github-release.mjs --token ghp_xxx [--version 0.3.0] [--confirm]')
  console.error('未提供 token（--token 或 GH_TOKEN 环境变量）。')
  process.exit(1)
}
if (!existsSync(installer) || !existsSync(portable)) {
  console.error('缺少发布产物，先跑 node scripts/package.mjs。')
  process.exit(1)
}

async function main() {
  // 1. 确认 gh 可用并已通过 token 认证身份
  let login
  try {
    const user = JSON.parse(gh('/user'))
    login = user.login
    log(`身份: @${login}`)
  } catch (cause) {
    console.error('无法用 token 访问 GitHub API，请检查 token 是否有效、是否过期。')
    process.exit(1)
  }

  // 2. 仓库：不存在则创建（公开仓库）
  let created = false
  try {
    gh(`/repos/${login}/youyou-music`)
    log('仓库已存在')
  } catch {
    created = true
    if (!dryRun) {
      gh('/user/repos', {
        method: 'POST',
        fields: {
          name: 'youyou-music',
          description: '悠悠音乐：网易云音乐 Windows 桌面客户端（Electron + mpv，LGPL-3.0）',
          homepage: 'https://github.com/' + login + '/youyou-music'
        }
      })
    }
    log(`将创建仓库 youyou-music${dryRun ? '（dry-run）' : ''}`)
  }

  // 3. 推送源码与 tag
  const remote = `https://x-access-token:${token}@github.com/${login}/youyou-music.git`
  if (!dryRun) {
    execFileSync('git', ['remote', 'remove', 'origin'], { stdio: 'ignore' })
    execFileSync('git', ['remote', 'add', 'origin', remote])
    execFileSync('git', ['push', '-u', 'origin', 'HEAD'], { stdio: 'inherit' })
    execFileSync('git', ['push', 'origin', releaseTag], { stdio: 'inherit' })
  }
  log(`将推送源码与 tag ${releaseTag}${dryRun ? '（dry-run）' : ''}`)

  // 4. Release：不存在则创建，再上传两个资产
  let release
  try {
    release = JSON.parse(gh(`/repos/${login}/youyou-music/releases/tags/${releaseTag}`))
    log(`Release ${releaseTag} 已存在`)
  } catch {
    if (!dryRun) {
      release = JSON.parse(
        gh(`/repos/${login}/youyou-music/releases`, {
          method: 'POST',
          fields: {
            tag_name: releaseTag,
            name: `悠悠音乐 ${version}`,
            body: releaseNotes(version),
            draft: false
          }
        })
      )
    }
    log(`将创建 Release ${releaseTag}${dryRun ? '（dry-run）' : ''}`)
  }

  for (const file of [portable, installer]) {
    const name = path.basename(file)
    const exists = dryRun
      ? false
      : JSON.parse(gh(`/repos/${login}/youyou-music/releases/tags/${releaseTag}`)).assets.some(
          (asset) => asset.name === name
        )
    if (exists) {
      log(`资产已存在，跳过: ${name}`)
      continue
    }
    if (!dryRun) {
      execFileSync('gh', ['release', 'upload', releaseTag, file, '--clobber', '--repo', `${login}/youyou-music`], {
        env: { ...process.env, GH_TOKEN: token },
        stdio: 'inherit'
      })
    }
    log(`将上传 ${name} (${(statSync(file).size / 1024 / 1024).toFixed(1)} MB)${dryRun ? '（dry-run）' : ''}`)
  }

  log(dryRun ? 'dry-run 结束：未产生任何远程写操作。正式发布加 --confirm。' : '发布完成。')
  if (created && !dryRun) {
    log('重要：src/main/update/service.ts 里的 GITHUB_OWNER 需确认为 ' + login + '（当前为 1191533749），并在下次发布前重新打包。')
  }
}

function releaseNotes(version) {
  return [
    `## 悠悠音乐 ${version}`,
    '',
    '### 本版要点',
    '- 全屏播放页：黑胶/胶片/波形/星海四种视觉 + 四种歌词特效（选择持久化）',
    '- 桌面歌词：窗口按歌词行自适配高度、透明区域点击穿透、特效移入设置',
    '- 未播放时点「播放全部」随机起播',
    '- 音质达不到所选档位时自动降档，不打扰用户',
    '- 深色主题重做；搜索条居中；侧栏品牌融入背景；全站按钮液态毛玻璃',
    '- 内置更新：启动检测、30 秒倒计时自动更新（可稍后）、更新后自动重开',
    '',
    '### 下载',
    `- 免安装：悠悠音乐便携版${version}.exe`,
    `- 安装版：悠悠音乐安装版${version}.exe`,
    '',
    '许可：LGPL-3.0，详见随包 LICENSE 与 THIRD-PARTY-NOTICES.txt。'
  ].join('\n')
}

void main()
