/**
 * QA 探针: 核实 app:info 返回的 version 与关于区渲染文本。
 * 不碰任何状态, 只读 IPC 返回值。
 */
import * as path from 'node:path'
import * as os from 'node:os'
import { boot, shutdown, cdpEval, log } from './test-qa-frontend-lib.mjs'

const PORT = 9391

async function main() {
  const userData = path.join(os.tmpdir(), 'youyou-qa-probe-info')
  const { child, ready } = await boot({ port: PORT, userData, withRealState: false, waitReady: 24 })
  if (!ready) {
    log('实例启动失败')
    process.exit(1)
  }
  const raw = await cdpEval(PORT, `(async () => {
    const r = await window.youyou.invoke('app:info')
    return JSON.stringify(r && r.data ? { version: r.data.version, electron: r.data.electron, node: r.data.node } : r)
  })()`)
  log(`app:info = ${raw}`)
  await cdpEval(PORT, `(() => { const l = [...document.querySelectorAll('.sidebar__link')].find((x) => (x.textContent ?? '').includes('设置')); l?.click(); return true })()`, false)
  const about = await cdpEval(PORT, `(document.querySelector('.settings__row-about')?.textContent ?? document.querySelectorAll('.settings__row')[document.querySelectorAll('.settings__row').length - 1]?.textContent ?? '')`)
  log(`关于区文本 = ${JSON.stringify(about)}`)
  await shutdown({ port: PORT, child })
}

main().catch((cause) => {
  log(`异常: ${cause}`)
  process.exit(1)
})
