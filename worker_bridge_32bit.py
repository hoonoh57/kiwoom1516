# -*- coding: utf-8 -*-
import sys
import os

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

import json
import argparse
from datetime import datetime, timedelta
from window_interceptor import Kiwoom1516Controller
from grid_extractor import CustomGridExtractor

def check_cybos_connection():
    try:
        import win32com.client
        cp_cybos = win32com.client.Dispatch("CpUtil.CpCybos")
        if cp_cybos.IsConnect == 1:
            return True, ""
        return False, "CybosPlus 로그인 상태 아님"
    except Exception as e:
        return False, f"Cybos COM 오류: {str(e)}"

def get_code_by_name_cybos(stock_name):
    try:
        import win32com.client
        cp_code_mgr = win32com.client.Dispatch("CpUtil.CpStockCode")
        code = cp_code_mgr.NameToCode(stock_name)
        if code:
            return code
    except Exception:
        pass
    return ""

def fetch_daily_candles_cybos(stock_code, target_date, count=65):
    is_connected, msg = check_cybos_connection()
    if not is_connected or not stock_code:
        return []

    daily_bars = []
    try:
        import win32com.client
        chart = win32com.client.Dispatch("CpSysDib.StockChart")
        chart.SetInputValue(0, stock_code)
        chart.SetInputValue(1, ord('2')) # 개수 기준
        chart.SetInputValue(4, count + 15)
        chart.SetInputValue(5, [0, 2, 3, 4, 5, 8, 9]) # 일자, 시, 고, 저, 종, 거래량, 거래대금
        chart.SetInputValue(6, ord('D'))
        chart.SetInputValue(9, ord('1'))
        # NXT 대비 11~13번 규격 지정
        chart.SetInputValue(11, ord('Y')) # 조기적용
        chart.SetInputValue(12, ord('A')) # 거래소 전체 (KRX + NXT)
        chart.SetInputValue(13, ord('1')) # 애프터마켓 포함
        chart.BlockRequest()

        target_int = int(target_date)
        total_cnt = chart.GetHeaderValue(3)
        for i in range(total_cnt):
            d = chart.GetDataValue(0, i)
            if d >= target_int:
                continue # target_date 당일 제외 (순수 과거 D-1 이하)
            
            daily_bars.append({
                "date": str(d),
                "open": float(chart.GetDataValue(1, i)),
                "high": float(chart.GetDataValue(2, i)),
                "low": float(chart.GetDataValue(3, i)),
                "close": float(chart.GetDataValue(4, i)),
                "volume": int(chart.GetDataValue(5, i)),
                "amount": float(chart.GetDataValue(6, i))
            })
            if len(daily_bars) >= count:
                break
        daily_bars.reverse()
    except Exception:
        pass
    return daily_bars

def convert_cybos_minute_to_start_time(time_val, timeframe_min):
    """ Cybos 분봉 마감 시각(0903) -> 키움 표준 시작 시각(0900) 차감 보정 """
    t_int = int(time_val)
    hh = t_int // 100
    mm = t_int % 100
    dt = datetime(2026, 1, 1, hh, mm) - timedelta(minutes=int(timeframe_min))
    return f"{dt.hour:02d}{dt.minute:02d}"

def convert_cybos_tick_to_hhmm(t_raw):
    """ Cybos 틱 시간 정수 t를 정석 4자리 HHMM 문자열로 변환 (00: 접두어 방지) """
    s = str(t_raw).strip()
    if len(s) == 3:
        return "0" + s
    elif len(s) == 4:
        return s
    elif len(s) == 5:
        return "0" + s[:3]
    elif len(s) >= 6:
        return s[:4]
    return s.zfill(4)

