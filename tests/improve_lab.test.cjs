const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

function harness(storageValue = null) {
  const nodes = new Map(), saved = new Map(), downloads = [], alerts = [], chartCalls = [];
  const defaults = { 'p-strat': 'S4.3', 'p-n0': '5.5', 'p-macd': '0.15', 'p-mincum': '3', 'p-hs': '-3', 'p-cost': '0.25',
    'p-vfrom': '5.5', 'p-vto': '5.5', 'p-vstep': '0.5', 'p-xfrom': '4', 'p-xto': '14', 'p-xstep': '1', 'p-k': '2',
    'p-ct': '090300', 'p-tf': 'T-360', 'p-stopmode': 'low', 'lb-mode': 'real', 'lb-big': '-3', 'lb-mfe': '5', 'lb-ratio': '30', 'lb-dmg': '50' };
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { value: defaults[id] || '', checked: ['p-gate', 'p-cum'].includes(id), innerHTML: '', textContent: '', events: {},
      addEventListener(event, fn) { this.events[event] = fn; }, querySelectorAll() { return []; }, click() { downloads.push(this); } });
    return nodes.get(id);
  }
  const document = { getElementById: node, querySelector: () => ({ value: 'capture' }), querySelectorAll: () => [], createElement: () => node('download-' + downloads.length) };
  const context = vm.createContext({ console, document, window: {}, TextDecoder, crypto: require('node:crypto').webcrypto, fetch: async () => ({ ok: true, arrayBuffer: async () => { const b = Buffer.from(read('static/app.js')); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } }), localStorage: { getItem: key => saved.get(key) || (key === 's4lab.versions' ? storageValue : null), setItem: (key, value) => saved.set(key, value) },
    setTimeout: fn => { fn(); return 1; }, Blob, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} }, alert: message => alerts.push(message) });
  const tuner = read('static/tuner.js');
  vm.runInContext(tuner.slice(0, tuner.indexOf('(function addStopBox()')) + '\n})();', context);
  const T = context.window.S4T;
  const original = read('static/app.js'), match = original.match(/\(\s*function\s*\(\s*\)\s*\{/);
  T.S.F = new Function('window', 'document', original.slice(match.index + match[0].length, original.lastIndexOf('})')) + '\nreturn evaluateStrategyTrade;')(
    { addEventListener() {} }, { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} });
  const actualOpenChart = T.openChart;
  T.openChart = (...args) => chartCalls.push(args);
  T.S.sha = require('node:crypto').createHash('sha256').update(original).digest('hex');
  T.S.ok = true;
  vm.runInContext(read('static/improve_lab.js').replace(/buildUI\(\);\s*\}\)\(\);\s*$/, 'buildUI(); window.labTest = { L, run, applyCfg, classify, judge, renderDetail, freeze, again, neighbors, simRecs, loadVariant, ensureSim, simKey, recsFor }; })();'), context);
  return { T, actualOpenChart, lab: context.window.labTest, node, saved, downloads, alerts, chartCalls };
}
function loadDays(h) {
  for (const file of fs.readdirSync(path.join(root, 'data')).filter(f => /^strategy-audit-.*\.json$/.test(f))) {
    const data = JSON.parse(read('data/' + file));
    for (const day of data.days || []) {
      const date = day.settings.targetDate;
      const d = { key: date, date, ct: '090300', tf: 'T-360', cases: day.cases };
      for (const c of d.cases) {
        const prev = (c.daily || []).filter(b => String(b.date) < date).sort((a, b) => String(a.date).localeCompare(String(b.date))).pop();
        const seed = c.candles.filter(b => b.date < date && b.time <= '1530');
        c._prev = prev ? prev.close : seed.length ? seed[seed.length - 1].close : null;
      }
      h.T.S.days.push(d); h.T.S.use[d.key] = true;
    }
  }
}

test('Lab is connected after tuner and remains gated by reproduction check', () => {
  const html = read('static/tuner.html');
  assert.match(html, /<button data-t="lab" disabled>6 개선Lab<\/button>/);
  assert.ok(html.indexOf('id="t-lab"') < html.indexOf('src="/static/tuner.js"'));
  assert.ok(html.indexOf('src="/static/tuner.js"') < html.indexOf('src="/static/improve_lab.js?v=lab-resim-3"'));
  assert.match(read('static/tuner.js'), /openChart\(dkey, code, chartParams = null\)/);
});

