// scripts/_probe-inject-fix.mjs — 往运行中的实例注入候选修复规则，验证 meta 不再溢出卡片
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

  const report = () => evalJs(`(() => {
    const round = (n) => Math.round(n);
    const cards = [];
    for (const card of document.querySelectorAll('.grid--playlists > .card')) {
      const meta = card.querySelector('.card__meta');
      const cb = card.getBoundingClientRect();
      if (!meta) continue;
      const mb = meta.getBoundingClientRect();
      const cs = getComputedStyle(meta);
      cards.push({
        cardW: round(cb.width),
        metaText: (meta.textContent || '').slice(0, 40),
        metaX: round(mb.x), metaW: round(mb.width),
        right: round(mb.right), cardRight: round(cb.right),
        overflowsCard: round(mb.right) > round(cb.right) + 1,
        scrollW: meta.scrollWidth, clientW: meta.clientWidth,
        ellipsisKicksIn: meta.scrollWidth > meta.clientWidth,
        ws: cs.whiteSpace, minW: cs.minWidth
      });
    }
    return { ua: navigator.userAgent, cards };
  })()`);

  console.log('--- BEFORE ---');
  for (const c of (await report()).cards) if (c.overflowsCard || c.metaW > 160) console.log(JSON.stringify(c));

  await evalJs(`(() => {
    document.getElementById('__probe_fix__')?.remove();
    const s = document.createElement('style');
    s.id = '__probe_fix__';
    s.textContent = '.card__title, .card__meta { min-width: 0; max-width: 100%; }';
    document.head.appendChild(s);
    return true;
  })()`);

  await new Promise((r) => setTimeout(r, 300));
  console.log('\n--- AFTER (injected .card__title, .card__meta { min-width: 0 }) ---');
  for (const c of (await report()).cards) console.log(JSON.stringify(c));

  await evalJs(`document.getElementById('__probe_fix__')?.remove(); true`);
  console.log('\n(注入样式已移除，未改文件)');
  ws.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
