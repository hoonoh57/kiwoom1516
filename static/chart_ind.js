/* static/chart_ind.js — 차트진단 MACD 패널
   원본 app.js의 calcNormalizedMACD·calcDailyCumulativeAmount와 호출 파라미터를 소스에서 그대로 꺼내 쓴다.
   엔진에 넘긴 것과 같은 봉 배열(prep)로 계산하므로 판정값과 동일하다. */
(function () {
'use strict';
const T = window.S4T; if (!T) return;
const $ = id => document.getElementById(id);
const { S, esc } = T;
const hm = t => { const d = new Date(t * 1000); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const pc = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const won = v => v > 0 ? Math.round(v).toLocaleString() + '원' : '-';
const ok = b => b ? '<span class="ok">✔</span>' : '<span class="bad">✖</span>';
const X = { fn: null, prm: null, ea: [], chart: null, ser: null, lines: [], variant: null, sync: false, drawId: 0, map: new Map() };
const EA_IDX = { 'S4.1': 0, 'S4.2': 1, 'S4.3': 2 };

async function load() {
  if (X.fn) return;
  const response = await fetch('/static/app.js', { cache: 'no-store' });
  if (!response.ok) throw new Error('app.js 로드 실패 HTTP ' + response.status);
  const buf = await response.arrayBuffer();
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
  if (S.sha && sha !== S.sha) throw new Error('app.js가 튜너 로드 이후 바뀌었습니다. Ctrl+F5 하세요.');
  const src = new TextDecoder('utf-8').decode(buf);
  const seg = src.slice(src.indexOf('function evaluateStrategyTrade'));
  const m = seg.match(/calcNormalizedMACD\(\s*candles\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (!m) throw new Error('evaluateStrategyTrade 안에서 calcNormalizedMACD 호출을 찾지 못했습니다.');
  X.prm = [+m[1], +m[2], +m[3]];
  X.ea = [...seg.matchAll(/earlyAccelerationEnter\s*=\s*\(\s*isS4Setup\s*&&\s*bar\.time\s*<=\s*"(\d{4})"\s*&&\s*curCumAmtEok\s*>=\s*([\d.]+)\s*&&\s*curNormMACD\s*>=\s*([\d.]+)\s*\)/g)]
    .map(q => ({ on: true, t: q[1], cum: +q[2], macd: +q[3] }));
  const b0 = src.match(/\(\s*function\s*\(\s*\)\s*\{/), end = src.lastIndexOf('})');
  if (!b0 || end < 0) throw new Error('app.js 구조를 인식하지 못했습니다.');
  const noop = () => {};
  const fakeDoc = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, createElement: () => ({ style: {} }) };
  const fakeWin = { addEventListener: noop, LightweightCharts: null, innerWidth: 1000, innerHeight: 800 };
  X.fn = new Function('window', 'document', src.slice(b0.index + b0[0].length, end) +
    '\n;return { macd: calcNormalizedMACD, cum: calcDailyCumulativeAmount };')(fakeWin, fakeDoc);
}

function ensure() {
  if (X.chart) return;
  const host = $('chart');
  const wrap = document.createElement('div');
  wrap.innerHTML = '<div id="ci-head" class="hint" style="margin:6px 0 2px"></div><div id="ci-macd"></div>' +
                   '<div id="ci-hover" class="hint" style="margin:2px 0"></div><div id="ci-cond"></div>';
  host.insertAdjacentElement('afterend', wrap);
  const opt = { layout: { background: { type: 'solid', color: '#0b1220' }, textColor: '#d1d5db' },
    grid: { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } }, rightPriceScale: { minimumWidth: 90 },
    timeScale: { timeVisible: true, secondsVisible: false, tickMarkFormatter: t => hm(t) },
    localization: { timeFormatter: t => hm(t), priceFormatter: v => pc(v) } };
  S.chart.applyOptions({ rightPriceScale: { minimumWidth: 90 } });
  X.chart = LightweightCharts.createChart($('ci-macd'), { ...opt, width: host.clientWidth, height: 180 });
  X.ser = X.chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false,
    priceFormat: { type: 'custom', formatter: v => pc(v), minMove: 0.01 } });
  const a = S.chart.timeScale(), b = X.chart.timeScale();
  const link = (from, to) => from.subscribeVisibleLogicalRangeChange(r => { if (r && !X.sync) { X.sync = true; try { to.setVisibleLogicalRange(r); } finally { X.sync = false; } } });
  link(a, b); link(b, a);
  const hover = p => { const v = p && p.time != null ? X.map.get(p.time) : null;
    $('ci-hover').innerHTML = v ? `${hm(p.time)} · MACD <b>${pc(v.m)}</b> · 누적대금 <b>${v.cum.toFixed(1)}억</b> · 종가 ${won(v.close)}` : ''; };
  S.chart.subscribeCrosshairMove(hover); X.chart.subscribeCrosshairMove(hover);
  window.addEventListener('resize', () => X.chart.applyOptions({ width: host.clientWidth }));
}

// 한 봉에서 진입 조건 판정 (ST·JMA 셋업은 표시하지 않음)
function judgeAt(i, ea, P, base, bars, macd, cum) {
  const bar = bars[i], m = macd[i].value, cu = cum[i].value;
  const normal = !(P.real || P.gate) || (base > 0 && bar.close >= base);
  const gateM = m >= P.macd, gateC = !P.cumGate || cu >= P.minCum;
  const eT = ea && ea.on && bar.time <= ea.t, eC = ea && ea.on && cu >= ea.cum, eM = ea && ea.on && m >= ea.macd;
  const early = !!(ea && ea.on && eT && eC && eM);
  return { bar, m, cu, normal, gateM, gateC, eT, eC, eM, early, res: !gateC ? '진입 불가 (누적대금 문턱 미달)' : !gateM ? '진입 불가 (MACD 문턱 미달)' : normal ? '일반진입' : early ? '조기진입' : '진입 불가' };
}

function markersFor(rec, res) {
  if (!rec || !res || !res.entered) return [];
  const markers = rec.mk || [];
  if (res.exitTimestamp == null) return markers;
  return markers.filter(m => m.time < res.exitTimestamp).concat({ time: res.exitTimestamp,
    position: 'aboveBar', color: '#3b82f6', shape: 'arrowDown', text: `[이익보호 청산] ${won(res.exitPrice)}` });
}
async function onDraw({ d, c, P, bars, b, mk }) {
  const drawId = ++X.drawId, pending = X.variant;
  X.variant = null;
  try {
  await load();
  if (drawId !== X.drawId) return;
  ensure();
  $('ci-hover').innerHTML = '';
  if (!bars.length) { X.ser.setData([]); $('ci-cond').textContent = '봉 데이터 없음'; return; }
  const macd = X.fn.macd(bars, ...X.prm), cum = X.fn.cum(bars, d.date);
  const today = []; bars.forEach((x, i) => { if (x.date === d.date) today.push(i); });
  X.map = new Map(today.map(i => [bars[i].timestamp, { m: macd[i].value, cum: cum[i].value, close: bars[i].close }]));
  X.ser.setData(today.map(i => ({ time: bars[i].timestamp, value: macd[i].value, color: macd[i].value >= 0 ? '#ef4444' : '#3b82f6' })));

  const v = pending && pending.key === d.key + '|' + c.code ? pending : null;
  if (v && v.baseRec) {
    b = { o: v.baseRes.entered ? v.baseRec.o : { entered: false }, r: { basePrice: v.baseRec.basePrice } };
    mk = markersFor(v.baseRec, v.baseRes).map(m => ({ ...m, text: '기준 ' + m.text }));
  }
  const eaSrc = X.ea[EA_IDX[P.strat]] || null;
  const eaB = v && v.baseEA ? v.baseEA : eaSrc, eaN = v ? v.newEA : null;

  X.lines.forEach(l => X.ser.removePriceLine(l)); X.lines = [];
  const L = [{ p: P.macd, t: `진입문턱 ${P.macd}`, c: '#9ca3af' }];
  if (eaB && eaB.on) L.push({ p: eaB.macd, t: `조기 ${eaB.macd.toFixed(2)}`, c: '#f97316' });
  if (eaN && eaN.on && (!eaB || eaN.macd !== eaB.macd)) L.push({ p: eaN.macd, t: `새 조기 ${eaN.macd.toFixed(2)}`, c: '#a78bfa' });
  L.forEach(q => X.lines.push(X.ser.createPriceLine({ price: q.p, color: q.c, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: q.t })));

  const base = b.r ? b.r.basePrice : 0, bi = b.o.entered ? b.o.idx : -1;
  const vr = v ? v.rec : null, vi = vr && v.res.entered && vr.o.entered ? vr.o.idx : -1;
  const hm2 = [];
  if (bi >= 0) hm2.push({ time: bars[bi].timestamp, position: 'belowBar', color: '#facc15', shape: 'arrowUp', text: `박제 ${pc(macd[bi].value)}` });
  if (vi >= 0) hm2.push({ time: bars[vi].timestamp, position: 'aboveBar', color: '#a78bfa', shape: 'arrowDown', text: `새 ${pc(macd[vi].value)}` });
  X.ser.setMarkers(hm2.sort((x, y) => x.time - y.time));

  if (v && vr) {
    S.ser.c.setMarkers(mk.concat(markersFor(vr, v.res).map(m => ({ ...m, color: '#a78bfa', shape: m.position === 'belowBar' ? 'arrowUp' : 'circle', text: '새 ' + m.text })))
      .sort((x, y) => x.time - y.time));
  }

  $('ci-head').innerHTML = `<b>MACD 히스토그램</b> · 원본 app.js <code>calcNormalizedMACD(candles, ${X.prm.join(', ')})</code> ` +
    `= (EMA${X.prm[0]} − EMA${X.prm[1]} − 시그널${X.prm[2]}) ÷ 종가 × 100 · 계산 시작 ${bars[0].date} ${bars[0].time} (전일 봉 포함, ${esc(d.tf)} 종가)` +
    (eaSrc ? ` · 원본 ${esc(P.strat)} 조기예외: ${eaSrc.t.slice(0, 2)}:${eaSrc.t.slice(2)} 이전 · 누적 ${eaSrc.cum}억 · MACD ${eaSrc.macd.toFixed(2)}` : '');

  const cols = [{ name: `박제 ${P.strat}`, ea: eaB }].concat(v ? [{ name: '새 버전', ea: eaN }] : []);
  const at = [...new Set([bi, vi].filter(i => i >= 0))];
  let h = '';
  for (const i of at) {
    const J = cols.map(col => judgeAt(i, col.ea, P, base, bars, macd, cum)), j0 = J[0];
    const eaTxt = k => cols.map(col => col.ea && col.ea.on ? col.ea[k] : '꺼짐').join(' / ');
    h += `<table style="margin-top:6px"><tr><th class="l">${hm(bars[i].timestamp)} 봉 조건</th><th>값</th>${cols.map(x => `<th>${esc(x.name)}</th>`).join('')}</tr>
      <tr><td class="l">일반진입: 종가 ≥ 기준선 ${won(base)}</td><td>${won(j0.bar.close)}</td>${J.map(j => `<td>${ok(j.normal)}</td>`).join('')}</tr>
      <tr><td class="l">MACD ≥ 진입문턱 ${P.macd}</td><td>${pc(j0.m)}</td>${J.map(j => `<td>${ok(j.gateM)}</td>`).join('')}</tr>
      <tr><td class="l">공통 누적대금 ${P.cumGate ? `≥ ${P.minCum}억` : '필터 꺼짐'}</td><td>${j0.cu.toFixed(1)}억</td>${J.map(j => `<td>${ok(j.gateC)}</td>`).join('')}</tr>
      <tr><td class="l">조기: 시각 ≤ ${eaTxt('t')}</td><td>${j0.bar.time.slice(0, 2)}:${j0.bar.time.slice(2)}</td>${J.map(j => `<td>${ok(j.eT)}</td>`).join('')}</tr>
      <tr><td class="l">조기: 누적대금 ≥ ${eaTxt('cum')}억</td><td>${j0.cu.toFixed(1)}억</td>${J.map(j => `<td>${ok(j.eC)}</td>`).join('')}</tr>
      <tr><td class="l">조기: MACD ≥ ${eaTxt('macd')}</td><td>${pc(j0.m)}</td>${J.map(j => `<td>${ok(j.eM)}</td>`).join('')}</tr>
      <tr><td class="l"><b>표시 조건 판정</b> (ST·JMA·진입 시간창 등은 별도)</td><td></td>${J.map(j => `<td><b>${j.res}</b></td>`).join('')}</tr></table>`;
    if (i === bi && !j0.normal && !j0.early) h += `<div class="bad">⚠ 원본은 이 봉에서 진입했는데 패널 계산으로는 조건 미충족 → 계산 불일치, 캡처해 주세요</div>`;
  }
  if (v) h += `<div class="hint">새 버전 (${esc(v.name)}): ${v.res.entered ? (v.res.open ? '미청산' : `진입 ${vi >= 0 ? hm(bars[vi].timestamp) : '-'} · 손익 ${pc(v.res.net)}`) : '미진입'}${v.res.why ? ' · ' + esc(v.res.why) : ''}</div>`;
  $('ci-cond').innerHTML = h || '<div class="hint">진입 없음</div>';
  const range = S.chart.timeScale().getVisibleLogicalRange();
  if (range) X.chart.timeScale().setVisibleLogicalRange(range);
  } catch (e) {
    if (drawId !== X.drawId) return;
    ensure(); X.map.clear(); X.ser.setData([]); X.ser.setMarkers([]);
    X.lines.forEach(l => X.ser.removePriceLine(l)); X.lines = [];
    $('ci-hover').innerHTML = ''; $('ci-cond').innerHTML = '';
    $('ci-head').innerHTML = `<span class="bad">MACD 패널: ${esc(e.message)}</span>`;
  }
}

window.S4X = { onDraw, setVariant: v => { X.variant = v; } };
})();
