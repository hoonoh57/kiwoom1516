// static/lab.js  (v2)
// 박제 원본(app.js) 바이트 그대로 실행 + 개선 버전(S4.5~) + 인과/오라클 모드 비교
// 브라우저: index.html에 <script src="/static/lab.js"></script> (app.js 다음)
//          오라클 대조: 콘솔에서 Lab.DEFAULTS.oracle = true 후 LAB 버튼 (기본 false = 인과)
// Node:    node static/lab.js --selftest            SHA·원본재현·청산사유 커버리지·미래절단 검증
//          node static/lab.js <data.json> [--costPct=0.25 --useBaseLine=true --oracle=false]
(function (root, factory) {
  const Lab = factory();
  if (typeof module === 'object' && module.exports) module.exports = Lab;
  else root.Lab = Lab;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const FROZEN_SHA256 = 'ade2280a11378e90a9fa7fb15a8ba7947d9259029df91009492d2ae82ddad368';
  const FROZEN = ['S4', 'S4.1', 'S4.2', 'S4.3'];

  // 한 버전 = 한 아이디어(누적). 새 아이디어는 여기 한 줄 추가.
  const VERSIONS = {
    'S4.3R': {},                                          // 원본 S4.3 재현 (원본과 차이 0이어야 함)
    'S4.5':  { sessionVwap: true },                       // + 당일 09:00 세션 VWAP
    'S4.6':  { sessionVwap: true, earlyMinRunMfe: 3.0 },  // + 조기진입도 실시간 MFE ≥3% 요구
    'S4.7':  { sessionVwap: true, earlyMinRunMfe: 3.0, fixHighInit: true, forceExit: true }, // + 최고가 초기화·미청산 회계
  };

  // [v2] oracle: true면 박제 S4~S4.3에 1516 MFE 게이트 적용(화면 대조용). 개선 버전은 항상 인과.
  const DEFAULTS = { baseRate: 5.5, labelMfe: 5.5, macdTh: 0.15, hardStop: -2.5,
    useBaseLine: true, applyCumAmtGate: false, minCumAmt: 3.0, costPct: 0.25, oracle: false };

  // ---------- 박제 원본 로더: 소스를 잘라 그대로 실행 ----------
  function loadFrozen(src) {
    const cut = (a, b) => {
      const i = src.indexOf(a), j = src.indexOf(b, i);
      if (i < 0 || j < 0) throw new Error('원본 구조 불일치: ' + a);
      return src.slice(i, j);
    };
    const consts = cut('const ENTRY_START_TIME', 'let macroBarsMap');
    const body = cut('function calcVWAP', 'async function executeCapture');
    return new Function(`${consts}\n${body}\nreturn { evaluateStrategyTrade, calcVWAP,
      calcJMADualSegments, calcSupertrendSingleLineSegments, calcNormalizedMACD,
      calcDailyCumulativeAmount, buildStrictTimestamps };`)();
  }

  function parseMfe(s) {
    if (s === null || s === undefined || s === '') return null;
    const v = parseFloat(String(s).replace(/[+%]/g, '').trim());
    return isNaN(v) ? null : v;
  }

  function captureInfo(bars, date) {
    let cap = 0, start = -1;
    for (let i = 0; i < bars.length; i++) {
      const c = bars[i];
      if (c.date !== date) continue;
      if (c.time <= '0903') cap = c.close;
      if (c.time >= '0904' && start === -1) start = i;
    }
    if (cap <= 0 && start !== -1) cap = bars[start].open;
    return { cap, start };
  }

  function dayMfe(bars, date) {            // 사후 계산 MFE (1516 값과 정의 일치 확인용)
    const { cap, start } = captureInfo(bars, date);
    if (cap <= 0 || start < 0) return null;
    let hi = -Infinity;
    for (let i = start; i < bars.length; i++) if (bars[i].date === date) hi = Math.max(hi, bars[i].high);
    return (hi - cap) / cap * 100;
  }

  function sessionVwap(bars, date) {
    let cv = 0, cpv = 0;
    return bars.map(b => {
      if (b.date !== date || b.time < '0900') return NaN;
      const tp = (b.high + b.low + b.close) / 3;
      cpv += tp * b.volume; cv += b.volume;
      return cv > 0 ? cpv / cv : b.close;
    });
  }

  // ---------- 박제 전략 ----------
  // [v2] mfe 인자 추가: p.oracle=true일 때만 1516 MFE를 원본에 전달, 기본은 null(인과 모드)
  function evaluateFrozen(F, bars, ver, p, mfe) {
    const r = F.evaluateStrategyTrade(bars, ver, p.date, p.baseRate, p.macdTh,
      p.useBaseLine, p.oracle ? (mfe ?? null) : null, p.applyCumAmtGate, p.minCumAmt, p.hardStop);
    return { entered: r.entered, pnl: r.pnl, entryTime: r.entryTime, exitReason: r.exitReason };
  }

  // ---------- 개선 엔진 (옵션 전부 off = S4.3 원본과 동일) ----------
  function evaluateLab(F, bars, cfg, p) {
    const out = { entered: false, pnl: 0, entryTime: '-', exitReason: '미진입',
      entryIdx: -1, entryType: null, runMfeAtEntry: null };
    if (!bars || !bars.length) return { ...out, exitReason: '데이터없음' };

    F.buildStrictTimestamps(bars);
    const jma = F.calcJMADualSegments(bars, 7, 0, 2).rawJMA;
    const st = F.calcSupertrendSingleLineSegments(bars, 14, 2.0);
    const macd = F.calcNormalizedMACD(bars, 5, 13, 4);
    const cum = F.calcDailyCumulativeAmount(bars, p.date);
    const vwap = cfg.sessionVwap ? sessionVwap(bars, p.date) : F.calcVWAP(bars).map(v => v.value);

    const { cap, start } = captureInfo(bars, p.date);
    if (cap <= 0 || start === -1) return { ...out, exitReason: '09:04봉없음' };
    const base = cap * (1.0 + p.baseRate / 100.0);
    const fmt = t => `${t.substring(0, 2)}:${t.substring(2, 4)}`;

    let pos = null, runHigh = 0;
    const close = (b, reason) => {
      let part = 0, rem = 1.0;
      for (const f of pos.fills) { part += ((f - pos.entry) / pos.entry * 30); rem -= 0.3; }
      out.pnl = part + ((b.close - pos.entry) / pos.entry * (rem * 100));
      out.exitReason = reason; out.exitTime = fmt(b.time);
    };

    for (let i = start; i < bars.length; i++) {
      const b = bars[i];
      if (b.date === p.date) runHigh = Math.max(runHigh, b.high);
      const runMfe = (runHigh - cap) / cap * 100;           // 실시간 MFE (인과적)
      const jPrev2 = i >= 2 ? jma[i - 2] : jma[i - 1];
      const jUp = jma[i] > jma[i - 1];
      const jTurnDown = jma[i] < jma[i - 1] && jma[i - 1] >= jPrev2;
      const trend = st.rawTrend[i], m = macd[i].value, amt = cum[i].value;

      if (!pos) {
        if (!(b.date === p.date && b.time >= '0904' && b.time <= '0930')) continue;
        const setup = trend === 1 && m >= p.macdTh && jUp;
        const pct = ((b.close - cap) / cap) * 100.0;
        const normal = p.useBaseLine ? (setup && b.close >= base && pct >= p.baseRate) : setup;
        let early = setup && b.time <= '0912' && amt >= 15.0 && m >= 0.20;
        if (early && cfg.earlyMinRunMfe != null && runMfe < cfg.earlyMinRunMfe) early = false;
        let go = normal || early;
        if (go && p.applyCumAmtGate && amt < p.minCumAmt) go = false;
        if (go) {
          pos = { entry: b.close, ts: b.timestamp, fills: [], hi: cfg.fixHighInit ? b.close : b.high, bep: false };
          Object.assign(out, { entered: true, entryTime: fmt(b.time), exitReason: '미체결',
            entryIdx: i, entryType: normal ? '기준선' : '조기', runMfeAtEntry: runMfe });
        }
        continue;
      }

      if (b.high > pos.hi) pos.hi = b.high;
      const pnl = ((b.close - pos.entry) / pos.entry) * 100.0;
      const atr = st.rawATR[i] || (b.high - b.low);

      if (pnl <= p.hardStop) { close(b, `초기손절(스탑${p.hardStop.toFixed(1)}%)`); break; }
      if (pos.bep && pnl <= 0.2) { close(b, '본전보호(BEP컷)'); break; }
      if (pos.fills.length === 0 && pnl >= 2.5 && jTurnDown) { pos.fills.push(b.close); pos.bep = true; }
      if (pos.fills.length === 1 && pnl >= 5.0 && jTurnDown) pos.fills.push(b.close);
      if (pos.fills.length === 2 && b.close < pos.hi - 2.5 * atr) { close(b, 'ATR동적트레일링컷'); break; }
      if (trend === -1 || (pos.fills.length >= 1 && b.close < vwap[i] * 0.995)) {
        close(b, pos.fills.length ? '추세이탈(런너청산)' : 'ST하락(손절)'); break;
      }
      if (b.date === p.date && b.time > '1003') {
        const strong = trend === 1 && b.close >= vwap[i] * 1.01;
        if (!strong || b.time >= '1030') {
          close(b, b.time >= '1030' ? '추세연장마감(10:30)' : '10:03시간종료'); break;
        }
      }
    }
    if (pos && out.exitReason === '미체결' && cfg.forceExit) close(bars[bars.length - 1], '데이터종료(강제청산)');
    return out;
  }

  // ---------- 배치 & 집계 ----------
  function runAll(F, items, p) {
    return items.map(it => {
      const q = it.date ? { ...p, date: it.date } : p;
      const row = { date: q.date, code: it.code, name: it.name, mfe: it.mfe,
        label: it.mfe == null ? '미상' : (it.mfe >= p.labelMfe ? '고' : '저'),
        calcMfe: it.bars && it.bars.length ? dayMfe(it.bars, q.date) : null, res: {} };
      if (!it.bars || !it.bars.length) return row;
      for (const v of FROZEN) row.res[v] = evaluateFrozen(F, it.bars, v, q, it.mfe);   // [v2] mfe 전달
      for (const [v, cfg] of Object.entries(VERSIONS)) row.res[v] = evaluateLab(F, it.bars, cfg, q);
      return row;
    });
  }

  function summarize(rows, p) {
    const sum = a => a.reduce((s, x) => s + x, 0);
    const hiTotal = rows.filter(r => r.label === '고').length;
    return [...FROZEN, ...Object.keys(VERSIONS)].map(v => {
      const t = rows.map(r => ({ r, x: r.res[v] })).filter(o => o.x && o.x.entered);
      const net = t.map(o => o.x.pnl - p.costPct);
      const wins = net.filter(x => x > 0), losses = net.filter(x => x <= 0);
      const lo = t.filter(o => o.r.label === '저');
      return {
        버전: v, 진입: t.length,
        승률: t.length ? +(wins.length / t.length * 100).toFixed(1) : 0,
        평균순익: t.length ? +(sum(net) / t.length).toFixed(2) : 0,
        합계순익: +sum(net).toFixed(2),
        PF: losses.length ? +(sum(wins) / Math.max(1e-9, -sum(losses))).toFixed(2) : null,
        고MFE포착: `${t.filter(o => o.r.label === '고').length}/${hiTotal}`,
        저MFE오진입: lo.length,
        저MFE평균: lo.length ? +(sum(lo.map(o => o.x.pnl - p.costPct)) / lo.length).toFixed(2) : null,
        미청산: t.filter(o => o.x.exitReason === '미체결').length,
      };
    });
  }

  // ---------- Node: 자체 테스트 ----------
  function rng(seed) {
    return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }

  // [v2] 변동성 3단계(seed별): 초기손절·BEP컷 분기까지 실행되도록
  function synth(seed) {
    const r = rng(seed), bars = []; let px = 10000, drift = 0, k = 0;
    const vol = [1, 2.5, 4][seed % 3];
    const add = (date, min) => {
      if (k++ % 8 === 0) drift = (r() - 0.45) * 0.012 * vol;
      const o = px, c = o * (1 + drift + (r() - 0.5) * 0.01 * vol);
      bars.push({ date, time: String(Math.floor(min / 60)).padStart(2, '0') + String(min % 60).padStart(2, '0'),
        open: o, high: Math.max(o, c) * (1 + r() * 0.004 * vol), low: Math.min(o, c) * (1 - r() * 0.004 * vol),
        close: c, volume: Math.floor(5000 + r() * 55000) });
      px = c;
    };
    for (let i = 0; i < 250; i++) add('20260915', 540 + i);
    for (let i = 0; i < 10; i++) add('20260916', 480 + i);     // NXT 프리마켓
    for (let i = 0; i <= 140; i++) add('20260916', 540 + i);
    return bars;
  }

  function selftest(F) {
    let n = 0, entered = 0, cutN = 0; const fails = [], cutFails = [], reasons = new Set();
    for (let seed = 1; seed <= 400; seed++) for (const useBaseLine of [true, false]) for (const hardStop of [-2.5, -4]) {
      const p = { ...DEFAULTS, date: '20260916', baseRate: 3.0, useBaseLine, hardStop };
      const a = evaluateFrozen(F, synth(seed), 'S4.3', p);
      const b = evaluateLab(F, synth(seed), VERSIONS['S4.3R'], p);
      n++; if (a.entered) entered++; reasons.add(a.exitReason);
      if (a.entered !== b.entered || a.entryTime !== b.entryTime || a.exitReason !== b.exitReason || Math.abs(a.pnl - b.pnl) > 1e-9)
        fails.push({ seed, useBaseLine, hardStop, a, b });
      // 미래 절단: 진입봉까지만 남겨도 같은 진입이어야 함 (원본·개선 모두)
      for (const v of ['S4.3', 'S4.6']) {
        const full = v === 'S4.3' ? b : evaluateLab(F, synth(seed), VERSIONS[v], p);
        if (!full.entered) continue;
        const cutBars = synth(seed).slice(0, full.entryIdx + 1);
        const c = v === 'S4.3' ? evaluateFrozen(F, cutBars, 'S4.3', p) : evaluateLab(F, cutBars, VERSIONS[v], p);
        cutN++; if (!c.entered || c.entryTime !== full.entryTime) cutFails.push({ seed, v });
      }
    }
    // [v2] 필수 청산사유 커버리지 검사
    const required = ['초기손절', '본전보호', 'ATR동적트레일링컷', '추세이탈', 'ST하락(손절)', '10:03시간종료', '추세연장마감'];
    const missing = required.filter(k => ![...reasons].some(x => x.includes(k)));

    console.log(`[재현] 원본 S4.3 vs S4.3R: ${n}건 중 불일치 ${fails.length} (진입 ${entered}건)`);
    console.log(`       청산사유 커버리지: ${[...reasons].join(', ')}`);
    console.log(`       필수 사유 누락: ${missing.length ? missing.join(', ') : '없음'}`);
    console.log(`[인과] 진입봉 이후 절단: ${cutN}건 중 불일치 ${cutFails.length}`);
    if (fails.length) console.log('첫 불일치:', JSON.stringify(fails[0]));
    const ok = !fails.length && !cutFails.length && !missing.length;
    console.log(ok ? '[결과] 통과' : '[결과] 실패');
    if (!ok) process.exitCode = 1;
  }

  // 데이터 파일 스키마는 audit_downloader 출력에 맞게 이 함수만 조정
  function normalize(json) {
    const days = json.days || json.dates || [json], items = [];
    for (const d of days) for (const s of (d.items || d.stocks || [])) items.push({
      date: String(s.date || d.date || '').replace(/-/g, ''),
      code: s.code || s.종목코드, name: s.name || s.종목명,
      mfe: typeof s.mfe === 'number' ? s.mfe : parseMfe(s.mfe ?? s['기간 내 최고수익률(MFE)']),
      bars: s.intraday || (s.candles && s.candles.intraday) || s.bars,
    });
    return items;
  }

  function nodeMain(argv) {
    const fs = require('fs'), path = require('path'), crypto = require('crypto');
    const buf = fs.readFileSync(path.join(__dirname, 'app.js'));
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    console.log(`[박제] app.js SHA-256 ${sha === FROZEN_SHA256 ? '일치' : '불일치! 중단'}`);
    if (sha !== FROZEN_SHA256) { process.exitCode = 1; return; }
    const F = loadFrozen(buf.toString('utf8'));
    if (!argv[0] || argv[0] === '--selftest') return selftest(F);
    const p = { ...DEFAULTS };
    for (const a of argv.slice(1)) {
      const m = a.match(/^--(\w+)=(.+)$/);
      if (m) p[m[1]] = m[2] === 'true' ? true : m[2] === 'false' ? false : Number(m[2]);
    }
    console.log(`[모드] ${p.oracle ? '오라클(1516 MFE 게이트, 화면 대조용)' : '인과(1516 MFE는 라벨 전용)'}`);
    const rows = runAll(F, normalize(JSON.parse(fs.readFileSync(argv[0], 'utf8'))), p);
    console.table(summarize(rows, p));
    const out = argv[0].replace(/\.json$/i, '') + (p.oracle ? '.lab-oracle.json' : '.lab.json');
    fs.writeFileSync(out, JSON.stringify({ params: p, summary: summarize(rows, p), rows }, null, 1));
    console.log('저장:', out);
  }

  // ---------- 브라우저: 기존 화면 무수정, 버튼 하나 추가 ----------
  function browserInit() {
    const origFetch = window.fetch.bind(window), chartCache = new Map();
    const list = { items: [], date: null };
    let F = null, shaOk = null;

    window.fetch = async (url, opts) => {           // 기존 앱 요청을 관찰만 함 (응답 변경 없음)
      const res = await origFetch(url, opts), u = String(url);
      if (u.includes('/api/capture') || u.includes('/api/dual_chart')) {
        res.clone().json().then(j => {
          if (j.status !== 'success') return;
          if (u.includes('/api/capture')) { list.items = j.data; try { list.date = JSON.parse(opts.body).date; } catch (e) {} }
          else chartCache.set(u, j);
        }).catch(() => {});
      }
      return res;
    };

    origFetch('/static/app.js', { cache: 'no-store' }).then(r => r.arrayBuffer()).then(async buf => {
      const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
      shaOk = h === FROZEN_SHA256;
      F = loadFrozen(new TextDecoder().decode(buf));
    });

    const btn = document.createElement('button');
    btn.textContent = 'LAB 인과비교';
    btn.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;padding:6px 12px;background:#7c3aed;color:#fff;border-radius:6px;font:12px sans-serif';
    document.body.appendChild(btn);

    btn.onclick = async () => {
      if (!F) return alert('박제 원본 로딩 중입니다.');
      if (!list.items.length) return alert('먼저 [1516 성과검증 가로채기]를 실행하세요.');
      const $ = id => document.getElementById(id);
      const date = $('edit-date').value.trim();
      if (list.date && list.date !== date) return alert(`목록 일자(${list.date})와 입력 일자(${date})가 다릅니다. 다시 가로채기 하세요.`);
      const [unit, tfs] = $('sel-batch-tf').value.split('-');
      const macd = ($('input-macd-base').value || '0, 0.15').split(',').map(s => parseFloat(s)).filter(n => n > 0);
      const baseRate = parseFloat($('input-base-rate').value) || 5.5;
      const p = { ...DEFAULTS, date, baseRate, labelMfe: baseRate, macdTh: macd[0] || 0.15,
        hardStop: parseFloat($('input-hard-stop').value) || -2.5,
        applyCumAmtGate: $('chk-apply-cum-amt-gate').checked,
        minCumAmt: parseFloat($('input-min-cum-amt').value) || 3.0 };

      const items = [];
      for (let k = 0; k < list.items.length; k++) {
        const s = list.items[k]; btn.textContent = `LAB ${k + 1}/${list.items.length}`;
        let bars = null;
        if (s.종목코드) {
          const u = `/api/dual_chart?code=${s.종목코드}&date=${date}&timeframe=${parseInt(tfs, 10)}&unit=${unit}`;
          let j = chartCache.get(u);
          if (!j) { try { j = await (await origFetch(u)).json(); if (j.status === 'success') chartCache.set(u, j); } catch (e) {} }
          bars = j && j.intraday ? j.intraday : null;
        }
        items.push({ code: s.종목코드, name: s.종목명, mfe: parseMfe(s['기간 내 최고수익률(MFE)']), bars });
      }
      const rows = runAll(F, items, p);
      render(rows, summarize(rows, p), p);
      btn.textContent = 'LAB 인과비교';
    };

    function render(rows, sum, p) {
      let box = document.getElementById('lab-box');
      if (!box) {
        box = document.createElement('div'); box.id = 'lab-box';
        box.style.cssText = 'position:fixed;inset:40px 40px 60px 40px;z-index:9998;overflow:auto;background:#0f172a;color:#e2e8f0;border:1px solid #475569;padding:12px;font:11px monospace';
        document.body.appendChild(box);
      }
      const vers = sum.map(s => s.버전);
      const th = a => `<tr>${a.map(x => `<th style="padding:2px 6px;border-bottom:1px solid #334155">${x}</th>`).join('')}</tr>`;
      const td = a => `<tr>${a.map(x => `<td style="padding:2px 6px;text-align:right">${x ?? '-'}</td>`).join('')}</tr>`;
      const f = x => x && x.entered ? `${x.pnl >= 0 ? '+' : ''}${x.pnl.toFixed(2)}${x.entryType === '조기' ? '*' : ''}` : '-';
      const n2 = v => typeof v === 'number' ? v.toFixed(2) : '-';
      const mode = p.oracle ? '<span style="color:#f59e0b">오라클 모드(박제 S4~S4.3만 1516 MFE 게이트) · 화면 대조용</span>'
                            : '인과 모드 · 1516 MFE는 라벨 전용';   // [v2]
      const url = URL.createObjectURL(new Blob([JSON.stringify({ params: p, summary: sum, rows }, null, 1)], { type: 'application/json' }));
      box.innerHTML = `
        <div style="display:flex;justify-content:space-between;margin-bottom:6px">
          <b>LAB · ${p.date} · ${mode} · 비용 ${p.costPct}% · 박제 SHA ${shaOk ? '일치' : '불일치!'}</b>
          <span><a href="${url}" download="lab-${p.date}${p.oracle ? '-oracle' : ''}.json" style="color:#38bdf8">JSON 저장</a>
          <button onclick="this.closest('#lab-box').remove()">닫기</button></span></div>
        <table>${th(Object.keys(sum[0]))}${sum.map(s => td(Object.values(s))).join('')}</table>
        <div style="margin:8px 0;color:#94a3b8">* = 조기진입 (개선 버전만 표시) · 종목별 수치는 비용 차감 전</div>
        <table>${th(['코드', '종목', '라벨', '1516MFE', '계산MFE', ...vers])}
        ${rows.map(r => td([r.code, r.name, r.label, n2(r.mfe), n2(r.calcMfe), ...vers.map(v => f(r.res[v]))])).join('')}</table>`;
    }
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined')
    window.addEventListener('DOMContentLoaded', browserInit);

  return { FROZEN_SHA256, VERSIONS, DEFAULTS, loadFrozen, evaluateLab, evaluateFrozen,
    runAll, summarize, dayMfe, normalize, nodeMain };
});

if (typeof module === 'object' && typeof require === 'function' && require.main === module)
  module.exports.nodeMain(process.argv.slice(2));
