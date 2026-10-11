// scripts/_shot.mjs — 用 CDP 截当前界面的指定区域（默认整屏）
// 用法: node scripts/_shot.mjs out.png [x y w h] [scale]
const PORT = process.env.SWEEP_PORT ?? '9436';
import fs from 'node:fs'

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) ?? list.find((t) => t.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('找不到页面 target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });

  const out = process.argv[2] ?? 'app.png';
  await send('Page.enable').catch(() => {});
  await send('Page.bringToFront').catch(() => {});
  const nums = process.argv.slice(3).map(Number);
  const clip = nums.length >= 4 ? { x: nums[0], y: nums[1], width: nums[2], height: nums[3], scale: nums[4] ?? 1 } : undefined;
  const shot = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('saved', out, clip ? JSON.stringify(clip) : 'full-viewport');
  ws.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
