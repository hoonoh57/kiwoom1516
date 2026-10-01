// JSON-lines oracle. Only the S4.3 early-entry expression is varied in memory.
// The frozen app.js on disk is never modified. No browser or brokerage APIs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
const hash = crypto.createHash('sha256').update(source).digest('hex');
if (hash !== 'ade2280a11378e90a9fa7fb15a8ba7947d9259029df91009492d2ae82ddad368') throw new Error('Frozen app.js SHA-256 mismatch');
const needle = /let\s+earlyAccelerationEnter\s*=\s*\(\s*isS4Setup\s*&&\s*bar\.time\s*<=\s*"0912"\s*&&\s*curCumAmtEok\s*>=\s*15\.0\s*&&\s*curNormMACD\s*>=\s*0\.20\s*\)\s*;/g;
const matches = [...source.matchAll(needle)];
if (matches.length !== 2) throw new Error('Expected S4.2 and S4.3 early-entry expressions');
const h = matches[1];
const variant = source.slice(0, h.index) + 'let earlyAccelerationEnter = (E.early_enabled && isS4Setup && bar.time <= E.early_until && curCumAmtEok >= E.early_cum_eok && curNormMACD >= E.early_macd);' + source.slice(h.index + h[0].length);
const noop = () => {};
const doc = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop };
const E = {};
function load(s) {
  const m = s.match(/\(\s*function\s*\(\s*\)\s*\{/);
  return new Function('window', 'document', 'E', s.slice(m.index + m[0].length, s.lastIndexOf('})')) + '\nreturn { evaluateStrategyTrade, calcVWAP, calcJMADualSegments, calcSupertrendSingleLineSegments, calcNormalizedMACD, calcDailyCumulativeAmount };')({ addEventListener: noop }, doc, E);
}
const original = load(source), changed = load(variant);
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  try {
    const req = JSON.parse(line), c = req.config, bars = req.candles;
    Object.assign(E, { early_enabled: true, early_until: '0912', early_cum_eok: 15, early_macd: .2 }, c);
    const api = req.original ? original : changed;
    const r = api.evaluateStrategyTrade(bars, 'S4.3', c.target_date, c.base_rate_pct ?? 5.5, c.macd_threshold ?? .15,
      c.apply_mfe_gate ?? true, req.official_mfe ?? null, c.apply_cum_gate ?? true, c.min_cum_eok ?? 3, c.hard_stop_pct ?? -3);
    const byTime = new Map(bars.map(b => [b.timestamp, b]));
    let partials = 0;
    const events = r.markers.map(m => {
      const kind = m.position === 'belowBar' ? 'entry' : /30%익절/.test(m.text) ? 'partial' : 'exit';
      const fraction = kind === 'entry' ? 1 : kind === 'partial' ? .3 : 1 - .3 * partials;
      if (kind === 'partial') partials++;
      const reason = kind === 'exit' ? r.exitReason : kind === 'entry' ? 'S4.3진입' : m.text.match(/\[(.*?)\]/)[1];
      return { kind, time: m.time, price: byTime.get(m.time).close, fraction, reason };
    });
    const result = { entered: r.entered, pnl: r.pnl, entryTime: r.entryTime, exitReason: r.exitReason,
      entryTimestamp: events.find(e => e.kind === 'entry')?.time ?? null,
      exitTimestamp: events.find(e => e.kind === 'exit')?.time ?? null,
      basePrice: r.basePrice, entryStartIdx: r.entryStartIdx, events };
    if (req.indicators && bars.length) {
      const st = api.calcSupertrendSingleLineSegments(bars, 14, 2);
      result.indicators = { vwap: api.calcVWAP(bars).map(x => x.value), jma: Array.from(api.calcJMADualSegments(bars, 7, 0, 2).rawJMA),
        trend: Array.from(st.rawTrend), atr: Array.from(st.rawATR), macd: api.calcNormalizedMACD(bars, 5, 13, 4).map(x => x.value),
        cum: api.calcDailyCumulativeAmount(bars, c.target_date).map(x => x.value) };
    }
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ error: error.stack }) + '\n'); }
});
