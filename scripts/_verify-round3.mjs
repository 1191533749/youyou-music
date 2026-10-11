// scripts/_verify-round3.mjs — 真机验收：搜索页只展示「点了能播」的歌
//  1) 每个 query 调 search:query，记录耗时与返回条数；
//  2) 把返回的每一首都真实点播一遍，统计 PASS/FAIL（期望 0 FAIL）；
//  3) 检查界面里是否还存在「暂时无法播放」这类失败文案（期望不存在）；
//  4) 打开「正在播放」页，读顶栏与标题的 -webkit-app-region（期望 bar/heading = drag，按钮 = no-drag）。
const PORT = process.env.SWEEP_PORT ?? '9436';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function invoke(channel, payload) {
  const r = await evalJs(`window.youyou.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)})`);
  return r?.data ?? r;
}

const QUERIES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['凤凰传奇', '谁记心上', '渡情', '周杰伦', '人间烟火'];

async function waitOutcome(key, budgetMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    await sleep(500);
    const st = await invoke('player:state', undefined);
    const failed = await evalJs(`window.__failed ?? []`);
    if (failed.some((f) => String(f.id) === String(key) || String(f.externalKey ?? '') === String(key)))
      return { result: 'FAIL', reason: 'trackFailed(行已隐藏)', state: st };
    if (st.playing && st.track && !st.loading && st.position > 0.4)
      return { result: 'PASS', reason: `pos=${st.position.toFixed(1)} from=${st.servedFrom ?? '官方'}`, state: st };
    if (!st.loading && !st.playing && st.queue?.length === 0)
      return { result: 'FAIL', reason: '安静停住(队列已剔空)', state: st };
  }
  const st = await invoke('player:state', undefined);
  return { result: 'TIMEOUT', reason: `loading=${st.loading} playing=${st.playing} pos=${st.position}`, state: st };
}

async function uiCheck(label) {
  const r = await evalJs(`(() => {
    const err = document.querySelector('.player-bar__error');
    const body = document.body.innerText || '';
    return { banner: err ? err.textContent : null, hasForbiddenText: body.includes('暂时无法播放'), hasFailToast: body.includes('播放失败') };
  })()`);
  console.log(`  [UI ${label}] 播放条错误文案=${r.banner === null ? '无' : JSON.stringify(r.banner)} 含"暂时无法播放"=${r.hasForbiddenText} 含"播放失败"=${r.hasFailToast}`);
  return r;
}

