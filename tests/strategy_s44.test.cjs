const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const S44 = require('../static/strategy_s44.js');
const original = fs.readFileSync(path.join(__dirname, 'fixtures/app.pre-s44.js'), 'utf8');
const current = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
const date = '20260918';
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const copy = x => JSON.parse(JSON.stringify(x));

function load(source, document = {}) {
    const context = { window: { addEventListener() {}, StrategyS44: S44 }, document, console,
        setTimeout, clearTimeout, alert: message => { throw new Error(message); } };
    vm.createContext(context);
    vm.runInContext(source.replace(/\}\)\(\);\s*$/, `globalThis.api = {
        evaluateStrategyTrade, ${source.includes('function evaluateStrategyWithExtensions') ? 'evaluateStrategyWithExtensions, buildStrategyAuditExport,' : ''}
        executeBatchBacktest, renderTable, loadDualChart, calcVWAP, calcJMADualSegments,
        calcSupertrendSingleLineSegments, calcNormalizedMACD, calcDailyCumulativeAmount,
        buildStrictTimestamps,
        seed: (list, cache) => { currentStockList = list; stockDataCache = cache; },
        attachCharts: (chart, series) => {
            chartMacro = chartMacroVol = chartMicro = chartMACD = chartCumAmt = chart;
            seriesMacroCandle = seriesMacroVol = lineMacroMA20 = lineMacroMA60 = lineMacroHigh20 = lineMacroLow60 = series;
            seriesMicroCandle = lineMicroVWAP = seriesMACDHist = seriesCumAmtBar = lineMicroBase = series;
        }
    }; })();`), context);
    return context.api;
}
const oldAPI = load(original), newAPI = load(current);

test('legacy source and indicator/evaluator prefix are frozen, original archive hash matches', () => {
    assert.equal(crypto.createHash('sha256').update(original).digest('hex'),
        'ade2280a11378e90a9fa7fb15a8ba7947d9259029df91009492d2ae82ddad368');
    assert.ok(current.startsWith(original.slice(0, original.indexOf('    async function executeCapture()'))));
});

// Artificial paths, NOT reconstructions of screenshot securities.
function generated(seed) {
    let state = seed;
    const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
    let price = 100;
    const bars = [];
    for (let i = 0; i < 190; i++) {
        const open = price;
        price = Math.max(10, open * (1 + (random() - 0.46) * 0.045));
        const m = i < 60 ? 14 * 60 + i : 9 * 60 + i - 60;
        bars.push({ date: i < 60 ? '20260917' : date,
            time: `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`,
            open, close: price, high: Math.max(open, price) * (1 + random() * 0.008),
            low: Math.min(open, price) * (1 - random() * 0.008), volume: 1000000 });
    }
    return bars;
}

test('S4~S4.3 runtime results are identical for 80 paths and gate/stop variants', () => {
    for (let seed = 1; seed <= 80; seed++) {
        const bars = generated(seed);
        for (const strategy of ['S4', 'S4.1', 'S4.2', 'S4.3']) {
            const args = [strategy, date, 5.5, 0.15, seed % 2 === 0, seed % 3 ? 20 : 4, true, 3, seed % 2 ? -3 : -2];
            const before = oldAPI.evaluateStrategyTrade(copy(bars), ...args);
            const after = newAPI.evaluateStrategyWithExtensions(copy(bars), ...args);
            assert.deepEqual(copy(after), copy(before), `seed ${seed}, ${strategy}`);
        }
    }
});

test('S4.4 with only supplements disabled reproduces S4.3 completed trade prices and PnL', () => {
    let compared = 0;
    for (let seed = 1; seed <= 80; seed++) {
        const bars = generated(seed);
        const input = { candles: bars, targetDate: date, baseRatePct: 5.5, macdThreshold: 0.15,
            applyMfeGate: false, officialMfeVal: 20, applyCumAmtGate: true, minCumAmtEok: 3, userHardStopPct: -3 };
        const old = oldAPI.evaluateStrategyTrade(copy(bars), 'S4.3', date, 5.5, 0.15, false, 20, true, 3, -3);
        const next = S44.evaluateResearch(input, newAPI, { intrabarHardStop: false, protectBeforePartial: false, recoveryEnabled: false });
        assert.equal(next.entered, old.entered);
        assert.equal(next.entryTime, old.entryTime);
        if (old.entered && old.exitReason !== '미체결') {
            compared++;
            near(next.pnl, old.pnl);
            assert.equal(next.exitReason, old.exitReason);
            assert.deepEqual(next.markers.map(m => m.time), Array.from(old.markers, m => m.time));
        }
        const enabled = S44.evaluateResearch(input, newAPI);
        assert.equal(enabled.entered, old.entered, 'new features must not block original entry');
        assert.equal(enabled.entryTime, old.entryTime);
    }
    assert.ok(compared > 30);
});

