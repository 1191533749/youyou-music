// scripts/_probe-user-search.mjs — CDP sweep: 复现用户反馈「搜索页部分歌曲播放不了」
// 对每个 query 调 search:query（单曲 tab 同款数据），逐首真实播放并记录成败。
const WS_URL = process.env.SWEEP_WS ?? 'ws://127.0.0.1:9436/devtools/page/FB11A56590134A43ACF031E678BFEAAD';

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

// window.youyou.invoke 返回 {ok, data} 信封；这里解包（抛错原样上抛）
async function invoke(channel, payload) {
  const r = await evalJs(`window.youyou.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)})`);
  return r?.data ?? r;
}

const QUERIES = (process.argv.slice(2).length ? process.argv.slice(2) : [
  '人间悠扬', '姑娘', '周杰伦', '林俊杰', '陈奕迅', '王力宏', '邓紫棋', '薛之谦',
  '刀郎', '凤凰传奇', '许嵩', '周深', '渡情', '人间烟火', '谁记心上', '爱如火', '乌梅子酱', '可能'
]);

async function waitForOutcome(kind, key, name, budgetMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    await sleep(700);
    const st = await invoke('player:state', undefined);
    const failed = await evalJs(`window.__failed ?? []`);
    const hit = failed.find((f) => String(f.id) === String(key));
    if (hit) return { result: 'FAIL', reason: 'trackFailed', state: st, hit };
    if (st.playing && st.track && !st.loading && st.position > 0.4) {
      return { result: 'PASS', reason: `pos=${st.position.toFixed(1)} from=${st.servedFrom ?? ''}`, state: st };
    }
    if (st.error && !st.loading && !st.playing) {
      // 单曲队列失败落定：error + 不播放
      if (st.queue?.length === 0) return { result: 'FAIL', reason: `error=${st.error}`, state: st };
    }
  }
  const st = await invoke('player:state', undefined);
  return { result: 'TIMEOUT', reason: `loading=${st.loading} playing=${st.playing} pos=${st.position}`, state: st };
}

async function main() {
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  await send('Runtime.enable');
  await evalJs(`window.__failed = []; window.youyou.on('player:trackFailed', (d) => { window.__failed.push(d); })`);
  console.log('trackFailed listener attached');

  const fails = [];
  let tested = 0, passed = 0;
  for (const q of QUERIES) {
    console.log(`\n=== query: ${q} ===`);
    let page;
    try {
      page = await invoke('search:query', { keywords: q, type: 'songs', limit: 30, offset: 0 });
    } catch (e) {
      console.log('  search FAILED:', e.message);
      continue;
    }
    const songs = page?.songs ?? [];
    const external = page?.external ?? [];
    console.log(`  netease=${songs.length} external=${external.length}`);

    for (const s of songs.slice(0, 12)) {
      tested++;
      await evalJs(`window.__failed = []`);
      try {
        await invoke('player:playTracks', { tracks: [s] });
      } catch (e) {
        fails.push({ q, kind: 'netease', name: s.name, artist: s.artists?.[0]?.name, fee: s.fee, pb: s.playability, reason: 'invoke throw: ' + e.message });
        console.log(`  FAIL(invoke) ${s.name} - ${s.artists?.[0]?.name}: ${e.message}`);
        continue;
      }
      const o = await waitForOutcome('netease', s.id, s.name, 30000);
      if (o.result === 'PASS') { passed++; console.log(`  ok   ${s.name} - ${s.artists?.[0]?.name} [${o.reason}]`); }
      else {
        fails.push({ q, kind: 'netease', id: s.id, name: s.name, artist: s.artists?.[0]?.name, fee: s.fee, pb: s.playability, reason: o.reason, state: { error: o.state?.error, source: o.state?.source, queue: o.state?.queue?.length } });
        console.log(`  FAIL ${s.name} - ${s.artists?.[0]?.name} fee=${s.fee} pb=${s.playability} :: ${o.reason}`);
      }
    }

    for (const item of external.slice(0, 6)) {
      tested++;
      const key = `${item.source}:${item.sourceId}`;
      await evalJs(`window.__failed = []`);
      try {
        await invoke('player:playExternal', { item });
      } catch (e) {
        fails.push({ q, kind: 'external', source: item.source, name: item.name, artist: item.artists, reason: 'invoke throw: ' + e.message });
        console.log(`  FAIL(invoke) ext ${item.name} - ${item.artists}: ${e.message}`);
        continue;
      }
      const o = await waitForOutcome('external', key, item.name, 30000);
      if (o.result === 'PASS') { passed++; console.log(`  ok   ext ${item.name} - ${item.artists} [${o.reason}]`); }
      else {
        fails.push({ q, kind: 'external', source: item.source, sourceId: item.sourceId, name: item.name, artist: item.artists, reason: o.reason, state: { error: o.state?.error, source: o.state?.source } });
        console.log(`  FAIL ext ${item.name} - ${item.artists} [${item.source}] :: ${o.reason}`);
      }
    }
  }

  await invoke('player:clearQueue', undefined).catch(() => {});
  console.log(`\n===== DONE tested=${tested} passed=${passed} failed=${fails.length} =====`);
  console.log(JSON.stringify(fails, null, 1));
  ws.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
