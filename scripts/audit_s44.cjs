// Read-only replay of exported market data; never places orders or changes defaults.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const S44 = require('../static/strategy_s44.js');

const variants = Object.freeze({
    rejectedAll: {},
    intrabarOnly: { protectBeforePartial: false, recoveryEnabled: false },
    protectionOnly: { intrabarHardStop: false, recoveryEnabled: false },
    recoveryOnly: { intrabarHardStop: false, protectBeforePartial: false },
    allOff: { intrabarHardStop: false, protectBeforePartial: false, recoveryEnabled: false }
});

function legacy() {
    const source = fs.readFileSync(path.join(__dirname, '../tests/fixtures/app.pre-s44.js'), 'utf8');
    const context = { window: { addEventListener() {} } };
    vm.createContext(context);
    vm.runInContext(source.replace(/\}\)\(\);\s*$/, `globalThis.api = {
        evaluateStrategyTrade, buildStrictTimestamps, calcVWAP, calcJMADualSegments,
        calcSupertrendSingleLineSegments, calcNormalizedMACD, calcDailyCumulativeAmount
    }; })();`), context);
    return context.api;
}

function audit(payload) {
    if (payload.schema === 's44-audit-batch-v1') {
        if (!Array.isArray(payload.days)) throw new Error('Batch export requires days');
        return { schema: 's44-audit-batch-report-v1', status: 'REJECTED_RESEARCH_ONLY',
            collection: payload.collection, cancelled: payload.cancelled,
            pendingDates: payload.pendingDates || [], days: payload.days.map(day => audit(day)) };
    }
    if (payload.schema !== 's44-audit-v1' || !Array.isArray(payload.cases) || !payload.settings) {
        throw new Error('Expected a s44-audit-v1 export from 검증자료 저장');
    }
    const s = payload.settings;
    if (!/^\d{8}$/.test(s.targetDate) || !Number.isFinite(s.baseRatePct) ||
        !Number.isFinite(s.macdThreshold) || !Number.isFinite(s.minCumAmtEok) ||
        !Number.isFinite(s.userHardStopPct) || s.userHardStopPct >= 0 ||
        typeof s.applyMfeGate !== 'boolean' || typeof s.applyCumAmtGate !== 'boolean') {
        throw new Error('Invalid strategy settings');
    }
    const deps = legacy();
    const results = payload.cases.map(item => {
        if (!Array.isArray(item.candles) || !item.candles.length ||
            !item.candles.some(c => c.date === s.targetDate)) throw new Error(`Missing date data: ${item.code}`);
        for (const c of item.candles) {
            if (!/^\d{8}$/.test(c.date) || !/^\d{4}$/.test(c.time) ||
                !['open', 'high', 'low', 'close', 'volume'].every(k => Number.isFinite(c[k])) ||
                c.low <= 0 || c.volume < 0 || c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close)) {
                throw new Error(`Invalid candle: ${item.code} ${c.date} ${c.time}`);
            }
        }
        const candles = item.candles.map(c => ({ ...c }));
        const baseline = deps.evaluateStrategyTrade(candles, 'S4.3', s.targetDate, s.baseRatePct,
            s.macdThreshold, s.applyMfeGate, item.officialMfeVal, s.applyCumAmtGate, s.minCumAmtEok, s.userHardStopPct);
        const compared = {};
        for (const [name, options] of Object.entries(variants)) {
            const r = S44.evaluateResearch({ ...s, candles: item.candles, officialMfeVal: item.officialMfeVal }, deps, options);
            // Do not compare an unclosed legacy 0% placeholder with an evaluated position.
            const comparable = baseline.entered && baseline.exitReason !== '미체결' && r.entered && r.closed;
            compared[name] = { entered: r.entered, pnl: r.entered ? r.pnl : null,
                delta: comparable ? r.pnl - baseline.pnl : null, comparable,
                exitReason: r.exitReason, trades: r.trades,
                hardStopEvidence: r.trades.filter(t => t.exitReason.startsWith('하드스탑(봉내')).map(t => {
                    const bar = item.candles[t.exitIndex];
                    const stop = t.entryPrice * (1 + s.userHardStopPct / 100);
                    return { entryTime: t.entryTime, exitTime: t.exitTime, stopPrice: stop,
                        fillPrice: t.exitPrice, bar,
                        closeRecoveredAboveStop: bar.close > stop,
                        gapBelowStop: bar.open < stop };
                }) };
        }
        return { code: item.code, name: item.name,
            baseline: { entered: baseline.entered, pnl: baseline.entered ? baseline.pnl : null,
                exitReason: baseline.exitReason, markers: baseline.markers }, variants: compared };
    });
    const summary = {};
    for (const name of Object.keys(variants)) {
        const rows = results.filter(r => r.variants[name].comparable);
        summary[name] = { comparableCount: rows.length,
            averageDelta: rows.length ? rows.reduce((sum, r) => sum + r.variants[name].delta, 0) / rows.length : null,
            worstDelta: rows.length ? Math.min(...rows.map(r => r.variants[name].delta)) : null,
            winnersTurnedToLoss: rows.filter(r => r.baseline.pnl > 0 && r.variants[name].pnl < 0).map(r => r.code) };
    }
    return { schema: 's44-audit-report-v1', status: 'REJECTED_RESEARCH_ONLY', settings: s,
        collection: payload.collection || null, errors: payload.errors || [],
        missing: payload.missing || [], summary, results };
}

if (require.main === module) {
    try {
        if (!process.argv[2]) throw new Error('Usage: node scripts/audit_s44.cjs strategy-audit-YYYYMMDD-T-360.json');
        process.stdout.write(JSON.stringify(audit(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))), null, 2) + '\n');
    } catch (error) {
        process.stderr.write(error.message + '\n');
        process.exitCode = 1;
    }
}
module.exports = { audit };
