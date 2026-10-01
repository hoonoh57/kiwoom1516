const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../static/audit_downloader.js');
const { audit } = require('../scripts/audit_s44.cjs');

const options = () => ({ startDate: '2026-09-16', endDate: '2026-09-18',
    mfeThreshold: 5.5, comparison: 'gt', timeframe: 'T-360', condition: 92, captureTime: '090300',
    settings: { baseRatePct: 5.5, macdThreshold: 0.15, applyMfeGate: true,
        applyCumAmtGate: true, minCumAmtEok: 3, userHardStopPct: -3 } });
const row = (code, mfe) => ({ 종목코드: code, 종목명: code, '기간 내 최고수익률(MFE)': mfe });
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
const candles = date => ['0903', '0904', '0905', '1030'].map((time, i) => ({ date, time,
    open: 100 + i, close: 100 + i, high: 101 + i, low: 99 + i, volume: 1000000 }));
function fakeFetch(rows, override) {
    const calls = [];
    const fetch = async (url, init) => {
        const parsed = new URL(url, 'http://localhost');
        const query = init ? JSON.parse(init.body) : Object.fromEntries(parsed.searchParams);
        calls.push({ url, query });
        if (override) {
            const r = await override(parsed.pathname, query);
            if (r) return r;
        }
        if (parsed.pathname === '/api/capture') return response({ status: 'success', data: rows });
        return response({ status: 'success', code: query.code, unit: query.unit,
            intraday: candles(query.date), daily: [], classification: { type: 'B' } });
    };
    return { fetch, calls };
}

test('strict MFE parsing rejects unknowns instead of accidentally downloading them', () => {
    assert.equal(D.parseMfe('+5.50%'), 5.5);
    assert.equal(D.parseMfe(' +6.25 % '), 6.25);
    assert.equal(D.parseMfe('−1.5%'), -1.5);
    assert.equal(D.parseMfe(0), 0);
    for (const s of [null, '', '-', 'NaN', 'Infinity', '5.6abc', '5+6', '5 6']) assert.equal(D.parseMfe(s), null);
});

test('dates are inclusive and reject invalid, reversed or excessive ranges', () => {
    assert.deepEqual(D.dateRange('2026-09-16', '20260918'), ['20260916', '20260917', '20260918']);
    assert.deepEqual(D.dateRange('2026-09-16', '2026-09-16'), ['20260916']);
    assert.throws(() => D.dateRange('2026-02-30', '2026-03-01'));
    assert.throws(() => D.dateRange('2026-09-18', '2026-09-16'));
    assert.throws(() => D.dateRange('2026-09-01', '2026-10-02'));
    assert.throws(() => D.validate({ ...options(), mfeThreshold: NaN }));
    assert.throws(() => D.validate({ ...options(), captureTime: '250000' }));
});

test('three dates fetch only MFE > 5.5, deduplicate codes, retain schema/settings and audit compatibility', async () => {
    const io = fakeFetch([row('ABOVE', '+5.51%'), row('EQUAL', '+5.50%'), row('LOW', '5.49%'),
        row('UNKNOWN', '-'), row('ABOVE', '6%')]);
    const input = options(), before = JSON.stringify(input);
    const bundle = await D.collect(input, io);
    assert.equal(JSON.stringify(input), before);
    assert.equal(io.calls.length, 6); // 3 captures + 3 eligible symbols, never all symbols.
    assert.deepEqual(io.calls.filter(x => !x.url.startsWith('/api/capture')).map(x => x.query.code), ['ABOVE', 'ABOVE', 'ABOVE']);
    assert.deepEqual(bundle.days.map(d => d.settings.targetDate), ['20260916', '20260917', '20260918']);
    for (const day of bundle.days) {
        assert.equal(day.schema, 's44-audit-v1'); assert.equal(day.cases.length, 1);
        assert.equal(day.collection.duplicates, 1); assert.equal(day.collection.invalidMfe, 1);
        assert.equal(day.collection.excludedByMfe, 2); assert.equal(day.collection.status, 'partial');
        assert.equal(day.cases[0].officialMfeVal, 5.51); assert.equal(day.settings.baseRatePct, 5.5);
        assert.equal(day.cases[0].coverage.targetBarCount, 4);
        assert.equal(day.cases[0].coverage.firstTargetTime, '0903');
    }
    assert.equal(D.filename(bundle), 'strategy-audit-20260916-20260918-T-360-mfe-gt-5p5.json');
    const report = audit(JSON.parse(JSON.stringify(bundle)));
    assert.equal(report.days.length, 3); assert.equal(report.days[0].errors.length, 1);
});

test('inclusive comparator includes the boundary without altering trading gate settings', async () => {
    const io = fakeFetch([row('BOUNDARY', '+7.0%'), row('BELOW', '+6.99%')]);
    const result = await D.collect({ ...options(), endDate: '2026-09-16', mfeThreshold: 7, comparison: 'gte' }, io);
    assert.equal(result.days[0].cases[0].code, 'BOUNDARY');
    assert.equal(result.days[0].settings.baseRatePct, 5.5);
});

