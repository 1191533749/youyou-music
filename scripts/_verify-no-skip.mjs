// scripts/_verify-no-skip.mjs — 验收禁令：播放失败绝不允许自动跳下一首（原地重试同一首，队列不变）
// 配合 YOYOU_FAIL_RESOLVE=1 启动的实例使用：整条解析链必败，验证「不跳歌」行为。
const PORT = process.env.SWEEP_PORT ?? '9436';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) ?? list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => { ws.onopen = r });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const invoke = async (ch, p) => { const r = await ev(`window.youyou.invoke(${JSON.stringify(ch)}, ${JSON.stringify(p)})`); if (r && r.ok === false) throw new Error(r.error); return r?.data ?? r; };

await ev(`window.__failed = []; window.youyou.on('player:trackFailed', (d) => window.__failed.push(d)); 'ok'`);

// 手造一首真实曲目（解析链被 YOYOU_FAIL_RESOLVE=1 强制打挂，绕开搜索校验）。
const first = {
  id: 186016,
  name: '晴天',
  artists: [{ id: 6452, name: '周杰伦' }],
  album: { id: 34720827, name: '叶惠美', picUrl: '' },
  durationMS: 269000,
  alias: [],
  transNames: [],
  fee: 1,
  mvID: 0,
  trackNo: 1,
  noCopyright: false,
  isCloud: false
};
console.log('点播：' + first.name);

try { await invoke('player:playTracks', { tracks: [first] }); } catch { /* ignore */ }

// 观察 ~22 秒：3 次原地重试（1.2+2.4+3.6s 间隔 + 每次解析超时）之后应安静停在原曲。
const timeline = [];
for (let i = 0; i < 22; i++) {
  await sleep(1000);
  const st = await invoke('player:state', {});
  timeline.push({ t: i + 1, playing: st.playing, loading: st.loading, queue: (st.queue ?? []).length, index: st.index, error: st.error ?? null });
}
console.log('时间线（每 1s）：' + timeline.map((x) => `t${x.t}=${x.playing ? '播' : x.loading ? '载' : '停'}/q${x.queue}/i${x.index}${x.error ? '/err' : ''}`).join(' '));
const failed = await ev(`window.__failed ?? []`);
console.log('trackFailed 事件数：' + (failed?.length ?? 0));
const st = await invoke('player:state', {});
console.log('最终：queue=' + (st.queue ?? []).length + ' index=' + st.index + ' error=' + (st.error ?? '(无)') + ' playing=' + st.playing);
ws.close();
