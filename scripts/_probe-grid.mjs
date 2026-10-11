// scripts/_probe-grid.mjs — 首页卡片网格：轨道宽度 vs 卡片实际宽度（找重叠/被撑宽）
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

  const out = await evalJs(`(() => {
    const round = (n) => Math.round(n);
    const r = (el) => { const b = el.getBoundingClientRect(); return [round(b.x), round(b.y), round(b.width), round(b.height)] };
    const grids = [];
    for (const g of document.querySelectorAll('.grid')) {
      const cs = getComputedStyle(g);
      const cards = [];
      for (const card of g.querySelectorAll(':scope > .card')) {
        const meta = card.querySelector('.card__meta');
        const title = card.querySelector('.card__title');
        const art = card.querySelector('.card__art');
        const mcs = meta ? getComputedStyle(meta) : null;
        cards.push({
          rect: r(card),
          art: art ? r(art) : null,
          title: title ? { text: (title.textContent || '').slice(0, 30), rect: r(title) } : null,
          meta: meta ? { text: (meta.textContent || '').slice(0, 60), rect: r(meta), scrollW: meta.scrollWidth, clientW: meta.clientWidth, ws: mcs.whiteSpace } : null
        });
      }
      grids.push({
        cls: g.className,
        rect: r(g),
        cols: cs.gridTemplateColumns,
        display: cs.display,
        overflowX: cs.overflowX,
        cardCount: cards.length,
        cards
      });
    }
    return grids;
  })()`);
  for (const g of out ?? []) {
    console.log(`\n=== grid.${g.cls} rect=${JSON.stringify(g.rect)} display=${g.display} cols=${g.cols} overflowX=${g.overflowX} cards=${g.cardCount} ===`);
    for (const c of g.cards) {
      console.log(`  card rect=${JSON.stringify(c.rect)} art=${JSON.stringify(c.art)}`);
      console.log(`    title=${JSON.stringify(c.title?.text)} ${JSON.stringify(c.title?.rect)}`);
      console.log(`    meta=${JSON.stringify(c.meta?.text)} rect=${JSON.stringify(c.meta?.rect)} scrollW=${c.meta?.scrollW} clientW=${c.meta?.clientW} ws=${c.meta?.ws}`);
    }
  }
  ws.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
