/* Sequential, MFE-filtered market-data collection. No strategy evaluation. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.AuditDownloader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    function parseMfe(value) {
        if (value == null) return null;
        const s = String(value).trim().replace(/,/g, '').replace(/\s*%$/, '').trim().replace(/^−/, '-');
        return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s) && Number.isFinite(Number(s)) ? Number(s) : null;
    }
    function parseDate(value) {
        const s = String(value).replace(/-/g, '');
        if (!/^\d{8}$/.test(s)) throw new Error('날짜를 YYYY-MM-DD 형식으로 입력하세요.');
        const date = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10).replace(/-/g, '') !== s) {
            throw new Error('존재하지 않는 날짜입니다.');
        }
        return date;
    }
    function dateRange(start, end) {
        const first = parseDate(start), last = parseDate(end);
        const length = Math.round((last - first) / 86400000) + 1;
        if (length < 1 || length > 31) throw new Error('시작일~종료일은 순서대로 최대 31일을 지정하세요.');
        return Array.from({ length }, (_, i) => new Date(+first + i * 86400000).toISOString().slice(0, 10).replace(/-/g, ''));
    }
    function validate(options) {
        const dates = dateRange(options.startDate, options.endDate);
        if (!Number.isFinite(options.mfeThreshold)) throw new Error('MFE 기준을 숫자로 입력하세요.');
        if (!['gt', 'gte'].includes(options.comparison)) throw new Error('MFE 비교 조건이 올바르지 않습니다.');
        if (!/^(T-(30|60|120|360|640|720)|m-(1|3|5|10|15))$/.test(options.timeframe)) throw new Error('지원하지 않는 TF입니다.');
        if (!Number.isInteger(options.condition) || options.condition < 0) throw new Error('조건식 번호가 올바르지 않습니다.');
        if (!/^([01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(options.captureTime)) throw new Error('검색 시각은 HHMMSS 형식으로 입력하세요.');
        return dates;
    }
    function validateCandles(data, code, date, unit) {
        if (data.code !== code || data.unit !== unit) throw new Error('요청한 종목/TF와 응답이 다릅니다.');
        const bars = data.intraday;
        if (!Array.isArray(bars) || !bars.length || bars[bars.length - 1].date !== date) {
            throw new Error('해당 날짜의 캔들이 없거나 다른 날짜 데이터입니다.');
        }
        let previous = '';
        for (const c of bars) {
            const key = `${c.date}${c.time}`;
            if (!/^\d{8}$/.test(c.date) || !/^([01]\d|2[0-3])[0-5]\d$/.test(c.time) ||
                key < previous || c.date > date ||
                !['open', 'high', 'low', 'close', 'volume'].every(k => Number.isFinite(c[k])) ||
                c.low <= 0 || c.volume < 0 || c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close)) {
                throw new Error('캔들의 시각 순서 또는 OHLC/거래량이 올바르지 않습니다.');
            }
            previous = key;
        }
    }
    async function collect(options, io) {
        const dates = validate(options);
        const [unit, size] = options.timeframe.split('-');
        const bundle = { schema: 's44-audit-batch-v1', exportedAt: new Date().toISOString(),
            collection: { startDate: dates[0], endDate: dates.at(-1), timeframe: options.timeframe,
                mfeThreshold: options.mfeThreshold, comparison: options.comparison,
                condition: options.condition, captureTime: options.captureTime },
            cancelled: false, pendingDates: [], days: [] };
        const cancelled = () => Boolean(io.isCancelled && io.isCancelled());
        const progress = message => { if (io.onProgress) io.onProgress(message); };
        async function request(url, init) {
            const response = await io.fetch(url, init);
            let body;
            try { body = await response.json(); } catch (_) { throw new Error(`응답 JSON 오류 (HTTP ${response.status})`); }
            if (!response.ok || body.status !== 'success') {
                throw new Error(typeof body.detail === 'string' ? body.detail : body.message || `조회 실패 (HTTP ${response.status})`);
            }
            return body;
        }
        for (const date of dates) {
            if (cancelled()) break;
            const day = { schema: 's44-audit-v1', exportedAt: new Date().toISOString(),
                settings: { ...options.settings, targetDate: date, timeframe: options.timeframe },
                collection: { ...bundle.collection, date, status: 'collecting', captured: 0, eligible: 0,
                    excludedByMfe: 0, invalidMfe: 0, duplicates: 0 }, cases: [], missing: [], errors: [] };
            bundle.days.push(day);
            progress(`${date} · 1516 종목 목록 조회 중 (${bundle.days.length}/${dates.length}일)`);
            let rows;
            try {
                const data = await request('/api/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cond: options.condition, date, time: options.captureTime }) });
                if (!Array.isArray(data.data)) throw new Error('종목 목록 응답 형식이 올바르지 않습니다.');
                rows = data.data;
            } catch (error) {
                day.collection.status = 'capture-error';
                day.errors.push({ stage: 'capture', message: error.message });
                progress(`${date} · 목록 조회 실패: ${error.message}`);
                continue;
            }
            day.collection.captured = rows.length;
            const selected = [], seen = new Set();
            for (const row of rows) {
                const mfe = parseMfe(row['기간 내 최고수익률(MFE)']);
                if (mfe === null) {
                    day.collection.invalidMfe++;
                    day.errors.push({ stage: 'mfe', code: row.종목코드 || null, name: row.종목명,
                        message: 'MFE를 읽을 수 없어 다운로드 대상 여부를 판정하지 못했습니다.' });
                    continue;
                }
                const eligible = options.comparison === 'gt' ? mfe > options.mfeThreshold : mfe >= options.mfeThreshold;
                if (!eligible) { day.collection.excludedByMfe++; continue; }
                const code = typeof row.종목코드 === 'string' ? row.종목코드.trim() : '';
                if (code && seen.has(code)) { day.collection.duplicates++; continue; }
                if (code) seen.add(code);
                selected.push({ code, name: row.종목명 || code, officialMfeVal: mfe });
            }
            day.collection.eligible = selected.length;
            for (let i = 0; i < selected.length; i++) {
                if (cancelled()) {
                    day.missing.push(...selected.slice(i).map(item => ({ ...item, reason: '사용자 중단: 미조회' })));
                    break;
                }
                const item = selected[i];
                if (!item.code) { day.missing.push({ ...item, reason: '종목코드 없음: Cybos 연결을 확인하세요.' }); continue; }
                progress(`${date} · ${item.name} (${i + 1}/${selected.length}종목), 저장 ${day.cases.length}개`);
                try {
                    const data = await request(`/api/dual_chart?code=${encodeURIComponent(item.code)}&date=${date}&timeframe=${size}&unit=${unit}`);
                    validateCandles(data, item.code, date, unit);
                    const targetBars = data.intraday.filter(bar => bar.date === date);
                    day.cases.push({ ...item, candles: data.intraday, daily: data.daily || [],
                        classification: data.classification || null,
                        coverage: { targetBarCount: targetBars.length,
                            seedBarCount: data.intraday.length - targetBars.length,
                            firstTargetTime: targetBars[0].time, lastTargetTime: targetBars.at(-1).time } });
                } catch (error) { day.missing.push({ ...item, reason: error.message }); }
            }
            day.collection.status = cancelled() ? 'cancelled' : day.missing.length || day.errors.length ? 'partial' :
                !rows.length ? 'empty-list' : !selected.length ? 'no-eligible' : 'complete';
            day.exportedAt = new Date().toISOString();
            progress(`${date} · 캔들 ${day.cases.length}/${selected.length}종목 · 누락 ${day.missing.length} · 확인 필요 ${day.errors.length}`);
        }
        bundle.cancelled = cancelled();
        bundle.pendingDates = dates.filter(date => !bundle.days.some(day => day.settings.targetDate === date));
        bundle.exportedAt = new Date().toISOString();
        return bundle;
    }
    function filename(bundle) {
        const c = bundle.collection;
        return `strategy-audit-${c.startDate}-${c.endDate}-${c.timeframe}-mfe-${c.comparison}-${String(c.mfeThreshold).replace('.', 'p')}.json`;
    }
    function mount({ document, fetch, getSettings }) {
        const el = id => document.getElementById(id);
        const start = el('btn-audit-batch'), stop = el('btn-audit-stop'), status = el('audit-download-status');
        const links = el('audit-download-links');
        let running = false, stopRequested = false, urls = [];
        function addDownload(payload, name, label) {
            const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
            urls.push(url);
            const a = document.createElement('a');
            a.href = url; a.download = name; a.textContent = label;
            a.className = 'text-sky-300 underline mr-4';
            links.appendChild(a);
            return a;
        }
        stop.addEventListener('click', () => {
            stopRequested = true; stop.disabled = true;
            status.textContent = '현재 조회 완료 후 중단합니다. 이미 받은 데이터는 저장할 수 있습니다.';
        });
        start.addEventListener('click', async () => {
            if (running) return;
            if (el('btn-capture').disabled || el('btn-batch-backtest').disabled) {
                status.textContent = '현재 조회/백테스트가 끝난 후 실행하세요.'; return;
            }
            let options;
            try {
                const rawMfe = el('audit-mfe').value.trim();
                options = { startDate: el('audit-start').value, endDate: el('audit-end').value,
                    mfeThreshold: rawMfe ? Number(rawMfe) : NaN, comparison: el('audit-comparison').value,
                    condition: Number(el('edit-cond').value.trim()), captureTime: el('edit-time').value.trim(),
                    timeframe: el('sel-batch-tf').value, settings: getSettings() };
                if (!el('edit-cond').value.trim()) throw new Error('조건식 번호를 입력하세요.');
                validate(options);
            } catch (error) { status.textContent = error.message; return; }
            running = true; stopRequested = false;
            urls.forEach(url => URL.revokeObjectURL(url)); urls = [];
            links.replaceChildren();
            const controls = Array.from(document.querySelectorAll('button, input, select'));
            const previous = controls.map(control => [control, control.disabled]);
            controls.forEach(control => { control.disabled = true; }); stop.disabled = false;
            const main = document.querySelector('main'), previousInert = main?.inert;
            if (main) main.inert = true;
            try {
                const bundle = await collect(options, { fetch, isCancelled: () => stopRequested,
                    onProgress: message => { status.textContent = message; } });
                const count = bundle.days.reduce((n, d) => n + d.cases.length, 0);
                const missing = bundle.days.reduce((n, d) => n + d.missing.length + d.errors.length, 0);
                const all = addDownload(bundle, filename(bundle), '전체 JSON 저장');
                bundle.days.forEach(day => addDownload(day, `strategy-audit-${day.settings.targetDate}-${options.timeframe}.json`,
                    `${day.settings.targetDate} JSON (${day.cases.length}종목)`));
                status.textContent = `${bundle.cancelled ? '중단' : '완료'} · ${bundle.days.length}일 / 캔들 ${count}건 · 누락·오류 ${missing}건 · 미조회 ${bundle.pendingDates.length}일. 저장이 시작되지 않으면 아래 링크를 누르세요.`;
                all.click(); // One combined download avoids multiple automatic-download prompts.
            } catch (error) { status.textContent = `수집 오류: ${error.message}`; }
            finally {
                previous.forEach(([control, disabled]) => { control.disabled = disabled; });
                stop.disabled = true;
                if (main) main.inert = previousInert;
                running = false;
            }
        });
    }
    return Object.freeze({ parseMfe, dateRange, validate, validateCandles, collect, filename, mount });
});