function b(time, close, extras = {}) {
    return { date, time, open: close, close, high: close + 0.1, low: close - 0.1, volume: 1000000, ...extras };
}
const deps = {
    buildStrictTimestamps: bars => bars.forEach((bar, i) => { bar.timestamp = i + 1; }),
    calcVWAP: bars => bars.map(bar => ({ value: bar.vwap ?? 90 })),
    calcJMADualSegments: bars => ({ rawJMA: bars.map(bar => bar.jma ?? bar.close) }),
    calcSupertrendSingleLineSegments: bars => ({ rawTrend: bars.map(bar => bar.st ?? 1), rawATR: bars.map(bar => bar.atr ?? 1) }),
    calcNormalizedMACD: bars => bars.map(bar => ({ value: bar.macd ?? 0.3 })),
    calcDailyCumulativeAmount: bars => bars.map(bar => ({ value: bar.amountEok ?? 20 }))
};
const start = () => [b('0903', 99), b('0904', 100)];
function run(bars, overrides = {}, input = {}) {
    return S44.evaluateResearch({ candles: bars, targetDate: date, baseRatePct: 5.5, macdThreshold: 0.15,
        applyMfeGate: false, officialMfeVal: 20, applyCumAmtGate: true, minCumAmtEok: 3,
        userHardStopPct: -3, ...input }, deps, overrides);
}

test('resting hard stop triggers on next-bar low, never the entry-bar low', () => {
    const bars = start(); bars[1].low = 80;
    bars.push(b('0905', 98, { open: 100, low: 96, high: 100 }));
    const r = run(bars);
    near(r.pnl, -3); assert.equal(r.trades[0].exitPrice, 97);
    assert.equal(r.trades[0].exitIndex, 2); assert.equal(r.recoveryCount, 0);
});

test('gap below hard stop fills at worse open, not a fictitious capped loss', () => {
    const r = run([...start(), b('0905', 95, { open: 94, low: 93 })]);
    near(r.pnl, -6); assert.equal(r.trades[0].exitPrice, 94);
});

test('strong trend keeps simultaneous 30/30 partials and 40% runner until 10:30', () => {
    const r = run([...start(), b('0905', 110), b('0906', 109.5), b('1030', 115)]);
    near(r.pnl, 11.7);
    assert.equal(r.trades[0].partials.length, 2);
    assert.deepEqual(r.trades[0].partials.map(p => p.price), [109.5, 109.5]);
    assert.equal(r.exitReason, '추세연장마감(10:30)');
});

test('profit guard protects a missed partial only after prior completed-close gain and breakdown', () => {
    const r = run([...start(), b('0905', 103.5, { atr: 0.2, macd: 0.4 }),
        b('0906', 101.5, { jma: 102, macd: 0.2 })]);
    near(r.pnl, 1.5); assert.equal(r.exitReason, '부분익절전 수익보호');
    assert.equal(r.trades[0].partials.length, 0);
});

test('entry wick or current-bar high alone cannot arm close-based protection', () => {
    const bars = start(); bars[1].high = 130;
    const r = run([...bars, b('0905', 101, { high: 110 }), b('1030', 100.5, { macd: 0.1 })]);
    assert.equal(r.exitReason, '추세연장마감(10:30)'); near(r.pnl, 0.5);
});

function recoveryPath(firstExit = 98.5) {
    return [...start(), b('0905', firstExit, { st: -1 }),
        b('0906', 100.5, { macd: 0.2 }), b('0907', 102, { macd: 0.3 }), b('1030', 108)];
}
test('one recovery requires cooldown/reclaim and includes initial loss with half weight', () => {
    const r = run(recoveryPath());
    assert.equal(r.tradeCount, 2); assert.equal(r.recoveryCount, 1);
    assert.equal(r.trades[1].entryTime, '0907'); near(r.trades[1].weight, 0.5);
    near(r.pnl, -1.5 + 0.5 * (108 - 102) / 102 * 100);
});

test('remaining loss budget reduces recovery size; a second stop cannot cause a third entry', () => {
    const bars = recoveryPath(97.5);
    bars[4] = b('0907', 102, { macd: 0.3 });
    bars[5] = b('0908', 98, { open: 102, low: 97, high: 102 });
    bars.push(b('0909', 110), b('0910', 115), b('1030', 120));
    const r = run(bars);
    near(r.trades[1].weight, 1 / 6); near(r.pnl, -3); assert.equal(r.tradeCount, 2);
});

