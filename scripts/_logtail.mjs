// scripts/_logtail.mjs — 读运行中实例的主进程日志尾巴（youyou:invoke:app:logTail）
const PORT = process.env.SWEEP_PORT ?? '9436';
const N = Number(process.env.N ?? 120);
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
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval error');
  return r.result?.result?.value;
};
const out = await ev(`window.youyou.invoke('app:logTail', undefined).then(r => r.data ?? r)`);
const lines = Array.isArray(out) ? out : (out?.lines ?? []);
for (const l of lines.slice(-N)) console.log(typeof l === 'string' ? l : JSON.stringify(l));
ws.close();
