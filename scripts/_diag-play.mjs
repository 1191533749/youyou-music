// scripts/_diag-play.mjs — 定向诊断：逐首播放并记录状态时间线（是卡死、解析失败还是快速失败）
const PORT = process.env.SWEEP_PORT ?? '9436';
const QUERY = process.env.Q ?? '渡情';
const OFFSETS = (process.env.OFF ?? '0,1,2,3,4,5,6,7').split(',').map(Number);
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
await new Promise((res) => { ws.onopen = res });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval error');
  return r.result?.result?.value;
};
const invoke = async (channel, payload) => {
  const r = await ev(`window.youyou.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)})`);
  if (r && r.ok === false) throw new Error(`${channel}: ${r.error}`);
  return r?.data ?? r;
};
await ev(`window.__failed = []; window.youyou.on('player:trackFailed', (d) => { window.__failed.push(d); })`);

for (const off of OFFSETS) {
  let page1;
  const ts = Date.now();
  try {
    page1 = await invoke('search:query', { keywords: QUERY, type: 'songs', limit: 1, offset: off });
  } catch (e) {
    console.log(`offset=${off} 搜索失败 ${e.message}`);
    continue;
  }
  const t = (page1?.songs ?? [])[0];
  const searchMs = Date.now() - ts;
  if (!t) { console.log(`offset=${off} 无结果`); continue; }
  await ev(`window.__failed = []`);
  const t0 = Date.now();
  let outcome = 'TIMEOUT';
  const timeline = [];
  try {
    await invoke('player:playTracks', { tracks: [t] });
  } catch (e) {
    console.log(`offset=${off} ${t.name} - ${t.artists?.[0]?.name} invoke失败: ${e.message}`);
    continue;
  }
  let last = '';
  while (Date.now() - t0 < 26_000) {
    await sleep(600);
    const st = await invoke('player:state', undefined);
    const sig = `load=${st.loading ? 1 : 0} play=${st.playing ? 1 : 0} pos=${(st.position ?? 0).toFixed(1)} idle=${st.source ? 1 : 0}`;
    if (sig !== last) { timeline.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${sig}`); last = sig; }
    const failed = await ev(`window.__failed ?? []`);
    if (failed.length) { outcome = 'trackFailed'; break; }
    if (st.playing && !st.loading && st.position > 0.4) { outcome = 'PASS'; break; }
    if (!st.loading && !st.playing) { outcome = '静默停住'; break; }
  }
  const st = await invoke('player:state', undefined);
  console.log(`offset=${off} 搜索${(searchMs / 1000).toFixed(1)}s | ${outcome} 用时${((Date.now() - t0) / 1000).toFixed(1)}s | fee=${t.fee} pb=${t.playability} servedFrom=${st.servedFrom ?? '官方'} pos=${st.position?.toFixed?.(1)}`);
  console.log(`   ${t.name} - ${t.artists?.[0]?.name}  ${timeline.join(' | ')}`);
  await invoke('player:clearQueue', undefined).catch(() => {});
}
await invoke('player:pause', undefined).catch(() => {});
ws.close();
