/* static/tuner.js — S4 Tuner v1
   원칙: app.js(박제 원본)는 읽기만 한다. 전략 판정은 원본 evaluateStrategyTrade를 그대로 호출한다.
   보완은 (1) 기준선 선택 (2) 단일봉 급등 필터 (3) 봉저가 손절이며, 원본 호출 전/후에서만 작동한다. */
(function () {
'use strict';
const $ = id => document.getElementById(id);
const STRATS = ['S4', 'S4.1', 'S4.2', 'S4.3'];
const MODE_NAME = { capture: '포착가', open: '시가', prev: '전일종가' };
const load = k => { try { return JSON.parse(localStorage.getItem(k)) || []; } catch (_) { return []; } };
const store = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const S = { F: null, sha: '', days: [], use: {}, prep: new Map(), ok: false, exp: null, cur: null,
            chart: null, ser: {}, lastDiag: null,
            versions: load('s4tuner.versions'), cases: load('s4tuner.cases') };
const tick = () => new Promise(r => setTimeout(r, 0));
const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const fp = (v, d = 2) => v == null || !Number.isFinite(v) ? '-' :
  `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v > 0 ? '+' : ''}${v.toFixed(d)}%</span>`;
const f2 = v => v == null ? '-' : v === Infinity ? '∞' : v.toFixed(2);
const won = v => v > 0 ? Math.round(v).toLocaleString() + '원' : '-';
const hm = t => { const d = new Date(t * 1000); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const hhmm = s => String(s).slice(0, 2) + ':' + String(s).slice(2, 4);

/* ───────── 1. 박제 원본 로드 ───────── */
async function loadFrozen() {
  const res = await fetch('/static/app.js', { cache: 'no-store' });
  if (!res.ok) throw new Error('app.js 로드 실패 HTTP ' + res.status);
  const buf = await res.arrayBuffer();
  const dig = await crypto.subtle.digest('SHA-256', buf);
  S.sha = [...new Uint8Array(dig)].map(b => b.toString(16).padStart(2, '0')).join('');
  const src = new TextDecoder('utf-8').decode(buf);
  const m = src.match(/\(\s*function\s*\(\s*\)\s*\{/);
  const end = src.lastIndexOf('})');
  if (!m || end < 0) throw new Error('app.js 구조를 인식하지 못했습니다.');
  const body = src.slice(m.index + m[0].length, end);
  const noop = () => {};
  const fakeDoc = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
                    addEventListener: noop, createElement: () => ({ style: {} }) };
  const fakeWin = { addEventListener: noop, LightweightCharts: null, innerWidth: 1000, innerHeight: 800 };
  const fn = new Function('window', 'document',
    body + '\n;return (typeof evaluateStrategyTrade === "function") ? evaluateStrategyTrade : null;');
  S.F = fn(fakeWin, fakeDoc);
  if (!S.F) throw new Error('원본에서 evaluateStrategyTrade를 찾지 못했습니다.');
  $('st-sha').textContent = 'app.js SHA-256 ' + S.sha.slice(0, 12) + '…';
}

/* ───────── 2. 봉 준비 (원본 화면과 같은 timestamp 규칙) ───────── */
function stamp(bars) {
  let last = 0;
  for (const b of bars) {
    const d = b.date, t = b.time;
    let ts = Math.floor(new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), 0).getTime() / 1000);
    if (ts <= last) ts = last + 1;
    b.timestamp = ts; last = ts;
  }
  return bars;
}
function cloneBars(candles, date, shift) {
  return stamp(candles.map(b => {
    const o = { ...b };
    if (shift && o.date === date) {
      const mm = +o.time.slice(0, 2) * 60 + +o.time.slice(2, 4) + shift;
      o.time = String(Math.floor(mm / 60)).padStart(2, '0') + String(mm % 60).padStart(2, '0');
    }
    return o;
  }));
}
function prep(d, c) {
  const k = d.key + '|' + c.code;
  if (!S.prep.has(k)) S.prep.set(k, cloneBars(c.candles, d.date, 0));
  return S.prep.get(k);
}
function refs(c, date) {
  const daily = (c.daily || []).map(x => ({ ...x, date: String(x.date) }));
  const today = daily.find(x => x.date === date);
  const prev = daily.filter(x => x.date < date).sort((a, b) => a.date < b.date ? -1 : 1).pop();
  const krx = c.candles.filter(b => b.date === date && b.time >= '0900');
  const seed = c.candles.filter(b => b.date < date && b.time <= '1530');
  c._open = today ? today.open : (krx[0] ? krx[0].open : null);
  c._openSrc = today ? '일봉' : '첫 360틱봉';
  c._prev = prev ? prev.close : (seed.length ? seed[seed.length - 1].close : null);
  c._prevSrc = prev ? '일봉' : '전일 15:30 이전 마지막 봉';
}

/* ───────── 3. 한 종목 평가 ───────── */
function entryIdx(bars, r) {
  const m = r && (r.markers || []).find(x => x.position === 'belowBar');
  return m ? bars.findIndex(b => b.timestamp === m.time) : -1;
}
function outcome(r, skip, cost) {
  if (skip) return { entered: false, reason: skip };
  if (!r || !r.entered) return { entered: false, reason: r ? r.exitReason : '-' };
  const open = r.exitReason === '미체결';
  return { entered: true, open, pnl: r.pnl, net: r.pnl - cost, stop: /손절|하드스탑/.test(r.exitReason),
           reason: r.exitReason, entryTime: r.entryTime };
}
function callF(bars, P, date, n, gate, mfe) {
  return S.F(bars, P.strat, date, n, P.macd, gate, mfe, P.cumGate, P.minCum, P.hardStop);
}
// 첫 익절 또는 원본 청산 봉까지만 검사한다. 분할 익절 이후는 원본 결과를 유지한다.
function applyStopMode(o, r, bars, P) {
  if (P.stopMode !== 'low' || !o.entered || o.entryPrice == null || !r) return o;
  const mk = r.markers || [];
  if (!mk.length) { console.warn('봉저가 손절: 원본 결과에 markers가 없어 적용하지 못했습니다'); return o; }
  const i0 = entryIdx(bars, r); if (i0 < 0) return o;
  const downs = mk.filter(m => m.shape === 'arrowDown');
  const exitTs = downs.length ? downs[downs.length - 1].time : Infinity;
  const tp = mk.find(m => /익절/.test(m.text || ''));
  const limitTs = Math.min(exitTs, tp ? tp.time : Infinity);
  const hs = Number(P.hardStop ?? P.stop ?? -3);
  const sp = o.entryPrice * (1 + hs / 100);
  for (let i = i0 + 1; i < bars.length && bars[i].timestamp <= limitTs; i++) {
    if (bars[i].date !== bars[i0].date) break;
    if (+bars[i].low <= sp) {
      const fill = +bars[i].open <= sp ? +bars[i].open : sp;
      o.pnl = (fill / o.entryPrice - 1) * 100;
      o.net = o.pnl - P.cost;
      o.open = false; o.stop = true; o.reason = '봉저손절'; o.stopTouch = hm(bars[i].timestamp);
      o.exitTimestamp = bars[i].timestamp; o.exitPrice = fill;
      return o;
    }
  }
  return o;
}
function resultMarkers(r, o) {
  const mk = r ? r.markers || [] : [];
  if (o.reason !== '봉저손절') return mk;
  return mk.filter(m => m.time < o.exitTimestamp).concat({
    time: o.exitTimestamp, position: 'aboveBar', color: '#3b82f6', shape: 'arrowDown',
    text: `[봉저손절] ${won(o.exitPrice)}`
  });
}
function evalCase(d, c, P, mode, v) {
  const bars = prep(d, c);
  let r = null, line = null, skip = null;
  if (mode === 'capture') {
    const mfe = c.officialMfeVal;
    if (P.real) { r = callF(bars, P, d.date, v, true, null); line = r.basePrice || null; }
    else if (P.gate && mfe != null && mfe < v) skip = '1516 MFE 미달';
    else { r = callF(bars, P, d.date, v, P.gate, mfe); line = r.basePrice || null; }
  } else {
    const r0 = callF(bars, P, d.date, 5.5, true, null);
    const ref = mode === 'open' ? c._open : c._prev;
    if (!(r0.basePrice > 0)) skip = r0.exitReason || '기준가 없음';
    else if (!(ref > 0)) skip = MODE_NAME[mode] + ' 없음';
    else {
      line = ref * (1 + v / 100);
      let hit = false;
      for (let i = Math.max(0, r0.entryStartIdx); i < bars.length; i++) {
        const b = bars[i];
        if (b.date !== d.date) continue;
        if (b.time > '1003') break;
        if (b.high >= line) { hit = true; break; }
      }
      if (!hit) skip = '기준선 미도달';
      else {
        const cap = r0.basePrice / 1.055;
        r = callF(bars, P, d.date, (line / cap - 1) * 100, true, null);
      }
    }
  }
  const o = outcome(r, skip, P.cost);
  let sp = null;
  if (o.entered) {
    const i = entryIdx(bars, r);
    o.idx = i; o.entryPrice = i >= 0 ? bars[i].close : null;
    o.path = (o.entryPrice != null && r.basePrice > 0 && o.entryPrice < r.basePrice) ? '조기' : '일반';
    if (i >= 0) {
      let mx = -Infinity;
      for (let j = Math.max(0, i - P.K + 1); j <= i; j++) {
        const b = bars[j];
        if (b.date === d.date && b.open > 0) mx = Math.max(mx, (b.high - b.open) / b.open * 100);
      }
      sp = Number.isFinite(mx) ? mx : null;
    }
  }
  applyStopMode(o, r, bars, P);
  return { o, sp, line, r, bars };
}
function applyX(o, sp, x) {
  if (x == null || !o.entered || sp == null || sp <= x) return o;
  return { entered: false, blocked: true, reason: `급등봉 +${sp.toFixed(1)}%` };
}

/* ───────── 4. 집계와 판정 ───────── */
function metrics(outs) {
  const t = outs.filter(o => o.entered && !o.open);
  const und = outs.filter(o => o.entered && o.open).length;
  const n = t.length, sum = t.reduce((s, o) => s + o.net, 0);
  const win = t.filter(o => o.net > 0).length, stop = t.filter(o => o.stop).length;
  const gp = t.filter(o => o.net > 0).reduce((s, o) => s + o.net, 0);
  const gl = -t.filter(o => o.net < 0).reduce((s, o) => s + o.net, 0);
  return { n, sum, win: n ? win / n * 100 : 0, stopRate: n ? stop / n * 100 : 0,
           pf: gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0), und };
}
function effect(bs, vs) {
  let blocked = 0, missed = 0;
  bs.forEach((b, i) => {
    const v = vs[i];
    if (b.entered && !b.open && !v.entered) { if (b.net < 0) blocked += -b.net; else missed += b.net; }
  });
  return { blocked, missed };
}
function cls(b, v) {
  if (!b.entered && !v.entered) return '동일';
  if (b.entered && !v.entered) return b.open ? '판정불가' : (b.net < 0 ? '막은손실' : '놓친수익');
  if (!b.entered && v.entered) return '신규진입';
  if (b.open || v.open) return '판정불가';
  if (b.net > 0 && v.net < 0) return '승자훼손';
  const dd = v.net - b.net;
  return dd > 1e-9 ? '개선' : dd < -1e-9 ? '악화' : '동일';
}
const pick = (arr, idx) => idx.map(i => arr[i]);

/* ───────── 5. 데이터 불러오기 ───────── */
function isIntraday(d) {
  if (!d.exportedAt) return false;
  const t = new Date(new Date(d.exportedAt).getTime() + 9 * 3600e3).toISOString();
  const kd = t.slice(0, 10).replace(/-/g, ''), h = t.slice(11, 16).replace(':', '');
  return kd < d.date || (kd === d.date && h < '1530');
}
async function readFiles(list) {
  const files = [...list].filter(f => /\.json$/i.test(f.name));
  let added = 0, dup = 0; const bad = [];
  for (const f of files) {
    let js;
    try { js = JSON.parse(await f.text()); } catch (_) { bad.push(f.name); continue; }
    const days = Array.isArray(js.days) ? js.days : Array.isArray(js.cases) ? [js] : null;
    if (!days) { bad.push(f.name); continue; }
    for (const day of days) {
      const date = String(day.settings?.targetDate || day.collection?.date || '');
      if (!/^\d{8}$/.test(date)) { bad.push(f.name); continue; }
      const ct = String(day.collection?.captureTime || '090300');
      const tf = String(day.settings?.timeframe || day.collection?.timeframe || '?');
      const key = `${date}|${ct}|${tf}`;
      let d = S.days.find(x => x.key === key);
      if (!d) {
        d = { key, date, ct, tf, exportedAt: day.exportedAt || '', collection: day.collection || {}, cases: [], missing: [], files: [] };
        S.days.push(d);
        S.use[key] = !isIntraday(d);
      }
      d.files.push(f.name);
      for (const c of day.cases || []) {
        if (!c.code || !Array.isArray(c.candles)) continue;
        if (d.cases.some(x => x.code === c.code)) { dup++; continue; }
        const cc = { code: c.code, name: c.name || c.code, officialMfeVal: c.officialMfeVal ?? null,
          candles: c.candles.map(b => ({ ...b, date: String(b.date), time: String(b.time).padStart(4, '0') })),
          daily: c.daily || [] };
        refs(cc, date);
        d.cases.push(cc); added++;
      }
      for (const m of day.missing || []) if (!d.missing.some(x => x.code === m.code)) d.missing.push(m);
    }
  }
  S.days.sort((a, b) => a.key < b.key ? -1 : 1);
  const tfs = [...new Set(S.days.map(d => d.tf))];
  const sel = $('p-tf'), prevTf = sel.value;
  sel.innerHTML = tfs.map(t => `<option ${t === (prevTf || 'T-360') ? 'selected' : ''}>${esc(t)}</option>`).join('');
  $('data-warn').innerHTML = (bad.length ? `<div class="bad">읽지 못한 파일: ${esc(bad.join(', '))}</div>` : '') +
    (dup ? `<div class="mut">중복 종목 ${dup}건은 먼저 읽은 파일 기준으로 유지했습니다.</div>` : '');
  refreshData();
  await selfCheck();
}
function mainDays() {
  const ct = $('p-ct').value.trim(), tf = $('p-tf').value;
  return S.days.filter(d => d.ct === ct && d.tf === tf);
}
function usedDays() { return mainDays().filter(d => S.use[d.key]).sort((a, b) => a.date < b.date ? -1 : 1); }
function refreshData() {
  const days = mainDays(), warn = [];
  const sig = {};
  let h = '<tr><th>사용</th><th class="l">날짜</th><th>포착시각</th><th>TF</th><th>1516 종목</th><th>MFE로 제외</th><th>봉 저장</th><th>누락</th><th>장초반 누락</th><th class="l">상태</th></tr>';
  for (const d of days) {
    const early = d.cases.filter(c => { const f = c.candles.find(b => b.date === d.date); return !f || f.time > '0903'; }).length;
    const intra = isIntraday(d);
    const exMfe = d.collection.excludedByMfe || 0;
    const codes = [...d.cases.map(c => c.code), ...d.missing.map(m => m.code)].sort().join(',');
    if (codes) (sig[codes] = sig[codes] || []).push(d.date);
    const st = intra ? '<span class="warn">장중 데이터</span>' : early ? '<span class="warn">일부 불완전</span>' : '<span class="ok">정상</span>';
    h += `<tr><td><input type="checkbox" data-k="${esc(d.key)}" ${S.use[d.key] ? 'checked' : ''}></td><td class="l">${d.date}</td><td>${hhmm(d.ct)}</td><td>${esc(d.tf)}</td>
      <td>${d.collection.captured ?? d.cases.length + d.missing.length}</td><td class="${exMfe ? 'warn' : ''}">${exMfe}</td><td>${d.cases.length}</td>
      <td>${d.missing.length}</td><td class="${early ? 'warn' : ''}">${early}</td><td class="l">${st}</td></tr>`;
    if (exMfe) warn.push(`${d.date}: MFE 기준으로 ${exMfe}종목이 빠졌습니다. 시가·전일종가 기준선 실험에는 MFE -100 수집이 필요합니다.`);
  }
  for (const k in sig) if (sig[k].length > 1) warn.push(`종목 목록이 똑같은 날짜: ${sig[k].join(', ')} → 1516 창 날짜 미변경 의심`);
  if (days.some(d => d.tf !== 'T-360')) warn.push('360틱이 아닌 데이터입니다. 박제 S4 성적(360틱)과 직접 비교하지 마세요.');
  $('tb-data').innerHTML = days.length ? h : '<tr><td class="l">주 포착시각·TF에 맞는 데이터가 없습니다.</td></tr>';
  $('data-warn').innerHTML += warn.map(w => `<div class="warn">${esc(w)}</div>`).join('');
  $('tb-data').querySelectorAll('input[data-k]').forEach(el => el.addEventListener('change', () => { S.use[el.dataset.k] = el.checked; status(); }));
  const others = S.days.filter(d => !days.includes(d));
  $('diag-lists').textContent = others.length ? '진단용 목록: ' + others.map(d => `${d.date} ${hhmm(d.ct)} ${d.tf} (${d.cases.length + d.missing.length}종목)`).join(' · ') : '';
  status();
}
function status() {
  const u = usedDays();
  const n = u.reduce((s, d) => s + d.cases.length, 0);
  $('st-data').textContent = u.length ? `${u[0].date}~${u[u.length - 1].date} · ${u.length}일 · ${n}종목 · ${$('p-tf').value}` : '데이터 없음';
}

/* ───────── 6. 재현검사 ───────── */
async function selfCheck() {
  S.ok = false; lockTabs();
  const days = usedDays();
  if (!S.F || !days.length) { $('st-check').innerHTML = '재현검사: 대기'; return; }
  const P = params();
  let runs = 0, det = 0, conv = 0, cnt = 0;
  const same = (a, b) => a.entered === b.entered && a.exitReason === b.exitReason && a.entryTime === b.entryTime && Math.abs((a.pnl || 0) - (b.pnl || 0)) < 1e-9;
  for (const d of days) for (const c of d.cases) {
    const bars = prep(d, c);
    for (const s of STRATS) {
      const Q = { ...P, strat: s };
      const a = callF(bars, Q, d.date, P.N0, true, null);
      const a2 = callF(bars, Q, d.date, P.N0, true, null);
      runs += 2; if (!same(a, a2)) det++;
      if (a.basePrice > 0) {
        const cap = a.basePrice / (1 + P.N0 / 100), line = cap * (1 + P.N0 / 100);
        const b = callF(bars, Q, d.date, (line / cap - 1) * 100, true, null);
        runs++; if (!same(a, b)) conv++;
      }
    }
    if (++cnt % 10 === 0) { $('st-check').textContent = `재현검사 중… ${runs}회`; await tick(); }
  }
  S.ok = det === 0 && conv === 0;
  $('st-check').innerHTML = S.ok
    ? `<span class="ok">재현검사: ✔ 통과</span> <span class="mut">(S4~S4.3 원본 직접 실행 ${runs}회 · 반복 불일치 0 · 기준선 변환 불일치 0)</span>`
    : `<span class="bad">재현검사: ✖ 실패</span> (반복 불일치 ${det} · 기준선 변환 불일치 ${conv}) → 분석 잠금`;
  const old = S.versions.find(v => v.sha && v.sha !== S.sha);
  if (old) $('st-check').innerHTML += ` <span class="warn">※ 버전 ${esc(old.id)} 기록 당시와 app.js가 다릅니다</span>`;
  lockTabs();
}
function lockTabs() {
  document.querySelectorAll('.tabs button').forEach(b => { if (b.dataset.t !== 'data') b.disabled = !S.ok; });
}

/* ───────── 7. 실험 ───────── */
function params() {
  const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
  return {
    strat: $('p-strat').value, gate: $('p-gate').checked, N0: num('p-n0', 5.5), macd: num('p-macd', 0.15),
    cumGate: $('p-cum').checked, minCum: num('p-mincum', 3), hardStop: parseFloat($('p-hs').value) || -2.5,
    real: !!($('p-real') && $('p-real').checked),
    stopMode: $('p-stopmode') ? $('p-stopmode').value : 'close',
    cost: num('p-cost', 0.25), mode: document.querySelector('input[name=p-mode]:checked').value,
    vFrom: num('p-vfrom', 5.5), vTo: num('p-vto', 5.5), vStep: num('p-vstep', 0.5),
    surge: $('p-surge').checked, xFrom: num('p-xfrom', 4), xTo: num('p-xto', 14), xStep: num('p-xstep', 1),
    K: Math.max(1, Math.round(num('p-k', 2)))
  };
}
function range(a, b, s) {
  const out = [];
  if (!(s > 0) || b < a) return [a];
  for (let v = a; v <= b + 1e-9; v += s) out.push(Math.round(v * 1000) / 1000);
  return out;
}
async function runExperiment() {
  if (!S.ok) return alert('재현검사를 통과해야 실험할 수 있습니다.');
  const P = params(), days = usedDays();
  if (!days.length) return alert('사용할 날짜가 없습니다.');
  const vs = range(P.vFrom, P.vTo, P.vStep), xs = P.surge ? range(P.xFrom, P.xTo, P.xStep) : [null];
  if (vs.length * xs.length > 400) return alert('조합이 400개를 넘습니다. 범위나 간격을 줄이세요.');
  const half = Math.ceil(days.length / 2);
  const setA = new Set(days.slice(0, half).map(d => d.key));
  const items = [];
  days.forEach(d => d.cases.forEach(c => items.push({ d, c })));
  const idxA = [], idxB = [];
  items.forEach((it, i) => (setA.has(it.d.key) ? idxA : idxB).push(i));
  const total = items.length * (1 + vs.length);
  let done = 0;
  const prog = async () => { if (++done % 25 === 0) { $('exp-prog').textContent = `계산 중… ${done}/${total}`; await tick(); } };
  $('btn-run').disabled = true;
  try {
    const base = [];
    for (const it of items) { base.push(evalCase(it.d, it.c, P, 'capture', P.N0).o); await prog(); }
    const runs = {};
    for (const v of vs) {
      runs[v] = [];
      for (const it of items) { const e = evalCase(it.d, it.c, P, P.mode, v); runs[v].push({ o: e.o, sp: e.sp }); await prog(); }
    }
    const bA = metrics(pick(base, idxA)), bB = metrics(pick(base, idxB)), bAll = metrics(base);
    const cells = [];
    for (const v of vs) for (const x of xs) {
      const outs = runs[v].map(e => applyX(e.o, e.sp, x));
      const mA = metrics(pick(outs, idxA));
      cells.push({ v, x, outs, mA, effA: mA.sum - bA.sum });
    }
    const near = (a, b) => Math.abs(a.v - b.v) <= 2 + 1e-9 && (a.x == null || Math.abs(a.x - b.x) <= 2 + 1e-9);
    for (const c of cells) {
      const nb = cells.filter(q => near(c, q));
      c.plateau = nb.reduce((s, q) => s + q.effA, 0) / nb.length;
      c.stable = nb.every(q => q.effA > 0);
    }
    const best = cells.reduce((a, c) => c.plateau > a.plateau ? c : a, cells[0]);
    const vA = best.mA, vB = metrics(pick(best.outs, idxB)), vAll = metrics(best.outs);
    const eA = effect(pick(base, idxA), pick(best.outs, idxA));
    const eB = effect(pick(base, idxB), pick(best.outs, idxB));
    const eAll = effect(base, best.outs);
    const checks = [
      { ok: idxB.length > 0 && vB.sum > bB.sum, t: '뒤 절반 순익 유지' },
      { ok: idxB.length > 0 && vB.stopRate < bB.stopRate, t: '뒤 절반 손절률 하락' },
      { ok: best.stable, t: '주변값(±2%p) 안정' }
    ];
    S.exp = {
      P, vs, xs, cells, best: { v: best.v, x: best.x }, items: items.map(it => ({ dkey: it.d.key, date: it.d.date, code: it.c.code, name: it.c.name, mfe: it.c.officialMfeVal })),
      base, outs: best.outs, datesA: days.slice(0, half).map(d => d.date), datesB: days.slice(half).map(d => d.date),
      rows: { bA, bB, bAll, vA, vB, vAll, eA, eB, eAll }, checks,
      status: checks.every(c => c.ok) ? '채택 후보' : '보류',
      maxAbs: Math.max(1e-9, ...cells.map(c => Math.abs(c.effA)))
    };
    renderExp(); renderTrades();
    $('exp-prog').textContent = `완료 · 조합 ${cells.length}개 시험 (시도 횟수가 많을수록 우연한 최고점일 가능성이 커집니다)`;
  } finally { $('btn-run').disabled = false; }
}
function desc(P, best) {
  let s = `${P.strat} + 기준선(${MODE_NAME[P.mode]} ${best.v}%)`;
  if (P.mode === 'capture' && best.v === P.N0) s = `${P.strat} 기준선 그대로`;
  if (best.x != null) s += ` + 급등필터 X=${best.x}% (${P.K}봉)`;
  if (P.real) s += ' · 실전모드 S4.3-R';
  s += ` · 손절 ${P.stopMode === 'low' ? '봉저가' : '봉종가'}`;
  return s;
}
function renderExp() {
  const E = S.exp, R = E.rows;
  const P = E.P, base = E.base || [];
  let h = `<div class="box">앞 절반(학습) ${E.datesA[0]}~${E.datesA[E.datesA.length - 1]} (${E.datesA.length}일) · 뒤 절반(확인) ${E.datesB.length ? E.datesB[0] + '~' + E.datesB[E.datesB.length - 1] : '없음'} (${E.datesB.length}일)` +
    (E.datesA.length + E.datesB.length < 4 ? ' <span class="warn">※ 4일 미만: 판정 신뢰 불가</span>' : '') + '</div>';
  h += `<p><b>실험 결과 · ${P.real ? '실전모드 S4.3-R' : P.gate ? '1516 게이트 ON' : '기준선 없음'} · ${esc(P.strat)} · 손절 ${P.stopMode === 'low' ? '봉저가' : '봉종가'}${P.stopMode === 'low' ? ` (전환 ${base.filter(o => o.reason === '봉저손절').length}건)` : ''}</b></p>`;
  h += `<div class="hint">앞 절반 순효과(박제 대비 순익합 차이, %p). 노란 테두리가 고원 점수(주변 ±2%p 평균) 최고 조합입니다.</div><table><tr><th class="l">${MODE_NAME[E.P.mode]} \\ 급등 X</th>` +
    E.xs.map(x => `<th>${x == null ? '필터 끔' : x + '%'}</th>`).join('') + '</tr>';
  for (const v of E.vs) {
    h += `<tr><td class="l">${v}%</td>`;
    for (const x of E.xs) {
      const c = E.cells.find(q => q.v === v && q.x === x), e = c.effA;
      const a = Math.min(1, Math.abs(e) / E.maxAbs);
      const bg = e > 0 ? `rgba(239,68,68,${0.12 + 0.6 * a})` : e < 0 ? `rgba(59,130,246,${0.12 + 0.6 * a})` : 'transparent';
      const isB = v === E.best.v && x === E.best.x;
      h += `<td style="background:${bg};${isB ? 'outline:2px solid #facc15' : ''}">${e > 0 ? '+' : ''}${e.toFixed(2)}</td>`;
    }
    h += '</tr>';
  }
  h += '</table>';
  const row = (name, m, e, b) => `<tr><td class="l">${name}</td><td>${m.n}</td><td>${fp(m.sum)}</td><td>${m.stopRate.toFixed(1)}%</td><td>${m.win.toFixed(1)}%</td><td>${f2(m.pf)}</td>
    <td>${e ? fp(e.blocked) : '-'}</td><td>${e ? fp(-e.missed) : '-'}</td><td>${b ? fp(m.sum - b.sum) : '-'}</td><td>${m.und}</td></tr>`;
  const nm = desc(E.P, E.best);
  h += `<table><tr><th class="l">버전 (비용 ${E.P.cost}% 차감)</th><th>거래</th><th>순익합</th><th>손절률</th><th>승률</th><th>PF</th><th>막은손실</th><th>놓친수익</th><th>순효과</th><th>판정불가</th></tr>
    ${row(E.P.strat + ' (박제) · 앞 절반', R.bA)}${row(nm + ' · 앞 절반', R.vA, R.eA, R.bA)}
    ${row(E.P.strat + ' (박제) · 뒤 절반', R.bB)}${row(nm + ' · 뒤 절반 확인', R.vB, R.eB, R.bB)}
    ${row(E.P.strat + ' (박제) · 전체', R.bAll)}${row(nm + ' · 전체', R.vAll, R.eAll, R.bAll)}</table>`;
  h += `<div class="box">판정: <b class="${E.status === '채택 후보' ? 'ok' : 'warn'}">${E.status}</b> &nbsp; ` +
    E.checks.map(c => `${esc(c.t)} ${c.ok ? '<span class="ok">✔</span>' : '<span class="bad">✖</span>'}`).join(' / ') +
    ` &nbsp; <button class="sub" id="btn-save-ver">버전 기록에 저장</button></div>`;
  const pathRow = k => {
    const m = metrics(base.filter(o => o.path === k));
    return `<tr><td>${k}진입</td><td>${m.n}</td><td>${fp(m.sum)}</td><td>${m.win.toFixed(1)}%</td><td>${m.stopRate.toFixed(1)}%</td><td>${f2(m.pf)}</td></tr>`;
  };
  const paths = `<p><b>${P.real ? '실전모드 S4.3-R' : P.gate ? '1516 게이트 ON' : '기준선 없음'} · 진입 경로별</b></p>` +
    `<table><tr><th>경로</th><th>거래</th><th>순익합</th><th>승률</th><th>손절률</th><th>PF</th></tr>${pathRow('일반')}${pathRow('조기')}</table>`;
  $('exp-out').innerHTML = paths + h;
  $('btn-save-ver').addEventListener('click', saveVersion);
}

/* ───────── 8. 거래비교 ───────── */
function renderTrades() {
  const E = S.exp;
  if (!E) { $('tb-trades').innerHTML = '<tr><td class="l">먼저 실험을 실행하세요.</td></tr>'; return; }
  const fc = $('f-cls').value, fl = $('f-loss').checked, fh = $('f-hide').checked;
  const cnt = {};
  let h = `<tr><th class="l">날짜</th><th class="l">종목</th><th>1516 MFE</th><th>박제 손익</th><th class="l">박제 사유</th><th>새 버전 손익</th><th class="l">새 버전 사유</th><th class="l">판정</th><th class="l">이유</th></tr>`;
  E.items.forEach((it, i) => {
    const b = E.base[i], v = E.outs[i], k = cls(b, v);
    cnt[k] = (cnt[k] || 0) + 1;
    if (fc && k !== fc) return;
    if (fl && !(b.entered && !b.open && b.net < 0)) return;
    if (fh && !b.entered && !v.entered) return;
    let why = '';
    if (v.blocked) why = v.reason;
    else if (b.entered && !v.entered) why = v.reason;
    else if (E.P.mode !== 'capture' && (b.entered || v.entered) && k !== '동일') why = '기준선 변경';
    const cell = o => o.entered ? (o.open ? '<span class="mut">미체결</span>' : fp(o.net)) : '<span class="mut">미진입</span>';
    h += `<tr class="click" data-i="${i}"><td class="l">${it.date}</td><td class="l">${esc(it.name)} <span class="mut">${esc(it.code)}</span></td><td>${it.mfe == null ? '-' : it.mfe.toFixed(2)}</td>
      <td>${cell(b)}</td><td class="l">${esc(b.reason)}</td><td>${cell(v)}</td><td class="l">${esc(v.reason)}</td><td class="l">${k}</td><td class="l">${esc(why)}</td></tr>`;
  });
  $('tb-trades').innerHTML = h;
  $('tr-sum').textContent = Object.entries(cnt).map(([k, n]) => `${k} ${n}`).join(' · ');
  $('tb-trades').querySelectorAll('tr.click').forEach(tr => tr.addEventListener('click', () => {
    const it = E.items[+tr.dataset.i]; openChart(it.dkey, it.code);
  }));
}

/* ───────── 9. 차트진단 ───────── */
function ensureChart() {
  if (S.chart) return;
  const el = $('chart');
  S.chart = LightweightCharts.createChart(el, {
    width: el.clientWidth, height: 430,
    layout: { background: { type: 'solid', color: '#0b1220' }, textColor: '#d1d5db' },
    grid: { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } },
    timeScale: { timeVisible: true, secondsVisible: false, tickMarkFormatter: t => hm(t) },
    localization: { timeFormatter: t => hm(t) }
  });
  S.ser.c = S.chart.addCandlestickSeries({ upColor: '#ef4444', downColor: '#3b82f6', borderVisible: false, wickUpColor: '#ef4444', wickDownColor: '#3b82f6' });
  S.ser.b = S.chart.addLineSeries({ color: '#f97316', lineWidth: 2, title: '박제 기준선' });
  S.ser.v = S.chart.addLineSeries({ color: '#a78bfa', lineWidth: 2, lineStyle: 2, title: '새 기준선' });
  S.ser.s = S.chart.addLineSeries({ color: '#22d3ee', lineWidth: 1, title: '기준시각 변경' });
  window.addEventListener('resize', () => S.chart.applyOptions({ width: el.clientWidth }));
}
function lineData(bars, from, date, value) {
  if (!(value > 0) || from < 0) return [];
  return bars.filter((b, i) => i >= from && b.date === date).map(b => ({ time: b.timestamp, value }));
}
function openChart(dkey, code) {
  const d = S.days.find(x => x.key === dkey), c = d && d.cases.find(x => x.code === code);
  if (!c) return;
  S.cur = { d, c }; S.lastDiag = null;
  showTab('chart'); ensureChart(); drawChart(null);
  $('dg-out').innerHTML = '기준시각을 고르고 [다시 계산]을 누르세요.';
}
function drawChart(diag) {
  const { d, c } = S.cur, P = S.exp ? S.exp.P : params();
  const bars = prep(d, c);
  const b = evalCase(d, c, P, 'capture', P.N0);
  const v = S.exp ? evalCase(d, c, P, P.mode, S.exp.best.v) : null;
  const vo = v ? applyX(v.o, v.sp, S.exp.best.x) : null;
  S.ser.c.setData(bars.filter(x => x.date === d.date).map(x => ({ time: x.timestamp, open: x.open, high: x.high, low: x.low, close: x.close })));
  const startIdx = b.r ? b.r.entryStartIdx : -1;
  S.ser.b.setData(lineData(bars, startIdx, d.date, b.line));
  S.ser.v.setData(v && (P.mode !== 'capture' || S.exp.best.v !== P.N0) ? lineData(bars, startIdx, d.date, v.line) : []);
  let mk = resultMarkers(b.r, b.o).map(m => ({ ...m, text: '박제 ' + m.text }));
  if (v && v.r && vo.entered) mk = mk.concat(resultMarkers(v.r, vo).map(m => ({ ...m, color: '#a78bfa', shape: m.position === 'belowBar' ? 'arrowUp' : 'circle', text: '새 ' + m.text })));
  if (diag && diag.r) {
    const map = new Map(diag.bars.map((x, i) => [x.timestamp, i]));
    mk = mk.concat(resultMarkers(diag.r, diag.o).map(m => { const i = map.get(m.time); return i == null ? null : { ...m, time: bars[i].timestamp, color: '#22d3ee', text: '시각 ' + m.text }; }).filter(Boolean));
    S.ser.s.setData(lineData(bars, diag.r.entryStartIdx, d.date, diag.r.basePrice));
  } else S.ser.s.setData([]);
  mk.sort((a, z) => a.time - z.time);
  S.ser.c.setMarkers(mk);
  S.chart.timeScale().fitContent();
  $('ch-title').innerHTML = `<b>${esc(c.name)} (${esc(c.code)}) · ${d.date} · ${esc(d.tf)}</b>`;
  const cap = b.line ? b.line / (1 + P.N0 / 100) : null;
  const res = (o, sp) => o.entered ? `${o.open ? '미체결' : fp(o.net)} · 진입 ${o.entryTime} ${won(o.entryPrice)} · ${esc(o.reason)}${sp != null ? ` · 진입 전 급등봉 +${sp.toFixed(1)}%` : ''}` : `미진입 (${esc(o.reason)})`;
  $('ch-info').innerHTML =
    `1516 MFE ${c.officialMfeVal == null ? '-' : c.officialMfeVal.toFixed(2) + '%'} · 포착가 ${won(cap)} · 박제 기준선 ${won(b.line)}<br>` +
    `시가 ${won(c._open)} (${c._openSrc}) · 전일종가 ${won(c._prev)} (${c._prevSrc})<br>` +
    `<b style="color:#f97316">박제 ${P.strat}</b>: ${res(b.o, b.sp)}<br>` +
    (v ? `<b style="color:#a78bfa">새 버전</b> ${esc(desc(P, S.exp.best))}: ${vo.blocked ? '<span class="warn">차단 · ' + esc(vo.reason) + '</span>' : res(vo, v.sp)}${v.line ? ' · 새 기준선 ' + won(v.line) : ''}` : '<span class="mut">실험을 실행하면 새 버전 결과가 함께 표시됩니다.</span>');
}
function findMfe(date, t, tf, code) {
  const day = S.days.find(x => x.date === date && x.tf === tf && x.ct.startsWith('090' + t));
  if (!day) return { list: false };
  const hit = day.cases.find(x => x.code === code) || day.missing.find(x => x.code === code);
  return { list: true, found: !!hit, mfe: hit ? hit.officialMfeVal ?? null : null };
}
function runDiag() {
  if (!S.cur) return;
  const { d, c } = S.cur, P = S.exp ? S.exp.P : params();
  const t = +$('dg-t0').value, k = 3 - t;
  const lst = findMfe(d.date, t, d.tf, c.code);
  const mfe = lst.found ? lst.mfe : null;
  const bars = cloneBars(c.candles, d.date, k);
  let r = null, skip = null;
  if (P.real) r = callF(bars, P, d.date, P.N0, true, null);
  else if (P.gate && mfe != null && mfe < P.N0) skip = `1516 MFE 미달 (09:0${t})`;
  else r = callF(bars, P, d.date, P.N0, P.gate, mfe);
  const o = outcome(r, skip, P.cost);
  const i = entryIdx(bars, r);
  o.entryPrice = i >= 0 ? bars[i].close : null;
  applyStopMode(o, r, bars, P);
  const orig = evalCase(d, c, P, 'capture', P.N0).o;
  let j;
  if (orig.entered && !orig.open && orig.net < 0) j = o.entered && !o.open ? (o.net > 0 ? '착시손실' : '진짜손실') : '미진입(손실회피)';
  else if (!orig.entered && !o.entered) j = '동일(미진입)';
  else if (!o.entered) j = '악화(미진입)';
  else if (!orig.entered) j = '신규진입';
  else j = o.net > orig.net + 1e-9 ? '개선' : o.net < orig.net - 1e-9 ? '악화' : '동일';
  const cap = r && r.basePrice ? r.basePrice / (1 + P.N0 / 100) : null;
  const listTxt = !lst.list ? '<span class="warn">09:0' + t + ' 목록 없음 → 1516에서 직접 확인 필요</span>'
    : lst.found ? `<span class="ok">09:0${t} 목록에서 포착됨 (MFE ${mfe == null ? '-' : mfe.toFixed(2) + '%'})</span>` : `<span class="bad">09:0${t} 목록에 없음 → 이 기준시각은 실전에서 불가능</span>`;
  const origCap = orig.entered || true ? (evalCase(d, c, P, 'capture', P.N0).line || 0) / (1 + P.N0 / 100) : null;
  $('dg-out').innerHTML = `${listTxt}<br>` +
    `09:03 기준: 기준가 ${won(origCap)} · ${orig.entered ? `진입 ${orig.entryTime} ${won(orig.entryPrice)} · 손익 ${orig.open ? '미체결' : fp(orig.net)}` : '미진입'}<br>` +
    `09:0${t} 기준: 기준가 ${won(cap)} · ${o.entered ? `진입 ${hhmm(c.candles[i]?.time || '----')} ${won(i >= 0 ? bars[i].close : 0)} · 손익 ${o.open ? '미체결' : fp(o.net)} · ${esc(o.reason)}` : '미진입 (' + esc(o.reason) + ')'}<br>` +
    `판정: <b>${j}</b> <span class="mut">(시간창 전체를 ${k}분 앞당겨 계산)</span>`;
  S.lastDiag = { date: d.date, code: c.code, name: c.name, t0: '09:0' + t, listFound: lst.list ? lst.found : null,
    orig: orig.entered && !orig.open ? +orig.net.toFixed(3) : null, shifted: o.entered && !o.open ? +o.net.toFixed(3) : null, judge: j };
  drawChart({ r, bars, o });
}
function saveCase() {
  if (!S.lastDiag) return alert('먼저 [다시 계산]으로 진단하세요.');
  S.cases.push({ ...S.lastDiag, memo: $('dg-memo').value.trim(), savedAt: new Date().toISOString() });
  store('s4tuner.cases', S.cases); $('dg-memo').value = ''; renderCases();
}
function renderCases() {
  $('tb-cases').innerHTML = '<tr><th class="l">날짜</th><th class="l">종목</th><th>기준시각</th><th>1516 확인</th><th>09:03 손익</th><th>변경 손익</th><th class="l">판정</th><th class="l">메모</th><th></th></tr>' +
    S.cases.map((x, i) => `<tr><td class="l">${x.date}</td><td class="l">${esc(x.name)}</td><td>${x.t0}</td><td>${x.listFound == null ? '미확인' : x.listFound ? '포착' : '없음'}</td>
      <td>${fp(x.orig)}</td><td>${fp(x.shifted)}</td><td class="l">${esc(x.judge)}</td><td class="l">${esc(x.memo)}</td><td><button class="sub" data-del="${i}">삭제</button></td></tr>`).join('');
  $('tb-cases').querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { S.cases.splice(+b.dataset.del, 1); store('s4tuner.cases', S.cases); renderCases(); }));
}