def fetch_minute_candles_with_seed(stock_code, target_date, timeframe=3):
    is_connected, msg = check_cybos_connection()
    if not is_connected or not stock_code:
        return []

    t_dt = datetime.strptime(str(target_date), "%Y%m%d")
    s_dt = t_dt - timedelta(days=7)
    start_date_str = s_dt.strftime("%Y%m%d")

    raw_candles = []
    try:
        import win32com.client
        chart = win32com.client.Dispatch("CpSysDib.StockChart")
        chart.SetInputValue(0, stock_code)
        chart.SetInputValue(1, ord('1'))             # 기간 기준
        chart.SetInputValue(2, int(target_date))      # 종료일
        chart.SetInputValue(3, int(start_date_str))   # 시작일
        chart.SetInputValue(4, 600)
        chart.SetInputValue(5, [0, 1, 2, 3, 4, 5, 8])# 일자, 시간, 시, 고, 저, 종, 거래량
        chart.SetInputValue(6, ord('m'))
        chart.SetInputValue(7, int(timeframe))
        chart.SetInputValue(9, ord('1'))
        # NXT 대비 옵션 지정
        chart.SetInputValue(11, ord('Y')) # 8시 45분 조기 적용
        chart.SetInputValue(12, ord('A')) # 전체 (KRX + NXT)
        chart.SetInputValue(13, ord('1')) # 애프터마켓 포함
        chart.BlockRequest()

        count = chart.GetHeaderValue(3)
        for i in range(count):
            d = chart.GetDataValue(0, i)
            t = chart.GetDataValue(1, i)
            op = chart.GetDataValue(2, i)
            hp = chart.GetDataValue(3, i)
            lp = chart.GetDataValue(4, i)
            cp = chart.GetDataValue(5, i)
            vol = chart.GetDataValue(6, i)

            std_time_str = convert_cybos_minute_to_start_time(t, timeframe)

            raw_candles.append({
                "date": str(d),
                "time": std_time_str,
                "open": float(op),
                "high": float(hp),
                "low": float(lp),
                "close": float(cp),
                "volume": int(vol)
            })
        raw_candles.reverse()
    except Exception:
        pass

    if not raw_candles:
        return []

    target_date_str = str(target_date)
    intraday_today = [c for c in raw_candles if c["date"] == target_date_str]
    past_candles = [c for c in raw_candles if c["date"] < target_date_str]
    seed_candles = []
    if past_candles:
        last_past_date = past_candles[-1]["date"]
        d1_candles = [c for c in past_candles if c["date"] == last_past_date]
        seed_candles = d1_candles[-15:]

    return seed_candles + intraday_today

def aggregate_ticks(base_ticks, target_tick_count, base_tick_unit):
    """
    120틱 이하 기저 데이터를 조립(합산)하여 360, 640, 720틱 등의 대형 틱봉 합성
    """
    if target_tick_count <= base_tick_unit or not base_ticks:
        return base_ticks

    ratio = max(1, round(target_tick_count / float(base_tick_unit)))
    aggregated = []

    # 일자별로 분리하여 캔들 합성 (D-1과 당일이 섞이지 않도록 방지)
    dates = []
    for t in base_ticks:
        if t["date"] not in dates:
            dates.append(t["date"])

    for d in dates:
        day_ticks = [t for t in base_ticks if t["date"] == d]
        for i in range(0, len(day_ticks), ratio):
            chunk = day_ticks[i:i + ratio]
            if not chunk:
                continue
            
            c_open = chunk[0]["open"]
            c_high = max(x["high"] for x in chunk)
            c_low = min(x["low"] for x in chunk)
            c_close = chunk[-1]["close"]
            c_vol = sum(x["volume"] for x in chunk)
            c_time = chunk[-1]["time"] # 마지막 봉 시각 적용

            aggregated.append({
                "date": d,
                "time": c_time,
                "open": c_open,
                "high": c_high,
                "low": c_low,
                "close": c_close,
                "volume": c_vol
            })

    return aggregated

