/* static/improve_lab.js — S4.3 개선 Lab (6번 탭)
   1) 원본 app.js 판정은 tuner.js의 evalCase로 한 번만 돌리고, 처방은 그 결과 위에서만 적용한다.
   2) 진입 처방은 원본 진입을 막기만 한다. 막힌 종목은 그날 재진입하지 않는다(실험 탭 급등필터와 같은 규칙).
   3) 청산 처방은 원본의 첫 익절·청산 이전 봉에서만, 봉종가로 판정한다.
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

/* ───────── 처방 목록 (대상 문제별 옵션과 시험 범위) ───────── */
const FAM = [
  { key: 'early', title: '조기진입 제한', target: '큰 손절',
    grids: [[{ t: 'off' }], ['0906', '0908', '0910'].map(v => ({ t: 'time', v })), [20, 30, 40, 50].map(v => ({ t: 'cum', v }))],
    label: g => g.t === 'off' ? '조기가속 진입 끄기' : g.t === 'time' ? `조기진입은 ${HM(g.v)}까지만 허용` : `조기진입은 누적대금 ${g.v}억 이상만 허용` },
  { key: 'rise', title: '추격 상한', target: '큰 손절',
    grids: [[8, 10, 12, 14, 16, 18, 20, 22, 25]],
    label: v => `진입 시 전일종가 대비 +${v}% 넘으면 진입 안 함` },
  { key: 'trail', title: '이익보호 트레일', target: '고MFE 저수익',
    grid2: { a: [3, 4, 5, 6, 8], b: [1.5, 2, 3, 4] },
    label: g => `+${g.a}% 도달 후 최고가 대비 -${g.b}% 아래 종가면 청산` }
];
const cfgText = cfg => {
  const t = FAM.filter(F => cfg[F.key] != null).map(F => F.label(cfg[F.key]));
  return t.length ? t.join(' + ') : '처방 없음 (원본 그대로)';
};

/* ───────── 화면 ───────── */
function buildUI() {
  const sec = $('t-lab'); if (!sec) return;
  sec.innerHTML = `
<fieldset><legend>기준 버전과 문제 거래 기준</legend>
 <div class="row">
  <label>기준 <select id="lb-mode"><option value="real">S4.3 실전모드 (S4.3-R)</option><option value="gate">S4.3 1516 게이트 ON (참고)</option></select></label>
  <label>큰 손절: 순손익 ≤ <input type="number" id="lb-big" value="-3" step="0.5">%</label>
  <label>고MFE 저수익: 진입 후 최고 ≥ <input type="number" id="lb-mfe" value="5" step="0.5">% 인데 실현 &lt; 그 <input type="number" id="lb-ratio" value="30" step="5">%</label>
 </div>
 <div class="row" style="margin-top:6px">
  <button class="act" id="lb-run">진단·탐색 실행</button>
  <button class="sub" id="lb-reset">기준을 S4.3로 되돌리기</button>
  <span id="lb-prog" class="hint"></span>
 </div>
 <div class="hint">MACD·누적대금·하드스탑·비용은 2 실험 탭 설정을 그대로 씁니다. 손절은 봉종가 기준입니다. 현재 기준 처방: <b id="lb-basecfg">없음</b></div>
</fieldset>
<div id="lb-sum"></div>
<div id="lb-cands"></div>
<div id="lb-detail"></div>
<fieldset><legend>박제 기록</legend><div id="lb-vers"></div></fieldset>`;
  $('lb-run').addEventListener('click', run);
  $('lb-reset').addEventListener('click', () => { L.baseCfg = {}; L.baseName = ''; $('lb-basecfg').textContent = '없음'; run(); });
  renderVers();
}

