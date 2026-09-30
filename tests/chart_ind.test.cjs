const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'static/app.js'), 'utf8');
const panel = fs.readFileSync(path.join(root, 'static/chart_ind.js'), 'utf8');
function harness(fetcher) {
  const nodes = new Map(), charts = [];
  const node = id => { if (!nodes.has(id)) nodes.set(id, { innerHTML: '', clientWidth: 900, insertAdjacentElement() {} }); return nodes.get(id); };
  function chart() {
    const scale = { range: { from: 0, to: 2 }, listeners: [], getVisibleLogicalRange() { return this.range; }, setVisibleLogicalRange(r) { this.range = r; this.listeners.forEach(fn => fn(r)); }, subscribeVisibleLogicalRangeChange(fn) { this.listeners.push(fn); } };
    const series = { data: [], markers: [], lines: [], setData(v) { this.data = v; }, setMarkers(v) { this.markers = v; }, createPriceLine(v) { this.lines.push(v); return v; }, removePriceLine(v) { this.lines = this.lines.filter(x => x !== v); } };
    const c = { series, crosshairs: [], timeScale: () => scale, addHistogramSeries: () => series, subscribeCrosshairMove(fn) { this.crosshairs.push(fn); }, applyOptions() {} };
    charts.push(c); return c;
  }
  const main = chart();
  const S = { sha: crypto.createHash('sha256').update(source).digest('hex'), chart: main, ser: { c: main.series } };
  const window = { S4T: { S, esc: s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])) }, addEventListener() {} };
  const response = () => { const b = Buffer.from(source); return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; };
  const context = vm.createContext({ window, document: { getElementById: node, createElement: () => ({}) }, console, TextDecoder, crypto: crypto.webcrypto,
    fetch: fetcher || (async () => response()), LightweightCharts: { createChart: chart } });
  vm.runInContext(panel.replace('window.S4X = {', 'window.panelTest = { X, judgeAt, markersFor }; window.S4X = {'), context);
  return { api: window.S4X, internals: window.panelTest, node, charts, S, response };
}
function input(key = 'day') {
  const bars = [ { date: '20260929', time: '1530', timestamp: 1, open: 100, close: 100, volume: 1 },
    { date: '20260930', time: '0905', timestamp: 2, open: 100, close: 105, volume: 10, amount: 2e9 },
    { date: '20260930', time: '0906', timestamp: 3, open: 105, close: 104, volume: 10 } ];
  const markers = [{ time: 2, position: 'belowBar', shape: 'arrowUp', text: '진입' }, { time: 3, position: 'aboveBar', shape: 'arrowDown', text: '청산' }];
  return { d: { key, date: '20260930', tf: 'T-360' }, c: { code: 'test' }, P: { strat: 'S4.3', real: true, gate: false, macd: .15, cumGate: true, minCum: 3 }, bars,
    b: { o: { entered: true, idx: 1 }, r: { basePrice: 110, markers } }, mk: markers };
}
test('MACD uses original functions/parameters, draws thresholds, hover and synchronized ranges', async () => {
  const h = harness(), p = input();
  h.api.setVariant({ key: 'day|test', name: 'MACD .30', baseEA: { on: true, t: '0912', cum: 15, macd: .2 }, newEA: { on: true, t: '0912', cum: 15, macd: .3 },
    rec: { o: { entered: true, idx: 1 }, mk: p.mk }, res: { entered: true, net: 1 } });
  await h.api.onDraw(p);
  const X = h.internals.X;
  assert.deepEqual(Array.from(X.prm), [5, 13, 4]);
  const start = source.match(/\(\s*function\s*\(\s*\)\s*\{/), body = source.slice(start.index + start[0].length, source.lastIndexOf('})'));
  const fn = new Function('window', 'document', body + '\nreturn {macd:calcNormalizedMACD,cum:calcDailyCumulativeAmount};')({ addEventListener() {} }, { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} });
  const expected = fn.macd(p.bars, 5, 13, 4);
  assert.equal(X.ser.data[0].value, expected[1].value);
  assert.equal(X.map.get(2).cum, 20);
  assert.deepEqual(Array.from(X.ser.lines, l => l.price), [.15, .2, .3]);
  assert.equal(X.ser.markers.length, 2);
  assert.ok(h.S.ser.c.markers.some(m => m.color === '#a78bfa'));
  h.charts[0].crosshairs[0]({ time: 2 }); assert.match(h.node('ci-hover').innerHTML, /20.0억/);
  h.charts[0].timeScale().setVisibleLogicalRange({ from: 1, to: 4 }); assert.equal(X.chart.timeScale().range.to, 4);
  X.chart.timeScale().setVisibleLogicalRange({ from: 0, to: 8 }); assert.equal(h.S.chart.timeScale().range.to, 8);
  assert.match(h.node('ci-head').innerHTML, /5, 13, 4/);
  await h.api.onDraw(p); assert.equal(X.ser.markers.length, 1); assert.equal(X.ser.lines.length, 2);
});
test('blocked entries have no new markers and trailing exits replace later raw exits', async () => {
  const h = harness(), p = input();
  const v = { key: 'day|test', name: 'blocked', rec: { o: { entered: true, idx: 1 }, mk: p.mk }, res: { entered: false }, baseEA: { on: true, t: '0912', cum: 15, macd: .2 }, newEA: { on: false } };
  h.api.setVariant(v); await h.api.onDraw(p);
  assert.equal(h.internals.X.ser.markers.length, 1);
  assert.equal(h.S.ser.c.markers.some(m => m.color === '#a78bfa'), false);
  v.res = { entered: true, exitTimestamp: 3, exitPrice: 104, net: 3.75 }; h.api.setVariant(v); await h.api.onDraw(p);
  assert.match(h.S.ser.c.markers.at(-1).text, /이익보호 청산/);
  assert.equal(h.S.ser.c.markers.filter(m => m.color === '#a78bfa').length, 2);
});
test('hash mismatch is surfaced without stale indicator data', async () => {
  const h = harness(); h.S.sha = 'mismatch'; await h.api.onDraw(input());
  assert.match(h.node('ci-head').innerHTML, /Ctrl\+F5/);
  assert.equal(h.internals.X.ser.data.length, 0);
});
test('late source response cannot overwrite a newer chart selection', async () => {
  const pending = []; const h = harness(() => new Promise(resolve => pending.push(resolve)));
  const first = h.api.onDraw(input('old'));
  const p = input('new'); p.bars[1].close = 120;
  const second = h.api.onDraw(p);
  pending[1](h.response()); await second;
  const latest = h.internals.X.ser.data[0].value;
  pending[0](h.response()); await first;
  assert.equal(h.internals.X.ser.data[0].value, latest);
});
test('partial entry-condition table respects disabled baseline and common cumulative gate', () => {
  const h = harness(), p = input(), macd = p.bars.map(() => ({ value: .4 })), cum = p.bars.map(() => ({ value: 1 }));
  let j = h.internals.judgeAt(1, null, { ...p.P, real: false, gate: false, cumGate: false }, 110, p.bars, macd, cum);
  assert.equal(j.normal, true);
  j = h.internals.judgeAt(1, null, { ...p.P, real: false, gate: false }, 110, p.bars, macd, cum);
  assert.match(j.res, /누적대금 문턱 미달/);
});
