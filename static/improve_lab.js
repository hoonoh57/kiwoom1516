/* static/improve_lab.js — S4.3 개선 Lab (6번 탭)
   1) 원본 app.js 파일은 보존한다. 변형 판정은 메모리 사본 엔진으로 재시뮬레이션한다.
   2) 재시뮬 처방: 조기진입 조건 · 하드스탑 · 추격 상한(봉 단위 진입 금지) · 이익보호 트레일(첫 익절 전, 봉종가).
   3) 변형 코드는 __X가 비어 있으면 원본과 똑같이 동작하며, 실행 때마다 원본 일치 검사를 한다.
   4) 처방은 옵션 조합(cfg)이고, 박제 버전은 그 cfg를 저장한 것이다. */
(function () {
'use strict';
const T = window.S4T;
if (!T) { console.error('improve_lab.js: window.S4T가 없습니다. tuner.js에 공개 줄을 추가하세요.'); return; }
const $ = id => document.getElementById(id);
const { S, fp, esc } = T;
const f2 = v => v == null ? '-' : v === Infinity ? '∞' : v.toFixed(2);
const HM = t => String(t).slice(0, 2) + ':' + String(t).slice(2, 4);
const tick = () => new Promise(r => setTimeout(r, 0));
const sumOf = (a, k) => a.reduce((s, x) => s + x[k], 0);
const loadVersions = () => { try { const v = JSON.parse(localStorage.getItem('s4lab.versions') || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } };
const L = { busy: false, key: '', recs: [], dates: [], P: null, mode: 'real', baseCfg: {}, baseName: '', show: [],
            versions: loadVersions() };
const LAB_VER = 'lab-resim-3';

/* ───────── 처방 목록 (대상 문제별 옵션과 시험 범위) ───────── */
const FAM = [
  { key: 'early', title: '조기진입 조정', target: '큰 손절', sim: true,
    grids: [[{ t: 'off' }],
            ['0910', '0908', '0906'].map(v => ({ t: 'time', v })),
            [20, 25, 30].map(v => ({ t: 'cum', v })),
            [0.25, 0.30, 0.35].map(v => ({ t: 'macd', v }))],
    label: g => g.t === 'off' ? '조기가속 진입 끄기 (재시뮬)' : g.t === 'time' ? `조기진입 시한 09:12→${HM(g.v)} (재시뮬)`
      : g.t === 'cum' ? `조기진입 누적대금 15→${g.v}억 (재시뮬)` : `조기진입 MACD 0.20→${g.v.toFixed(2)} (재시뮬)` },
  { key: 'hs', title: '하드스탑', target: '큰 손절', sim: true,
    grids: [[-2.0, -2.5, -3.0, -3.5, -4.0]],
    label: v => `하드스탑 ${Number(L.P ? L.P.hardStop : T.params().hardStop)}% → ${v}% (재시뮬)` },
  { key: 'rise', title: '추격 상한', target: '큰 손절', sim: true,
    grids: [[14, 16, 18, 20, 22, 25]],
    label: v => `전일종가 대비 +${v}% 넘는 봉에서는 진입 안 함 (재시뮬)` },
  { key: 'trail', title: '이익보호 트레일', target: '고MFE 저수익', sim: true,
    grid2: { a: [4, 5, 6, 8], b: [1, 1.5, 2, 3] },
    label: g => `+${g.a}% 도달 후 최고가 대비 -${g.b}% 아래 종가면 청산 (재시뮬)` }
];
const cfgText = cfg => {
  const t = FAM.filter(F => cfg[F.key] != null).map(F => F.label(cfg[F.key]));
  return t.length ? t.join(' + ') : '처방 없음 (원본 그대로)';
};

/* ───────── 변형 엔진 (app.js 파일은 그대로, 메모리 사본의 S4.3 블록만 수정) ───────── */
const EA0 = { on: true, t: '0912', cum: 15, macd: 0.20 };
const EA = { ...EA0 };
const X = { rise: null, trail: null, prev: 0 };   // null이면 원본과 동일하게 동작
let FV = null;
const eaOf = g => Object.assign({}, EA0, !g ? {} : g.t === 'off' ? { on: false } : g.t === 'time' ? { t: g.v } : g.t === 'cum' ? { cum: g.v } : { macd: g.v });
const setEA = g => Object.assign(EA, eaOf(g));
async function loadVariant() {
  if (FV) return;
  const response = await fetch('/static/app.js', { cache: 'no-store' });
  if (!response.ok) throw new Error('app.js 로드 실패 HTTP ' + response.status);
  const buf = await response.arrayBuffer();
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
  if (sha !== S.sha) throw new Error('app.js가 튜너 로드 이후 바뀌었습니다. Ctrl+F5 후 다시 실행하세요.');
  const src = new TextDecoder('utf-8').decode(buf);
  const re = /let\s+earlyAccelerationEnter\s*=\s*\(\s*isS4Setup\s*&&\s*bar\.time\s*<=\s*"0912"\s*&&\s*curCumAmtEok\s*>=\s*15\.0\s*&&\s*curNormMACD\s*>=\s*0\.20\s*\)\s*;/g;
  const hits = [...src.matchAll(re)];
  if (hits.length !== 2) throw new Error(`S4.3 조기가속 줄을 찾지 못했습니다 (일치 ${hits.length}건, 기대 2건: S4.2·S4.3)`);
  const h = hits[1];   // 두 번째 = S4.3
  const tail = src.slice(h.index);
  // 주입 전 이름 검사: 이름이 다르면 계산이 조용히 틀어지므로 중단
  const nm = [...src.slice(0, h.index).matchAll(/\b(let|const|var)\s+normalEnter\b/g)].pop();
  if (!nm || nm[1] !== 'let') throw new Error('주입 불가: S4.3 normalEnter 선언(let)을 찾지 못했습니다.');
  const evaluatorStart = src.indexOf('function evaluateStrategyTrade');
  const setup = src.slice(evaluatorStart, h.index);
  if (!/const\s+markers\s*=\s*\[\s*\]/.test(setup)) throw new Error('주입 불가: markers 선언을 찾지 못했습니다.');
  for (const v of ['exitPrice', 'exitReason', 'pnlPct'])
    if (!new RegExp('\\b' + v + '\\s*=').test(tail)) throw new Error(`주입 불가: S4.3 청산부에서 ${v} 변수를 찾지 못했습니다.`);
  if (!/\bs43_stg1\b/.test(tail) || !/\bs43_stg2\b/.test(tail)) throw new Error('주입 불가: s43_stg1 / s43_stg2를 찾지 못했습니다.');
  // (가) 추격 상한: 진입 판정 봉의 종가가 전일종가 대비 상한을 넘으면 그 봉만 진입 금지
  const EARLY = 'let earlyAccelerationEnter = (__EA.on && isS4Setup && bar.time <= __EA.t && curCumAmtEok >= __EA.cum && curNormMACD >= __EA.macd);'
    + ' if (__X.rise != null && __X.prev > 0 && (bar.close / __X.prev - 1) * 100 > __X.rise) { normalEnter = false; earlyAccelerationEnter = false; }';
  let src2 = src.slice(0, h.index) + EARLY + src.slice(h.index + h[0].length);
  // (나) 트레일: S4.3 청산부 curPnL 줄 바로 뒤, 첫 익절 전까지만 봉종가로 판정
  const reP = /const\s+curPnL\s*=\s*\(\(bar\.close\s*-\s*entryPrice\)\s*\/\s*entryPrice\)\s*\*\s*100\.0\s*;/g;
  reP.lastIndex = h.index + EARLY.length;
  const pm = reP.exec(src2);
  if (!pm) throw new Error('주입 불가: S4.3 청산부 curPnL 줄을 찾지 못했습니다.');
  const TRAIL = ' if (__X.trail) { __trHi = Math.max(__trHi, +bar.high);'
    + ' if (!s43_stg1 && !s43_stg2 && __trHi >= entryPrice * (1 + __X.trail.a / 100) && bar.close <= __trHi * (1 - __X.trail.b / 100)) {'
    + ' exitPrice = bar.close; exitReason = "이익보호트레일"; pnlPct = curPnL;'
    + ' markers.push({ time: bar.timestamp, position: "aboveBar", color: "#22d3ee", shape: "arrowDown", text: "[이익보호트레일] " + exitPrice.toLocaleString() + "원 (" + curPnL.toFixed(2) + "%)" }); break; } }';
  const at = pm.index + pm[0].length;
  src2 = src2.slice(0, at) + TRAIL + src2.slice(at);
  const hv = src2.slice(evaluatorStart, h.index).match(/let\s+s43_highestPrice\s*=\s*0\s*;/);
  if (!hv) throw new Error('주입 불가: s43_highestPrice 선언을 찾지 못했습니다.');
  const hvAt = evaluatorStart + hv.index + hv[0].length;
  src2 = src2.slice(0, hvAt) + ' let __trHi = 0;' + src2.slice(hvAt);

  const m = src2.match(/\(\s*function\s*\(\s*\)\s*\{/), end = src2.lastIndexOf('})');
  if (!m || end < 0) throw new Error('app.js 구조를 인식하지 못했습니다.');
  const noop = () => {};
  const fakeDoc = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, createElement: () => ({ style: {} }) };
  const fakeWin = { addEventListener: noop, LightweightCharts: null, innerWidth: 1000, innerHeight: 800 };
  FV = new Function('window', 'document', '__EA', '__X',
    '"use strict";\n' + src2.slice(m.index + m[0].length, end) + '\n;return (typeof evaluateStrategyTrade === "function") ? evaluateStrategyTrade : null;')(fakeWin, fakeDoc, EA, X);
  if (!FV) throw new Error('변형 엔진에서 evaluateStrategyTrade를 찾지 못했습니다.');
}
const SIMK = ['early', 'hs', 'rise', 'trail'];
const simKey = cfg => JSON.stringify(SIMK.map(k => cfg[k] ?? null));
const needSim = cfg => SIMK.some(k => cfg[k] != null);
async function simRecs(cfg, tag) {
  const P = cfg.hs != null ? { ...L.P, hardStop: cfg.hs } : L.P;
  return buildRecs(P, L.days, tag, cfg.early || null, { rise: cfg.rise ?? null, trail: cfg.trail || null });
}
async function ensureSim(cfg) {
  if (!needSim(cfg) || L.sims.has(simKey(cfg))) return;
  const t = FAM.filter(F => F.sim && cfg[F.key] != null).map(F => F.label(cfg[F.key])).join(' + ');
  L.sims.set(simKey(cfg), await simRecs(cfg, '재시뮬 · ' + t));
}
const recsFor = cfg => needSim(cfg) ? L.sims.get(simKey(cfg)) : L.recs0;

/* ───────── 화면 ───────── */
function buildUI() {
  const sec = $('t-lab'); if (!sec) return;
  sec.innerHTML = `
<fieldset><legend>기준 버전과 문제 거래 기준 <span class="mut">(${LAB_VER})</span></legend>
 <div class="row">
  <label>기준 <select id="lb-mode"><option value="real">S4.3 실전모드 (S4.3-R)</option><option value="gate">S4.3 1516 게이트 ON (참고)</option></select></label>
  <label>큰 손절: 순손익 ≤ <input type="number" id="lb-big" value="-3" step="0.5">%</label>
  <label>고MFE 저수익: 진입 후 최고 ≥ <input type="number" id="lb-mfe" value="5" step="0.5">% 인데 실현 &lt; 그 <input type="number" id="lb-ratio" value="30" step="5">%</label>
  <label>훼손 허용: 개선액의 <input type="number" id="lb-dmg" value="50" step="10" style="width:52px">%</label>
 </div>
 <div class="row" style="margin-top:6px">
  <button class="act" id="lb-run">진단·탐색 실행</button>
  <button class="sub" id="lb-reset">기준을 S4.3로 되돌리기</button>
  <span id="lb-prog" class="hint"></span>
 </div>
 <div class="hint">MACD·누적대금·하드스탑·비용은 2 실험 탭 설정을 그대로 씁니다. 손절은 봉종가 기준입니다. 모든 처방은 원본 엔진 재시뮬입니다. 현재 기준 처방: <b id="lb-basecfg">없음</b></div>
</fieldset>
<div id="lb-sum"></div>
<div id="lb-cands"></div>
<div id="lb-detail"></div>
<fieldset><legend>박제 기록</legend><div id="lb-vers"></div></fieldset>`;
  $('lb-run').addEventListener('click', run);
  $('lb-reset').addEventListener('click', () => { L.baseCfg = {}; L.baseName = ''; $('lb-basecfg').textContent = '없음'; run(); });
  renderVers();
}

/* ───────── 판정 + 진입 시점 특징 ───────── */
async function buildRecs(P, days, tag, variant = undefined, x = null) {
  const half = Math.ceil(days.length / 2), A = new Set(days.slice(0, half).map(d => d.key));
  const out = [], tot = days.reduce((s, d) => s + d.cases.length, 0);
  let k = 0;
  for (const d of days) for (const c of d.cases) {
    let e;
    const F0 = S.F;
    try {
      if (variant !== undefined) {
        setEA(variant); X.rise = x ? x.rise : null; X.trail = x ? x.trail : null; X.prev = +c._prev || 0;
        S.F = FV;
      }
      e = T.evalCase(d, c, P, 'capture', P.N0);
    } finally { S.F = F0; setEA(null); X.rise = null; X.trail = null; X.prev = 0; }
    const rec = { d, c, o: e.o, half: A.has(d.key) ? 'A' : 'B', ok: false, mk: (e.r && e.r.markers) || [], basePrice: e.r && e.r.basePrice };
    if (e.o.entered && !e.o.open && e.o.idx >= 0 && e.o.entryPrice > 0) feat(rec, e);
    out.push(rec);
    if (++k % 50 === 0) { $('lb-prog').textContent = `${tag} ${k}/${tot}…`; await tick(); }
  }
  return out;
}
function feat(rec, e) {
  const { bars, r } = e, o = rec.o, i0 = o.idx, b0 = bars[i0], date = rec.d.date, ep = o.entryPrice;
  const mk = (r && r.markers) || [];
  const downs = mk.filter(m => m.shape === 'arrowDown');
  const exitTs = downs.length ? downs[downs.length - 1].time : Infinity;
  let hi = -Infinity, cum = 0;
  for (let i = i0 + 1; i < bars.length && bars[i].date === date && bars[i].timestamp <= exitTs; i++) hi = Math.max(hi, +bars[i].high);
  for (let i = 0; i <= i0; i++) { const b = bars[i]; if (b.date === date && b.time >= '0900') cum += (+b.close) * (+b.volume || 0); }
  rec.f = {
    time: b0.time, path: o.path,
    rise: rec.c._prev > 0 ? (ep / rec.c._prev - 1) * 100 : null,
    cum: cum / 1e8,
    spike: e.sp,
    wick: b0.open > 0 ? (b0.high - Math.max(b0.open, b0.close)) / b0.open * 100 : null,
    overLine: r && r.basePrice > 0 ? (ep / r.basePrice - 1) * 100 : null,
    mfe: Number.isFinite(hi) ? Math.max(0, (hi / ep - 1) * 100) : 0
  };
  rec.ok = true;
}

/* ───────── 처방 적용 (모든 처방이 재시뮬이므로 엔진 결과 그대로) ───────── */
function applyCfg(rec, cfg) {
  const o = rec.o;
  if (!o.entered) return { entered: false, why: '' };
  return { entered: true, open: o.open, net: o.net, pnl: o.pnl, stop: o.stop, why: '' };
}
function classify(rec, x) {
  if (!x.entered || x.open) return '';
  if (x.net <= L.Q.big) return '큰손절';
  if (rec.ok && rec.f.mfe >= L.Q.mfe && x.pnl < rec.f.mfe * L.Q.ratio / 100) return '고MFE저수익';
  return x.net > 0 ? '수익' : '소손실';
}
function mets(res) {
  const t = res.filter(x => x.entered && !x.open), n = t.length, sum = sumOf(t, 'net');
  const gp = t.filter(x => x.net > 0).reduce((s, x) => s + x.net, 0), gl = -t.filter(x => x.net < 0).reduce((s, x) => s + x.net, 0);
  return { n, sum, win: n ? t.filter(x => x.net > 0).length / n * 100 : 0, pf: gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0) };
}
function halves(res) {
  let A = 0, B = 0;
  res.forEach((x, i) => { if (x.entered && !x.open) { if (L.recs[i].half === 'A') A += x.net; else B += x.net; } });
  return { A, B };
}
function evaluate(cfg) {
  const recs = recsFor(cfg);
  if (!recs) throw new Error('재시뮬 결과가 없습니다: ' + simKey(cfg));
  const res = recs.map(r => applyCfg(r, cfg)), all = mets(res), h = halves(res);
  let fixed = 0, broken = 0, gain = 0, loss = 0, nN = 0, nE = 0; const changes = [];
  res.forEach((x, i) => {
    const xIn = x.entered && !x.open;
    if (xIn && recs[i].ok) { if (recs[i].f.path === '조기') nE++; else nN++; }
    const b = L.baseRes[i], bIn = b.entered && !b.open;
    if (!bIn && !xIn) return;
    const bn = bIn ? b.net : 0, nn = xIn ? x.net : 0, dd = nn - bn;
    if (Math.abs(dd) < 1e-6) return;
    const cl = L.cls[i];
    if (dd > 0) { gain += dd; if (cl === '큰손절' || cl === '고MFE저수익') fixed++; }
    else { loss += -dd; if (bn > 0) broken++; }
    let why = x.why || '';
    if (!why && recs !== L.recs) {
      const r = recs[i], ex = (r.mk || []).filter(m => m.shape === 'arrowDown').pop();
      const exT = ex ? ((ex.text || '').match(/\[(.+?)\]/) || [])[1] : '';
      why = !xIn ? '재시뮬: 진입 없음' : (r.ok ? `재시뮬: ${r.f.path}진입 ${HM(r.f.time)}` : '재시뮬 진입') + (exT ? ` → ${exT}` : '');
    }
    changes.push({ i, bn, nn, dd, bIn, xIn, why, cl });
  });
  return { cfg, all, dA: h.A - L.bA, dB: h.B - L.bB, dAll: all.sum - L.bAll.sum, fixed, broken, gain, loss, nN, nE, changes };
}
/* ───────── 탐색과 판정 ───────── */
const dist = (a, b) => a.slice(1).reduce((s, v, i) => s + Math.abs(v - b[i + 1]), 0);
function judge(p) {
  const e = p.ev, why = [];
  if (e.dA <= 0) why.push('앞 기간 악화');
  if (e.dB <= 0) why.push('뒤 기간 악화');
  if (e.fixed < 3) why.push(`고친 문제거래 ${e.fixed}건`);
  if (e.loss > e.gain * L.Q.dmg / 100) why.push(`훼손액 ${e.loss.toFixed(1)} > 개선액 ${e.gain.toFixed(1)}의 ${L.Q.dmg}%`);
  if (!p.stable) why.push('주변값에서 효과 사라짐');
  p.pass = why.length ? 0 : 1;
  p.verdict = e.dAll <= 0 ? '기각' : p.pass ? '추천' : '보류';
  p.why = e.dAll <= 0 ? '전체 순익 개선 없음' : p.pass ? '4개 조건 통과' : why.join(', ');
}
function neighbors(key, pts, p) {
  const F = FAM.find(f => f.key === key);
  if (key === 'early' && p.g.t === 'off')
    return F.grids.slice(1).map((l, gi) => pts.find(q => q.pos[0] === gi + 1 && q.pos[1] === l.length - 1)).filter(Boolean);
  return pts.filter(q => q.pos[0] === p.pos[0] && dist(p.pos, q.pos) === 1);
}
const sameG = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function search() {
  const out = [], curHs = L.baseCfg.hs ?? Number(L.P.hardStop);
  for (const F of FAM) {
    const pts = [];
    if (F.grid2) F.grid2.a.forEach((a, ia) => F.grid2.b.forEach((b, ib) => pts.push({ g: { a, b }, pos: [0, ia, ib] })));
    else F.grids.forEach((list, gi) => list.forEach((g, j) => pts.push({ g, pos: [gi, j] })));
    // 현재 기준과 같은 값은 비교 의미가 없으므로 제외
    const cur = F.key === 'hs' ? curHs : L.baseCfg[F.key];
    const live = pts.filter(p => !(cur != null && (F.key === 'hs' ? Math.abs(p.g - cur) < 1e-9 : sameG(p.g, cur))));
    for (const p of live) {
      const cfg = { ...L.baseCfg, [F.key]: p.g };
      await ensureSim(cfg);
      p.label = F.label(p.g); p.ev = evaluate(cfg);
    }
    if (!live.length) continue;
    live.forEach(p => { p.stable = neighbors(F.key, live, p).every(q => q.ev.dAll > 0); judge(p); });
    live.sort((x, y) => (y.pass - x.pass) || (y.ev.dAll - x.ev.dAll));
    out.push({ key: F.key, title: F.title, target: F.target, best: live[0], all: live });
  }
  return out;
}
async function stack(cands) {
  const order = cands.filter(c => c.best.ev.dAll > 0).sort((a, b) => b.best.ev.dAll - a.best.ev.dAll);
  if (order.length < 2) return null;
  let cfg = { ...L.baseCfg }, cur = null, stable = true; const used = [];
  for (const c of order) {
    const pre = cur ? cur.dAll : 0; let best = null;
    for (const p of c.all) {
      const cf = { ...cfg, [c.key]: p.g }; await ensureSim(cf);
      const ev = evaluate(cf);
      if (ev.dAll > pre && ev.dA > 0 && ev.dB > 0 && (!best || ev.dAll > best.ev.dAll)) best = { p, ev };
    }
    if (!best) continue;
    let st = true;
    for (const q of neighbors(c.key, c.all, best.p)) {
      const cf = { ...cfg, [c.key]: q.g }; await ensureSim(cf);
      if (evaluate(cf).dAll <= pre) { st = false; break; }
    }
    cfg = { ...cfg, [c.key]: best.p.g }; cur = best.ev; stable = stable && st; used.push({ c, p: best.p });
  }
  if (used.length < 2) return null;
  const p = { g: null, ev: cur, stable, label: used.map(u => u.p.label).join(' + ') };
  judge(p);
  return { key: 'combo', title: '조합 (순차 누적)', target: [...new Set(used.map(u => u.c.target))].join(' + '), best: p, all: [p] };
}
/* ───────── 진단 요약 ───────── */
const FEATS = [['rise', '진입 시 전일종가 대비 상승', '%'], ['cum', '진입까지 누적대금', '억'], ['spike', '진입 직전 급등봉', '%'],
  ['wick', '진입봉 윗꼬리', '%'], ['overLine', '기준선 위 진입 거리', '%'], ['tmin', '진입 시각(09:00 이후)', '분'], ['early', '조기진입 비율', '%']];
function diag() {
  const grp = name => L.recs.filter((r, i) => L.cls[i] === name && r.ok).map(r => r.f);
  const bad = grp('큰손절'), good = grp('수익');
  const val = (f, k) => k === 'early' ? (f.path === '조기' ? 100 : 0) : k === 'tmin' ? (+f.time.slice(0, 2) * 60 + +f.time.slice(2, 4) - 540) : f[k];
  const st = (arr, k) => {
    const v = arr.map(f => val(f, k)).filter(Number.isFinite), n = v.length || 1;
    const m = v.reduce((s, x) => s + x, 0) / n;
    return { m, sd: Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / n) };
  };
  return FEATS.map(([k, nm, u]) => {
    const a = st(bad, k), b = st(good, k);
    return { nm, u, a: a.m, b: b.m, es: (a.m - b.m) / (Math.sqrt((a.sd ** 2 + b.sd ** 2) / 2) || 1) };
  }).sort((x, y) => Math.abs(y.es) - Math.abs(x.es));
}
function renderSum() {
  const b = L.bAll, g = {};
  L.recs.forEach((r, i) => { const c = L.cls[i]; if (c) (g[c] = g[c] || []).push({ r, x: L.baseRes[i] }); });
  const big = g['큰손절'] || [], hm = g['고MFE저수익'] || [];
  const avg = (a, fn) => a.length ? a.reduce((s, y) => s + fn(y), 0) / a.length : 0;
  const line = z => `${esc(z.nm)}: 큰 손절 평균 <b>${z.a.toFixed(1)}${z.u}</b> · 수익거래 평균 <b>${z.b.toFixed(1)}${z.u}</b>`;
  $('lb-sum').innerHTML = `<div class="box"><b>기준 ${esc(L.baseName)}</b> · ${esc(cfgText(L.baseCfg))} · ${L.dates[0]}~${L.dates[L.dates.length - 1]} (${L.dates.length}일)<br>
    ${b.n}건 · 순익 ${fp(b.sum)} (앞 ${fp(L.bA)} / 뒤 ${fp(L.bB)}) · 승률 ${b.win.toFixed(1)}% · PF ${f2(b.pf)}<br>
    문제 거래: <b>큰 손절 ${big.length}건</b> 합 ${fp(big.reduce((s, y) => s + y.x.net, 0))} ·
    <b>고MFE 저수익 ${hm.length}건</b> (진입 후 최고 평균 +${avg(hm, y => y.r.f.mfe).toFixed(1)}% → 실현 평균 ${fp(avg(hm, y => y.x.pnl))})
    <details open><summary class="hint">큰 손절이 수익거래와 다른 점 (진입 시점에 알 수 있던 값, 차이 큰 순)</summary>${diag().map(line).join('<br>')}</details></div>`;
}

/* ───────── 후보 표 · 거래별 변화 ───────── */
function renderCands() {
  let h = `<p><b>처방 후보 · ${esc(L.baseName)} 대비</b> <span class="hint">행을 누르면 거래별 변화가 나옵니다.</span></p>
  <table><tr><th class="l">처방</th><th class="l">대상</th><th class="l">내용 (가장 나은 값)</th><th>순익 변화</th><th>앞 / 뒤</th><th>거래 · 승률 · PF</th><th>개선액 / 훼손액</th><th class="l">판정</th></tr>`;
  L.show.forEach((c, k) => {
    const p = c.best, e = p.ev, cl = p.verdict === '추천' ? 'ok' : p.verdict === '보류' ? 'warn' : 'bad';
    const good = c.all.filter(q => q.ev.dAll > 0).length;
    h += `<tr class="click" data-k="${k}"><td class="l">${esc(c.title)}</td><td class="l">${esc(c.target)}</td><td class="l">${esc(p.label)}</td>
      <td>${fp(e.dAll)}</td><td>${fp(e.dA)} / ${fp(e.dB)}</td><td>${e.all.n} (일반 ${e.nN}·조기 ${e.nE}) · ${e.all.win.toFixed(1)}% · ${f2(e.all.pf)}</td>
      <td>+${e.gain.toFixed(1)} / −${e.loss.toFixed(1)}</td><td class="l"><b class="${cl}">${p.verdict}</b> <span class="mut">${esc(p.why)}${c.all.length > 1 ? ` · 시험 ${c.all.length}개 중 개선 ${good}개` : ''}</span></td></tr>`;
  });
  $('lb-cands').innerHTML = h + '</table>';
  $('lb-cands').querySelectorAll('tr.click').forEach(tr => tr.addEventListener('click', () => renderDetail(+tr.dataset.k)));
}
function renderDetail(k) {
  const c = L.show[k], p = c.best, e = p.ev;
  const ch = e.changes.slice().sort((a, b) => b.dd - a.dd), up = ch.filter(x => x.dd > 0), dn = ch.filter(x => x.dd < 0);
  const cell = (inn, v) => inn ? fp(v) : '<span class="mut">미진입</span>';
  let h = `<div class="box"><b>${esc(p.label)}</b> · ${esc(L.baseName)} 대비 ${fp(e.dAll)} · 좋아진 거래 ${up.length}건 ${fp(sumOf(up, 'dd'))} · 나빠진 거래 ${dn.length}건 ${fp(sumOf(dn, 'dd'))}
    &nbsp; <button class="sub" id="lb-freeze">이 처방 박제</button> <button class="sub" id="lb-again">이 처방을 기준으로 다시 개선</button></div>
    <div class="scroll" style="max-height:45vh"><table><tr><th class="l">날짜</th><th class="l">종목</th><th class="l">분류</th><th>기준 손익</th><th>새 손익</th><th>변화</th><th class="l">사유</th></tr>`;
  for (const x of ch) {
    const r = L.recs[x.i];
    h += `<tr class="click" data-i="${x.i}"><td class="l">${r.d.date}</td><td class="l">${esc(r.c.name)}</td><td class="l">${esc(x.cl || '-')}</td>
      <td>${cell(x.bIn, x.bn)}</td><td>${cell(x.xIn, x.nn)}</td><td>${fp(x.dd)}</td><td class="l">${esc(x.why)}</td></tr>`;
  }
  $('lb-detail').innerHTML = h + '</table></div>';
  $('lb-freeze').addEventListener('click', () => freeze(c));
  $('lb-again').addEventListener('click', () => again(c));
  $('lb-detail').querySelectorAll('tr.click').forEach(tr => tr.addEventListener('click', () => {
    const i = +tr.dataset.i, r = L.recs[i], cfg = e.cfg, vr = recsFor(cfg)[i];
    if (window.S4X) window.S4X.setVariant({ key: r.d.key + '|' + r.c.code, name: p.label,
      baseEA: eaOf(L.baseCfg.early), newEA: eaOf(cfg.early), rec: vr, res: applyCfg(vr, cfg),
      baseRec: r, baseRes: L.baseRes[i] });
    try { T.openChart(r.d.key, r.c.code, L.P); T.showTab('chart'); }
    catch (err) { console.warn(err); alert('차트를 열지 못했습니다. 2 실험 탭에서 실험을 한 번 실행한 뒤 다시 눌러 주세요.'); }
  }));
}

/* ───────── 박제 · 반복 ───────── */
function freeze(c) {
  const p = c.best, e = p.ev, id = `S4.3-L${L.versions.length + 1}`;
  const v = { id, parent: L.baseName, cfg: e.cfg, text: cfgText(e.cfg), verdict: p.verdict, why: p.why, mode: L.mode, sha: S.sha, lab: LAB_VER,
    period: `${L.dates[0]}~${L.dates[L.dates.length - 1]}`, days: L.dates.length,
    common: { N0: L.P.N0, macd: L.P.macd, cumGate: L.P.cumGate, minCum: L.P.minCum, hardStop: L.P.hardStop, cost: L.P.cost, stop: '봉종가' },
    result: { n: e.all.n, sum: +e.all.sum.toFixed(2), win: +e.all.win.toFixed(1), pf: e.all.pf === Infinity ? null : +e.all.pf.toFixed(2),
              vsParent: +e.dAll.toFixed(2), front: +e.dA.toFixed(2), back: +e.dB.toFixed(2), fixed: e.fixed, broken: e.broken,
              gain: e.gain, loss: e.loss, normal: e.nN, early: e.nE },
    criteria: { ...L.Q },
    createdAt: new Date().toISOString() };
  L.versions.push(v);
  localStorage.setItem('s4lab.versions', JSON.stringify(L.versions));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(v, null, 2)], { type: 'application/json' }));
  a.download = `${id}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  renderVers();
}
function again(c) {
  const cfg = c.best.ev.cfg, saved = L.versions.find(v => JSON.stringify(v.cfg) === JSON.stringify(cfg));
  L.baseCfg = { ...cfg };
  L.baseName = saved ? saved.id : `${L.baseName} + ${c.best.label}`;
  $('lb-basecfg').textContent = cfgText(L.baseCfg);
  run();
}
function renderVers() {
  const el = $('lb-vers'); if (!el) return;
  if (!L.versions.length) { el.innerHTML = '<span class="hint">아직 박제한 버전이 없습니다.</span>'; return; }
  el.innerHTML = `<table><tr><th class="l">버전</th><th class="l">기준</th><th class="l">처방</th><th>거래</th><th>순익</th><th>기준 대비</th><th class="l">기간</th><th class="l">판정</th><th class="l">계산</th><th></th></tr>` +
    L.versions.map((v, i) => `<tr><td class="l">${esc(v.id)}</td><td class="l">${esc(v.parent)}</td><td class="l">${esc(v.text)}</td><td>${v.result.n}</td>
      <td>${fp(v.result.sum)}</td><td>${fp(v.result.vsParent)}</td><td class="l">${esc(v.period)}</td><td class="l">${esc(v.verdict)}</td>
      <td class="l">${v.lab ? '재시뮬' : '<span class="mut">근사 포함</span>'}</td>
      <td><button class="sub" data-v="${i}">기준으로</button></td></tr>`).join('') + '</table>';
  el.querySelectorAll('button[data-v]').forEach(b => b.addEventListener('click', () => {
    const v = L.versions[+b.dataset.v];
    L.baseCfg = { ...v.cfg }; L.baseName = v.id; $('lb-basecfg').textContent = cfgText(L.baseCfg); run();
  }));
}

/* ───────── 실행 ───────── */
async function run() {
  if (L.busy) return;
  if (!S.ok) return alert('데이터 탭에서 재현검사를 통과해야 합니다.');
  const btn = $('lb-run'); btn.disabled = true; L.busy = true;
  try {
    const mode = $('lb-mode').value;
    const P = { ...T.params(), strat: 'S4.3', real: mode === 'real', gate: mode === 'gate', stopMode: 'close', surge: false };
    const days = T.usedDays();
    if (!days.length) { $('lb-prog').textContent = '데이터 탭에서 사용할 날짜를 선택하세요.'; return; }
    const key = JSON.stringify([mode, P.N0, P.macd, P.cumGate, P.minCum, P.hardStop, P.cost, P.K, days.map(d => [d.key, d.cases.length])]);
    L.P = P;
    if (key !== L.key) {
      L.days = days; L.dates = days.map(d => d.date); L.sims = new Map(); L.vOK = false;
      L.recs0 = await buildRecs(P, days, '원본 S4.3 판정');
      L.key = key;
    }
    await loadVariant();
    if (!L.vOK) {
      const chk = await simRecs({}, '변형 엔진 검사');
      const bad = chk.filter((r, i) => { const a = r.o, b = L.recs0[i].o;
        return a.entered !== b.entered || a.open !== b.open || a.idx !== b.idx || Math.abs((a.net || 0) - (b.net || 0)) > 1e-9; }).length;
      if (bad) throw new Error(`변형 엔진 검사 실패: 처방 없이 원본과 다른 거래 ${bad}건`);
      L.vOK = true;
    }
    await ensureSim(L.baseCfg);
    if (L.mode !== mode && !Object.keys(L.baseCfg).length) L.baseName = '';
    L.mode = mode;
    L.Q = { big: parseFloat($('lb-big').value) || -3, mfe: parseFloat($('lb-mfe').value) || 5,
            ratio: parseFloat($('lb-ratio').value) || 30, dmg: Number.isFinite(parseFloat($('lb-dmg').value)) ? Math.max(0, parseFloat($('lb-dmg').value)) : 50 };
    if (!L.baseName) L.baseName = mode === 'real' ? 'S4.3-R' : 'S4.3(게이트ON)';
    L.recs = recsFor(L.baseCfg);
    L.baseRes = L.recs.map(r => applyCfg(r, L.baseCfg));
    L.cls = L.recs.map((r, i) => classify(r, L.baseRes[i]));
    L.bAll = mets(L.baseRes);
    const h = halves(L.baseRes); L.bA = h.A; L.bB = h.B;
    renderSum();
    $('lb-prog').textContent = '처방 탐색 중…'; await tick();
    const cands = await search(), cb = await stack(cands);
    L.show = cb ? cands.concat(cb) : cands;
    renderCands();
    $('lb-detail').innerHTML = '';
    $('lb-prog').textContent = `완료 (${LAB_VER}) · 변형엔진 검사 ✓ · 재시뮬 ${L.sims.size}종 · 처방 값 ${cands.reduce((s, c) => s + c.all.length, 0)}개 시험`;
  } catch (err) {
    console.error(err);
    $('lb-prog').innerHTML = `<span class="bad">오류: ${esc(err.message)}</span>`;
  } finally { btn.disabled = false; L.busy = false; }
}

buildUI();
})();