test('real data: baseline, all prescription grids, drilldown, freeze, repeat and gate mode', async () => {
  const h = harness(); loadDays(h);
  await h.lab.run();
  const L = h.lab.L;
  assert.equal(L.P.stopMode, 'close');
  assert.equal(L.vOK, true);
  assert.ok(L.sims.size >= 14);
  const off = L.sims.get(JSON.stringify([{ t: 'off' }, null, null, null]));
  assert.ok(off.some((r, i) => r.o.entered && r.o.idx !== L.recs0[i].o.idx), 'disabling early entry must resimulate later entries');
  const early = L.show.find(c => c.key === 'early');
  const neighbors = h.lab.neighbors('early', early.all, early.all.find(p => p.g.t === 'off'));
  assert.deepEqual(Array.from(neighbors, p => p.g.v), ['0906', 30, .35]);
  assert.equal(L.bAll.n, 230);
  assert.equal(L.bAll.sum.toFixed(2), '-16.88');
  assert.deepEqual(Array.from(L.show.slice(0, 4), c => c.all.length), [10, 4, 6, 16]);
  assert.match(h.node('lb-sum').innerHTML, /큰 손절/);
  assert.match(h.node('lb-cands').innerHTML, /처방 후보/);
  const hs = L.show.find(c => c.key === 'hs');
  assert.ok(hs.all.every(p => p.g !== -3));
  assert.match(hs.best.label, /하드스탑 -3% →/);
  h.lab.renderDetail(L.show.indexOf(hs));
  assert.match(h.node('lb-detail').innerHTML, /좋아진 거래/);
  assert.equal(h.node('lb-run').disabled, false);
  for (const c of L.show) {
    const p = c.best;
    assert.ok(Number.isFinite(p.ev.dAll));
    if (p.verdict === '추천') assert.ok(p.ev.dA > 0 && p.ev.dB > 0 && p.ev.fixed >= 3 && p.ev.loss <= p.ev.gain * L.Q.dmg / 100 && p.stable);
  }
  console.log('Lab results:', JSON.stringify(L.show.map(c => ({ title: c.title, delta: c.best.ev.dAll, verdict: c.best.verdict }))));
  h.lab.renderDetail(0);
  assert.match(h.node('lb-detail').innerHTML, /이 처방 박제/);
  h.node('lb-freeze').events.click();
  assert.equal(h.downloads[0].download, 'S4.3-L1.json');
  const frozen = JSON.parse(h.saved.get('s4lab.versions'))[0];
  assert.equal(frozen.lab, 'lab-resim-3');
  assert.match(h.node('t-lab').innerHTML, /lab-resim-3/);
  assert.equal(frozen.mode, 'real'); assert.equal(frozen.common.stop, '봉종가');
  assert.equal(frozen.sha, h.T.S.sha);
  const originalEngine = h.T.S.F;
  assert.equal(L.vOK, true); assert.ok(L.sims.size >= 14);
  const expected = L.show[0].best.ev.all.sum;
  h.lab.again(L.show[0]);
  while (L.busy) await new Promise(resolve => setImmediate(resolve));
  assert.ok(Math.abs(L.bAll.sum - expected) < 1e-9);
  assert.equal(h.T.S.F, originalEngine);
  assert.equal(L.baseName, 'S4.3-L1');
  L.baseCfg = {}; L.baseName = ''; h.node('lb-mode').value = 'gate';
  await h.lab.run();
  assert.equal(L.bAll.n, 91); assert.equal(L.bAll.sum.toFixed(2), '237.80');
  assert.equal(h.alerts.length, 0);
});

test('applyCfg exposes simulated outcomes without blocking or repricing them again', () => {
  const h = harness();
  const r = { o: { entered: true, open: false, net: 2.75, pnl: 3, stop: false } };
  const result = h.lab.applyCfg(r, { rise: 0, trail: { a: 1, b: 1 } });
  assert.equal(result.entered, true); assert.equal(result.net, 2.75);
});

test('empty days and damaged storage do not crash or leave the run button locked', async () => {
  const h = harness('{broken');
  assert.equal(h.lab.L.versions.length, 0);
  await h.lab.run();
  assert.match(h.node('lb-prog').textContent, /사용할 날짜/);
  assert.equal(h.lab.L.busy, false); assert.equal(h.node('lb-run').disabled, false);
  h.T.S.ok = false; await h.lab.run(); assert.equal(h.alerts.length, 1);
});

