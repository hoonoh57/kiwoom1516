// static/app.js
(function () {
    let chartMacro = null, seriesMacroCandle = null;
    let chartMacroVol = null, seriesMacroVol = null;
    let lineMacroMA20 = null, lineMacroMA60 = null, lineMacroHigh20 = null, lineMacroLow60 = null;

    let chartMicro = null, seriesMicroCandle = null;
    let lineMicroBase = null, lineMicroVWAP = null;
    
    let jmaSeriesList = [];
    let stSeriesList = [];
    
    let chartMACD = null, seriesMACDHist = null;
    let macdPriceLines = [];

    let chartCumAmt = null, seriesCumAmtBar = null;
    let cumAmtPriceLines = [];

    let currentStockList = [];
    let stockDataCache = {};
    let activeStockCode = null;
    let activeStockName = null;

    const ENTRY_START_TIME = "0904";   // 09:03:59 포착 후 09:04부터 실전 진입
    const ENTRY_CUTOFF_TIME = "0930";  // 09:30 이후 늦은 진입 차단
    const ENTRY_END_TIME = "1003";     // 기본 포지션 청산 마감 시각
    const DEFAULT_HARD_STOP_LOSS_PCT = -2.5; // 기본 하드스탑 비율 (-2.5%)

    let macroBarsMap = {}, microBarsMap = {};

    function initCharts() {
        const cMacro = document.getElementById('chart-macro');
        const cMacroVol = document.getElementById('chart-macro-vol');
        const cMicro = document.getElementById('chart-micro');
        const cMACD = document.getElementById('chart-macd');
        const cCumAmt = document.getElementById('chart-cum-amt');
        if (!cMacro || !cMacroVol || !cMicro || !cMACD || !cCumAmt || !window.LightweightCharts) return;

        const baseOpts = {
            layout: { background: { type: 'solid', color: '#131722' }, textColor: '#d1d4dc' },
            grid: { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } },
            rightPriceScale: { borderColor: '#374151' },
            crosshair: { mode: 1 },
        };

        // 1. 일봉 차트
        chartMacro = window.LightweightCharts.createChart(cMacro, {
            ...baseOpts,
            timeScale: { borderColor: '#374151', timeVisible: true, secondsVisible: false }
        });
        seriesMacroCandle = chartMacro.addCandlestickSeries({
            upColor: '#ef4444', downColor: '#3b82f6', borderVisible: false, wickUpColor: '#ef4444', wickDownColor: '#3b82f6'
        });

        lineMacroMA20 = chartMacro.addLineSeries({ color: '#facc15', lineWidth: 1.5, title: '20일선' });
        lineMacroMA60 = chartMacro.addLineSeries({ color: '#c084fc', lineWidth: 1.5, title: '60일선' });
        lineMacroHigh20 = chartMacro.addLineSeries({ color: '#f43f5e', lineWidth: 1.5, lineStyle: 2, title: '20일고가' });
        lineMacroLow60 = chartMacro.addLineSeries({ color: '#10b981', lineWidth: 1.5, lineStyle: 2, title: '60일저점' });

        chartMacroVol = window.LightweightCharts.createChart(cMacroVol, {
            ...baseOpts,
            timeScale: { visible: false, borderColor: '#374151' }
        });
        seriesMacroVol = chartMacroVol.addHistogramSeries({
            color: '#38bdf8', priceFormat: { type: 'volume' }
        });

        chartMacro.timeScale().subscribeVisibleLogicalRangeChange(range => {
            if (range) chartMacroVol.timeScale().setVisibleLogicalRange(range);
        });

        // 2. 타점 차트
        chartMicro = window.LightweightCharts.createChart(cMicro, {
            ...baseOpts,
            timeScale: {
                borderColor: '#374151',
                timeVisible: true,
                secondsVisible: false,
                tickMarkFormatter: (t) => {
                    const d = new Date(t * 1000);
                    const hh = String(d.getHours()).padStart(2, '0');
                    const mm = String(d.getMinutes()).padStart(2, '0');
                    return `${hh}:${mm}`;
                }
            },
            localization: {
                timeFormatter: (t) => {
                    const d = new Date(t * 1000);
                    const hh = String(d.getHours()).padStart(2, '0');
                    const mm = String(d.getMinutes()).padStart(2, '0');
                    return `${hh}:${mm}`;
                }
            }
        });
        seriesMicroCandle = chartMicro.addCandlestickSeries({
            upColor: '#ef4444', downColor: '#3b82f6', borderVisible: false, wickUpColor: '#ef4444', wickDownColor: '#3b82f6'
        });

        lineMicroBase = chartMicro.addLineSeries({ color: '#f97316', lineWidth: 2, title: '기준선' });
        lineMicroVWAP = chartMicro.addLineSeries({ color: '#eab308', lineWidth: 1.8, title: 'VWAP' });

        // 3. Normalized MACD Histogram (%)
        chartMACD = window.LightweightCharts.createChart(cMACD, {
            ...baseOpts,
            timeScale: { visible: false, borderColor: '#374151' }
        });
        seriesMACDHist = chartMACD.addHistogramSeries({
            color: '#22c55e',
            priceFormat: {
                type: 'custom',
                formatter: (price) => `${price >= 0 ? '+' : ''}${price.toFixed(2)}%`
            }
        });

        // 4. 당일 08:00 누적 거래대금 차트
        chartCumAmt = window.LightweightCharts.createChart(cCumAmt, {
            ...baseOpts,
            timeScale: { visible: false, borderColor: '#374151' }
        });
        seriesCumAmtBar = chartCumAmt.addHistogramSeries({
            color: '#06b6d4',
            priceFormat: {
                type: 'custom',
                formatter: (price) => `${price.toFixed(1)}억`
            }
        });

        chartMicro.timeScale().subscribeVisibleLogicalRangeChange(range => {
            if (range) {
                chartMACD.timeScale().setVisibleLogicalRange(range);
                chartCumAmt.timeScale().setVisibleLogicalRange(range);
            }
        });

        window.addEventListener('resize', () => {
            if (chartMacro) chartMacro.applyOptions({ width: cMacro.clientWidth, height: cMacro.clientHeight });
            if (chartMacroVol) chartMacroVol.applyOptions({ width: cMacroVol.clientWidth, height: cMacroVol.clientHeight });
            if (chartMicro) chartMicro.applyOptions({ width: cMicro.clientWidth, height: cMicro.clientHeight });
            if (chartMACD) chartMACD.applyOptions({ width: cMACD.clientWidth, height: cMACD.clientHeight });
            if (chartCumAmt) chartCumAmt.applyOptions({ width: cCumAmt.clientWidth, height: cCumAmt.clientHeight });
        });

        setupHoverTooltip(chartMacro, cMacro, () => macroBarsMap, true);
        setupHoverTooltip(chartMicro, cMicro, () => microBarsMap, false);
        bindIndicatorVisibilityEvents();

        document.getElementById('sel-tf').addEventListener('change', () => {
            if (activeStockCode && activeStockName) {
                delete stockDataCache[activeStockCode];
                loadDualChart(activeStockCode, activeStockName);
            }
        });

        document.getElementById('sel-strategy').addEventListener('change', () => {
            if (activeStockCode && activeStockName) {
                loadDualChart(activeStockCode, activeStockName);
            }
        });

        ['input-macd-base', 'input-cum-amt-lines', 'chk-apply-mfe-gate', 'input-base-rate', 
         'chk-apply-cum-amt-gate', 'input-min-cum-amt', 'input-hard-stop'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', () => {
                if (activeStockCode && activeStockName) loadDualChart(activeStockCode, activeStockName);
            });
        });
    }

    function updateMACDPriceLines() {
        if (!seriesMACDHist) return;
        macdPriceLines.forEach(pl => seriesMACDHist.removePriceLine(pl));
        macdPriceLines = [];

        const inputVal = document.getElementById('input-macd-base').value || "0, 0.15";
        const vals = inputVal.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));

        vals.forEach(val => {
            const pl = seriesMACDHist.createPriceLine({
                price: val, color: '#ffffff', lineWidth: 1, lineStyle: 2, axisLabelVisible: true,
                title: `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`
            });
            macdPriceLines.push(pl);
        });
    }

    function updateCumAmtPriceLines() {
        if (!seriesCumAmtBar) return;
        cumAmtPriceLines.forEach(pl => seriesCumAmtBar.removePriceLine(pl));
        cumAmtPriceLines = [];

        const inputVal = document.getElementById('input-cum-amt-lines').value || "10, 30";
        const vals = inputVal.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));

        vals.forEach(val => {
            const pl = seriesCumAmtBar.createPriceLine({
                price: val, color: '#ffffff', lineWidth: 1, lineStyle: 2, axisLabelVisible: true,
                title: `${val}억`
            });
            cumAmtPriceLines.push(pl);
        });
    }

    function bindIndicatorVisibilityEvents() {
        const updateVisibility = () => {
            const showBase = document.getElementById('chk-base-line').checked;
            const showVWAP = document.getElementById('chk-vwap').checked;
            const showJMA = document.getElementById('chk-jma').checked;
            const showST = document.getElementById('chk-supertrend').checked;

            if (lineMicroBase) lineMicroBase.applyOptions({ visible: showBase });
            if (lineMicroVWAP) lineMicroVWAP.applyOptions({ visible: showVWAP });

            jmaSeriesList.forEach(s => s.applyOptions({ visible: showJMA }));
            stSeriesList.forEach(s => s.applyOptions({ visible: showST }));
        };

        ['chk-base-line', 'chk-vwap', 'chk-jma', 'chk-supertrend'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', updateVisibility);
        });
    }

    function calcVWAP(intradayBars) {
        let cumVol = 0, cumVolPrice = 0;
        return intradayBars.map(b => {
            const typicalPrice = (b.high + b.low + b.close) / 3.0;
            cumVolPrice += typicalPrice * b.volume;
            cumVol += b.volume;
            return { time: b.timestamp, value: cumVol > 0 ? cumVolPrice / cumVol : b.close };
        });
    }

    function calcDailyCumulativeAmount(candles, targetDate) {
        let runningAmtWon = 0;
        const res = [];
        candles.forEach(c => {
            if (c.date === targetDate) {
                const barAmtWon = c.amount ? c.amount : (c.close * c.volume);
                runningAmtWon += barAmtWon;
            } else {
                runningAmtWon = 0;
            }
            const amtEok = runningAmtWon / 100000000.0;
            res.push({
                time: c.timestamp,
                value: amtEok,
                color: amtEok >= 30.0 ? '#22c55e' : (amtEok >= 10.0 ? '#06b6d4' : '#64748b')
            });
        });
        return res;
    }

    function calcJMADualSegments(candles, length = 7, phase = 0, power = 2) {
        const n = candles.length;
        if (n === 0) return { rawJMA: [], segments: [] };

        const phaseParam = phase < -100 ? 0.5 : (phase > 100 ? 2.5 : phase / 100.0 + 1.5);
        const beta = 0.45 * (length - 1) / (0.45 * (length - 1) + 2);
        const alpha = Math.pow(beta, power);

        let e0 = candles[0].close, e1 = 0, e2 = 0, jma = candles[0].close;
        const jmaVals = new Float64Array(n);
        const slopes = new Int8Array(n);
        jmaVals[0] = candles[0].close;
        slopes[0] = 1;

        for (let i = 1; i < n; i++) {
            const src = candles[i].close;
            e0 = (1 - alpha) * src + alpha * e0;
            e1 = (src - e0) * (1 - beta) + beta * e1;
            e2 = (e0 + phaseParam * e1 - jma) * Math.pow(1 - alpha, 2) + Math.pow(alpha, 2) * e2;
            jma = jma + e2;
            jmaVals[i] = jma;
            slopes[i] = jmaVals[i] >= jmaVals[i - 1] ? 1 : -1;
        }

        const segments = [];
        let curSegment = {
            color: slopes[0] === 1 ? '#38bdf8' : '#fb7185',
            slope: slopes[0],
            data: [{ time: candles[0].timestamp, value: jmaVals[0] }]
        };

        for (let i = 1; i < n; i++) {
            const t = candles[i].timestamp, val = jmaVals[i], curS = slopes[i], prevS = slopes[i - 1];
            if (curS === prevS) {
                curSegment.data.push({ time: t, value: val });
            } else {
                segments.push(curSegment);
                curSegment = {
                    color: curS === 1 ? '#38bdf8' : '#fb7185', slope: curS,
                    data: [{ time: candles[i - 1].timestamp, value: jmaVals[i - 1] }, { time: t, value: val }]
                };
            }
        }
        segments.push(curSegment);
        return { rawJMA: jmaVals, segments };
    }

    function calcSupertrendSingleLineSegments(candles, period = 14, multiplier = 2.0) {
        const n = candles.length;
        if (n === 0) return { segments: [], rawTrend: [], rawATR: [] };

        const tr = new Float64Array(n);
        tr[0] = candles[0].high - candles[0].low;
        for (let i = 1; i < n; i++) {
            tr[i] = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
        }

        const atr = new Float64Array(n);
        let sumTR = 0;
        for (let i = 0; i < Math.min(period, n); i++) sumTR += tr[i];
        atr[period - 1] = sumTR / period;
        for (let i = period; i < n; i++) {
            atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
        }
        for (let i = 0; i < period - 1; i++) atr[i] = tr[i];

        const upBand = new Float64Array(n), dnBand = new Float64Array(n), trend = new Int8Array(n), stVal = new Float64Array(n);
        const hl2_0 = (candles[0].high + candles[0].low) / 2.0;
        upBand[0] = hl2_0 - multiplier * atr[0];
        dnBand[0] = hl2_0 + multiplier * atr[0];
        trend[0] = 1;
        stVal[0] = upBand[0];

        for (let i = 1; i < n; i++) {
            const hl2 = (candles[i].high + candles[i].low) / 2.0;
            const basicUp = hl2 - multiplier * atr[i];
            const basicDn = hl2 + multiplier * atr[i];

            upBand[i] = trend[i - 1] === 1 ? Math.max(basicUp, upBand[i - 1]) : basicUp;
            dnBand[i] = trend[i - 1] === -1 ? Math.min(basicDn, dnBand[i - 1]) : basicDn;

            let curTrend = trend[i - 1];
            if (curTrend === 1 && candles[i].close < upBand[i]) curTrend = -1;
            else if (curTrend === -1 && candles[i].close > dnBand[i]) curTrend = 1;

            trend[i] = curTrend;
            stVal[i] = curTrend === 1 ? upBand[i] : dnBand[i];
        }

        const segments = [];
        let curSegment = { color: trend[0] === 1 ? '#22c55e' : '#ef4444', trend: trend[0], data: [{ time: candles[0].timestamp, value: stVal[0] }] };

        for (let i = 1; i < n; i++) {
            const t = candles[i].timestamp, val = stVal[i], curT = trend[i], prevT = trend[i - 1];
            if (curT === prevT) {
                curSegment.data.push({ time: t, value: val });
            } else {
                segments.push(curSegment);
                curSegment = { color: curT === 1 ? '#22c55e' : '#ef4444', trend: curT, data: [{ time: candles[i - 1].timestamp, value: stVal[i - 1] }, { time: t, value: val }] };
            }
        }
        segments.push(curSegment);
        return { segments, rawTrend: trend, lastST: stVal, rawATR: atr };
    }

    function calcNormalizedMACD(intradayBars, fast = 5, slow = 13, signal = 4) {
        let emaFast = intradayBars[0].close, emaSlow = intradayBars[0].close, emaSignal = 0;
        const kFast = 2.0 / (fast + 1), kSlow = 2.0 / (slow + 1), kSig = 2.0 / (signal + 1);
        const histData = [];

        intradayBars.forEach((b, idx) => {
            emaFast = idx === 0 ? b.close : emaFast + kFast * (b.close - emaFast);
            emaSlow = idx === 0 ? b.close : emaSlow + kSlow * (b.close - emaSlow);
            const macdLine = emaFast - emaSlow;
            emaSignal = idx === 0 ? macdLine : emaSignal + kSig * (macdLine - emaSignal);
            const histRaw = macdLine - emaSignal;
            const normHistPct = b.close > 0 ? (histRaw / b.close) * 100.0 : 0.0;

            histData.push({
                time: b.timestamp,
                value: normHistPct,
                color: normHistPct >= 0 ? '#ef4444' : '#3b82f6'
            });
        });
        return histData;
    }

    function setupHoverTooltip(chart, container, getBarsMap, isDaily) {
        const tooltip = document.getElementById('global-candle-tooltip');
        let hoverTimer = null, activeKey = null, mouseX = 0, mouseY = 0;

        container.addEventListener('mousemove', (e) => { mouseX = e.clientX; mouseY = e.clientY; });
        container.addEventListener('mouseleave', () => {
            if (hoverTimer) clearTimeout(hoverTimer);
            activeKey = null;
            tooltip.style.display = 'none';
        });

        chart.subscribeCrosshairMove((param) => {
            if (!param || !param.time || !param.point || param.point.x < 0 || param.point.y < 0) {
                if (hoverTimer) clearTimeout(hoverTimer);
                activeKey = null;
                tooltip.style.display = 'none';
                return;
            }

            let key = param.time;
            if (typeof key === 'object' && key !== null) {
                key = `${key.year}-${String(key.month).padStart(2, '0')}-${String(key.day).padStart(2, '0')}`;
            } else {
                key = String(key);
            }

            if (activeKey === key) return;
            if (hoverTimer) clearTimeout(hoverTimer);
            tooltip.style.display = 'none';
            activeKey = key;

            hoverTimer = setTimeout(() => {
                const map = getBarsMap();
                const barInfo = map[activeKey];
                if (!barInfo) return;

                const curr = barInfo.current, prev = barInfo.prev;
                let chgHtml = '-';
                if (prev && prev.close > 0) {
                    const pct = ((curr.close - prev.close) / prev.close) * 100.0;
                    chgHtml = `<span style="color:${pct >= 0 ? '#ef4444' : '#3b82f6'};font-weight:bold;">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>`;
                }

                const amt = curr.amount ? curr.amount : (curr.close * curr.volume);
                const amtStr = `${(amt / 100000000.0).toFixed(1)}억`;
                const rawT = String(curr.time).padStart(4, '0');
                const tDisp = `${rawT.substring(0, 2)}:${rawT.substring(2, 4)}`;
                const titleStr = isDaily ? `[일봉] ${curr.date}` : `[타점] ${curr.date} ${tDisp}`;

                tooltip.innerHTML = `
                    <div style="font-weight:bold;color:#38bdf8;border-bottom:1px solid #334155;padding-bottom:2px;margin-bottom:3px;">
                        ${titleStr} (등락: ${chgHtml})
                    </div>
                    <div>시: ${curr.open.toLocaleString()} | 종: <b>${curr.close.toLocaleString()}</b></div>
                    <div>고: <span style="color:#ef4444">${curr.high.toLocaleString()}</span> | 저: <span style="color:#3b82f6">${curr.low.toLocaleString()}</span></div>
                    <div style="border-top:1px dashed #334155;margin-top:2px;padding-top:2px;">
                        거래량: <span style="color:#facc15">${curr.volume.toLocaleString()}주</span> (${amtStr})
                    </div>
                `;
                tooltip.style.display = 'block';
                tooltip.style.left = `${Math.min(mouseX + 15, window.innerWidth - 220)}px`;
                tooltip.style.top = `${Math.min(mouseY + 15, window.innerHeight - 150)}px`;
            }, 3000);
        });
    }

    function parseDateToDateString(dStr) {
        return `${dStr.substring(0, 4)}-${dStr.substring(4, 6)}-${dStr.substring(6, 8)}`;
    }

    function buildStrictTimestamps(candles) {
        let lastTs = 0;
        candles.forEach(c => {
            const dStr = String(c.date);
            const tStr = String(c.time).padStart(4, '0');
            const y = parseInt(dStr.substring(0, 4), 10);
            const m = parseInt(dStr.substring(4, 6), 10) - 1;
            const d = parseInt(dStr.substring(6, 8), 10);
            const hh = parseInt(tStr.substring(0, 2), 10);
            const mm = parseInt(tStr.substring(2, 4), 10);
            const dt = new Date(y, m, d, hh, mm, 0);
            let ts = Math.floor(dt.getTime() / 1000);
            if (ts <= lastTs) ts = lastTs + 1;
            c.timestamp = ts;
            lastTs = ts;
        });
    }

    // --- [통합 전략 시뮬레이션 엔진: S4 / S4.1 / S4.2(동결) / S4.3(ATR 동적 트레일링 실험)] ---
    function evaluateStrategyTrade(candles, targetStrategy, targetDate, baseRatePct, macdThreshold, applyMfeGate, officialMfeVal, applyCumAmtGate, minCumAmtEok, userHardStopPct) {
        if (!candles || candles.length === 0) {
            return { entered: false, pnl: 0, entryTime: '-', exitReason: '데이터없음', markers: [], basePrice: 0, entryStartIdx: -1, cumAmtData: [] };
        }

        const effectiveHardStop = (typeof userHardStopPct === 'number' && !isNaN(userHardStopPct)) ? userHardStopPct : DEFAULT_HARD_STOP_LOSS_PCT;

        // 공식 MFE 사전 게이트
        if (applyMfeGate && officialMfeVal !== null && officialMfeVal !== undefined) {
            if (officialMfeVal < baseRatePct) {
                return { entered: false, pnl: 0, entryTime: '-', exitReason: `MFE미달(${officialMfeVal.toFixed(1)}%)`, markers: [], basePrice: 0, entryStartIdx: -1, cumAmtData: [] };
            }
        }

        buildStrictTimestamps(candles);

        const vwapData = calcVWAP(candles);
        const jmaResult = calcJMADualSegments(candles, 7, 0, 2);
        const stResult = calcSupertrendSingleLineSegments(candles, 14, 2.0);
        const macdData = calcNormalizedMACD(candles, 5, 13, 4);
        const cumAmtData = calcDailyCumulativeAmount(candles, targetDate);

        const rawJMA = jmaResult.rawJMA;
        const rawSTTrend = stResult.rawTrend;
        const rawATR = stResult.rawATR;

        let capturePrice = 0;
        let entryStartIdx = -1;

        for (let i = 0; i < candles.length; i++) {
            const c = candles[i];
            if (c.date === targetDate) {
                if (c.time <= "0903") capturePrice = c.close;
                if (c.time >= ENTRY_START_TIME && entryStartIdx === -1) entryStartIdx = i;
            }
        }

        if (capturePrice <= 0 && entryStartIdx !== -1) capturePrice = candles[entryStartIdx].open;
        if (capturePrice <= 0 || entryStartIdx === -1) {
            return { entered: false, pnl: 0, entryTime: '-', exitReason: '09:04봉없음', markers: [], basePrice: 0, entryStartIdx: -1, cumAmtData };
        }

        const basePrice = capturePrice * (1.0 + baseRatePct / 100.0);

        const markers = [];
        let entryTaken = false;
        let entryPrice = 0;
        let entryTimestamp = 0;
        let entryTimeStr = '-';
        let exitPrice = 0;
        let exitReason = '미체결';
        let pnlPct = 0;

        let halfExited = false, halfExitPrice = 0;
        let s41_stg1 = false, s41_stg1_p = 0;
        let s41_stg2 = false, s41_stg2_p = 0;

        let s42_stg1 = false, s42_stg1_p = 0;
        let s42_stg2 = false, s42_stg2_p = 0;
        let s42_bepActive = false;

        // [S4.3 전용 지표 변수]
        let s43_stg1 = false, s43_stg1_p = 0;
        let s43_stg2 = false, s43_stg2_p = 0;
        let s43_bepActive = false;
        let s43_highestPrice = 0;

        for (let i = entryStartIdx; i < candles.length; i++) {
            const bar = candles[i];
            const prevBar = candles[i - 1];
            const curVWAP = vwapData[i].value;
            const curJMAVal = rawJMA[i];
            const prevJMAVal = rawJMA[i - 1];
            const prevPrevJMAVal = i >= 2 ? rawJMA[i - 2] : prevJMAVal;
            const curNormMACD = macdData[i].value;
            const curSTTrend = rawSTTrend[i];
            const curATRVal = rawATR[i] || (bar.high - bar.low);
            const curCumAmtEok = cumAmtData[i].value;

            const isWithinEntryWindow = (bar.date === targetDate && bar.time >= ENTRY_START_TIME && bar.time <= ENTRY_CUTOFF_TIME);
            const currentPctFromCap = ((bar.close - capturePrice) / capturePrice) * 100.0;

            // ==============================================================
            // [전략 A: S4 Baseline - 완전 동결 보존]
            // ==============================================================
            if (targetStrategy === 'S4') {
                if (!entryTaken && isWithinEntryWindow) {
                    const isSTUp = (curSTTrend === 1);
                    const isMACDReady = (curNormMACD >= macdThreshold);
                    const isJMATurnUp = (curJMAVal > prevJMAVal && prevJMAVal <= prevPrevJMAVal);
                    const isJMAUpTrend = (curJMAVal > prevJMAVal);
                    const isS4Setup = isSTUp && isMACDReady && (isJMATurnUp || isJMAUpTrend);

                    let canEnter = applyMfeGate ? (isS4Setup && bar.close >= basePrice && currentPctFromCap >= baseRatePct) : isS4Setup;
                    if (canEnter && applyCumAmtGate && curCumAmtEok < minCumAmtEok) canEnter = false;

                    if (canEnter) {
                        entryTaken = true; entryPrice = bar.close; entryTimestamp = bar.timestamp;
                        entryTimeStr = `${bar.time.substring(0, 2)}:${bar.time.substring(2, 4)}`;
                        markers.push({ time: entryTimestamp, position: 'belowBar', color: '#facc15', shape: 'arrowUp', text: `[S4진입] ${entryPrice.toLocaleString()}원` });
                    }
                }

                if (entryTaken && bar.timestamp > entryTimestamp) {
                    const curPnL = ((bar.close - entryPrice) / entryPrice) * 100.0;
                    const isJMATurnDown = (curJMAVal < prevJMAVal && prevJMAVal >= prevPrevJMAVal);

                    if (curPnL <= DEFAULT_HARD_STOP_LOSS_PCT) {
                        exitPrice = bar.close; exitReason = '하드스탑(-2.5%)';
                        pnlPct = halfExited ? (((halfExitPrice - entryPrice) / entryPrice * 50) + ((exitPrice - entryPrice) / entryPrice * 50)) : curPnL;
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#3b82f6', shape: 'arrowDown', text: `[${exitReason}] ${exitPrice.toLocaleString()}원 (${curPnL.toFixed(2)}%)` });
                        break;
                    }
                    if (!halfExited && curPnL >= 1.0 && isJMATurnDown) {
                        halfExited = true; halfExitPrice = bar.close;
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#fb923c', shape: 'arrowDown', text: `[50%익절] ${halfExitPrice.toLocaleString()}원 (+${curPnL.toFixed(2)}%)` });
                    }
                    if (curSTTrend === -1) {
                        exitPrice = bar.close; exitReason = halfExited ? 'ST하락(잔여청산)' : (curPnL >= 0 ? 'ST하락(익절)' : 'ST하락(손절)');
                        pnlPct = halfExited ? (((halfExitPrice - entryPrice) / entryPrice * 50) + ((exitPrice - entryPrice) / entryPrice * 50)) : curPnL;
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: pnlPct >= 0 ? '#ef4444' : '#3b82f6', shape: 'arrowDown', text: `[${exitReason}] ${exitPrice.toLocaleString()}원 (${curPnL.toFixed(2)}%)` });
                        break;
                    }
                    if (bar.date === targetDate && bar.time > ENTRY_END_TIME) {
                        exitPrice = bar.close; exitReason = halfExited ? '10:03종료(잔여)' : '10:03시간종료';
                        pnlPct = halfExited ? (((halfExitPrice - entryPrice) / entryPrice * 50) + ((exitPrice - entryPrice) / entryPrice * 50)) : curPnL;
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#c084fc', shape: 'arrowDown', text: `[${exitReason}] ${exitPrice.toLocaleString()}원 (${curPnL.toFixed(2)}%)` });
                        break;
                    }
                }
            }
            // ==============================================================
            // [전략 B: S4.1 (MFE Extractor) - 완전 동결 보존]
            // ==============================================================
            else if (targetStrategy === 'S4.1') {
                if (!entryTaken && isWithinEntryWindow) {
                    const isSTUp = (curSTTrend === 1);
                    const isMACDReady = (curNormMACD >= macdThreshold);
                    const isJMATurnUp = (curJMAVal > prevJMAVal && prevJMAVal <= prevPrevJMAVal);
                    const isJMAUpTrend = (curJMAVal > prevJMAVal);
                    const isS4Setup = isSTUp && isMACDReady && (isJMATurnUp || isJMAUpTrend);

                    let normalEnter = applyMfeGate ? (isS4Setup && bar.close >= basePrice && currentPctFromCap >= baseRatePct) : isS4Setup;
                    let earlyAccelerationEnter = (isS4Setup && bar.time <= "0910" && curCumAmtEok >= 20.0 && curNormMACD >= 0.25);
                    let canEnter = normalEnter || earlyAccelerationEnter;
                    if (canEnter && applyCumAmtGate && curCumAmtEok < minCumAmtEok) canEnter = false;

                    if (canEnter) {
                        entryTaken = true; entryPrice = bar.close; entryTimestamp = bar.timestamp;
                        entryTimeStr = `${bar.time.substring(0, 2)}:${bar.time.substring(2, 4)}`;
                        markers.push({ time: entryTimestamp, position: 'belowBar', color: '#38bdf8', shape: 'arrowUp', text: `[S4.1진입] ${entryPrice.toLocaleString()}원` });
                    }
                }

                if (entryTaken && bar.timestamp > entryTimestamp) {
                    const curPnL = ((bar.close - entryPrice) / entryPrice) * 100.0;
                    const isJMATurnDown = (curJMAVal < prevJMAVal && prevJMAVal >= prevPrevJMAVal);

                    if (curPnL <= DEFAULT_HARD_STOP_LOSS_PCT) {
                        exitPrice = bar.close; exitReason = '하드스탑(-2.5%)';
                        let rem = 1.0, part = 0;
                        if (s41_stg1) { part += ((s41_stg1_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                        if (s41_stg2) { part += ((s41_stg2_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                        pnlPct = part + ((exitPrice - entryPrice) / entryPrice * (rem * 100));
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#3b82f6', shape: 'arrowDown', text: `[${exitReason}] ${exitPrice.toLocaleString()}원` });
                        break;
                    }
                    if (!s41_stg1 && curPnL >= 2.0 && isJMATurnDown) {
                        s41_stg1 = true; s41_stg1_p = bar.close;
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#fb923c', shape: 'arrowDown', text: `[30%익절] ${s41_stg1_p.toLocaleString()}원` });
                    }
                    if (s41_stg1 && !s41_stg2 && curPnL >= 4.5 && isJMATurnDown) {
                        s41_stg2 = true; s41_stg2_p = bar.close;
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#f59e0b', shape: 'arrowDown', text: `[60%익절] ${s41_stg2_p.toLocaleString()}원` });
                    }
                    if (curSTTrend === -1) {
                        exitPrice = bar.close; exitReason = 'ST하락(런너청산)';
                        let rem = 1.0, part = 0;
                        if (s41_stg1) { part += ((s41_stg1_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                        if (s41_stg2) { part += ((s41_stg2_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                        pnlPct = part + ((exitPrice - entryPrice) / entryPrice * (rem * 100));
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: pnlPct >= 0 ? '#ef4444' : '#3b82f6', shape: 'arrowDown', text: `[${exitReason}] ${exitPrice.toLocaleString()}원` });
                        break;
                    }
                    if (bar.date === targetDate && bar.time > ENTRY_END_TIME) {
                        const isTrendAlive = (curSTTrend === 1 && bar.close >= curVWAP);
                        if (!isTrendAlive || bar.time >= "1030") {
                            exitPrice = bar.close; exitReason = (bar.time >= "1030") ? '추세연장마감(10:30)' : '10:03시간종료';
                            let rem = 1.0, part = 0;
                            if (s41_stg1) { part += ((s41_stg1_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                            if (s41_stg2) { part += ((s41_stg2_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                            pnlPct = part + ((exitPrice - entryPrice) / entryPrice * (rem * 100));
                            markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#c084fc', shape: 'arrowDown', text: `[${exitReason}] ${exitPrice.toLocaleString()}원` });
                            break;
                        }
                    }
                }
            }
            // ==============================================================
            // [전략 C: S4.2 (Adaptive Runner & BEP Protection) - 핵심 기준선 완전 보존]
            // ==============================================================
            else if (targetStrategy === 'S4.2') {
                if (!entryTaken && isWithinEntryWindow) {
                    const isSTUp = (curSTTrend === 1);
                    const isMACDReady = (curNormMACD >= macdThreshold);
                    const isJMATurnUp = (curJMAVal > prevJMAVal && prevJMAVal <= prevPrevJMAVal);
                    const isJMAUpTrend = (curJMAVal > prevJMAVal);
                    const isS4Setup = isSTUp && isMACDReady && (isJMATurnUp || isJMAUpTrend);

                    let normalEnter = applyMfeGate ? (isS4Setup && bar.close >= basePrice && currentPctFromCap >= baseRatePct) : isS4Setup;
                    let earlyAccelerationEnter = (isS4Setup && bar.time <= "0912" && curCumAmtEok >= 15.0 && curNormMACD >= 0.20);
                    let canEnter = normalEnter || earlyAccelerationEnter;
                    if (canEnter && applyCumAmtGate && curCumAmtEok < minCumAmtEok) canEnter = false;

                    if (canEnter) {
                        entryTaken = true; entryPrice = bar.close; entryTimestamp = bar.timestamp;
                        entryTimeStr = `${bar.time.substring(0, 2)}:${bar.time.substring(2, 4)}`;
                        markers.push({ time: entryTimestamp, position: 'belowBar', color: '#a855f7', shape: 'arrowUp', text: `[S4.2진입] ${entryPrice.toLocaleString()}원` });
                    }
                }

                if (entryTaken && bar.timestamp > entryTimestamp) {
                    const curPnL = ((bar.close - entryPrice) / entryPrice) * 100.0;
                    const isJMATurnDown = (curJMAVal < prevJMAVal && prevJMAVal >= prevPrevJMAVal);

                    // 1) 사용자 조절 하드스탑
                    if (curPnL <= effectiveHardStop) {
                        exitPrice = bar.close;
                        exitReason = `초기손절(스탑${effectiveHardStop.toFixed(1)}%)`;
                        let rem = 1.0, part = 0;
                        if (s42_stg1) { part += ((s42_stg1_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                        if (s42_stg2) { part += ((s42_stg2_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                        pnlPct = part + ((exitPrice - entryPrice) / entryPrice * (rem * 100));
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#ef4444', shape: 'arrowDown', text: `[${exitReason}] ${exitPrice.toLocaleString()}원` });
                        break;
                    }

                    // 2) BEP 본전보호 트레일링
                    if (s42_bepActive && curPnL <= 0.2) {
                        exitPrice = bar.close;
                        exitReason = '본전보호(BEP컷)';
                        let rem = 1.0, part = 0;
                        if (s42_stg1) { part += ((s42_stg1_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                        if (s42_stg2) { part += ((s42_stg2_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                        pnlPct = part + ((exitPrice - entryPrice) / entryPrice * (rem * 100));
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#38bdf8', shape: 'arrowDown', text: `[${exitReason}] ${exitPrice.toLocaleString()}원` });
                        break;
                    }

                    // 3) 1차 익절: +2.5% 도달 시 30% 매도 및 BEP 보호 가동
                    if (!s42_stg1 && curPnL >= 2.5 && isJMATurnDown) {
                        s42_stg1 = true; s42_stg1_p = bar.close; s42_bepActive = true;
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#fb923c', shape: 'arrowDown', text: `[1차30%익절] ${s42_stg1_p.toLocaleString()}원 (+${curPnL.toFixed(2)}%)` });
                    }

                    // 4) 2차 익절: +5.0% 이상 시 추가 30% 매도
                    if (s42_stg1 && !s42_stg2 && curPnL >= 5.0 && isJMATurnDown) {
                        s42_stg2 = true; s42_stg2_p = bar.close;
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#f59e0b', shape: 'arrowDown', text: `[2차30%익절] ${s42_stg2_p.toLocaleString()}원 (+${curPnL.toFixed(2)}%)` });
                    }

                    // 5) Supertrend 하락 또는 VWAP 이탈 시 잔여 물량 청산
                    if (curSTTrend === -1 || (s42_stg1 && bar.close < curVWAP * 0.995)) {
                        exitPrice = bar.close;
                        exitReason = (s42_stg1 || s42_stg2) ? '추세이탈(런너청산)' : 'ST하락(손절)';
                        let rem = 1.0, part = 0;
                        if (s42_stg1) { part += ((s42_stg1_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                        if (s42_stg2) { part += ((s42_stg2_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                        pnlPct = part + ((exitPrice - entryPrice) / entryPrice * (rem * 100));
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: pnlPct >= 0 ? '#ef4444' : '#3b82f6', shape: 'arrowDown', text: `[${exitReason}] ${exitPrice.toLocaleString()}원` });
                        break;
                    }

                    // 6) 10:03 타임아웃 검사
                    if (bar.date === targetDate && bar.time > ENTRY_END_TIME) {
                        const isTrendStrong = (curSTTrend === 1 && bar.close >= curVWAP * 1.01);
                        if (!isTrendStrong || bar.time >= "1030") {
                            exitPrice = bar.close;
                            exitReason = (bar.time >= "1030") ? '추세연장마감(10:30)' : '10:03시간종료';
                            let rem = 1.0, part = 0;
                            if (s42_stg1) { part += ((s42_stg1_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                            if (s42_stg2) { part += ((s42_stg2_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                            pnlPct = part + ((exitPrice - entryPrice) / entryPrice * (rem * 100));
                            markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#c084fc', shape: 'arrowDown', text: `[${exitReason}] ${exitPrice.toLocaleString()}원` });
                            break;
                        }
                    }
                }
            }
            // ==============================================================
            // [전략 D: S4.3 (ATR 기반 동적 변동성 트레일링 런너 - 실험 분기)]
            // ==============================================================
            else if (targetStrategy === 'S4.3') {
                if (!entryTaken && isWithinEntryWindow) {
                    const isSTUp = (curSTTrend === 1);
                    const isMACDReady = (curNormMACD >= macdThreshold);
                    const isJMATurnUp = (curJMAVal > prevJMAVal && prevJMAVal <= prevPrevJMAVal);
                    const isJMAUpTrend = (curJMAVal > prevJMAVal);
                    const isS4Setup = isSTUp && isMACDReady && (isJMATurnUp || isJMAUpTrend);

                    let normalEnter = applyMfeGate ? (isS4Setup && bar.close >= basePrice && currentPctFromCap >= baseRatePct) : isS4Setup;
                    let earlyAccelerationEnter = (isS4Setup && bar.time <= "0912" && curCumAmtEok >= 15.0 && curNormMACD >= 0.20);
                    let canEnter = normalEnter || earlyAccelerationEnter;
                    if (canEnter && applyCumAmtGate && curCumAmtEok < minCumAmtEok) canEnter = false;

                    if (canEnter) {
                        entryTaken = true; entryPrice = bar.close; entryTimestamp = bar.timestamp;
                        entryTimeStr = `${bar.time.substring(0, 2)}:${bar.time.substring(2, 4)}`;
                        s43_highestPrice = bar.high;
                        markers.push({ time: entryTimestamp, position: 'belowBar', color: '#c026d3', shape: 'arrowUp', text: `[S4.3진입] ${entryPrice.toLocaleString()}원` });
                    }
                }

                // S4.3 청산 엔진 (하드코딩 배제, 2.5 * ATR 동적 트레일링 적용)
                if (entryTaken && bar.timestamp > entryTimestamp) {
                    if (bar.high > s43_highestPrice) s43_highestPrice = bar.high;

                    const curPnL = ((bar.close - entryPrice) / entryPrice) * 100.0;
                    const isJMATurnDown = (curJMAVal < prevJMAVal && prevJMAVal >= prevPrevJMAVal);

                    // 1) 사용자 조절 하드스탑
                    if (curPnL <= effectiveHardStop) {
                        exitPrice = bar.close;
                        exitReason = `초기손절(스탑${effectiveHardStop.toFixed(1)}%)`;
                        let rem = 1.0, part = 0;
                        if (s43_stg1) { part += ((s43_stg1_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                        if (s43_stg2) { part += ((s43_stg2_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                        pnlPct = part + ((exitPrice - entryPrice) / entryPrice * (rem * 100));
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#ef4444', shape: 'arrowDown', text: `[${exitReason}] ${exitPrice.toLocaleString()}원` });
                        break;
                    }

                    // 2) BEP 본전보호 트레일링
                    if (s43_bepActive && curPnL <= 0.2) {
                        exitPrice = bar.close;
                        exitReason = '본전보호(BEP컷)';
                        let rem = 1.0, part = 0;
                        if (s43_stg1) { part += ((s43_stg1_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                        if (s43_stg2) { part += ((s43_stg2_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                        pnlPct = part + ((exitPrice - entryPrice) / entryPrice * (rem * 100));
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#38bdf8', shape: 'arrowDown', text: `[${exitReason}] ${exitPrice.toLocaleString()}원` });
                        break;
                    }

                    // 3) 1차 익절: +2.5% 도달 시 30% 매도 및 BEP 보호 가동
                    if (!s43_stg1 && curPnL >= 2.5 && isJMATurnDown) {
                        s43_stg1 = true; s43_stg1_p = bar.close; s43_bepActive = true;
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#fb923c', shape: 'arrowDown', text: `[1차30%익절] ${s43_stg1_p.toLocaleString()}원 (+${curPnL.toFixed(2)}%)` });
                    }

                    // 4) 2차 익절: +5.0% 이상 시 추가 30% 매도
                    if (s43_stg1 && !s43_stg2 && curPnL >= 5.0 && isJMATurnDown) {
                        s43_stg2 = true; s43_stg2_p = bar.close;
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#f59e0b', shape: 'arrowDown', text: `[2차30%익절] ${s43_stg2_p.toLocaleString()}원 (+${curPnL.toFixed(2)}%)` });
                    }

                    // 5) [S4.3 핵심 혁신] ATR 기반 동적 변동성 트레일링 컷
                    // 2차 익절(+5.0%) 달성 후 장중 최고가 대비 2.5배 ATR 이상 급반락 시 잔여 40% 런너를 이익 보존 청산
                    const atrTrailingStopPrice = s43_highestPrice - (2.5 * curATRVal);
                    if (s43_stg2 && bar.close < atrTrailingStopPrice) {
                        exitPrice = bar.close;
                        exitReason = 'ATR동적트레일링컷';
                        let rem = 1.0, part = 0;
                        if (s43_stg1) { part += ((s43_stg1_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                        if (s43_stg2) { part += ((s43_stg2_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                        pnlPct = part + ((exitPrice - entryPrice) / entryPrice * (rem * 100));
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#c026d3', shape: 'arrowDown', text: `[ATR트레일링컷] ${exitPrice.toLocaleString()}원 (+${curPnL.toFixed(2)}%)` });
                        break;
                    }

                    // 6) Supertrend 하락 또는 VWAP 이탈 시 잔여 물량 청산
                    if (curSTTrend === -1 || (s43_stg1 && bar.close < curVWAP * 0.995)) {
                        exitPrice = bar.close;
                        exitReason = (s43_stg1 || s43_stg2) ? '추세이탈(런너청산)' : 'ST하락(손절)';
                        let rem = 1.0, part = 0;
                        if (s43_stg1) { part += ((s43_stg1_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                        if (s43_stg2) { part += ((s43_stg2_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                        pnlPct = part + ((exitPrice - entryPrice) / entryPrice * (rem * 100));
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: pnlPct >= 0 ? '#ef4444' : '#3b82f6', shape: 'arrowDown', text: `[${exitReason}] ${exitPrice.toLocaleString()}원` });
                        break;
                    }

                    // 7) 10:03 타임아웃 검사
                    if (bar.date === targetDate && bar.time > ENTRY_END_TIME) {
                        const isTrendStrong = (curSTTrend === 1 && bar.close >= curVWAP * 1.01);
                        if (!isTrendStrong || bar.time >= "1030") {
                            exitPrice = bar.close;
                            exitReason = (bar.time >= "1030") ? '추세연장마감(10:30)' : '10:03시간종료';
                            let rem = 1.0, part = 0;
                            if (s43_stg1) { part += ((s43_stg1_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                            if (s43_stg2) { part += ((s43_stg2_p - entryPrice) / entryPrice * 30); rem -= 0.3; }
                            pnlPct = part + ((exitPrice - entryPrice) / entryPrice * (rem * 100));
                            markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#c084fc', shape: 'arrowDown', text: `[${exitReason}] ${exitPrice.toLocaleString()}원` });
                            break;
                        }
                    }
                }
            }
            // ==============================================================
            // [기타 전략 S1, S2, S3]
            // ==============================================================
            else if (basePrice > 0) {
                if (!entryTaken && isWithinEntryWindow && bar.close >= basePrice) {
                    let canEnter = false;
                    let stratName = targetStrategy;
                    if (targetStrategy.includes('S1') && bar.low >= curVWAP * 0.99 && curJMAVal > prevJMAVal && curNormMACD >= macdThreshold) canEnter = true;
                    else if (targetStrategy.includes('S3') && prevBar.close < curVWAP && bar.close >= curVWAP && curNormMACD >= macdThreshold) canEnter = true;
                    else if (targetStrategy.includes('S2') && curJMAVal > prevJMAVal && curNormMACD >= macdThreshold) canEnter = true;

                    if (canEnter && applyCumAmtGate && curCumAmtEok < minCumAmtEok) canEnter = false;
                    if (canEnter) {
                        entryTaken = true; entryPrice = bar.close; entryTimestamp = bar.timestamp;
                        entryTimeStr = `${bar.time.substring(0, 2)}:${bar.time.substring(2, 4)}`;
                        markers.push({ time: entryTimestamp, position: 'belowBar', color: '#facc15', shape: 'arrowUp', text: `[${stratName}진입] ${entryPrice.toLocaleString()}원` });
                    }
                }

                if (entryTaken && bar.timestamp > entryTimestamp) {
                    const curPnL = ((bar.close - entryPrice) / entryPrice) * 100.0;
                    if (bar.close < basePrice * 0.99 || curPnL <= -2.0) {
                        exitPrice = bar.close; exitReason = curPnL <= -2.0 ? '손절(-2%)' : '기준선이탈손절';
                        pnlPct = curPnL;
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#3b82f6', shape: 'arrowDown', text: `[${exitReason}] ${exitPrice.toLocaleString()}원` });
                        break;
                    }
                    if (curPnL >= 5.0) {
                        exitPrice = bar.close; exitReason = '목표익절(+5%)'; pnlPct = curPnL;
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#ef4444', shape: 'arrowDown', text: `[${exitReason}] ${exitPrice.toLocaleString()}원` });
                        break;
                    }
                    if (bar.date === targetDate && bar.time > ENTRY_END_TIME) {
                        exitPrice = bar.close; exitReason = '10:03시간종료'; pnlPct = curPnL;
                        markers.push({ time: bar.timestamp, position: 'aboveBar', color: '#c084fc', shape: 'arrowDown', text: `[${exitReason}] ${exitPrice.toLocaleString()}원` });
                        break;
                    }
                }
            }
        }

        return {
            entered: entryTaken, pnl: pnlPct, entryTime: entryTimeStr, exitReason: entryTaken ? exitReason : '미진입',
            markers: markers, basePrice: basePrice, entryStartIdx: entryStartIdx, cumAmtData
        };
    }

    async function executeCapture() {
        const btn = document.getElementById('btn-capture');
        const cond = document.getElementById('edit-cond').value.trim();
        const date = document.getElementById('edit-date').value.trim();
        const time = document.getElementById('edit-time').value.trim();

        btn.disabled = true;
        btn.innerText = "가로채는 중...";

        try {
            const resp = await fetch('/api/capture', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cond: parseInt(cond), date, time })
            });
            const res = await resp.json();
            if (res.status !== 'success') {
                alert(res.message || '가로채기 실패');
                return;
            }

            currentStockList = res.data;
            stockDataCache = {};
            renderTable();

            if (currentStockList.length > 0 && currentStockList[0].종목코드) {
                loadDualChart(currentStockList[0].종목코드, currentStockList[0].종목명);
            }
        } catch (e) {
            alert('통신 오류: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.innerText = "1516 성과검증 가로채기";
        }
    }

    function parseMfeStringToFloat(mfeStr) {
        if (!mfeStr) return null;
        const cleaned = String(mfeStr).replace(/[+%]/g, '').trim();
        const val = parseFloat(cleaned);
        return isNaN(val) ? null : val;
    }

    // --- [4단 동시 비교 배치 백테스트: S4 vs S4.1 vs S4.2 vs S4.3] ---
    async function executeBatchBacktest() {
        if (!currentStockList || currentStockList.length === 0) {
            alert("먼저 [1516 성과검증 가로채기]를 실행해 종목 리스트를 불러오세요.");
            return;
        }

        const btn = document.getElementById('btn-batch-backtest');
        const badge = document.getElementById('batch-stat-badge');
        const date = document.getElementById('edit-date').value.trim();
        const baseRate = parseFloat(document.getElementById('input-base-rate').value) || 5.5;
        const applyMfeGate = document.getElementById('chk-apply-mfe-gate').checked;
        const applyCumAmtGate = document.getElementById('chk-apply-cum-amt-gate').checked;
        const minCumAmtEok = parseFloat(document.getElementById('input-min-cum-amt').value) || 3.0;
        const userHardStopPct = parseFloat(document.getElementById('input-hard-stop').value) || DEFAULT_HARD_STOP_LOSS_PCT;

        const batchTfVal = document.getElementById('sel-batch-tf').value;
        const parts = batchTfVal.split('-');
        const unit = parts[0];
        const tf = parseInt(parts[1], 10);

        document.getElementById('sel-tf').value = batchTfVal;

        const inputVal = document.getElementById('input-macd-base').value || "0, 0.15";
        const parsed = inputVal.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n) && n > 0);
        const macdThreshold = parsed.length > 0 ? parsed[0] : 0.15;

        btn.disabled = true;
        let completed = 0;
        let total = currentStockList.length;

        let entered_S4 = 0, win_S4 = 0, totalPnl_S4 = 0.0;
        let entered_S41 = 0, win_S41 = 0, totalPnl_S41 = 0.0;
        let entered_S42 = 0, win_S42 = 0, totalPnl_S42 = 0.0;
        let entered_S43 = 0, win_S43 = 0, totalPnl_S43 = 0.0;

        for (let item of currentStockList) {
            const code = item.종목코드;
            completed++;
            badge.innerText = `S4 / S4.1 / S4.2 / S4.3 4단 백테스트 중... (${completed}/${total})`;

            const officialMfeVal = parseMfeStringToFloat(item['기간 내 최고수익률(MFE)']);

            if (!code) {
                item._batchPnl_S4 = null; item._batchPnl_S41 = null; item._batchPnl_S42 = null; item._batchPnl_S43 = null;
                item._batchExitReason_S43 = '코드없음';
                continue;
            }

            if (applyMfeGate && officialMfeVal !== null && officialMfeVal < baseRate) {
                item._batchPnl_S4 = null; item._batchPnl_S41 = null; item._batchPnl_S42 = null; item._batchPnl_S43 = null;
                item._batchExitReason_S43 = `MFE미달(${officialMfeVal.toFixed(1)}%)`;
                renderTable();
                continue;
            }

            let data = stockDataCache[code];
            if (!data || data._tf !== batchTfVal) {
                try {
                    const resp = await fetch(`/api/dual_chart?code=${code}&date=${date}&timeframe=${tf}&unit=${unit}`);
                    data = await resp.json();
                    if (data.status === 'success') {
                        data._tf = batchTfVal;
                        stockDataCache[code] = data;
                    }
                } catch (e) {
                    console.error(e);
                }
            }

            if (data && data.intraday) {
                // 1) S4 원형 (완전 보존)
                const simS4 = evaluateStrategyTrade(data.intraday, 'S4', date, baseRate, macdThreshold, applyMfeGate, officialMfeVal, applyCumAmtGate, minCumAmtEok, userHardStopPct);
                item._batchPnl_S4 = simS4.entered ? simS4.pnl : null;
                if (simS4.entered) { entered_S4++; totalPnl_S4 += simS4.pnl; if (simS4.pnl > 0) win_S4++; }

                // 2) S4.1 가변 익절 (완전 보존)
                const simS41 = evaluateStrategyTrade(data.intraday, 'S4.1', date, baseRate, macdThreshold, applyMfeGate, officialMfeVal, applyCumAmtGate, minCumAmtEok, userHardStopPct);
                item._batchPnl_S41 = simS41.entered ? simS41.pnl : null;
                if (simS41.entered) { entered_S41++; totalPnl_S41 += simS41.pnl; if (simS41.pnl > 0) win_S41++; }

                // 3) S4.2 확정 기준선 (완전 보존)
                const simS42 = evaluateStrategyTrade(data.intraday, 'S4.2', date, baseRate, macdThreshold, applyMfeGate, officialMfeVal, applyCumAmtGate, minCumAmtEok, userHardStopPct);
                item._batchPnl_S42 = simS42.entered ? simS42.pnl : null;
                if (simS42.entered) { entered_S42++; totalPnl_S42 += simS42.pnl; if (simS42.pnl > 0) win_S42++; }

                // 4) [S4.3 실험] ATR 기반 동적 트레일링 런너
                const simS43 = evaluateStrategyTrade(data.intraday, 'S4.3', date, baseRate, macdThreshold, applyMfeGate, officialMfeVal, applyCumAmtGate, minCumAmtEok, userHardStopPct);
                item._batchPnl_S43 = simS43.entered ? simS43.pnl : null;
                item._batchExitReason_S43 = simS43.exitReason;
                if (simS43.entered) { entered_S43++; totalPnl_S43 += simS43.pnl; if (simS43.pnl > 0) win_S43++; }
            } else {
                item._batchPnl_S4 = null; item._batchPnl_S41 = null; item._batchPnl_S42 = null; item._batchPnl_S43 = null;
                item._batchExitReason_S43 = '데이터부족';
            }

            renderTable();
        }

        btn.disabled = false;

        const avg_S4 = entered_S4 > 0 ? (totalPnl_S4 / entered_S4).toFixed(2) : '0.00';
        const avg_S41 = entered_S41 > 0 ? (totalPnl_S41 / entered_S41).toFixed(2) : '0.00';
        const avg_S42 = entered_S42 > 0 ? (totalPnl_S42 / entered_S42).toFixed(2) : '0.00';
        const avg_S43 = entered_S43 > 0 ? (totalPnl_S43 / entered_S43).toFixed(2) : '0.00';
        const win_S43_pct = entered_S43 > 0 ? ((win_S43 / entered_S43) * 100.0).toFixed(1) : '0.0';

        badge.innerHTML = `
            <span class="text-emerald-400 font-bold">S4: ${avg_S4}%</span> | 
            <span class="text-cyan-300 font-bold">S4.1: ${avg_S41}%</span> | 
            <span class="text-amber-300 font-bold">S4.2(기준): ${avg_S42}%</span> | 
            <span class="text-fuchsia-400 font-bold">S4.3(실험): <span class="${avg_S43 >= 0 ? 'text-rose-400' : 'text-sky-400'} font-bold">${avg_S43 >= 0 ? '+' : ''}${avg_S43}%</span> (승률:${win_S43_pct}%)</span>
        `;

        if (activeStockCode && activeStockName) {
            loadDualChart(activeStockCode, activeStockName);
        }
    }

    async function loadDualChart(code, name) {
        activeStockCode = code;
        activeStockName = name;

        const date = document.getElementById('edit-date').value.trim();
        const tfVal = document.getElementById('sel-tf').value;
        const parts = tfVal.split('-');
        const unit = parts[0];
        const tf = parseInt(parts[1], 10);

        const tfLabel = unit === 'm' ? `${tf}분봉` : `${tf}틱`;
        document.getElementById('macro-chart-title').innerText = `${name} (${code}) | D-1 일봉 (20/60선 & 20일고가/60일저점)`;
        document.getElementById('micro-chart-title').innerText = `${name} (${code}) | ${date} [${tfLabel} 타점 차트]`;

        try {
            let data = stockDataCache[code];
            if (!data || data._tf !== tfVal) {
                const resp = await fetch(`/api/dual_chart?code=${code}&date=${date}&timeframe=${tf}&unit=${unit}`);
                data = await resp.json();
                if (data.status === 'success') {
                    data._tf = tfVal;
                    stockDataCache[code] = data;
                }
            }

            if (!data || data.status !== 'success' || !data.intraday || data.intraday.length === 0) {
                document.getElementById('trade-pnl-badge').innerText = "데이터 없음";
                return;
            }

            // 1. 일봉 차트 바인딩
            const dailyCandles = [], dailyVol = [];
            const ma20Data = [], ma60Data = [], high20Data = [], low60Data = [];
            macroBarsMap = {};

            const highs = data.daily.map(b => b.high);
            const lows = data.daily.map(b => b.low);

            data.daily.forEach((b, idx, arr) => {
                const dKey = parseDateToDateString(b.date);
                dailyCandles.push({ time: dKey, open: b.open, high: b.high, low: b.low, close: b.close });
                dailyVol.push({ time: dKey, value: b.volume, color: b.close >= b.open ? '#ef4444' : '#3b82f6' });
                macroBarsMap[dKey] = { current: b, prev: idx > 0 ? arr[idx - 1] : null };

                if (idx >= 19) {
                    ma20Data.push({ time: dKey, value: arr.slice(idx - 19, idx + 1).reduce((acc, x) => acc + x.close, 0) / 20.0 });
                    high20Data.push({ time: dKey, value: Math.max(...highs.slice(idx - 19, idx + 1)) });
                }
                if (idx >= 59) {
                    ma60Data.push({ time: dKey, value: arr.slice(idx - 59, idx + 1).reduce((acc, x) => acc + x.close, 0) / 60.0 });
                    low60Data.push({ time: dKey, value: Math.min(...lows.slice(idx - 59, idx + 1)) });
                }
            });

            seriesMacroCandle.setData(dailyCandles);
            seriesMacroVol.setData(dailyVol);
            lineMacroMA20.setData(ma20Data);
            lineMacroMA60.setData(ma60Data);
            lineMacroHigh20.setData(high20Data);
            lineMacroLow60.setData(low60Data);

            chartMacro.timeScale().fitContent();
            chartMacroVol.timeScale().fitContent();

            const cls = data.classification || {};
            const det = cls.detail || {};
            document.getElementById('macro-metrics').innerText = 
                `분류:[${cls.type || '-'}] | 20일선:${det.ma20 || '-'} | 20일고가:${det.high20 || '-'} | D-1대금:${det.d1_amt || 0}억`;

            // 2. 타점 차트 바인딩
            buildStrictTimestamps(data.intraday);

            const microCandles = [];
            microBarsMap = {};

            data.intraday.forEach((c, idx, arr) => {
                microCandles.push({ time: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close });
                microBarsMap[String(c.timestamp)] = { current: c, prev: idx > 0 ? arr[idx - 1] : null };
            });

            seriesMicroCandle.setData(microCandles);

            const vwapData = calcVWAP(data.intraday);
            const macdData = calcNormalizedMACD(data.intraday, 5, 13, 4);
            lineMicroVWAP.setData(vwapData);
            seriesMACDHist.setData(macdData);

            updateMACDPriceLines();

            // JMA 2색
            jmaSeriesList.forEach(s => chartMicro.removeSeries(s));
            jmaSeriesList = [];
            const jmaResult = calcJMADualSegments(data.intraday, 7, 0, 2);
            const showJMA = document.getElementById('chk-jma').checked;
            jmaResult.segments.forEach(seg => {
                const sSeries = chartMicro.addLineSeries({
                    color: seg.color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false
                });
                sSeries.setData(seg.data);
                sSeries.applyOptions({ visible: showJMA });
                jmaSeriesList.push(sSeries);
            });

            // Supertrend 2색
            stSeriesList.forEach(s => chartMicro.removeSeries(s));
            stSeriesList = [];
            const stResult = calcSupertrendSingleLineSegments(data.intraday, 14, 2.0);
            const showST = document.getElementById('chk-supertrend').checked;
            stResult.segments.forEach(seg => {
                const sSeries = chartMicro.addLineSeries({
                    color: seg.color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false
                });
                sSeries.setData(seg.data);
                sSeries.applyOptions({ visible: showST });
                stSeriesList.push(sSeries);
            });

            // 전략 시뮬레이션 평가 (하드스탑 연동)
            const baseRatePct = parseFloat(document.getElementById('input-base-rate').value) || 5.5;
            const applyMfeGate = document.getElementById('chk-apply-mfe-gate').checked;
            const applyCumAmtGate = document.getElementById('chk-apply-cum-amt-gate').checked;
            const minCumAmtEok = parseFloat(document.getElementById('input-min-cum-amt').value) || 3.0;
            const userHardStopPct = parseFloat(document.getElementById('input-hard-stop').value) || DEFAULT_HARD_STOP_LOSS_PCT;

            const inputVal = document.getElementById('input-macd-base').value || "0, 0.15";
            const parsed = inputVal.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n) && n > 0);
            const macdThreshold = parsed.length > 0 ? parsed[0] : 0.15;
            const selectedStrategy = document.getElementById('sel-strategy').value;

            let currentItem = currentStockList.find(x => x.종목코드 === code);
            let officialMfeVal = currentItem ? parseMfeStringToFloat(currentItem['기간 내 최고수익률(MFE)']) : null;

            const tradeResult = evaluateStrategyTrade(data.intraday, selectedStrategy, date, baseRatePct, macdThreshold, applyMfeGate, officialMfeVal, applyCumAmtGate, minCumAmtEok, userHardStopPct);

            seriesCumAmtBar.setData(tradeResult.cumAmtData);
            updateCumAmtPriceLines();

            const baseLineData = [];
            if (tradeResult.basePrice > 0 && tradeResult.entryStartIdx !== -1) {
                for (let i = tradeResult.entryStartIdx; i < data.intraday.length; i++) {
                    baseLineData.push({ time: data.intraday[i].timestamp, value: tradeResult.basePrice });
                }
            }
            lineMicroBase.setData(baseLineData);

            seriesMicroCandle.setMarkers(tradeResult.markers);

            chartMicro.timeScale().fitContent();
            chartMACD.timeScale().fitContent();
            chartCumAmt.timeScale().fitContent();

            const pnlBadge = document.getElementById('trade-pnl-badge');
            if (tradeResult.entered) {
                const colorClass = tradeResult.pnl >= 0 ? 'text-emerald-400 border-emerald-800' : 'text-rose-400 border-rose-800';
                pnlBadge.className = `font-mono text-[11px] font-bold px-2 py-0.5 rounded bg-slate-950 border ${colorClass}`;
                pnlBadge.innerText = `[${selectedStrategy}] 결과: ${tradeResult.pnl >= 0 ? '+' : ''}${tradeResult.pnl.toFixed(2)}% (${tradeResult.exitReason})`;
            } else {
                pnlBadge.className = 'font-mono text-[11px] font-bold px-2 py-0.5 rounded bg-slate-950 border border-slate-800 text-slate-400';
                pnlBadge.innerText = `신호 미발생 (${tradeResult.exitReason})`;
            }

        } catch (e) {
            console.error(e);
        }
    }

    function renderTable() {
        const tbody = document.getElementById('table-body');
        const countEl = document.getElementById('stock-count');
        tbody.innerHTML = '';

        if (!currentStockList || currentStockList.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" class="p-4 text-center text-slate-500">데이터가 없습니다.</td></tr>`;
            countEl.innerText = "0개 종목";
            return;
        }

        countEl.innerText = `${currentStockList.length}개 종목`;

        currentStockList.forEach((item, idx) => {
            const tr = document.createElement('tr');
            tr.className = `cursor-pointer border-b border-slate-800/80 transition hover:bg-slate-800`;

            const mfeStr = item['기간 내 최고수익률(MFE)'] || '';
            
            // S4 순익
            let pnlHtml_S4 = `<span class="text-slate-500">-</span>`;
            if (item._batchPnl_S4 !== null && item._batchPnl_S4 !== undefined) {
                const val = item._batchPnl_S4;
                pnlHtml_S4 = `<span class="${val >= 0 ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}">${val >= 0 ? '+' : ''}${val.toFixed(2)}%</span>`;
            }

            // S4.1 순익
            let pnlHtml_S41 = `<span class="text-slate-500">-</span>`;
            if (item._batchPnl_S41 !== null && item._batchPnl_S41 !== undefined) {
                const val = item._batchPnl_S41;
                pnlHtml_S41 = `<span class="${val >= 0 ? 'text-cyan-300 font-bold' : 'text-rose-400 font-bold'}">${val >= 0 ? '+' : ''}${val.toFixed(2)}%</span>`;
            }

            // S4.2 순익 (기준선)
            let pnlHtml_S42 = `<span class="text-slate-500">-</span>`;
            if (item._batchPnl_S42 !== null && item._batchPnl_S42 !== undefined) {
                const val = item._batchPnl_S42;
                pnlHtml_S42 = `<span class="${val >= 0 ? 'text-amber-300 font-bold' : 'text-rose-400 font-bold'}">${val >= 0 ? '+' : ''}${val.toFixed(2)}%</span>`;
            }

            // S4.3 순익 (실험 분기)
            let pnlHtml_S43 = `<span class="text-slate-500">-</span>`;
            if (item._batchPnl_S43 !== null && item._batchPnl_S43 !== undefined) {
                const val = item._batchPnl_S43;
                pnlHtml_S43 = `<span class="${val >= 0 ? 'text-fuchsia-400 font-bold' : 'text-rose-400 font-bold'}">${val >= 0 ? '+' : ''}${val.toFixed(2)}%</span>`;
            }

            const exitReasonDisp = item._batchExitReason_S43 ? item._batchExitReason_S43 : '-';

            tr.innerHTML = `
                <td class="p-1.5 text-center text-slate-400">${idx + 1}</td>
                <td class="p-1.5 font-mono font-bold text-sky-400 text-center">${item.종목코드 || '-'}</td>
                <td class="p-1.5 font-semibold text-slate-100">${item.종목명}</td>
                <td class="p-1.5 text-right font-mono">${pnlHtml_S4}</td>
                <td class="p-1.5 text-right font-mono border-l border-slate-800">${pnlHtml_S41}</td>
                <td class="p-1.5 text-right font-mono border-l border-slate-800">${pnlHtml_S42}</td>
                <td class="p-1.5 text-right font-mono border-l border-slate-800">${pnlHtml_S43}</td>
                <td class="p-1.5 text-center font-mono text-[10px] text-slate-300">${exitReasonDisp}</td>
                <td class="p-1.5 text-right text-slate-400">${mfeStr}</td>
            `;

            tr.addEventListener('click', () => {
                loadDualChart(item.종목코드, item.종목명);
            });

            tbody.appendChild(tr);
        });
    }

    window.addEventListener('DOMContentLoaded', () => {
        initCharts();
        document.getElementById('btn-capture').addEventListener('click', executeCapture);
        document.getElementById('btn-batch-backtest').addEventListener('click', executeBatchBacktest);
    });
})();