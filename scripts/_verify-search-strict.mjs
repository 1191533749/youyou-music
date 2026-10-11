// scripts/_verify-search-strict.mjs — 验收：搜索结果只出现能播的歌（含用户关键词「恶龙咆哮」）
const PORT = '9436';
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

await ev(`window.__failed = []; window.youyou.on('player:trackFailed', (d) => window.__failed.push(d)); 'ok'`);

for (const kw of ['恶龙咆哮', '凤凰传奇']) {
  const t0 = Date.now();
  const res = await invoke('search:query', { keywords: kw, type: 'songs', limit: 30, offset: 0 });
  const songs = res?.songs ?? [];
  const ext = res?.external ?? [];
  console.log(`\n=== 搜索「${kw}」→ ${songs.length} 首 + 站外 ${ext.length} 条（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  console.log('  曲目: ' + songs.map((s) => s.name).join(' / '));
  let ok = 0;
  const bad = [];
  for (const s of songs.slice(0, 8)) {
    await ev(`window.__failed = []`);
    try { await invoke('player:playTracks', { tracks: [s] }); } catch (e) { bad.push(s.name + '(invoke)'); continue; }
    let pass = false;
    for (let i = 0; i < 20 && !pass; i++) {
      await sleep(600);
      const st = await invoke('player:state', {});
      const f = await ev(`window.__failed ?? []`);
      if (f.length) break;
      if (st.playing && !st.loading && st.position > 0.4) pass = true;
      if (!st.loading && !st.playing && (st.queue ?? []).length === 0) break;
    }
    if (pass) ok++; else bad.push(s.name);
  }
  console.log(`  点播 ${Math.min(8, songs.length)} 首：通过 ${ok}，失败 ${bad.length}${bad.length ? ' → ' + bad.join(' / ') : ''}`);
}
await invoke('player:pause', {}).catch(() => {});

// 一起听中继：真 token 的 WSS 握手
const token = 'yy-7f3a9c2e51d84b06';
const wss = await new Promise((resolve) => {
  const sock = new WebSocket(`wss://yy.ytw.asia/relay?token=${token}`);
  const timer = setTimeout(() => { try { sock.close() } catch {} ; resolve('TIMEOUT(10s)') }, 10_000);
  sock.addEventListener('open', () => { clearTimeout(timer); sock.close(); resolve('OPEN(握手成功)') });
  sock.addEventListener('error', () => { clearTimeout(timer); resolve('ERROR') });
  sock.addEventListener('close', (e) => { clearTimeout(timer); resolve(`CLOSE code=${e.code}`) });
});
console.log(`\n中继 wss://yy.ytw.asia/relay?token=… → ${wss}`);
ws.close();