/* ───────── 원본 판정 1회 + 진입 시점 특징 ───────── */
async function build(P, days) {
  const half = Math.ceil(days.length / 2), A = new Set(days.slice(0, half).map(d => d.key));
  L.recs = []; L.dates = days.map(d => d.date);
  const tot = days.reduce((s, d) => s + d.cases.length, 0);
  let k = 0;
  for (const d of days) for (const c of d.cases) {
    const e = T.evalCase(d, c, P, 'capture', P.N0);
    const rec = { d, c, o: e.o, half: A.has(d.key) ? 'A' : 'B', ok: false };
    if (e.o.entered && !e.o.open && e.o.idx >= 0 && e.o.entryPrice > 0) feat(rec, e);
    L.recs.push(rec);
    if (++k % 25 === 0) { $('lb-prog').textContent = `원본 S4.3 판정 ${k}/${tot}…`; await tick(); }
  }
}
function feat(rec, e) {
  const { bars, r } = e, o = rec.o, i0 = o.idx, b0 = bars[i0], date = rec.d.date, ep = o.entryPrice;
  const mk = (r && r.markers) || [];
  const downs = mk.filter(m => m.shape === 'arrowDown');
  const exitTs = downs.length ? downs[downs.length - 1].time : Infinity;
  const tp = mk.find(m => /익절/.test(m.text || ''));
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
  rec.bars = bars; rec.i0 = i0; rec.limTs = Math.min(exitTs, tp ? tp.time : Infinity); rec.ok = true;
}

/* ───────── 처방 적용 ───────── */
function applyCfg(rec, cfg) {
  const o = rec.o, cost = L.P.cost;
  if (!o.entered) return { entered: false, why: '' };
  if (o.open || !rec.ok) return { entered: true, open: o.open, net: o.net, pnl: o.pnl, stop: o.stop, why: '' };
  const f = rec.f;
  const g = cfg.early;
  if (g && f.path === '조기' && (g.t === 'off' || (g.t === 'time' && f.time > g.v) || (g.t === 'cum' && f.cum < g.v)))
    return { entered: false, why: `조기진입 차단 (${HM(f.time)}, 누적 ${f.cum.toFixed(0)}억)` };
  if (cfg.rise != null && f.rise != null && f.rise > cfg.rise)
    return { entered: false, why: `추격 차단 (전일 대비 +${f.rise.toFixed(1)}%)` };
  let res = { entered: true, open: false, net: o.net, pnl: o.pnl, stop: o.stop, why: '' };
  if (cfg.trail) {
    const { a, b } = cfg.trail, ep = o.entryPrice, bars = rec.bars, date = rec.d.date;
    let hi = -Infinity;
    for (let i = rec.i0 + 1; i < bars.length && bars[i].date === date && bars[i].timestamp < rec.limTs; i++) {
      hi = Math.max(hi, +bars[i].high);
      if (hi >= ep * (1 + a / 100) && +bars[i].close <= hi * (1 - b / 100)) {
        const pnl = (+bars[i].close / ep - 1) * 100;
        res = { entered: true, open: false, pnl, net: pnl - cost, stop: false, why: `이익보호 청산 ${HM(bars[i].time)}` };
        break;
      }
    }
  }
  return res;
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
  const res = L.recs.map(r => applyCfg(r, cfg)), all = mets(res), h = halves(res);
  let fixed = 0, broken = 0; const changes = [];
  res.forEach((x, i) => {
    const b = L.baseRes[i], bIn = b.entered && !b.open, xIn = x.entered && !x.open;
    if (!bIn && !xIn) return;
    const bn = bIn ? b.net : 0, nn = xIn ? x.net : 0, dd = nn - bn;
    if (Math.abs(dd) < 1e-6) return;
    const cl = L.cls[i];
    if (dd > 0 && (cl === '큰손절' || cl === '고MFE저수익')) fixed++;
    if (dd < 0 && bn > 0) broken++;
    changes.push({ i, bn, nn, dd, bIn, xIn, why: x.why || '', cl });
  });
  return { cfg, all, dA: h.A - L.bA, dB: h.B - L.bB, dAll: all.sum - L.bAll.sum, fixed, broken, changes };
}

