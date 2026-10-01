"""Run: python -m unittest discover -s tests -p test_s43r_engine.py -v

Golden data are local-only. Missing data are an explicit skip, not a parity pass.
"""
import copy
from dataclasses import asdict, replace
import hashlib
import json
import os
from pathlib import Path
import subprocess
import unittest

from s43r_engine import SOURCE_SHA256, StrategyConfig, S43REngine, evaluate

ROOT = Path(__file__).resolve().parents[1]


class Parity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        env = dict(os.environ, TZ='Asia/Seoul')
        cls.node = subprocess.Popen(['node', str(ROOT / 'scripts/s43r_oracle.cjs')],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', env=env)

    @classmethod
    def tearDownClass(cls):
        cls.node.stdin.close()
        cls.node.wait(timeout=10)
        errors = cls.node.stderr.read()
        cls.node.stdout.close(); cls.node.stderr.close()
        if cls.node.returncode:
            raise AssertionError(errors)

    def oracle(self, bars, cfg, official_mfe=None, **extra):
        self.node.stdin.write(json.dumps(dict(candles=bars, config=asdict(cfg), official_mfe=official_mfe, **extra)) + '\n')
        self.node.stdin.flush()
        line = self.node.stdout.readline()
        self.assertTrue(line, 'JS oracle exited unexpectedly')
        obj = json.loads(line)
        self.assertNotIn('error', obj, obj.get('error'))
        return obj

    def assert_result(self, actual, expected):
        for k in ('entered', 'entryTime', 'exitReason', 'entryTimestamp', 'exitTimestamp', 'entryStartIdx'):
            self.assertEqual(actual[k], expected[k], k)
        self.assertAlmostEqual(actual['basePrice'], expected['basePrice'], places=8)
        self.assertAlmostEqual(actual['pnl'], expected['pnl'], places=9)
        self.assertEqual(f"{actual['pnl']:.4f}", f"{expected['pnl']:.4f}")
        self.assertEqual(len(actual['events']), len(expected['events']))
        for a, b in zip(actual['events'], expected['events']):
            for k in ('kind', 'time', 'price', 'reason'):
                self.assertEqual(a[k], b[k], k)
            self.assertAlmostEqual(a['fraction'], b['fraction'], places=14)

    def test_frozen_source(self):
        self.assertEqual(hashlib.sha256((ROOT / 'static/app.js').read_bytes()).hexdigest(), SOURCE_SHA256)

    def test_golden_matrix(self):
        paths = [p for p in sorted((ROOT / 'data').glob('strategy-audit-*-T-360.json'))
                 if '20260831' <= p.name[15:23] <= '20260929']
        if not paths:
            self.skipTest('Golden Set absent: local data/ audit files required')
        self.assertEqual(len(paths), 20, 'Incomplete Golden Set: require all 20 daily files')
        comparisons = cases = 0
        totals = {}
        reason_counts = {}
        seeds = []
        for p in paths:
            for day in json.loads(p.read_text(encoding='utf-8'))['days']:
                date = day['settings']['targetDate']
                for item in day['cases']:
                    bars = item['candles']; cases += 1
                    seeds.append(sum(b['date'] < date for b in bars))
                    for enabled in (True, False):
                        for macd in (.2, .3):
                            cfg = StrategyConfig(date, early_enabled=enabled, early_macd=macd)
                            with self.subTest(date=date, code=item['code'], early=enabled, macd=macd):
                                actual = evaluate(bars, cfg)
                                expected = self.oracle(bars, cfg)
                                self.assert_result(actual, expected)
                                if enabled and macd == .2:
                                    self.assert_result(expected, self.oracle(bars, cfg, original=True))
                                comparisons += 1
                                key = f'{enabled}/{macd}'
                                t = totals.setdefault(key, {'closed': 0, 'gross': 0, 'net': 0})
                                if actual['entered'] and actual['exitReason'] != '미체결':
                                    t['closed'] += 1; t['gross'] += actual['pnl']; t['net'] += actual['pnl'] - .25
                                reason_counts[actual['exitReason']] = reason_counts.get(actual['exitReason'], 0) + 1
        print('\nGOLDEN', json.dumps(dict(files=len(paths), cases=cases, comparisons=comparisons,
              totals=totals, seed_range=[min(seeds), max(seeds)], reasons=reason_counts), ensure_ascii=False))
        self.assertEqual(cases, 572)

    def test_short_indicators_and_edge_inputs(self):
        cfg = StrategyConfig('20260930', apply_cum_gate=False, macd_threshold=0)
        seed = [{'date': '20260929', 'time': '1530', 'open': 100, 'high': 101, 'low': 99, 'close': 100, 'volume': 1}]
        today = [dict(date='20260930', time=f'09{3+i//3:02}', open=100+i, high=104+i, low=99+i,
                      close=101+i, volume=100000, amount=0 if i%2 else 2000000) for i in range(20)]
        for n in (0, 1, 2, 12, 13, 14, 15, 21):
            bars = (seed+today)[:n]
            with self.subTest(n=n):
                original = copy.deepcopy(bars)
                eng = S43REngine(cfg)
                for b in bars:
                    eng.step(b)
                expected = self.oracle(bars, cfg, indicators=True)
                self.assert_result(eng.result(), expected)
                self.assertEqual(bars, original)
                if n:
                    for k, values in expected['indicators'].items():
                        for a, b in zip([v[k] for v in eng.values], values):
                            self.assertAlmostEqual(a, b, places=10, msg=k)
                self.assert_result(evaluate(bars, cfg, 1), self.oracle(bars, cfg, 1))
        for bars in (today[:3], today[:1], seed, []):
            self.assert_result(evaluate(bars, cfg), self.oracle(bars, cfg))

    def test_streaming_matches_batch_and_prefix_has_no_future_information(self):
        cfg = StrategyConfig('20260930', apply_mfe_gate=False, apply_cum_gate=False, macd_threshold=0)
        bars = [dict(date='20260930', time=f'09{3+i:02}', open=100+i, high=102+i,
                     low=99+i, close=100+i, volume=100000) for i in range(20)]
        stream = S43REngine(cfg); emitted = []
        for i, b in enumerate(bars):
            emitted.extend(stream.step(b))
            self.assert_result(stream.result(), self.oracle(bars[:i+1], cfg))
        self.assertEqual(emitted, stream.result()['events'])
        self.assertEqual(stream.result(), evaluate(bars, cfg))
        self.assertEqual(stream.result()['exitReason'], '미체결')
        self.assertEqual(stream.result()['pnl'], 0)

    def test_generated_paths_gates_stops_and_next_day_management(self):
        # Deterministic varied paths exercise partials, gaps, exits and non-target bars.
        cfg0 = StrategyConfig('20260930')
        for seed in range(24):
            state = seed + 1
            price = 100.0
            bars = []
            for i in range(120):
                state = (1664525 * state + 1013904223) & 0xffffffff
                delta = (state / 2**32 - .43) * 6
                op = price
                price = max(1, price + delta)
                minute = 9 * 60 + i
                bars.append(dict(date='20260930' if i < 100 else '20261001',
                    time=f'{minute//60:02}{minute%60:02}', open=op, high=max(op, price)+2,
                    low=max(0, min(op, price)-2), close=price, volume=1000000))
            for gate in (True, False):
                for stop in (-2.0, -3.0, -4.0):
                    cfg = replace(cfg0, apply_mfe_gate=gate, hard_stop_pct=stop, early_macd=.3)
                    with self.subTest(seed=seed, gate=gate, stop=stop):
                        self.assert_result(evaluate(bars, cfg), self.oracle(bars, cfg))
                        self.assert_result(evaluate(bars, cfg, 2.0), self.oracle(bars, cfg, 2.0))

    def test_configuration_is_frozen_and_events_do_not_mutate_state(self):
        from dataclasses import FrozenInstanceError
        cfg = StrategyConfig('20260930', apply_mfe_gate=False, apply_cum_gate=False, macd_threshold=0)
        with self.assertRaises(FrozenInstanceError):
            cfg.early_macd = .3
        with self.assertRaises(ValueError):
            StrategyConfig('20260930', entry_start='1000', entry_cutoff='0930')
        e = S43REngine(cfg)
        e.step(dict(date='20260930', time='0903', open=100, high=101, low=99, close=100, volume=1))
        events = e.step(dict(date='20260930', time='0904', open=100, high=103, low=100, close=102, volume=1))
        self.assertTrue(events)
        events[0]['price'] = -1
        self.assertEqual(e.result()['events'][0]['price'], 102)


if __name__ == '__main__':
    unittest.main()
