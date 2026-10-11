/**
 * 删除 GitHub Release 上指定的资产（用于「同名替换」：先删旧资产，再用
 * scripts/github-release.mjs 重新上传新构建产物）。
 *
 * 用法：node scripts/github-release-replace-asset.mjs --token ghp_xxx --tag v0.4.2 --name YouyouMusic-Portable-0.4.2.exe [--name sha256sums.txt] [--confirm]
 * 默认 dry-run，正式执行需 --confirm。
 */
import process from 'node:process'

const token = process.env.GH_TOKEN ?? process.argv[process.argv.indexOf('--token') + 1]
const tag = process.argv[process.argv.indexOf('--tag') + 1]
const names = process.argv.reduce((list, item, index) => {
  if (item === '--name') list.push(process.argv[index + 1])
  return list
}, [])
const confirm = process.argv.includes('--confirm')

if (!token || !tag || names.length === 0) {
  console.error('用法: node scripts/github-release-replace-asset.mjs --token ghp_xxx --tag v0.4.2 --name <资产名> [--name <资产名>] [--confirm]')
  process.exit(1)
}

async function api(method, requestPath) {
  const response = await fetch(`https://api.github.com${requestPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'YouyouMusic-Release'
    }
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`HTTP ${response.status} ${requestPath}: ${text.slice(0, 200)}`)
  }
  return response.status === 204 ? null : response.json()
}

const user = await api('GET', '/user')
const release = await api('GET', `/repos/${user.login}/youyou-music/releases/tags/${tag}`)
for (const name of names) {
  const asset = (release.assets ?? []).find((item) => item.name === name)
  if (!asset) {
    console.log(`[replace] 资产不存在，跳过：${name}`)
    continue
  }
  if (!confirm) {
    console.log(`[replace] 将删除 ${name}（id=${asset.id}, ${(asset.size / 1024 / 1024).toFixed(1)} MB）（dry-run）`)
    continue
  }
  await api('DELETE', `/repos/${user.login}/youyou-music/releases/assets/${asset.id}`)
  console.log(`[replace] 已删除 ${name}`)
}
console.log(confirm ? '[replace] 完成' : '[replace] dry-run 结束：正式执行加 --confirm')
