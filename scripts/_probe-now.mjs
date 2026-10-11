// scripts/_probe-now.mjs — 用户在用的实例此刻长什么样：路由 / 搜索词 / 结果行 / 播放器状态
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

  const routes = await evalJs(`(() => {
    const input = document.querySelector('input');
    const rows = [];
    for (const el of document.querySelectorAll('.song-row, .song-list__row, [class*="song-row"]')) {
      const t = el.querySelector('[class*="song-row__title"], [class*="title"]');
      const a = el.querySelector('[class*="artist"]');
      rows.push({ i: rows.length, title: (t?.textContent || '').trim().slice(0, 40), artist: (a?.textContent || '').trim().slice(0, 30), cls: el.className.slice(0, 40) });
    }
    return {
      hash: location.hash,
      searchInput: input ? input.value : null,
      rowCount: rows.length,
      rows: rows.slice(0, 14),
      playerBarText: (document.querySelector('.player-bar')?.innerText || '').replace(/\\n/g, ' | ').slice(0, 200),
      errorTexts: [...document.querySelectorAll('[class*="error"]')].map((e) => (e.textContent || '').trim().slice(0, 60)).filter(Boolean).slice(0, 5)
    };
  })()`);
  console.log(JSON.stringify(routes, null, 1));

  let state = null;
  try {
    const r = await evalJs(`window.youyou.invoke('player:state', {}).then(r => JSON.stringify(r?.data ?? r))`);
    state = r;
  } catch (e) {
    state = 'ERR ' + e.message;
  }
  console.log('player:state =', typeof state === 'string' ? state.slice(0, 600) : JSON.stringify(state));
  ws.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