test('Lab chart uses its own real/close parameters even after a different experiment', () => {
  const h = harness(); loadDays(h);
  const d = h.T.S.days.find(d => d.cases.length), c = d.cases[0];
  const P = { ...h.T.params(), strat: 'S4.3', real: true, gate: false, stopMode: 'close' };
  h.T.S.exp = { P: { ...P, real: false, stopMode: 'low' }, best: { v: 5.5, x: null } };
  h.T.S.chart = { applyOptions() {}, timeScale: () => ({ fitContent() {} }) };
  const series = { setData() {}, setMarkers() {} };
  h.T.S.ser = { c: series, b: series, v: series, s: series };
  h.actualOpenChart(d.key, c.code, P);
  assert.equal(h.T.S.cur.P, P);
  assert.match(h.node('ch-info').innerHTML, /1516 MFE/);
  assert.doesNotMatch(h.node('ch-info').innerHTML, /<b style="color:#a78bfa">새 버전/);
});

test('variant rejects source hash mismatch and restores shared engine after evaluation failure', async () => {
  const bad = harness(); bad.T.S.sha = 'wrong';
  await assert.rejects(bad.lab.loadVariant(), /app.js가 튜너 로드 이후 바뀌었습니다/);
  const h = harness(); loadDays(h); await h.lab.loadVariant();
  const original = h.T.S.F;
  h.lab.L.P = h.T.params(); h.lab.L.days = h.T.S.days;
  h.T.evalCase = () => { throw new Error('injected evaluation failure'); };
  await assert.rejects(h.lab.simRecs({ early: { t: 'off' } }, 'test'), /injected evaluation failure/);
  assert.equal(h.T.S.F, original);
});

test('damage verdict uses amounts, including zero tolerance, rather than winner counts', () => {
  const h = harness(); h.lab.L.Q = { dmg: 50 };
  const make = () => ({ stable: true, ev: { dA: 1, dB: 1, dAll: 2, fixed: 3, broken: 99, gain: 10, loss: 5 } });
  let p = make(); h.lab.judge(p); assert.equal(p.verdict, '추천');
  p = make(); p.ev.loss = 5.01; h.lab.judge(p); assert.equal(p.verdict, '보류');
  h.lab.L.Q.dmg = 0; p = make(); h.lab.judge(p); assert.equal(p.verdict, '보류');
});

test('hard-stop reruns match the original engine, joint variants are isolated and cache is reused', async () => {
  const h = harness(); loadDays(h);
  const L = h.lab.L;
  L.P = { ...h.T.params(), real: true, gate: false, stopMode: 'close' };
  L.days = h.T.usedDays(); L.sims = new Map();
  await h.lab.loadVariant();
  const original = h.T.S.F, evalCase = h.T.evalCase;
  let calls = 0;
  h.T.evalCase = (...args) => { calls++; return evalCase(...args); };
  const cfg = { hs: -2.5 };
  await h.lab.ensureSim(cfg);
  const recs = h.lab.recsFor(cfg), firstCalls = calls;
  assert.ok(firstCalls > 0);
  for (const r of recs) {
    const direct = evalCase(r.d, r.c, { ...L.P, hardStop: -2.5 }, 'capture', L.P.N0);
    assert.deepEqual(r.o, direct.o);
  }
  const fullCfg = { ...cfg, rise: 16, trail: { a: 5, b: 2 } };
  await h.lab.ensureSim(fullCfg);
  assert.equal(calls, firstCalls * 2);
  await h.lab.ensureSim(fullCfg);
  assert.equal(calls, firstCalls * 2);
  assert.notEqual(h.lab.recsFor(fullCfg), recs);
  const full = h.lab.recsFor(fullCfg);
  assert.ok(full.filter(r => r.ok && r.f.rise != null).every(r => r.f.rise <= fullCfg.rise + 1e-9));
  const trailed = full.filter(r => r.o.reason === '이익보호트레일');
  assert.ok(trailed.length > 0, 'engine must produce actual trailing-exit markers');
  for (const r of trailed) {
    const exit = r.mk.find(m => /이익보호트레일/.test(m.text || ''));
    assert.ok(exit);
    assert.ok(!r.mk.some(m => /익절/.test(m.text || '') && m.time < exit.time));
    const entry = r.mk.find(m => m.position === 'belowBar');
    assert.ok(exit.time > entry.time, 'entry-bar high must not trigger an exit');
  }
  assert.equal(h.lab.recsFor(cfg), recs);
  const combined = { early: { t: 'macd', v: .3 }, hs: -2.5 };
  await h.lab.ensureSim(combined);
  assert.equal(calls, firstCalls * 3);
  assert.notEqual(h.lab.recsFor(combined), recs);
  assert.ok(h.lab.recsFor(combined).some((r, i) => r.o.idx !== recs[i].o.idx));
  await h.lab.ensureSim(combined); assert.equal(calls, firstCalls * 3);
  assert.equal(L.P.hardStop, -3); assert.equal(h.T.S.F, original);
});
