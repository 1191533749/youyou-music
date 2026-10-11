// scripts/_probe-artist-dom.mjs — 定位「歌手名那一行」在真实界面里的位置与溢出情况
const PORT = process.env.SWEEP_PORT ?? '9436';

async function findPageWs() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) ?? list.find((t) => t.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('找不到页面 target');
  return page.webSocketDebuggerUrl;
}

let msgId = 0;
const pending = new Map();
let ws;
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error('EVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

const NEEDLES = process.argv.slice(2);

async function main() {
  const url = await findPageWs();
  ws = new WebSocket(url);
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

  const state = await evalJs(`window.youyou.invoke('player:state', undefined).then(r => r?.data ?? r)`);
  console.log('当前播放:', JSON.stringify({ name: state?.track?.name, artists: (state?.track?.artists ?? []).map((a) => a.name), from: state?.servedFrom }));
  console.log('视图:', await evalJs(`location.hash || '(none)'`));
  console.log('窗口:', await evalJs(`JSON.stringify({w: innerWidth, h: innerHeight})`));

  const info = await evalJs(`(() => {
    const needles = ${JSON.stringify(NEEDLES)};
    const pick = (el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const chain = [];
      let n = el;
      while (n && n !== document.body && chain.length < 5) { chain.push(n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).join('.') : '')); n = n.parentElement; }
      return {
        text: (el.textContent || '').slice(0, 80),
        chain,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        overflow: cs.overflow, textOverflow: cs.textOverflow, whiteSpace: cs.whiteSpace,
        scrollW: el.scrollWidth, clientW: el.clientWidth,
        display: cs.display, position: cs.position, zIndex: cs.zIndex, flex: cs.flex, minWidth: cs.minWidth, maxWidth: cs.maxWidth
      };
    };
    const out = [];
    for (const needle of needles) {
      const hits = [];
      for (const el of document.querySelectorAll('*')) {
        if (el.children.length === 0 && (el.textContent || '').includes(needle)) hits.push(pick(el));
        else if ((el.textContent || '').includes(needle) && !Array.from(el.children).some((c) => (c.textContent || '').includes(needle))) hits.push(pick(el));
      }
      out.push({ needle, hits: hits.slice(0, 4) });
    }
    return out;
  })()`);
  for (const group of info ?? []) {
    console.log(`\n--- 含「${group.needle}」的元素 ${group.hits.length} 个 ---`);
    for (const h of group.hits) {
      console.log(`  ${h.chain.join(' < ')}`);
      console.log(`    rect=${JSON.stringify(h.rect)} scrollW=${h.scrollW} clientW=${h.clientW} overflow=${h.overflow} ellipsis=${h.textOverflow} ws=${h.whiteSpace} minW=${h.minWidth} maxW=${h.maxWidth}`);
      console.log(`    text=${JSON.stringify(h.text)}`);
    }
  }

  // 播放条里所有元素的几何：看有没有东西压在歌手行上
  const bar = await evalJs(`(() => {
    const bar = document.querySelector('.player-bar');
    if (!bar) return null;
    const out = [];
    for (const el of bar.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cls = typeof el.className === 'string' ? el.className : '';
      const txt = (el.children.length === 0 ? el.textContent : '').trim().slice(0, 40);
      const cs = getComputedStyle(el);
      out.push({ tag: el.tagName.toLowerCase(), cls, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], radius: cs.borderRadius, bg: cs.backgroundColor, txt });
    }
    return { bar: (() => { const r = bar.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] })(), out };
  })()`);
  if (bar) {
    console.log(`\n=== 播放条 rect=${JSON.stringify(bar.bar)} ===`);
    for (const el of bar.out) console.log(`  ${el.tag}.${el.cls} rect=${JSON.stringify(el.rect)} radius=${el.radius} bg=${el.bg} text=${JSON.stringify(el.txt)}`);
  }

  ws.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