/* ───────── 10. 버전기록 ───────── */
function saveVersion() {
  const E = S.exp;
  const id = 'T' + (S.versions.filter(v => /^T\d+$/.test(v.id)).length + 1);
  S.versions.push({ id, desc: desc(E.P, E.best), P: E.P, best: E.best, dates: [...E.datesA, ...E.datesB],
    base: E.rows.bAll, var: E.rows.vAll, checks: E.checks, status: E.status, sha: S.sha, createdAt: new Date().toISOString(), recheck: '' });
  store('s4tuner.versions', S.versions); renderVersions();
  alert(`${id} 저장 (${E.status})`);
}
function recheck(ver) {
  const days = usedDays().filter(d => !ver.dates.includes(d.date));
  if (!days.length) return '새 날짜 없음';
  const P = ver.P, bs = [], vs = [];
  for (const d of days) for (const c of d.cases) {
    bs.push(evalCase(d, c, P, 'capture', P.N0).o);
    const e = evalCase(d, c, P, P.mode, ver.best.v);
    vs.push(applyX(e.o, e.sp, ver.best.x));
  }
  const mb = metrics(bs), mv = metrics(vs);
  return `${days[0].date}~${days[days.length - 1].date} ${days.length}일: 새 ${mv.sum.toFixed(2)}% / 박제 ${mb.sum.toFixed(2)}% · 손절률 ${mv.stopRate.toFixed(1)}% / ${mb.stopRate.toFixed(1)}% ${mv.sum > mb.sum && mv.stopRate <= mb.stopRate ? '✔' : '✖'}`;
}
function renderVersions() {
  $('tb-ver').innerHTML = '<tr><th class="l">버전</th><th class="l">내용</th><th>검증 기간</th><th>박제 순익합</th><th>새 순익합</th><th>박제 손절률</th><th>새 손절률</th><th class="l">상태</th><th class="l">새 날짜 재확인</th><th></th></tr>' +
    S.versions.map((v, i) => `<tr><td class="l">${esc(v.id)}${v.sha !== S.sha ? ' <span class="warn" title="app.js 변경">⚠</span>' : ''}</td><td class="l">${esc(v.desc)}</td>
      <td>${v.dates[0]}~${v.dates[v.dates.length - 1]}</td><td>${fp(v.base.sum)}</td><td>${fp(v.var.sum)}</td><td>${v.base.stopRate.toFixed(1)}%</td><td>${v.var.stopRate.toFixed(1)}%</td>
      <td class="l"><select data-st="${i}">${['채택 후보', '채택', '보류'].map(s => `<option ${s === v.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
      <td class="l">${esc(v.recheck || '')}</td><td><button class="sub" data-del="${i}">삭제</button></td></tr>`).join('');
  $('tb-ver').querySelectorAll('[data-st]').forEach(s => s.addEventListener('change', () => { S.versions[+s.dataset.st].status = s.value; store('s4tuner.versions', S.versions); }));
  $('tb-ver').querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    if (!confirm('이 버전 기록을 삭제할까요?')) return;
    S.versions.splice(+b.dataset.del, 1); store('s4tuner.versions', S.versions); renderVersions();
  }));
}
function download(obj, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ───────── 11. 화면 연결 ───────── */
function showTab(t) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  document.querySelectorAll('section').forEach(s => s.classList.toggle('on', s.id === 't-' + t));
  if (t === 'chart') { ensureChart(); S.chart.applyOptions({ width: $('chart').clientWidth }); }
}
(function addStopBox() {
  if ($('p-stopmode')) return;
  const l = $('p-hs').closest('label');
  const s = document.createElement('label');
  s.innerHTML = ' 손절적용 <select id="p-stopmode"><option value="close">봉종가</option><option value="low">봉저가</option></select>';
  l.insertAdjacentElement('afterend', s);
  const g = $('p-gate'), rl = document.createElement('label');
  rl.innerHTML = ' <input type="checkbox" id="p-real"> 실전모드 S4.3-R (1516 사전제외 없이 실시간 기준선과 조기가속 예외만 적용)';
  (g.closest('label') || g).insertAdjacentElement('afterend', rl);
})();
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => !b.disabled && showTab(b.dataset.t)));
$('in-dir').addEventListener('change', e => readFiles(e.target.files));
$('in-files').addEventListener('change', e => readFiles(e.target.files));
$('p-ct').addEventListener('change', async () => { refreshData(); await selfCheck(); });
$('p-tf').addEventListener('change', async () => { refreshData(); await selfCheck(); });
$('btn-recheck').addEventListener('click', selfCheck);
$('btn-run').addEventListener('click', runExperiment);
['f-cls', 'f-loss', 'f-hide'].forEach(id => $(id).addEventListener('change', renderTrades));
$('btn-diag').addEventListener('click', runDiag);
$('btn-case').addEventListener('click', saveCase);
$('btn-case-exp').addEventListener('click', () => download(S.cases, 's4tuner-cases.json'));
$('btn-ver-exp').addEventListener('click', () => download(S.versions, 's4tuner-versions.json'));
$('btn-ver-check').addEventListener('click', () => { S.versions.forEach(v => { v.recheck = recheck(v); }); store('s4tuner.versions', S.versions); renderVersions(); });
$('in-ver').addEventListener('change', async e => {
  try { const arr = JSON.parse(await e.target.files[0].text()); if (!Array.isArray(arr)) throw 0;
    arr.forEach(v => { if (!S.versions.some(x => x.id === v.id && x.createdAt === v.createdAt)) S.versions.push(v); });
    store('s4tuner.versions', S.versions); renderVersions();
  } catch (_) { alert('버전 기록 파일 형식이 아닙니다.'); }
});
document.querySelectorAll('input[name=p-mode]').forEach(r => r.addEventListener('change', () => {
  const d = { capture: [5.5, 5.5, 0.5], open: [3, 8, 0.5], prev: [5, 15, 1] }[r.value];
  $('p-vfrom').value = d[0]; $('p-vto').value = d[1]; $('p-vstep').value = d[2];
}));
renderCases(); renderVersions();
loadFrozen().catch(e => { $('st-check').innerHTML = `<span class="bad">원본 로드 실패: ${esc(e.message)}</span>`; });
})();