async function main() {
  const url = await findPageWs();
  console.log(`CDP target: ${url}`);
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
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('ws error'));
  });
  await send('Runtime.enable');
  await evalJs(`window.__failed = []; window.youyou.on('player:trackFailed', (d) => { window.__failed.push(d); })`);

  const me = await invoke('auth:state', undefined).catch(() => null);
  const profile = me?.profile ?? me;
  console.log(`登录态: ${profile?.nickname ?? '(未登录)'} vip=${profile?.vipType ?? '?'}`);

  const fails = [];
  let tested = 0;
  let passed = 0;
  const perQuery = [];

  for (const q of QUERIES) {
    console.log(`\n=== 搜索「${q}」 ===`);
    const t0 = Date.now();
    let page;
    try {
      page = await invoke('search:query', { keywords: q, type: 'songs', limit: 30, offset: 0 });
    } catch (e) {
      console.log(`  搜索失败: ${e.message}`);
      continue;
    }
    const elapsed = Date.now() - t0;
    const songs = page?.songs ?? [];
    const external = page?.external ?? [];
    console.log(`  返回 ${songs.length} 首 + 站外 ${external.length} 条（耗时 ${(elapsed / 1000).toFixed(1)}s）`);
    console.log(`  曲目: ${songs.map((s) => s.name).join(' / ')}`);
    perQuery.push({ q, elapsedMS: elapsed, songs: songs.length, external: external.length });

    for (const s of songs.slice(0, 12)) {
      tested++;
      await evalJs(`window.__failed = []`);
      try {
        await invoke('player:playTracks', { tracks: [s] });
      } catch (e) {
        fails.push({ q, kind: 'netease', name: s.name, reason: 'invoke throw: ' + e.message });
        console.log(`  FAIL(invoke) ${s.name}: ${e.message}`);
        continue;
      }
      const o = await waitOutcome(s.id, 20_000);
      if (o.result === 'PASS') {
        passed++;
        console.log(`  ok   ${s.name} - ${s.artists?.[0]?.name} [${o.reason}]`);
      } else {
        fails.push({ q, kind: 'netease', id: s.id, name: s.name, artist: s.artists?.[0]?.name, fee: s.fee, pb: s.playability, reason: o.reason });
        console.log(`  FAIL ${s.name} - ${s.artists?.[0]?.name} fee=${s.fee} pb=${s.playability} :: ${o.reason}`);
      }
    }

    for (const item of external.slice(0, 4)) {
      tested++;
      await evalJs(`window.__failed = []`);
      try {
        await invoke('player:playExternal', { item });
      } catch (e) {
        fails.push({ q, kind: 'external', name: item.name, reason: 'invoke throw: ' + e.message });
        console.log(`  FAIL(invoke) ext ${item.name}: ${e.message}`);
        continue;
      }
      const o = await waitOutcome(`${item.source}:${item.sourceId}`, 20_000);
      if (o.result === 'PASS') {
        passed++;
        console.log(`  ok   ext ${item.name} - ${item.artists} [${o.reason}]`);
      } else {
        fails.push({ q, kind: 'external', source: item.source, sourceId: item.sourceId, name: item.name, reason: o.reason });
        console.log(`  FAIL ext ${item.name} - ${item.artists} [${item.source}] :: ${o.reason}`);
      }
    }
    await uiCheck(q);
  }

  // 「正在播放」页：窗口拖动与按钮不抢点击
  console.log('\n=== 正在播放页拖动区 ===');
  const drag = await evalJs(`(() => {
    const art = document.querySelector('.player-bar__art');
    if (!art) return { error: '找不到播放条封面，无法进入正在播放页' };
    art.click();
    return { clicked: true };
  })()`);
  if (drag.error) console.log('  ' + drag.error);
  else {
    await sleep(1200);
    const probe = await evalJs(`(() => {
      const get = (sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); return { region: cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region'), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) }; };
      const bar = get('.np-fs__bar');
      const heading = get('.np-fs__heading');
      const btn = document.querySelector('.np-fs__bar button, .np-fs__bar .back-button');
      const btnRegion = btn ? (getComputedStyle(btn).webkitAppRegion || getComputedStyle(btn).getPropertyValue('-webkit-app-region')) : null;
      const rules = [];
      for (const sheet of document.styleSheets) {
        let list; try { list = sheet.cssRules } catch { continue }
        for (const rule of list) if (rule.selectorText && rule.selectorText.includes('np-fs__bar')) rules.push(rule.cssText.slice(0, 120));
      }
      return { hasPage: !!document.querySelector('.np-fullscreen'), bar, heading, btnRegion, rules: rules.slice(0, 6) };
    })()`);
    console.log(`  正在播放页存在=${probe.hasPage} 顶栏=${JSON.stringify(probe.bar)} 标题=${JSON.stringify(probe.heading)} 顶栏按钮=${JSON.stringify(probe.btnRegion)}`);
    for (const r of probe.rules ?? []) console.log(`  规则: ${r}`);
    await evalJs(`(() => { const b = document.querySelector('.np-fullscreen .back-button'); if (b) b.click(); return true })()`);
    await sleep(600);
  }

  await invoke('player:pause', undefined).catch(() => {});
  await invoke('player:clearQueue', undefined).catch(() => {});
  console.log(`\n===== 验收结果 tested=${tested} passed=${passed} failed=${fails.length} =====`);
  console.log('搜索耗时/条数: ' + JSON.stringify(perQuery));
  if (fails.length) console.log(JSON.stringify(fails, null, 1));
  ws.close();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
