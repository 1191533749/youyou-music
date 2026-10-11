// scripts/_verify-gdstudio.mjs — 验收：受限歌（VIP/灰）能靠「聚合音源」拿到完整版并真的出声
// 用法：先启动带 CDP 的实例（YOYOU_USER_DATA 指向验证档案、--remote-debugging-port=9436），
//       再 node scripts/_verify-gdstudio.mjs（日志路径用 YOYOU_LOG 指定）。
import { readFileSync } from 'node:fs';

const PORT = process.env.SWEEP_PORT ?? '9436';
const LOG = process.env.YOYOU_LOG ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) ?? list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => { ws.onopen = r });
const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const invoke = async (ch, p) => { const r = await ev(`window.youyou.invoke(${JSON.stringify(ch)}, ${JSON.stringify(p)})`); if (r && r.ok === false) throw new Error(r.error); return r?.data ?? r; };

const auth = await invoke('auth:state', undefined);
console.log(`登录态：${auth?.profile?.nickname ?? auth?.profile?.nickName ?? '(未登录)'} userId=${auth?.profile?.userId ?? '-'} vipType=${auth?.profile?.vipType ?? '-'}`);

const logLines = () => {
  if (!LOG) return [];
  try { return readFileSync(LOG, 'utf8').split('\n'); } catch { return []; }
};
const mark = logLines().length;

await ev(`window.__failed = []; window.youyou.on('player:trackFailed', (d) => window.__failed.push(d)); 'ok'`);

// 这些是「官方接口拿不到完整直链」的典型：VIP 原唱（fee=1，本账号 vipType=0）。
// 聚合音源按歌曲 ID 直取，不搜索不匹配，所以它们是这条链路能不能救 VIP 歌的试金石。
const CASES = [
  { kw: '孤勇者 陈奕迅', note: 'VIP 原唱（网易云有，官方不给非会员）' },
  { kw: '富士山下 陈奕迅', note: 'VIP 原唱' },
  { kw: '起风了 买辣椒也用券', note: '常灰' }
];

let totalPass = 0;
let totalFail = 0;
for (const { kw, note } of CASES) {
  const t0 = Date.now();
  const res = await invoke('search:query', { keywords: kw, type: 'songs', limit: 10, offset: 0 });
  const songs = res?.songs ?? [];
  const ext = res?.external ?? [];
  console.log(`\n=== 「${kw}」（${note}）→ ${songs.length} 首 + 站外 ${ext.length} 条（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  console.log('  ' + songs.slice(0, 5).map((s) => `${s.name} - ${(s.artists ?? []).map((a) => a.name).join('/')}`).join(' | '));

  const tries = songs.slice(0, 4);
  for (const s of tries) {
    await ev(`window.__failed = []`);
    try { await invoke('player:playTracks', { tracks: [s] }); } catch { totalFail += 1; console.log(`  ✗ ${s.name}（点播接口就失败）`); continue; }
    let pass = false;
    for (let i = 0; i < 22 && !pass; i += 1) {
      await sleep(600);
      const st = await invoke('player:state', {});
      const failed = await ev(`window.__failed ?? []`);
      if (failed.length) break;
      if (st.playing && !st.loading && st.position > 0.4) pass = true;
      if (!st.loading && !st.playing && (st.queue ?? []).length === 0) break;
    }
    if (pass) { totalPass += 1; console.log(`  ✓ ${s.name}`); } else { totalFail += 1; console.log(`  ✗ ${s.name}`); }
  }
}
await invoke('player:pause', {}).catch(() => {});

const tail = logLines().slice(mark);
const bySource = new Map();
for (const line of tail) {
  const m = /换源成功：(.+?) 来自 (.+)$/.exec(line.trim());
  if (m) bySource.set(m[2], (bySource.get(m[2]) ?? 0) + 1);
}
console.log(`\n本轮点播：通过 ${totalPass}，失败 ${totalFail}`);
console.log('换源来源统计：' + (bySource.size ? [...bySource].map(([k, v]) => `${k}×${v}`).join('、') : '(没有换源记录)'));
console.log('聚合音源相关日志：');
for (const line of tail.filter((l) => /聚合音源|gdstudio|CDN 主机|镜像主机/.test(l)).slice(-12)) console.log('  ' + line.trim());
console.log('剔除统计：');
for (const line of tail.filter((l) => /搜索校验|站外校验/.test(l)).slice(-6)) console.log('  ' + line.trim());
ws.close();
