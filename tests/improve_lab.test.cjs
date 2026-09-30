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
    'p-ct': '090300', 'p-tf': 'T-360', 'p-stopmode': 'low', 'lb-mode': 'real', 'lb-big': '-3', 'lb-mfe': '5', 'lb-ratio': '30' };
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { value: defaults[id] || '', checked: ['p-gate', 'p-cum'].includes(id), innerHTML: '', textContent: '', events: {},
      addEventListener(event, fn) { this.events[event] = fn; }, querySelectorAll() { return []; }, click() { downloads.push(this); } });
    return nodes.get(id);
  }
  const document = { getElementById: node, querySelector: () => ({ value: 'capture' }), querySelectorAll: () => [], createElement: () => node('download-' + downloads.length) };
  const context = vm.createContext({ console, document, window: {}, localStorage: { getItem: key => saved.get(key) || (key === 's4lab.versions' ? storageValue : null), setItem: (key, value) => saved.set(key, value) },
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
  vm.runInContext(read('static/improve_lab.js').replace(/buildUI\(\);\s*\}\)\(\);\s*$/, 'buildUI(); window.labTest = { L, run, applyCfg, classify, judge, renderDetail, freeze, again }; })();'), context);
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
  assert.ok(html.indexOf('src="/static/tuner.js"') < html.indexOf('src="/static/improve_lab.js"'));
  assert.match(read('static/tuner.js'), /openChart\(dkey, code, chartParams = null\)/);
});

test('real data: baseline, all prescription grids, drilldown, freeze, repeat and gate mode', async () => {
  const h = harness(); loadDays(h);
  await h.lab.run();
  const L = h.lab.L;
  assert.equal(L.P.stopMode, 'close');
  assert.equal(L.bAll.n, 230);
  assert.equal(L.bAll.sum.toFixed(2), '-16.88');
  assert.deepEqual(Array.from(L.show.slice(0, 3), c => c.all.length), [8, 9, 20]);
  assert.match(h.node('lb-sum').innerHTML, /큰 손절/);
  assert.match(h.node('lb-cands').innerHTML, /처방 후보/);
  assert.equal(h.node('lb-run').disabled, false);
  for (const c of L.show) {
    const p = c.best;
    assert.ok(Number.isFinite(p.ev.dAll));
    if (p.verdict === '추천') assert.ok(p.ev.dA > 0 && p.ev.dB > 0 && p.ev.fixed >= 3 && p.ev.broken <= p.ev.fixed / 3 && p.stable);
  }
  console.log('Lab results:', JSON.stringify(L.show.map(c => ({ title: c.title, delta: c.best.ev.dAll, verdict: c.best.verdict }))));
  h.lab.renderDetail(0);
  assert.match(h.node('lb-detail').innerHTML, /이 처방 박제/);
  h.node('lb-freeze').events.click();
  assert.equal(h.downloads[0].download, 'S4.3-L1.json');
  const frozen = JSON.parse(h.saved.get('s4lab.versions'))[0];
  assert.equal(frozen.mode, 'real'); assert.equal(frozen.common.stop, '봉종가');
  assert.equal(frozen.sha, h.T.S.sha);
  const expected = L.show[0].best.ev.all.sum;
  h.lab.again(L.show[0]);
  assert.ok(Math.abs(L.bAll.sum - expected) < 1e-9);
  while (L.busy) await new Promise(resolve => setImmediate(resolve));
  assert.equal(L.baseName, 'S4.3-L1');
  L.baseCfg = {}; L.baseName = ''; h.node('lb-mode').value = 'gate';
  await h.lab.run();
  assert.equal(L.bAll.n, 91); assert.equal(L.bAll.sum.toFixed(2), '237.80');
  assert.equal(h.alerts.length, 0);
});

test('entry filters and trailing respect entry features and first-exit cutoff', () => {
  const h = harness(); h.lab.L.P = { cost: .25 };
  const r = { o: { entered: true, open: false, entryPrice: 100, net: -3.25, pnl: -3, stop: true }, ok: true,
    f: { path: '조기', time: '0909', cum: 25, rise: 13 }, i0: 0, limTs: 3, d: { date: '20260930' },
    bars: [{ timestamp: 1, date: '20260930', high: 110, close: 90 }, { timestamp: 2, date: '20260930', time: '0910', high: 106, close: 103 }, { timestamp: 3, date: '20260930', high: 110, close: 97 }] };
  for (const cfg of [{ early: { t: 'off' } }, { early: { t: 'time', v: '0908' } }, { early: { t: 'cum', v: 30 } }, { rise: 12 }]) assert.equal(h.lab.applyCfg(r, cfg).entered, false);
  const out = h.lab.applyCfg(r, { trail: { a: 5, b: 2 } });
  assert.ok(Math.abs(out.net - 2.75) < 1e-9);
  assert.match(out.why, /이익보호 청산/);
  r.limTs = 2; assert.equal(h.lab.applyCfg(r, { trail: { a: 5, b: 2 } }).net, -3.25);
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
