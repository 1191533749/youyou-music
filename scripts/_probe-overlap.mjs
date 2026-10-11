// scripts/_probe-overlap.mjs — 找出压在某个文字上的元素（rect 相交）
// 用法: node scripts/_probe-overlap.mjs "Emma Stone"
const PORT = process.env.SWEEP_PORT ?? '9436';

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) ?? list.find((t) => t.type === 'page');
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
  await send('Runtime.enable');
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('EVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  };

  const needles = process.argv.slice(2);
  const out = await evalJs(`(() => {
    const needles = ${JSON.stringify(needles)};
    const res = [];
    for (const needle of needles) {
      let leaf = null;
      for (const el of document.querySelectorAll('*')) {
        if (el.children.length === 0 && (el.textContent || '').includes(needle)) { leaf = el; break; }
      }
      if (!leaf) { res.push({ needle, found: false }); continue; }
      const target = leaf.getBoundingClientRect();
      const cs = getComputedStyle(leaf);
      const overlaps = [];
      for (const el of document.querySelectorAll('body *')) {
        if (el === leaf || el.contains(leaf) || leaf.contains(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const ix = Math.min(r.right, target.right) - Math.max(r.left, target.left);
        const iy = Math.min(r.bottom, target.bottom) - Math.max(r.top, target.top);
        if (ix <= 0 || iy <= 0) continue;
        const s = getComputedStyle(el);
        overlaps.push({
          cls: typeof el.className === 'string' ? el.className : '',
          tag: el.tagName.toLowerCase(),
          rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          inter: [Math.round(ix), Math.round(iy)],
          pos: s.position, z: s.zIndex, bg: s.backgroundColor, radius: s.borderRadius,
          txt: (el.textContent || '').trim().slice(0, 50)
        });
      }
      res.push({
        needle, found: true,
        rect: [Math.round(target.x), Math.round(target.y), Math.round(target.width), Math.round(target.height)],
        scrollW: leaf.scrollWidth, clientW: leaf.clientWidth,
        color: cs.color, font: cs.fontSize, display: cs.display, textAlign: cs.textAlign,
        overlapCount: overlaps.length,
        overlaps: overlaps.slice(0, 12)
      });
    }
    return res;
  })()`);
  console.log(JSON.stringify(out, null, 1));
  ws.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
