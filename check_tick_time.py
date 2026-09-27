# -*- coding: utf-8 -*-
import win32com.client

def verify_raw_tick_times(stock_code="A159010", tick_count=30):
    chart = win32com.client.Dispatch("CpSysDib.StockChart")
    chart.SetInputValue(0, stock_code)
    chart.SetInputValue(1, ord('2')) # 개수 기준
    chart.SetInputValue(4, 50)       # 50개 샘플
    chart.SetInputValue(5, [0, 1, 2, 3, 4, 5, 8]) # 일자, 시간, 시, 고, 저, 종, 거래량
    chart.SetInputValue(6, ord('T')) # 틱 단위
    chart.SetInputValue(7, int(tick_count))
    chart.SetInputValue(9, ord('1'))
    chart.BlockRequest()

    count = chart.GetHeaderValue(3)
    print(f"=== [Cybos 원본 틱 데이터 시간값 검증 (총 {count}개 수신)] ===")
    
    raw_list = []
    for i in range(count):
        d = chart.GetDataValue(0, i)
        t = chart.GetDataValue(1, i)
        c = chart.GetDataValue(5, i)
        raw_list.append((d, t, c))
    
    # 시간 오름차순(과거 -> 최신) 정렬
    raw_list.reverse()

    print("\n--- 첫 캔들 10개 (과거) ---")
    for idx, (d, t, c) in enumerate(raw_list[:10], 1):
        t_str = str(t)
        print(f"[{idx:02d}] 일자: {d} | 원본 t: {t:<8} (자릿수: {len(t_str)}) | 종가: {c}")

    print("\n--- 마지막 캔들 10개 (최신) ---")
    for idx, (d, t, c) in enumerate(raw_list[-10:], 1):
        t_str = str(t)
        print(f"[{idx:02d}] 일자: {d} | 원본 t: {t:<8} (자릿수: {len(t_str)}) | 종가: {c}")

if __name__ == "__main__":
    verify_raw_tick_times()