# -*- coding: utf-8 -*-
import sys
import os

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

import json
import subprocess
import pandas as pd
from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QLabel, QLineEdit, QPushButton, QTableWidget, QTableWidgetItem,
    QHeaderView, QMessageBox, QStatusBar, QSplitter, QTextEdit,
    QComboBox
)
from PyQt5.QtCore import Qt, QThread, pyqtSignal, QRectF
from PyQt5.QtGui import QPainter, QColor, QPen, QBrush, QFont

PYTHON_32_EXE = r"E:\Python310-32\python.exe"
WORKER_SCRIPT = os.path.join(CURRENT_DIR, "worker_bridge_32bit.py")

class SubprocessCaller(QThread):
    finished_signal = pyqtSignal(dict)
    log_signal = pyqtSignal(str)

    def __init__(self, cmd_args):
        super().__init__()
        self.cmd_args = cmd_args

    def run(self):
        if not os.path.exists(PYTHON_32_EXE):
            err = f"[오류] 32비트 파이썬을 찾을 수 없습니다: {PYTHON_32_EXE}"
            self.log_signal.emit(err)
            self.finished_signal.emit({"status": "error", "message": err})
            return

        cmd = [PYTHON_32_EXE, WORKER_SCRIPT] + self.cmd_args
        self.log_signal.emit(f"[64-bit Core] 프로세스 호출: {' '.join(cmd)}")
        try:
            creationflags = 0x08000000 if sys.platform == "win32" else 0
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=CURRENT_DIR,
                creationflags=creationflags
            )
            stdout_bytes, stderr_bytes = proc.communicate(timeout=30)

            stdout_str = ""
            if stdout_bytes:
                try:
                    stdout_str = stdout_bytes.decode("utf-8")
                except UnicodeDecodeError:
                    stdout_str = stdout_bytes.decode("cp949", errors="replace")

            if proc.returncode != 0:
                err_msg = stderr_bytes.decode("cp949", errors="replace")
                self.log_signal.emit(f"[32-bit 에러] {err_msg.strip()}")
                self.finished_signal.emit({"status": "error", "message": err_msg.strip()})
                return

            if not stdout_str.strip():
                self.finished_signal.emit({"status": "error", "message": "수신 데이터가 비어 있습니다."})
                return

            parsed = json.loads(stdout_str.strip())
            self.finished_signal.emit(parsed)
        except Exception as e:
            self.log_signal.emit(f"[호출 실패] {str(e)}")
            self.finished_signal.emit({"status": "error", "message": str(e)})