test('hard-stop loss, winning ST exit, weak MACD or late recovery cannot re-enter', () => {
    const hard = recoveryPath(); hard[2].low = 96;
    assert.equal(run(hard).tradeCount, 1);
    const win = recoveryPath(); win[2] = b('0905', 101, { st: -1 });
    assert.equal(run(win).tradeCount, 1);
    const weak = recoveryPath(); weak[4].macd = 0.1;
    assert.equal(run(weak).tradeCount, 1);
    const late = recoveryPath(); late[4].time = '0931';
    assert.equal(run(late).tradeCount, 1);
});

test('causality: appending future rally/crash does not alter earlier recovery decisions', () => {
    const prefix = recoveryPath().slice(0, -1);
    const rising = run([...prefix, b('1030', 120)]);
    const falling = run([...prefix, b('1030', 90)]);
    assert.deepEqual(rising.trades.map(t => [t.entryIndex, t.entryPrice, t.weight]),
        falling.trades.map(t => [t.entryIndex, t.entryPrice, t.weight]));
});

test('empty/gated data, input isolation and open position valuation are explicit', () => {
    assert.equal(run([]).exitReason, '데이터없음');
    assert.equal(run(start(), {}, { applyMfeGate: true, officialMfeVal: 4 }).entered, false);
    const bars = [...start(), b('0905', 102)]; const saved = copy(bars);
    const r = run(bars); assert.deepEqual(bars, saved);
    near(r.pnl, 2); assert.equal(r.closed, false); assert.match(r.exitReason, /평가손익/);
});

test('batch quarantines S4.4 without a fabricated zero return', async () => {
    const values = { 'edit-date': date, 'input-base-rate': '5.5', 'input-min-cum-amt': '3',
        'input-hard-stop': '-3', 'sel-batch-tf': 'T-360', 'input-macd-base': '0, 0.15' };
    const elements = {};
    function element(id) {
        return elements[id] ||= { value: values[id] || '', checked: true, innerText: '',
            innerHTML: '', children: [], appendChild(child) { this.children.push(child); }, addEventListener() {} };
    }
    const api = load(current, { getElementById: element, createElement: () => ({ addEventListener() {} }) });
    const list = [{ 종목코드: 'SYNTHETIC', 종목명: '합성검증', '기간 내 최고수익률(MFE)': '+20%' },
        { 종목코드: 'LOW', 종목명: '게이트검증', '기간 내 최고수익률(MFE)': '+4%' },
        { 종목명: '코드없음' }];
    api.seed(list, { SYNTHETIC: { intraday: generated(7), _tf: 'T-360' } });
    await api.executeBatchBacktest();
    assert.equal(list[0]._batchPnl_S44, null);
    assert.equal(list[0]._batchExitReason_S44, '채택보류');
    assert.match(list[1]._batchExitReason_S44, /MFE미달/);
    assert.equal(list[2]._batchExitReason_S44, '코드없음');
    assert.match(element('batch-stat-badge').innerHTML, /S4.4: 채택보류 · 성과 미집계/);
    const row = element('table-body').children[0].innerHTML;
    assert.equal((row.match(/<td /g) || []).length, 12);
    assert.equal(element('btn-batch-backtest').disabled, false);
});

test('forced rejected strategy has no markers and switching back preserves S4.3', async () => {
    const values = { 'edit-date': date, 'input-base-rate': '5.5', 'input-min-cum-amt': '3',
        'input-hard-stop': '-3', 'sel-tf': 'T-360', 'input-macd-base': '0, 0.15',
        'input-cum-amt-lines': '10, 30', 'sel-strategy': 'S4.4' };
    const elements = {};
    const getElementById = id => elements[id] ||= { value: values[id] || '', checked: true, innerText: '' };
    let markers;
    const series = { setData() {}, setMarkers(value) { markers = copy(value); },
        createPriceLine() { return {}; }, removePriceLine() {}, applyOptions() {} };
    const chart = { timeScale: () => ({ fitContent() {} }), removeSeries() {}, addLineSeries: () => series };
    const api = load(current, { getElementById });
    const bars = generated(7);
    const data = { status: 'success', intraday: bars, daily: [], _tf: 'T-360' };
    api.seed([{ 종목코드: 'SYNTHETIC', '기간 내 최고수익률(MFE)': '+20%' }], { SYNTHETIC: data });
    api.attachCharts(chart, series);
    await api.loadDualChart('SYNTHETIC', '합성검증');
    assert.match(getElementById('trade-pnl-badge').innerText, /S4.4/);
    assert.deepEqual(markers, []);
    assert.match(getElementById('trade-pnl-badge').innerText, /채택보류/);
    getElementById('sel-strategy').value = 'S4.3';
    await api.loadDualChart('SYNTHETIC', '합성검증');
    const expected = oldAPI.evaluateStrategyTrade(copy(bars), 'S4.3', date, 5.5, 0.15, true, 20, true, 3, -3);
    assert.deepEqual(markers, copy(expected.markers));
    assert.match(getElementById('trade-pnl-badge').innerText, /S4.3/);
});