def fetch_tick_candles_paging(stock_code, target_date, target_tick_count=60):
    """
    Cybos 틱 요청 (최대 120틱 지원) + 120틱 초과 시 조립 엔진 구동
    """
    is_connected, msg = check_cybos_connection()
    if not is_connected or not stock_code:
        return []

    # 120틱 초과(360, 640, 720) 요청 시 Cybos 수신 기저 단위를 60틱 또는 120틱으로 설정
    if target_tick_count > 120:
        base_unit = 120 if (target_tick_count % 120 == 0) else 60
    else:
        base_unit = target_tick_count

    raw_ticks = []
    target_int = int(target_date)

    try:
        import win32com.client
        chart = win32com.client.Dispatch("CpSysDib.StockChart")
        chart.SetInputValue(0, stock_code)
        chart.SetInputValue(1, ord('2')) # 개수 기준
        chart.SetInputValue(4, 2000)      # 1회 최대 2000개 수신
        chart.SetInputValue(5, [0, 1, 2, 3, 4, 5, 8])
        chart.SetInputValue(6, ord('T')) # 틱 단위
        chart.SetInputValue(7, int(base_unit)) # Cybos 실제 요청 주기
        chart.SetInputValue(9, ord('1'))
        # NXT 대비 11~13번 옵션 적용
        chart.SetInputValue(11, ord('Y')) # 8시 45분 조기 적용
        chart.SetInputValue(12, ord('A')) # 전체 (KRX + NXT)
        chart.SetInputValue(13, ord('1')) # 애프터마켓 포함

        for page in range(20):
            chart.BlockRequest()
            count = chart.GetHeaderValue(3)
            if count == 0:
                break

            reached_d1 = False
            d1_count = 0

            for i in range(count):
                d = chart.GetDataValue(0, i)
                t = chart.GetDataValue(1, i)
                op = chart.GetDataValue(2, i)
                hp = chart.GetDataValue(3, i)
                lp = chart.GetDataValue(4, i)
                cp = chart.GetDataValue(5, i)
                vol = chart.GetDataValue(6, i)

                if d > target_int:
                    continue

                time_str = convert_cybos_tick_to_hhmm(t)

                raw_ticks.append({
                    "date": str(d),
                    "time": time_str,
                    "open": float(op),
                    "high": float(hp),
                    "low": float(lp),
                    "close": float(cp),
                    "volume": int(vol)
                })

                if d < target_int:
                    reached_d1 = True
                    d1_count += 1

            if reached_d1 and d1_count >= 250:
                break

            if not chart.Continue:
                break

        raw_ticks.reverse()
    except Exception:
        pass

    if not raw_ticks:
        return []

    # 대형 틱봉 조립 실행 (예: 640틱 -> 120틱 데이터 합성)
    if target_tick_count > 120:
        raw_ticks = aggregate_ticks(raw_ticks, target_tick_count, base_unit)

    target_date_str = str(target_date)
    today_ticks = [c for c in raw_ticks if c["date"] == target_date_str]
    past_ticks = [c for c in raw_ticks if c["date"] < target_date_str]

    seed_ticks = []
    if past_ticks:
        last_date = past_ticks[-1]["date"]
        d1_all = [c for c in past_ticks if c["date"] == last_date]
        seed_ticks = d1_all[-min(len(d1_all), 80):] # D-1 후반 시드

    return seed_ticks + today_ticks

def evaluate_macro_classification(daily_bars):
    if len(daily_bars) < 25:
        return {"status": "PASS", "type": "B", "kill_reason": "", "strategy": "S3", "detail": {}}

    d1 = daily_bars[-1]
    closes = [b["close"] for b in daily_bars]
    highs = [b["high"] for b in daily_bars]
    lows = [b["low"] for b in daily_bars]
    volumes = [b["volume"] for b in daily_bars]
    amounts = [b["amount"] for b in daily_bars]

    ma5 = sum(closes[-5:]) / 5.0
    ma20 = sum(closes[-20:]) / 20.0
    ma60 = sum(closes[-min(60, len(closes)):]) / float(min(60, len(closes)))
    high20 = max(highs[-20:])
    avg_vol20 = sum(volumes[-20:]) / 20.0
    d1_amt_억 = d1["amount"] / 100000000.0

    body = abs(d1["close"] - d1["open"])
    upper_tail = d1["high"] - max(d1["close"], d1["open"])
    disparity20 = ((d1["close"] - ma20) / ma20) * 100.0

    kill_reason = ""
    if d1["volume"] > avg_vol20 * 2.5 and upper_tail > body * 2.0 and upper_tail > (d1["close"] * 0.04):
        kill_reason = "설거지패턴"
    elif 0 < (high20 - d1["close"]) / d1["close"] < 0.015:
        kill_reason = "머리위저항"

    if kill_reason:
        return {
            "status": "KILLED",
            "type": "KILL",
            "kill_reason": kill_reason,
            "strategy": "-",
            "detail": {"d1_amt": d1_amt_억, "disparity20": disparity20}
        }

    assigned_type = "B"
    assigned_strat = "S3"

    is_consec_up = (closes[-1] > closes[-2] > closes[-3])
    if disparity20 > 15.0 or (is_consec_up and disparity20 > 12.0):
        assigned_type = "C"
        assigned_strat = "S2(제한)"
    elif (d1["close"] >= high20 * 0.90) and (d1["volume"] >= avg_vol20 * 1.8) and (ma5 > ma20):
        assigned_type = "A"
        assigned_strat = "S1/S2"
    else:
        assigned_type = "B"
        assigned_strat = "S3"

    return {
        "status": "PASS",
        "type": assigned_type,
        "kill_reason": "",
        "strategy": assigned_strat,
        "detail": {
            "d1_amt": round(d1_amt_억, 1),
            "disparity20": round(disparity20, 1),
            "ma20": round(ma20, 0),
            "high20": round(high20, 0)
        }
    }

