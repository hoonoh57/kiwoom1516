# -*- coding: utf-8 -*-
import time
import threading
from typing import List, Dict, Optional

class TwoStageOrderEngine:
    def __init__(self, account_no: str = "12345678-01", allocation_per_stock: int = 10000000):
        self.account_no = account_no
        self.allocation_per_stock = allocation_per_stock  # 종목당 배정 금액 (예: 1,000만원)
        self.active_positions: Dict[str, dict] = {}       # 보유 포지션
        self.trade_logs: List[str] = []
        self.is_running = False
        self._lock = threading.Lock()

    def log(self, msg: str):
        timestamp = time.strftime("%H:%M:%S")
        formatted = f"[{timestamp}] [AutoTrader] {msg}"
        print(formatted)
        with self._lock:
            self.trade_logs.append(formatted)

    def filter_and_rank_top_n(
        self,
        candidate_items: List[dict],
        macro_results: Dict[str, dict],
        micro_snapshots: Dict[str, dict],
        target_n: int = 3
    ) -> List[dict]:
        """
        2-Stage 결합 평가:
        Stage 1: D-1 일봉 매크로 점수 (가중합 산출)
        Stage 2: 09:03 마이크로 수급 필터 (최소 거래량, 시초가 지지 여부, 체결강도)
        """
        self.log(f"2-Stage 선별 시작: 입력 후보군 {len(candidate_items)}개")
        scored_candidates = []

        # 튜닝 검증된 가중치 설정 (알파 +3.28%p 기준)
        w_trend = 0.0
        w_breakout = -1.2
        w_squeeze = 0.3
        w_volume = 1.0
        w_oversold = 2.0

        for item in candidate_items:
            code = item.get("종목코드", "")
            name = item.get("종목명", "")
            if not code:
                continue

            # Stage 1: 매크로 점수 산출
            macro_f = macro_results.get(code, {
                "trend": 0.0, "breakout": 0.0, "squeeze": 0.0, "volume": 0.0, "oversold": 0.0
            })
            raw_macro = (
                macro_f.get("trend", 0) * w_trend +
                macro_f.get("breakout", 0) * w_breakout +
                macro_f.get("squeeze", 0) * w_squeeze +
                macro_f.get("volume", 0) * w_volume +
                macro_f.get("oversold", 0) * w_oversold
            )

            # Stage 2: 마이크로 수급 게이트 검증
            micro_f = micro_snapshots.get(code, {
                "current_price": 0,
                "open_price": 0,
                "accum_vol": 0,
                "power": 100.0,
                "valid": False
            })

            # 최소 거래량 컷 (호가 얇은 유령 종목 탈락)
            vol_val = micro_f.get("accum_vol", 0)
            if vol_val < 3000:
                continue

            # 시초가 지지 여부 (시가 아래로 밀린 음봉 종목 탈락)
            curr_p = micro_f.get("current_price", 0)
            open_p = micro_f.get("open_price", 0)
            if open_p > 0 and curr_p < open_p:
                continue

            # 마이크로 수급 가산점
            power_bonus = 10.0 if micro_f.get("power", 0) >= 120.0 else 0.0
            gap_pct = ((curr_p - open_p) / open_p * 100.0) if open_p > 0 else 0.0
            gap_bonus = min(15.0, gap_pct * 3.0)

            final_quant_score = raw_macro + power_bonus + gap_bonus

            scored_candidates.append({
                "code": code,
                "name": name,
                "final_score": round(final_quant_score, 2),
                "macro_score": round(raw_macro, 2),
                "price": curr_p,
                "accum_vol": vol_val,
                "power": micro_f.get("power", 0)
            })

        # 최종 점수 내림차순 정렬
        scored_candidates.sort(key=lambda x: x["final_score"], reverse=True)
        top_n = scored_candidates[:target_n]

        self.log(f"최종 상위 {len(top_n)}종목 선별 완료:")
        for rank, cand in enumerate(top_n, 1):
            self.log(
                f"  [{rank}위] {cand['name']}({cand['code']}) - 최종점수: {cand['final_score']} "
                f"(매크로: {cand['macro_score']}, 현재가: {cand['price']:,}원, 체결강도: {cand['power']}%)"
            )

        return top_n

    def execute_buy_orders(self, top_candidates: List[dict]):
        """ 상위 3종목 분할 매수 주문 집행 """
        for item in top_candidates:
            code = item["code"]
            name = item["name"]
            price = item["price"]

            if price <= 0:
                continue

            qty = int(self.allocation_per_stock // price)
            if qty <= 0:
                continue

            with self._lock:
                self.active_positions[code] = {
                    "name": name,
                    "buy_price": price,
                    "qty": qty,
                    "highest_price": price, # MFE 추종용
                    "entry_time": time.time(),
                    "half_taken": False
                }

            self.log(f"[매수 체결] {name}({code}) - 수량: {qty:,}주 @ 체결가: {price:,}원 (투자금: {price * qty:,}원)")

    def update_tick_and_check_exit(self, current_ticks: Dict[str, float]):
        """
        실시간 시세 수신 시 MFE 기반 트레일링 스탑 및 타임컷 청산 실행
        - +5% 도달 시 50% 분할 익절
        - 최고가 대비 -2% 하락 시 트레일링 스탑 전량 청산
        - -2% 손절선 터치 시 전량 손절
        - 보유 60분 경과 시 시장가 타임컷
        """
        closed_codes = []

        with self._lock:
            for code, pos in self.active_positions.items():
                cur_price = current_ticks.get(code, 0.0)
                if cur_price <= 0:
                    continue

                # 최고가 갱신 (MFE 추종)
                if cur_price > pos["highest_price"]:
                    pos["highest_price"] = cur_price

                buy_p = pos["buy_price"]
                high_p = pos["highest_price"]
                pnl_pct = ((cur_price - buy_p) / buy_p) * 100.0
                mfe_pct = ((high_p - buy_p) / buy_p) * 100.0
                elapsed_min = (time.time() - pos["entry_time"]) / 60.0

                # 1. 1차 익절 (+5% 도달 시 절반 매도)
                if pnl_pct >= 5.0 and not pos["half_taken"]:
                    half_qty = pos["qty"] // 2
                    pos["qty"] -= half_qty
                    pos["half_taken"] = True
                    self.log(
                        f"[1차 분할익절 (+5%)] {pos['name']}({code}) - {half_qty:,}주 매도 @ {cur_price:,}원 "
                        f"(수익률: {pnl_pct:+.2f}%)"
                    )

                # 2. 트레일링 스탑 (최고 MFE에서 2% 이상 밀릴 때)
                trailing_drop = ((high_p - cur_price) / high_p) * 100.0
                if mfe_pct >= 5.0 and trailing_drop >= 2.0:
                    self.log(
                        f"[트레일링 익절 청산] {pos['name']}({code}) - 잔량 {pos['qty']:,}주 전량 매도 @ {cur_price:,}원 "
                        f"(최고수익률: {mfe_pct:+.2f}%, 확정수익률: {pnl_pct:+.2f}%)"
                    )
                    closed_codes.append(code)
                    continue

                # 3. 손절 (-2.0% 터치)
                if pnl_pct <= -2.0:
                    self.log(
                        f"[손절 청산 (-2%)] {pos['name']}({code}) - {pos['qty']:,}주 전량 매도 @ {cur_price:,}원 "
                        f"(손실률: {pnl_pct:+.2f}%)"
                    )
                    closed_codes.append(code)
                    continue

                # 4. 60분 경과 타임컷
                if elapsed_min >= 60.0:
                    self.log(
                        f"[60분 타임컷 청산] {pos['name']}({code}) - {pos['qty']:,}주 전량 매도 @ {cur_price:,}원 "
                        f"(보유시간: {elapsed_min:.1f}분, 최종수익률: {pnl_pct:+.2f}%)"
                    )
                    closed_codes.append(code)
                    continue

            for c in closed_codes:
                del self.active_positions[c]

    def get_status_report(self) -> dict:
        with self._lock:
            positions_summary = []
            for code, pos in self.active_positions.items():
                positions_summary.append({
                    "code": code,
                    "name": pos["name"],
                    "buy_price": pos["buy_price"],
                    "qty": pos["qty"],
                    "highest_price": pos["highest_price"],
                    "half_taken": pos["half_taken"],
                    "elapsed_sec": int(time.time() - pos["entry_time"])
                })
            return {
                "active_count": len(self.active_positions),
                "positions": positions_summary,
                "recent_logs": self.trade_logs[-15:]
            }

order_engine = TwoStageOrderEngine()