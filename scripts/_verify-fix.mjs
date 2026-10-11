// scripts/_verify-fix.mjs — 修复后重测：之前失败的曲目现在必须出声（看门狗换源）或自动跳过（不挂 0:00）
const WS_URL = process.env.VERIFY_WS ?? 'ws://127.0.0.1:9436/devtools/page/392B2D2CC5859E01DD21F50574D804FB';

let msgId = 0;
const pending = new Map();
const ws = new WebSocket(WS_URL);

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message));
    else resolve(m.result);
  }
};
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error('EVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function invoke(channel, payload) {
  const r = await evalJs(`window.youyou.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)})`);
  return r?.data ?? r;
}

// [query, songId, 类别]
const TARGETS = [
  ['周杰伦', 400876427, '官方死流(卡0:00)'],
  ['凤凰传奇', 1298436957, '官方死流 fee=8'],
  ['凤凰传奇', 29418062, '官方死流 Live'],
  ['许嵩', 167786, 'open挂死(loading恒真)'],
  ['许嵩', 3394036706, '全源失败 fee=8'],
  ['渡情', 3433460057, '全源失败 fee=8'],
  ['渡情', 3416457431, '全源失败 fee=0']
];

async function waitForOutcome(key, budgetMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < budgetMs) {
    await sleep(700);
    last = await invoke('player:state', undefined);
    const failed = await evalJs(`window.__failed ?? []`);
    const hit = failed.find((f) => String(f.id) === String(key));
    if (hit) return { result: 'SKIPPED', reason: 'trackFailed+隐藏', state: last, hit };
    if (last.playing && last.track && !last.loading && last.position > 0.4) {
      return { result: 'PLAYS', reason: `pos=${last.position.toFixed(1)} from=${last.servedFrom ?? 'netease'}`, state: last };
    }
  }
  return { result: 'HANG', reason: `loading=${last?.loading} playing=${last?.playing} pos=${last?.position} error=${last?.error ?? '-'}`, state: last };
}

async function main() {
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  await send('Runtime.enable');
  await evalJs(`window.__failed = []; window.youyou.on('player:trackFailed', (d) => { window.__failed.push(d); })`);

  const results = [];
  for (const [q, id, cls] of TARGETS) {
    const page = await invoke('search:query', { keywords: q, type: 'songs', limit: 30, offset: 0 });
    const song = (page?.songs ?? []).find((s) => s.id === id);
    if (!song) { console.log(`MISS  ${id} in "${q}"`); results.push({ id, cls, result: 'MISS' }); continue; }
    await evalJs(`window.__failed = []`);
    await invoke('player:playTracks', { tracks: [song] });
    const o = await waitForOutcome(id, 45000);
    console.log(`${o.result.padEnd(7)} id=${id} [${cls}] :: ${o.reason}`);
    results.push({ id, name: song.name, cls, result: o.result, reason: o.reason });
  }
  console.log('\n===== SUMMARY =====');
  for (const r of results) console.log(`${r.result} | ${r.id} | ${r.name} | ${r.cls}`);
  console.log(`HANG=${results.filter((r) => r.result === 'HANG').length} PLAYS=${results.filter((r) => r.result === 'PLAYS').length} SKIPPED=${results.filter((r) => r.result === 'SKIPPED').length}`);
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