/* ───────── 탐색과 판정 ───────── */
const dist = (a, b) => a.slice(1).reduce((s, v, i) => s + Math.abs(v - b[i + 1]), 0);
function judge(p) {
  const e = p.ev, why = [];
  if (e.dA <= 0) why.push('앞 기간 악화');
  if (e.dB <= 0) why.push('뒤 기간 악화');
  if (e.fixed < 3) why.push(`고친 문제거래 ${e.fixed}건`);
  if (e.broken > e.fixed / 3) why.push(`수익거래 훼손 ${e.broken}건`);
  if (!p.stable) why.push('주변값에서 효과 사라짐');
  p.pass = why.length ? 0 : 1;
  p.verdict = e.dAll <= 0 ? '기각' : p.pass ? '추천' : '보류';
  p.why = e.dAll <= 0 ? '전체 순익 개선 없음' : p.pass ? '4개 조건 통과' : why.join(', ');
}
function search() {
  return FAM.map(F => {
    const pts = [];
    if (F.grid2) F.grid2.a.forEach((a, ia) => F.grid2.b.forEach((b, ib) => pts.push({ g: { a, b }, pos: [0, ia, ib] })));
    else F.grids.forEach((list, gi) => list.forEach((g, j) => pts.push({ g, pos: [gi, j] })));
    pts.forEach(p => { p.label = F.label(p.g); p.ev = evaluate({ ...L.baseCfg, [F.key]: p.g }); });
    pts.forEach(p => {
      p.stable = pts.filter(q => q.pos[0] === p.pos[0] && dist(p.pos, q.pos) === 1).every(q => q.ev.dAll > 0);
      judge(p);
    });
    pts.sort((x, y) => (y.pass - x.pass) || (y.ev.dAll - x.ev.dAll));
    return { key: F.key, title: F.title, target: F.target, best: pts[0], all: pts };
  });
}
function combo(cands) {
  const ok = cands.filter(c => c.best.verdict === '추천').sort((a, b) => b.best.ev.dAll - a.best.ev.dAll);
  if (ok.length < 2) return null;
  let cfg = { ...L.baseCfg }, cur = null; const used = [];
  for (const c of ok) {
    const tryCfg = { ...cfg, [c.key]: c.best.g }, ev = evaluate(tryCfg);
    if (!cur || (ev.dAll > cur.dAll && ev.dA > 0 && ev.dB > 0)) { cfg = tryCfg; cur = ev; used.push(c); }
  }
  if (used.length < 2) return null;
  const p = { g: null, ev: cur, stable: used.every(c => c.best.stable), label: used.map(c => c.best.label).join(' + ') };
  judge(p);
  return { key: 'combo', title: '조합', target: [...new Set(used.map(c => c.target))].join(' + '), best: p, all: [p] };
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
    <details><summary class="hint">큰 손절이 수익거래와 다른 점 (진입 시점에 알 수 있던 값, 차이 큰 순)</summary>${diag().map(line).join('<br>')}</details></div>`;
}

/* ───────── 후보 표 · 거래별 변화 ───────── */
function renderCands() {
  let h = `<p><b>처방 후보 · ${esc(L.baseName)} 대비</b> <span class="hint">행을 누르면 거래별 변화가 나옵니다.</span></p>
  <table><tr><th class="l">처방</th><th class="l">대상</th><th class="l">내용 (가장 나은 값)</th><th>순익 변화</th><th>앞 / 뒤</th><th>거래 · 승률 · PF</th><th>고친 / 망친</th><th class="l">판정</th></tr>`;
  L.show.forEach((c, k) => {
    const p = c.best, e = p.ev, cl = p.verdict === '추천' ? 'ok' : p.verdict === '보류' ? 'warn' : 'bad';
    const good = c.all.filter(q => q.ev.dAll > 0).length;
    h += `<tr class="click" data-k="${k}"><td class="l">${esc(c.title)}</td><td class="l">${esc(c.target)}</td><td class="l">${esc(p.label)}</td>
      <td>${fp(e.dAll)}</td><td>${fp(e.dA)} / ${fp(e.dB)}</td><td>${e.all.n} · ${e.all.win.toFixed(1)}% · ${f2(e.all.pf)}</td>
      <td>${e.fixed} / ${e.broken}</td><td class="l"><b class="${cl}">${p.verdict}</b> <span class="mut">${esc(p.why)}${c.all.length > 1 ? ` · 시험 ${c.all.length}개 중 개선 ${good}개` : ''}</span></td></tr>`;
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
    const r = L.recs[+tr.dataset.i];
    try { T.openChart(r.d.key, r.c.code, L.P); T.showTab('chart'); }
    catch (err) { console.warn(err); alert('차트를 열지 못했습니다. 2 실험 탭에서 실험을 한 번 실행한 뒤 다시 눌러 주세요.'); }
  }));
}

/* ───────── 박제 · 반복 ───────── */
function freeze(c) {
  const p = c.best, e = p.ev, id = `S4.3-L${L.versions.length + 1}`;
  const v = { id, parent: L.baseName, cfg: e.cfg, text: cfgText(e.cfg), verdict: p.verdict, why: p.why, mode: L.mode, sha: S.sha,
    period: `${L.dates[0]}~${L.dates[L.dates.length - 1]}`, days: L.dates.length,
    common: { N0: L.P.N0, macd: L.P.macd, cumGate: L.P.cumGate, minCum: L.P.minCum, hardStop: L.P.hardStop, cost: L.P.cost, stop: '봉종가' },
    result: { n: e.all.n, sum: +e.all.sum.toFixed(2), win: +e.all.win.toFixed(1), pf: e.all.pf === Infinity ? null : +e.all.pf.toFixed(2),
              vsParent: +e.dAll.toFixed(2), front: +e.dA.toFixed(2), back: +e.dB.toFixed(2), fixed: e.fixed, broken: e.broken },
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
  el.innerHTML = `<table><tr><th class="l">버전</th><th class="l">기준</th><th class="l">처방</th><th>거래</th><th>순익</th><th>기준 대비</th><th class="l">기간</th><th class="l">판정</th><th></th></tr>` +
    L.versions.map((v, i) => `<tr><td class="l">${esc(v.id)}</td><td class="l">${esc(v.parent)}</td><td class="l">${esc(v.text)}</td><td>${v.result.n}</td>
      <td>${fp(v.result.sum)}</td><td>${fp(v.result.vsParent)}</td><td class="l">${esc(v.period)}</td><td class="l">${esc(v.verdict)}</td>
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
    if (key !== L.key) { await build(P, days); L.key = key; }
    if (L.mode !== mode && !Object.keys(L.baseCfg).length) L.baseName = '';
    L.mode = mode;
    L.Q = { big: parseFloat($('lb-big').value) || -3, mfe: parseFloat($('lb-mfe').value) || 5, ratio: parseFloat($('lb-ratio').value) || 30 };
    if (!L.baseName) L.baseName = mode === 'real' ? 'S4.3-R' : 'S4.3(게이트ON)';
    L.baseRes = L.recs.map(r => applyCfg(r, L.baseCfg));
    L.cls = L.recs.map((r, i) => classify(r, L.baseRes[i]));
    L.bAll = mets(L.baseRes); const h = halves(L.baseRes); L.bA = h.A; L.bB = h.B;
    renderSum();
    $('lb-prog').textContent = '처방 탐색 중…'; await tick();
    const cands = search(), cb = combo(cands);
    L.show = cb ? cands.concat(cb) : cands;
    renderCands();
    $('lb-detail').innerHTML = '';
    $('lb-prog').textContent = `완료 · 처방 값 ${cands.reduce((s, c) => s + c.all.length, 0)}개 시험`;
  } catch (err) {
    console.error(err);
    $('lb-prog').innerHTML = `<span class="bad">오류: ${esc(err.message)}</span>`;
  } finally { btn.disabled = false; L.busy = false; }
}

buildUI();
})();