class CandleStickChartWidget(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.candles = []
        self.trade_signals = []
        self.capture_time = ""
        self.title = "종목을 더블클릭하면 CybosPlus 분봉 차트가 표시됩니다."
        self.setMinimumHeight(280)
        self.setStyleSheet("background-color: #141414;")

    def set_chart_data(self, title, candles, capture_time, signals):
        self.title = title
        self.candles = candles
        self.capture_time = capture_time
        self.trade_signals = signals
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        painter.fillRect(self.rect(), QColor("#141414"))

        # 상단 타이틀
        painter.setPen(QColor("#e0e0e0"))
        painter.setFont(QFont("Malgun Gothic", 10, QFont.Bold))
        painter.drawText(15, 25, self.title)

        if not self.candles:
            painter.setFont(QFont("Malgun Gothic", 9))
            painter.setPen(QColor("#777777"))
            painter.drawText(self.rect(), Qt.AlignCenter, "표시할 캔들 데이터가 없습니다.")
            return

        margin_left = 65
        margin_right = 30
        margin_top = 40
        margin_bottom = 35

        w = self.width() - margin_left - margin_right
        h = self.height() - margin_top - margin_bottom

        if w <= 0 or h <= 0:
            return

        highs = [c["high"] for c in self.candles]
        lows = [c["low"] for c in self.candles]
        min_p = min(lows)
        max_p = max(highs)
        p_range = max_p - min_p if max_p != min_p else 1.0

        n = len(self.candles)
        candle_w = max(2.0, w / n)

        # 수평 그리드 및 가격 라벨
        painter.setFont(QFont("Arial", 8))
        grid_pen = QPen(QColor("#262626"), 1, Qt.DashLine)
        for step in range(5):
            y = margin_top + (h / 4) * step
            painter.setPen(grid_pen)
            painter.drawLine(margin_left, int(y), self.width() - margin_right, int(y))
            
            p_val = max_p - (p_range / 4) * step
            painter.setPen(QColor("#888888"))
            painter.drawText(5, int(y) + 4, f"{p_val:,.0f}")

        # 캔들스틱 드로잉
        red_pen = QPen(QColor("#ff4d4d"), 1.2)
        red_brush = QBrush(QColor("#ff4d4d"))
        blue_pen = QPen(QColor("#4da6ff"), 1.2)
        blue_brush = QBrush(QColor("#4da6ff"))

        capture_idx = -1
        clean_cap_time = self.capture_time.replace(":", "")[:4]

        for i, c in enumerate(self.candles):
            cx = margin_left + i * candle_w + candle_w / 2.0
            o_y = margin_top + h * (1.0 - (c["open"] - min_p) / p_range)
            c_y = margin_top + h * (1.0 - (c["close"] - min_p) / p_range)
            h_y = margin_top + h * (1.0 - (c["high"] - min_p) / p_range)
            l_y = margin_top + h * (1.0 - (c["low"] - min_p) / p_range)

            is_up = c["close"] >= c["open"]
            painter.setPen(red_pen if is_up else blue_pen)
            painter.setBrush(red_brush if is_up else blue_brush)

            painter.drawLine(int(cx), int(h_y), int(cx), int(l_y))

            rect_top = min(o_y, c_y)
            rect_h = max(1.5, abs(c_y - o_y))
            body_w = max(1.5, candle_w * 0.7)
            painter.drawRect(QRectF(cx - body_w / 2.0, rect_top, body_w, rect_h))

            if c["time"] == clean_cap_time and capture_idx == -1:
                capture_idx = i

        # 포착 시점 노란색 수직선
        if capture_idx != -1:
            px = margin_left + capture_idx * candle_w + candle_w / 2.0
            painter.setPen(QPen(QColor("#ffea00"), 1.5, Qt.DotLine))
            painter.drawLine(int(px), margin_top, int(px), margin_top + h)
            painter.setPen(QColor("#ffea00"))
            painter.drawText(int(px) - 15, margin_top - 5, "포착")

        # 진입/청산 화살표 신호
        for sig in self.trade_signals:
            s_idx = sig["idx"]
            if 0 <= s_idx < n:
                sx = margin_left + s_idx * candle_w + candle_w / 2.0
                c = self.candles[s_idx]
                if sig["type"] == "BUY":
                    sy = margin_top + h * (1.0 - (c["low"] - min_p) / p_range) + 12
                    painter.setPen(QPen(QColor("#ff2222"), 2))
                    painter.drawLine(int(sx), int(sy), int(sx), int(sy - 8))
                    painter.drawLine(int(sx), int(sy - 8), int(sx - 4), int(sy - 4))
                    painter.drawLine(int(sx), int(sy - 8), int(sx + 4), int(sy - 4))
                elif sig["type"] == "SELL":
                    sy = margin_top + h * (1.0 - (c["high"] - min_p) / p_range) - 12
                    painter.setPen(QPen(QColor("#2288ff"), 2))
                    painter.drawLine(int(sx), int(sy), int(sx), int(sy + 8))
                    painter.drawLine(int(sx), int(sy + 8), int(sx - 4), int(sy + 4))
                    painter.drawLine(int(sx), int(sy + 8), int(sx + 4), int(sy + 4))

class MainWindow64(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Kiwoom [1516] MFE Analyzer & Strategy Platform (64-bit)")
        self.resize(1220, 800)
        self.current_df = pd.DataFrame()
        self.init_ui()

    def init_ui(self):
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        main_layout = QVBoxLayout(central_widget)

        top_bar = QHBoxLayout()

        top_bar.addWidget(QLabel("조건식:"))
        self.edit_cond = QLineEdit("92")
        self.edit_cond.setFixedWidth(40)
        top_bar.addWidget(self.edit_cond)

        top_bar.addWidget(QLabel("일자:"))
        self.edit_date = QLineEdit("20260922")
        self.edit_date.setFixedWidth(85)
        top_bar.addWidget(self.edit_date)

        top_bar.addWidget(QLabel("시간:"))
        self.edit_time = QLineEdit("090300")
        self.edit_time.setFixedWidth(70)
        top_bar.addWidget(self.edit_time)

        top_bar.addWidget(QLabel("분봉(TF):"))
        self.combo_tf = QComboBox()
        self.combo_tf.addItems(["1분봉", "3분봉", "5분봉", "10분봉", "15분봉", "60분봉"])
        self.combo_tf.setFixedWidth(75)
        top_bar.addWidget(self.combo_tf)

        top_bar.addWidget(QLabel("전략:"))
        self.combo_strategy = QComboBox()
        self.combo_strategy.addItems(["포착시점 매수 후 60분 보유 청산", "MFE 5% 익절 / -2% 손절", "장마감 보유 청산"])
        top_bar.addWidget(self.combo_strategy)

        self.btn_run = QPushButton("1516 가로채기 및 코드매핑")
        self.btn_run.clicked.connect(self.start_capture)
        top_bar.addWidget(self.btn_run)

        main_layout.addLayout(top_bar)

        v_splitter = QSplitter(Qt.Vertical)

        # 결과 테이블
        self.table = QTableWidget()
        self.table.setColumnCount(8)
        self.table.setHorizontalHeaderLabels(["종목코드", "종목명", "1분간", "3분간", "60분간", "최고수익률(MFE)", "검색시점거래량", "기타"])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table.cellDoubleClicked.connect(self.on_table_double_clicked)
        v_splitter.addWidget(self.table)

        # 하단 (차트 뷰어 + 로그 콘솔)
        h_bottom_splitter = QSplitter(Qt.Horizontal)

        self.chart_view = CandleStickChartWidget()
        h_bottom_splitter.addWidget(self.chart_view)

        self.txt_log = QTextEdit()
        self.txt_log.setReadOnly(True)
        h_bottom_splitter.addWidget(self.txt_log)
        h_bottom_splitter.setSizes([750, 400])

        v_splitter.addWidget(h_bottom_splitter)
        v_splitter.setSizes([380, 340])

        main_layout.addWidget(v_splitter)

        self.status_bar = QStatusBar()
        self.setStatusBar(self.status_bar)
        self.status_bar.showMessage("준비 완료 - 1516 가로채기를 실행하세요.")

    def append_log(self, text):
        self.txt_log.append(text)

    def start_capture(self):
        try:
            cond_idx = int(self.edit_cond.text().strip())
        except ValueError:
            QMessageBox.warning(self, "입력 오류", "조건식 번호는 정수여야 합니다.")
            return

        date_val = self.edit_date.text().strip()
        time_val = self.edit_time.text().strip()

        self.btn_run.setEnabled(False)
        self.status_bar.showMessage("1516 데이터 가로채기 및 CybosPlus 종목코드 매핑 중...")

        args = ["--mode", "capture", "--cond", str(cond_idx), "--date", date_val, "--time", time_val]
        self.worker = SubprocessCaller(args)
        self.worker.log_signal.connect(self.append_log)
        self.worker.finished_signal.connect(self.on_capture_finished)
        self.worker.start()

    def on_capture_finished(self, result):
        self.btn_run.setEnabled(True)
        if result.get("status") != "success":
            msg = result.get("message", "오류")
            self.status_bar.showMessage(f"실패: {msg}")
            return

        records = result.get("data", [])
        self.current_df = pd.DataFrame(records)
        self.table.setRowCount(0)

        if self.current_df.empty:
            self.status_bar.showMessage("추출된 데이터가 없습니다.")
            return

        cols = list(self.current_df.columns)
        if "종목코드" in cols:
            cols.remove("종목코드")
            cols = ["종목코드"] + cols

        self.table.setRowCount(len(self.current_df))
        self.table.setColumnCount(len(cols))
        self.table.setHorizontalHeaderLabels(cols)

        for row_idx, row in self.current_df.iterrows():
            for col_idx, col_name in enumerate(cols):
                val = str(row.get(col_name, ""))
                item = QTableWidgetItem(val)
                item.setTextAlignment(Qt.AlignCenter)
                self.table.setItem(row_idx, col_idx, item)

        self.status_bar.showMessage(f"추출 성공: 총 {len(self.current_df)}건 (종목 행을 더블클릭하면 차트를 로드합니다)")
        self.append_log(f"[64-bit Engine] {len(self.current_df)}개 종목 수신 완료. 종목 더블클릭 시 CybosPlus 분봉 조회가 실행됩니다.")

    def on_table_double_clicked(self, row, col):
        code_item = self.table.item(row, 0)
        name_item = self.table.item(row, 1)
        stock_code = code_item.text().strip() if code_item else ""
        stock_name = name_item.text().strip() if name_item else "종목"

        if not stock_code:
            self.status_bar.showMessage(f"[{stock_name}] 종목코드가 없습니다. (CybosPlus 미로그인 확인 필요)")
            self.append_log(f"[오류] {stock_name}: CybosPlus 종목코드가 존재하지 않아 조회를 중단합니다.")
            return

        date_val = self.edit_date.text().strip()
        tf_str = self.combo_tf.currentText().replace("분봉", "").strip()
        timeframe = int(tf_str) if tf_str.isdigit() else 1

        self.status_bar.showMessage(f"[{stock_name}({stock_code})] CybosPlus {timeframe}분봉 수신 중...")
        self.append_log(f"[차트 요청] {stock_name} ({stock_code}), 일자: {date_val}, TF: {timeframe}분")

        args = ["--mode", "chart", "--code", stock_code, "--date", date_val, "--timeframe", str(timeframe)]
        self.chart_worker = SubprocessCaller(args)
        self.chart_worker.log_signal.connect(self.append_log)
        self.chart_worker.finished_signal.connect(
            lambda res: self.on_chart_data_received(res, stock_name, stock_code)
        )
        self.chart_worker.start()

    def on_chart_data_received(self, result, stock_name, stock_code):
        if result.get("status") != "success":
            err_msg = result.get("message", "조회 실패")
            self.status_bar.showMessage(f"[CybosPlus 오류] {err_msg}")
            self.append_log(f"[차트 수신 실패] {stock_name}({stock_code}): {err_msg}")
            return

        candles = result.get("candles", [])
        if not candles:
            self.status_bar.showMessage("조회된 실제 캔들 데이터가 없습니다.")
            self.append_log(f"[알림] {stock_name}({stock_code})의 수신 캔들 개수가 0입니다.")
            return

        capture_time = self.edit_time.text().strip()
        strategy_type = self.combo_strategy.currentText()

        signals, pnl_log = self.simulate_strategy(candles, capture_time, strategy_type)

        title = f"{stock_name} ({stock_code}) | {self.edit_date.text()} | {self.combo_tf.currentText()} | 전략: {strategy_type}"
        self.chart_view.set_chart_data(title, candles, capture_time, signals)

        self.append_log(f"--- [{stock_name} 실제 캔들 전략 시뮬레이션 결과 (총 {len(candles)}봉)] ---")
        for line in pnl_log:
            self.append_log(line)
        self.status_bar.showMessage(f"{stock_name} 실제 분봉 차트 렌더링 완료 ({len(candles)}개 캔들).")

    def simulate_strategy(self, candles, capture_time, strategy_type):
        signals = []
        logs = []
        clean_cap = capture_time.replace(":", "")[:4]

        entry_idx = -1
        for i, c in enumerate(candles):
            if c["time"] >= clean_cap:
                entry_idx = i
                break

        if entry_idx == -1 or entry_idx >= len(candles) - 1:
            logs.append("포착 시점 이후 거래 데이터가 없어 진입을 생략합니다.")
            return signals, logs

        entry_candle = candles[entry_idx]
        entry_price = entry_candle["close"]
        signals.append({"idx": entry_idx, "type": "BUY", "price": entry_price})
        logs.append(f"진입: {entry_candle['time']} @ {entry_price:,.0f}원")

        exit_idx = -1
        exit_price = 0.0
        exit_reason = ""

        if "60분 보유" in strategy_type:
            tf = int(self.combo_tf.currentText().replace("분봉", ""))
            hold_bars = max(1, 60 // tf)
            exit_idx = min(len(candles) - 1, entry_idx + hold_bars)
            exit_price = candles[exit_idx]["close"]
            exit_reason = "60분 경과 타임컷 청산"

        elif "MFE 5% 익절" in strategy_type:
            for i in range(entry_idx + 1, len(candles)):
                c = candles[i]
                high_ret = (c["high"] - entry_price) / entry_price * 100.0
                low_ret = (c["low"] - entry_price) / entry_price * 100.0

                if high_ret >= 5.0:
                    exit_idx = i
                    exit_price = entry_price * 1.05
                    exit_reason = "MFE +5.0% 익절 청산"
                    break
                elif low_ret <= -2.0:
                    exit_idx = i
                    exit_price = entry_price * 0.98
                    exit_reason = "-2.0% 손절 청산"
                    break

            if exit_idx == -1:
                exit_idx = len(candles) - 1
                exit_price = candles[exit_idx]["close"]
                exit_reason = "장마감 동시호가 청산"

        else:
            exit_idx = len(candles) - 1
            exit_price = candles[exit_idx]["close"]
            exit_reason = "장마감 청산"

        signals.append({"idx": exit_idx, "type": "SELL", "price": exit_price})
        pnl_pct = (exit_price - entry_price) / entry_price * 100.0
        logs.append(f"청산: {candles[exit_idx]['time']} @ {exit_price:,.0f}원 ({exit_reason})")
        logs.append(f"최종 수익률: {pnl_pct:+.2f}%")

        return signals, logs

if __name__ == "__main__":
    app = QApplication(sys.argv)
    window = MainWindow64()
    window.show()
    sys.exit(app.exec_())