test('capture and per-symbol failures are recorded; other dates/symbols continue', async () => {
    const io = fakeFetch([row('BAD', 7), row('GOOD', 8)], (route, q) => {
        if (route === '/api/capture' && q.date === '20260917') return response({ detail: '1516 unavailable' }, 500);
        if (q.code === 'BAD') return response({ status: 'error', message: 'no candles' });
    });
    const r = await D.collect(options(), io);
    assert.equal(r.days[0].missing.length, 1); assert.equal(r.days[0].cases.length, 1);
    assert.equal(r.days[1].collection.status, 'capture-error');
    assert.equal(r.days[1].errors[0].message, '1516 unavailable');
    assert.equal(r.days[2].cases.length, 1);
    assert.equal(audit(r).days[1].collection.status, 'capture-error');
});

test('mismatched dates/symbols and malformed candles cannot silently enter an export', async () => {
    const io = fakeFetch([row('WRONG_DATE', 7), row('WRONG_CODE', 8), row('MALFORMED', 9)], (_, q) => {
        if (!q.code) return null;
        const bars = candles(q.code === 'WRONG_DATE' ? '20260915' : q.date);
        if (q.code === 'MALFORMED') bars[0].low = 200;
        return response({ status: 'success', code: q.code === 'WRONG_CODE' ? 'OTHER' : q.code, unit: 'T', intraday: bars });
    });
    const r = await D.collect({ ...options(), endDate: '2026-09-16' }, io);
    assert.equal(r.days[0].cases.length, 0); assert.equal(r.days[0].missing.length, 3);
});

test('unknown code and no qualifying symbols do not trigger candle requests', async () => {
    const io = fakeFetch([row('', 8), row('LOW', 4)]);
    const r = await D.collect({ ...options(), endDate: '2026-09-16' }, io);
    assert.equal(io.calls.length, 1); assert.match(r.days[0].missing[0].reason, /종목코드 없음/);
    const low = fakeFetch([row('LOW', 4)]);
    const r2 = await D.collect({ ...options(), endDate: '2026-09-16' }, low);
    assert.equal(low.calls.length, 1); assert.equal(r2.days[0].collection.status, 'no-eligible');
});

test('stop waits for in-flight request and keeps completed data with pending dates/symbols', async () => {
    let stop = false;
    const io = fakeFetch([row('FIRST', 7), row('SECOND', 8)], (_, q) => { if (q.code === 'FIRST') stop = true; });
    const r = await D.collect(options(), { ...io, isCancelled: () => stop });
    assert.equal(r.cancelled, true); assert.equal(io.calls.length, 2);
    assert.equal(r.days[0].cases.length, 1); assert.equal(r.days[0].missing[0].code, 'SECOND');
    assert.deepEqual(r.pendingDates, ['20260917', '20260918']);
});

test('worker requests never overlap', async () => {
    let active = 0, maxActive = 0;
    const io = fakeFetch([row('A', 7), row('B', 8)]);
    await D.collect(options(), { fetch: async (...args) => {
        active++; maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setImmediate(resolve));
        const result = await io.fetch(...args); active--; return result;
    } });
    assert.equal(maxActive, 1); assert.equal(io.calls.length, 9);
});

test('UI exposes defaults, comparator, stop, progress and module mounted after lab', () => {
    const html = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
    assert.match(html, /id="audit-start"[^>]+value="2026-09-30"/);
    assert.match(html, /id="audit-end"[^>]+value="2026-10-01"/);
    assert.match(html, /value="gt" selected/);
    assert.match(html, /id="audit-mfe"[^>]+value="5.5"/);
    assert.match(html, /id="btn-audit-stop" disabled/);
    assert.ok(html.indexOf('src="/static/audit_downloader.js"') > html.indexOf('src="/static/lab.js"'));
    assert.match(html, /window\.AuditDownloader\.mount\(/);
});

test('UI click saves one bundle, offers per-date files, and restores disabled controls', async () => {
    const values = { 'audit-start': '2026-09-16', 'audit-end': '2026-09-18', 'audit-mfe': '5.5',
        'audit-comparison': 'gt', 'edit-cond': '92', 'edit-time': '090300', 'sel-batch-tf': 'T-360' };
    const elements = {};
    function element(id) {
        return elements[id] ||= { value: values[id], disabled: id === 'btn-audit-stop',
            listeners: {}, children: [], addEventListener(event, cb) { this.listeners[event] = cb; },
            appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; } };
    }
    for (const id of [...Object.keys(values), 'btn-audit-batch', 'btn-audit-stop', 'btn-capture',
        'btn-batch-backtest', 'audit-download-status', 'audit-download-links']) element(id);
    const main = { inert: false };
    let clicks = 0;
    const doc = { getElementById: element, querySelectorAll: () => Object.values(elements),
        querySelector: () => main,
        createElement: () => ({ click() { clicks++; } }) };
    const io = fakeFetch([row('ELIGIBLE', 8)]);
    D.mount({ document: doc, fetch: io.fetch, getSettings: () => options().settings });
    await element('btn-audit-batch').listeners.click();
    assert.equal(clicks, 1); assert.equal(element('audit-download-links').children.length, 4);
    assert.equal(element('btn-capture').disabled, false); assert.equal(main.inert, false);
    assert.equal(element('btn-audit-stop').disabled, true);
    assert.match(element('audit-download-status').textContent, /캔들 3건/);
    for (const a of element('audit-download-links').children) URL.revokeObjectURL(a.href);
});
