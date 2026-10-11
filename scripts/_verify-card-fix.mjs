// scripts/_verify-card-fix.mjs — 验收：卡片歌手行不再溢出错位（真机 DOM 几何）
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

  const res = await evalJs(`(() => {
    const round = (n) => Math.round(n);
    let total = 0, overflow = 0, ellipsized = 0;
    const bad = [], clipped = [];
    for (const card of document.querySelectorAll('.card')) {
      const meta = card.querySelector('.card__meta');
      if (!meta) continue;
      total++;
      const cb = card.getBoundingClientRect(), mb = meta.getBoundingClientRect();
      const cs = getComputedStyle(meta);
      if (round(mb.right) > round(cb.right) + 1 || round(mb.left) < round(cb.left) - 1) {
        overflow++;
        if (bad.length < 4) bad.push({ text: (meta.textContent || '').slice(0, 30), cardW: round(cb.width), metaW: round(mb.width), maxW: cs.maxWidth });
      }
      if (meta.scrollWidth > meta.clientWidth) {
        ellipsized++;
        if (clipped.length < 3) clipped.push({ text: (meta.textContent || '').slice(0, 40), clientW: meta.clientWidth, scrollW: meta.scrollWidth });
      }
    }
    return { url: location.hash, totalCards: total, metaOverflowCount: overflow, ellipsizedCount: ellipsized, bad, clipped };
  })()`);
  console.log(JSON.stringify(res, null, 1));
  ws.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
