// scripts/_probe-external.mjs — 看「站外搜索」返回了什么（周杰伦原唱是否在站外音源里）
const PORT = process.env.SWEEP_PORT ?? '9436';
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

for (const kw of ['晴天 周杰伦', '稻香 周杰伦', '孤勇者 陈奕迅', '十年 陈奕迅', '江南 林俊杰', '泡沫 邓紫棋']) {
  const res = await invoke('search:query', { keywords: kw, type: 'songs', limit: 10, offset: 0 });
  console.log(`\n=== 「${kw}」 站内 ${res?.songs?.length ?? 0} 首 / 站外 ${res?.external?.length ?? 0} 条`);
  for (const s of res?.songs ?? []) {
    const artists = (s.artists ?? []).map((a) => a.name).join('/');
    const flags = ['playable', 'vipOnly', 'paidAlbum', 'noCopyright', 'delisted'].filter((k) => s[k] === true);
    console.log(`站内：${s.name} - ${artists}${flags.length ? ' [' + flags.join(',') + ']' : ''}${s.fee !== undefined ? ' fee=' + s.fee : ''}`);
  }
  for (const e of res?.external ?? []) {
    const artists = Array.isArray(e.artists)
      ? e.artists.map((a) => a?.name ?? a).join('/')
      : (e.artists ?? e.artist ?? '?');
    console.log(`站外：${e.name} - ${artists} [${e.sourceName ?? e.source ?? e.provider ?? '?'}]`);
  }
}
ws.close();
