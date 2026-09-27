/* S4.4: independent extension. Never edits or selects outcomes from S4~S4.3. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.StrategyS44 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Rejected after observed winner-to-loss regressions (2026-09-16/17).
    // Keep the original experiment reproducible, but do not run it as a candidate.
    const STATUS = Object.freeze({ adopted: false, label: '채택보류',
        reason: '기존 수익 거래 훼손: 실데이터 재검증 필요' });

    const DEFAULTS = Object.freeze({
        intrabarHardStop: true,
        protectBeforePartial: true,
        recoveryEnabled: true,
        protectionArmPct: 2.5,
        minGivebackPct: 1.5,
        givebackATR: 2.5,
        recoveryMaxWeight: 0.5,
        recoveryCooldownBars: 2,
        recoveryCooldownMinutes: 2
    });
    const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(2, 4));
    const pct = (price, entry) => (price - entry) / entry * 100;

    // A resting sell stop becomes active AFTER the entry close. Gap fills use open.
    // OHLC cannot model liquidity/slippage; this is a backtest fill assumption.
    function hardStopFill(bar, stopPrice) {
        if (bar.open <= stopPrice) return bar.open;
        return bar.low <= stopPrice ? stopPrice : null;
    }

    function evaluateResearch(input, deps, overrides = {}) {
        const config = Object.freeze({ ...DEFAULTS, ...overrides });
        const { targetDate, baseRatePct, macdThreshold, applyMfeGate, officialMfeVal,
            applyCumAmtGate, minCumAmtEok, userHardStopPct } = input;
        // Isolated copies: running S4.4 cannot change candles used by legacy engines.
        const candles = (input.candles || []).map(c => ({ ...c }));
        const result = { entered: false, pnl: 0, entryTime: '-', exitReason: '미진입',
            markers: [], basePrice: 0, entryStartIdx: -1, cumAmtData: [],
            trades: [], tradeCount: 0, recoveryCount: 0, closed: true };
        if (!candles.length) return { ...result, exitReason: '데이터없음' };
        if (applyMfeGate && officialMfeVal != null && officialMfeVal < baseRatePct) {
            return { ...result, exitReason: `MFE미달(${officialMfeVal.toFixed(1)}%)` };
        }
        const hardStop = Number.isFinite(userHardStopPct) && userHardStopPct < 0 ? userHardStopPct : -2.5;
        const riskBudget = Math.abs(hardStop);
        deps.buildStrictTimestamps(candles);
        const vwap = deps.calcVWAP(candles);
        const jma = deps.calcJMADualSegments(candles, 7, 0, 2).rawJMA;
        const st = deps.calcSupertrendSingleLineSegments(candles, 14, 2.0);
        const macd = deps.calcNormalizedMACD(candles, 5, 13, 4);
        result.cumAmtData = deps.calcDailyCumulativeAmount(candles, targetDate);
        let capturePrice = 0;
        candles.forEach((c, i) => {
            if (c.date !== targetDate) return;
            if (c.time <= '0903') capturePrice = c.close;
            if (c.time >= '0904' && result.entryStartIdx < 0) result.entryStartIdx = i;
        });
        if (capturePrice <= 0 && result.entryStartIdx >= 0) capturePrice = candles[result.entryStartIdx].open;
        if (capturePrice <= 0 || result.entryStartIdx < 0) return { ...result, exitReason: '09:04봉없음' };
        result.basePrice = capturePrice * (1 + baseRatePct / 100);

        let position = null, recovery = null, done = false, lastIndex = -1;
        const marker = (bar, text, entry = false) => result.markers.push({
            time: bar.timestamp, position: entry ? 'belowBar' : 'aboveBar',
            color: entry ? '#2dd4bf' : '#fbbf24', shape: entry ? 'arrowUp' : 'arrowDown', text
        });
        function enter(bar, i, weight) {
            position = { entryPrice: bar.close, entryIndex: i, entryTime: bar.time,
                weight, stage1: false, stage2: false, part: 0, remaining: 1,
                // Retain S4.3 runner's high-water calculation for comparable exits.
                runnerHigh: bar.high, peakClose: bar.close, peakHigh: bar.close, mae: 0,
                partials: [] };
            result.tradeCount++;
            if (!result.entered) result.entryTime = `${bar.time.slice(0, 2)}:${bar.time.slice(2, 4)}`;
            result.entered = true;
            const label = result.tradeCount === 1 ? 'S4.4진입' : `S4.4재진입 ${(weight * 100).toFixed(1)}%`;
            marker(bar, `[${label}] ${bar.close.toLocaleString()}원`, true);
        }
        function exit(bar, i, price, reason, allowRecovery = false) {
            const p = position;
            const tradePnl = p.part + p.remaining * pct(price, p.entryPrice);
            result.pnl += p.weight * tradePnl;
            result.trades.push({ entryIndex: p.entryIndex, exitIndex: i,
                entryTime: p.entryTime, exitTime: bar.time, entryPrice: p.entryPrice,
                exitPrice: price, weight: p.weight, pnl: tradePnl,
                contribution: p.weight * tradePnl, exitReason: reason,
                mfeClose: pct(p.peakClose, p.entryPrice), mfeHigh: pct(p.peakHigh, p.entryPrice),
                mae: Math.min(p.mae, pct(price, p.entryPrice)), partials: p.partials });
            result.exitReason = result.tradeCount > 1 ? `재진입종료: ${reason}` : reason;
            marker(bar, `[S4.4 ${reason}] ${price.toLocaleString()}원`);
            const remainingRisk = riskBudget + Math.min(0, result.pnl);
            if (config.recoveryEnabled && allowRecovery && result.tradeCount === 1 &&
                tradePnl < 0 && !p.stage1 && remainingRisk > 0 && bar.time < '0930') {
                recovery = { index: i, time: bar.time, high: bar.high, entryPrice: p.entryPrice,
                    weight: Math.min(config.recoveryMaxWeight, remainingRisk / riskBudget) };
            } else done = true;
            position = null;
        }

        for (let i = result.entryStartIdx; i < candles.length && !done; i++) {
            const bar = candles[i], prev = candles[i - 1];
            if (bar.date !== targetDate) continue;
            lastIndex = i;
            const prevJMA = jma[i - 1], prevPrevJMA = i >= 2 ? jma[i - 2] : prevJMA;
            const setup = st.rawTrend[i] === 1 && macd[i].value >= macdThreshold && jma[i] > prevJMA;
            const withinWindow = bar.time >= '0904' && bar.time <= '0930';
            const amountReady = !applyCumAmtGate || result.cumAmtData[i].value >= minCumAmtEok;
            if (!position && !result.entered && withinWindow) {
                // EXACT S4.3 first-entry rules, including acceleration exception.
                const normal = applyMfeGate ? setup && bar.close >= result.basePrice &&
                    pct(bar.close, capturePrice) >= baseRatePct : setup;
                const early = setup && bar.time <= '0912' &&
                    result.cumAmtData[i].value >= 15 && macd[i].value >= 0.20;
                if ((normal || early) && amountReady) enter(bar, i, 1);
            } else if (!position && recovery && withinWindow && prev) {
                const cooled = i - recovery.index >= config.recoveryCooldownBars &&
                    minutes(bar.time) - minutes(recovery.time) >= config.recoveryCooldownMinutes;
                const regained = bar.close > Math.max(recovery.high, recovery.entryPrice, prev.high);
                if (cooled && regained && setup && amountReady && st.rawTrend[i - 1] === 1 &&
                    bar.close >= vwap[i].value && macd[i].value > macd[i - 1].value) {
                    const weight = recovery.weight;
                    recovery = null;
                    result.recoveryCount++;
                    enter(bar, i, weight);
                }
            }
            if (!position || i <= position.entryIndex) continue;
            const p = position;
            const curPnL = pct(bar.close, p.entryPrice);
            const jmaTurnDown = jma[i] < prevJMA && prevJMA >= prevPrevJMA;
            const priorPeakClose = p.peakClose;
            const priorATR = st.rawATR[i - 1] || (prev.high - prev.low);

            if (config.intrabarHardStop) {
                const fill = hardStopFill(bar, p.entryPrice * (1 + hardStop / 100));
                if (fill !== null) {
                    exit(bar, i, fill, `하드스탑(봉내/갭 ${hardStop.toFixed(1)}%)`);
                    continue;
                }
            } else if (curPnL <= hardStop) {
                exit(bar, i, bar.close, `초기손절(스탑${hardStop.toFixed(1)}%)`);
                continue;
            }
            p.runnerHigh = Math.max(p.runnerHigh, bar.high);
            p.peakHigh = Math.max(p.peakHigh, bar.high);
            p.peakClose = Math.max(p.peakClose, bar.close);
            p.mae = Math.min(p.mae, pct(bar.low, p.entryPrice));
            if (p.stage1 && curPnL <= 0.2) {
                exit(bar, i, bar.close, '본전보호(BEP컷)');
                continue;
            }
            function takePartial(stage) {
                p.part += curPnL * 0.3;
                p.remaining -= 0.3;
                p.partials.push({ stage, time: bar.time, price: bar.close, fraction: 0.3 });
                marker(bar, `[S4.4 ${stage}차30%익절] ${bar.close.toLocaleString()}원 (+${curPnL.toFixed(2)}%)`);
            }
            if (!p.stage1 && curPnL >= 2.5 && jmaTurnDown) {
                p.stage1 = true;
                takePartial(1);
            }
            if (p.stage1 && !p.stage2 && curPnL >= 5 && jmaTurnDown) {
                p.stage2 = true;
                takePartial(2);
            }
            // No fixed-profit selling: only protect a missed first partial AFTER
            // a completed close armed protection, with price/momentum breakdown.
            const peakPct = pct(priorPeakClose, p.entryPrice);
            const giveback = Math.max(config.minGivebackPct, config.givebackATR * priorATR / p.entryPrice * 100);
            if (config.protectBeforePartial && !p.stage1 && peakPct >= config.protectionArmPct &&
                curPnL < 2.5 && curPnL <= Math.max(0.2, peakPct - giveback) &&
                jma[i] < prevJMA && bar.close < prev.low && macd[i].value < macd[i - 1].value) {
                exit(bar, i, bar.close, '부분익절전 수익보호');
                continue;
            }
            // Keep the S4.3 runner rules and priority unchanged.
            const atr = st.rawATR[i] || (bar.high - bar.low);
            if (p.stage2 && bar.close < p.runnerHigh - 2.5 * atr) {
                exit(bar, i, bar.close, 'ATR동적트레일링컷');
                continue;
            }
            if (st.rawTrend[i] === -1 || (p.stage1 && bar.close < vwap[i].value * 0.995)) {
                exit(bar, i, bar.close, p.stage1 ? '추세이탈(런너청산)' : 'ST하락(손절)', true);
                continue;
            }
            if (bar.time > '1003') {
                const strong = st.rawTrend[i] === 1 && bar.close >= vwap[i].value * 1.01;
                if (!strong || bar.time >= '1030') {
                    exit(bar, i, bar.close, bar.time >= '1030' ? '추세연장마감(10:30)' : '10:03시간종료');
                }
            }
        }
        if (position && lastIndex >= 0) {
            // Truncated/live data is explicitly valued, never silently reported as 0%.
            exit(candles[lastIndex], lastIndex, candles[lastIndex].close, '데이터종료(평가손익)');
            result.closed = false;
        }
        return result;
    }
    function evaluate() {
        return { entered: false, pnl: null, entryTime: '-', exitReason: STATUS.label,
            disabled: true, markers: [], basePrice: 0, entryStartIdx: -1,
            cumAmtData: [], trades: [], tradeCount: 0, recoveryCount: 0, closed: true };
    }
    return Object.freeze({ STATUS, DEFAULTS, evaluate, evaluateResearch, hardStopFill });
});