test('browser module and HTML integration load S4.4 before app without changing default selection', () => {
    const context = {}; vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/strategy_s44.js'), 'utf8'), context);
    assert.equal(typeof context.StrategyS44.evaluate, 'function');
    const html = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
    assert.ok(html.indexOf('/static/strategy_s44.js') < html.indexOf('/static/app.js'));
    assert.match(html, /<option value="S4.3" selected>/);
    assert.match(html, /<option value="S4.4" disabled>/);
    const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), m => m[1]);
    assert.equal(ids.length, new Set(ids).size);
});

test('rejected public evaluator cannot trade, even with overrides; research path stays explicit', () => {
    const r = S44.evaluate({}, new Proxy({}, { get() { throw new Error('Must not run indicators'); } }),
        { intrabarHardStop: false, recoveryEnabled: false });
    assert.equal(S44.STATUS.adopted, false);
    assert.equal(r.disabled, true); assert.equal(r.entered, false);
    assert.equal(r.pnl, null); assert.deepEqual(r.markers, []);
});

test('reproduces the rejected mechanism: recovered intrabar wick destroys a later winning trade', () => {
    // Mechanism fixture only. These are NOT the real 9/17 candles.
    const bars = [...start(), b('0905', 99.5, { open: 100, high: 101, low: 96, jma: 100.5 }),
        b('0906', 110), b('0907', 109.5), b('1030', 115)];
    const rejected = run(bars);
    const withoutIntrabar = run(bars, { intrabarHardStop: false });
    near(rejected.pnl, -3); assert.ok(withoutIntrabar.pnl > 10);
    assert.equal(rejected.trades[0].exitTime, '0905');
});

test('audit export excludes wrong timeframe/date cache and copies usable candles', () => {
    const values = { 'edit-date': date, 'sel-batch-tf': 'T-360', 'input-macd-base': '0, 0.15',
        'input-base-rate': '5.5', 'input-min-cum-amt': '3', 'input-hard-stop': '-3' };
    const api = load(current, { getElementById: id => ({ value: values[id], checked: true }) });
    const bars = generated(7);
    const list = ['GOOD', 'STALE', 'WRONG_TF'].map(code => ({ 종목코드: code, 종목명: code, '기간 내 최고수익률(MFE)': '+20%' }));
    api.seed(list, { GOOD: { _tf: 'T-360', intraday: bars },
        STALE: { _tf: 'T-360', intraday: [...bars, { ...bars.at(-1), date: '20260921' }] },
        WRONG_TF: { _tf: 'T-120', intraday: bars } });
    const payload = api.buildStrategyAuditExport();
    assert.equal(payload.cases.length, 1); assert.equal(payload.missing.length, 2);
    assert.equal(payload.cases[0].code, 'GOOD');
    payload.cases[0].candles[0].close = -1;
    assert.ok(bars[0].close > 0);
});

test('read-only audit isolates all three supplements and reports comparable regressions', () => {
    const { audit } = require('../scripts/audit_s44.cjs');
    const report = audit({ schema: 's44-audit-v1', settings: { targetDate: date, baseRatePct: 5.5,
        macdThreshold: 0.15, applyMfeGate: false, applyCumAmtGate: true, minCumAmtEok: 3, userHardStopPct: -3 },
        cases: [{ code: 'SYNTHETIC', name: '합성검증', officialMfeVal: 20, candles: generated(7) }], missing: [] });
    assert.equal(report.status, 'REJECTED_RESEARCH_ONLY');
    assert.equal(Object.keys(report.summary).length, 5);
    near(report.results[0].variants.allOff.delta, 0);
    assert.equal(report.summary.allOff.comparableCount, 1);
    assert.throws(() => audit({ schema: 'invalid' }), /s44-audit-v1/);
});