def run_dual_chart(stock_code, date_val, timeframe, unit):
    daily_bars = fetch_daily_candles_cybos(stock_code, date_val, count=60)
    
    if unit == 'T':
        intraday_bars = fetch_tick_candles_paging(stock_code, date_val, target_tick_count=timeframe)
    else:
        intraday_bars = fetch_minute_candles_with_seed(stock_code, date_val, timeframe=timeframe)

    macro_eval = evaluate_macro_classification(daily_bars)

    resp = {
        "status": "success",
        "code": stock_code,
        "daily": daily_bars,
        "intraday": intraday_bars,
        "unit": unit,
        "classification": macro_eval
    }
    sys.stdout.buffer.write(json.dumps(resp, ensure_ascii=False).encode("utf-8"))

# worker_bridge_32bit.py 내 run_capture 함수 교체

def run_capture(cond_idx, date_val, time_val):
    controller = Kiwoom1516Controller()
    top_hwnd = controller.find_1516_window()

    if not top_hwnd:
        resp = {"status": "error", "message": "1516 창을 찾을 수 없습니다.", "data": []}
        sys.stdout.buffer.write(json.dumps(resp, ensure_ascii=False).encode("utf-8"))
        return

    controller.set_parameters_and_query(cond_index=cond_idx, date_str=date_val, time_str=time_val)
    extractor = CustomGridExtractor(top_hwnd)
    raw_records = extractor.extract_rows()

    is_cybos, _ = check_cybos_connection()
    valid_records = []

    # 비정상 행('10분간', 빈 종목명 등) 사전 필터링
    invalid_keywords = ["분간", "초간", "시간", "수익률", "성과"]

    for item in raw_records:
        name = item.get("종목명", "").strip()
        if not name or any(k in name for k in invalid_keywords):
            continue

        if is_cybos:
            code = get_code_by_name_cybos(name)
            if not code:
                continue
            item["종목코드"] = code
        else:
            item["종목코드"] = ""

        valid_records.append(item)

    resp = {"status": "success", "count": len(valid_records), "data": valid_records}
    sys.stdout.buffer.write(json.dumps(resp, ensure_ascii=False).encode("utf-8"))

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="32-bit Quant Engine")
    parser.add_argument("--mode", type=str, default="capture", choices=["capture", "dual_chart"])
    parser.add_argument("--cond", type=int, default=92)
    parser.add_argument("--date", type=str, default="20260923")
    parser.add_argument("--time", type=str, default="090300")
    parser.add_argument("--code", type=str, default="")
    parser.add_argument("--timeframe", type=int, default=30)
    parser.add_argument("--unit", type=str, default="m", choices=["m", "T"])
    args = parser.parse_args()

    if args.mode == "capture":
        run_capture(args.cond, args.date, args.time)
    elif args.mode == "dual_chart":
        run_dual_chart(args.code, args.date, args.timeframe, args.unit)