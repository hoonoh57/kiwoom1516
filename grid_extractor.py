# -*- coding: utf-8 -*-
import ctypes
from ctypes import wintypes
import time

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
KEYEVENTF_KEYUP = 0x0002
VK_Z = 0x5A
CF_UNICODETEXT = 13

class CustomGridExtractor:
    def __init__(self, top_1516_hwnd):
        self.top_hwnd = top_1516_hwnd

    def _force_foreground(self):
        """ 브라우저 뒤에 있는 1516 창을 강제로 최상단 활성화 """
        fore_wnd = user32.GetForegroundWindow()
        cur_thread = kernel32.GetCurrentThreadId()
        fore_thread = user32.GetWindowThreadProcessId(fore_wnd, None)

        user32.AttachThreadInput(cur_thread, fore_thread, True)
        user32.ShowWindow(self.top_hwnd, 9)  # SW_RESTORE
        user32.SetForegroundWindow(self.top_hwnd)
        user32.BringWindowToTop(self.top_hwnd)
        user32.AttachThreadInput(cur_thread, fore_thread, False)
        time.sleep(0.2)

    def _get_clipboard_text(self):
        for _ in range(12):
            if user32.OpenClipboard(0):
                try:
                    h_glb = user32.GetClipboardData(CF_UNICODETEXT)
                    if h_glb:
                        kernel32.GlobalLock.restype = ctypes.c_void_p
                        ptr = kernel32.GlobalLock(h_glb)
                        if ptr:
                            text = ctypes.c_wchar_p(ptr).value
                            kernel32.GlobalUnlock(h_glb)
                            user32.CloseClipboard()
                            return text or ""
                finally:
                    try:
                        user32.CloseClipboard()
                    except:
                        pass
            time.sleep(0.05)
        return ""

    def _clear_clipboard(self):
        if user32.OpenClipboard(0):
            user32.EmptyClipboard()
            user32.CloseClipboard()

    def extract_rows(self):
        if not self.top_hwnd or not user32.IsWindow(self.top_hwnd):
            return []

        # 1. 1516 창 강제 전면 배치
        self._force_foreground()

        rect = wintypes.RECT()
        user32.GetWindowRect(self.top_hwnd, ctypes.byref(rect))
        w = rect.right - rect.left
        h = rect.bottom - rect.top

        # 우측 종목 리스트 헤더 아래 첫 데이터 행 위치
        target_x = rect.left + int(w * 0.65)
        target_y = rect.top + int(h * 0.39)

        self._clear_clipboard()

        user32.SetCursorPos(target_x, target_y)
        time.sleep(0.1)

        # 좌클릭 포커스
        user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        time.sleep(0.05)
        user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
        time.sleep(0.15)

        # 우클릭 -> 컨텍스트 메뉴 팝업
        user32.mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0)
        time.sleep(0.05)
        user32.mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0)
        time.sleep(0.2)

        # '복사(Z)' 가속키 입력
        user32.keybd_event(VK_Z, 0, 0, 0)
        time.sleep(0.05)
        user32.keybd_event(VK_Z, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.3)

        raw_text = self._get_clipboard_text()
        if not raw_text.strip():
            user32.keybd_event(VK_Z, 0, 0, 0)
            time.sleep(0.05)
            user32.keybd_event(VK_Z, 0, KEYEVENTF_KEYUP, 0)
            time.sleep(0.3)
            raw_text = self._get_clipboard_text()

        if not raw_text.strip():
            return []

        lines = [line.strip() for line in raw_text.strip().splitlines() if line.strip()]
        if not lines:
            return []

        default_headers = ["종목명", "1분간", "3분간", "60분간", "기간 내 최고수익률(MFE)", "검색시점 거래량", "기타"]
        result = []
        for line in lines:
            tokens = [token.strip().strip('"').strip() for token in line.split("\t") if token.strip()]
            if any(h in tokens[0] for h in ["종목명", "기간", "1분간"]):
                continue
            if not tokens:
                continue

            item_dict = {}
            for idx, val in enumerate(tokens):
                key = default_headers[idx] if idx < len(default_headers) else f"col_{idx}"
                item_dict[key] = val
            result.append(item_dict)

        return result