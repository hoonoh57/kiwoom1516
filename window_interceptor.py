# -*- coding: utf-8 -*-
import ctypes
from ctypes import wintypes
import time

user32 = ctypes.windll.user32

WM_COMMAND = 0x0111
WM_SETTEXT = 0x000C
BM_CLICK = 0x00F5
CB_SETCURSEL = 0x014E

class Kiwoom1516Controller:
    def __init__(self):
        self.top_hwnd = None
        self.controls = {}

    def find_1516_window(self):
        found_hwnds = []

        def enum_windows_proc(hwnd, lparam):
            if user32.IsWindowVisible(hwnd):
                length = user32.GetWindowTextLengthW(hwnd)
                if length > 0:
                    buff = ctypes.create_unicode_buffer(length + 1)
                    user32.GetWindowTextW(hwnd, buff, length + 1)
                    title = buff.value
                    if "1516" in title or "성과검증" in title:
                        found_hwnds.append(hwnd)
            return True

        ENUM_PROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
        user32.EnumWindows(ENUM_PROC(enum_windows_proc), 0)

        if not found_hwnds:
            return None
        self.top_hwnd = found_hwnds[0]
        self.scan_child_controls()
        return self.top_hwnd

    def scan_child_controls(self):
        self.controls.clear()
        if not self.top_hwnd:
            return

        def enum_child_proc(hwnd, lparam):
            cls_buff = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls_buff, 256)
            cls_name = cls_buff.value

            rect = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))

            self.controls[hwnd] = {
                "class": cls_name,
                "rect": (rect.left, rect.top, rect.right, rect.bottom),
                "width": rect.right - rect.left,
                "height": rect.bottom - rect.top
            }
            return True

        ENUM_CHILD_PROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
        user32.EnumChildWindows(self.top_hwnd, ENUM_CHILD_PROC(enum_child_proc), 0)

    def identify_roles(self):
        roles = {
            "cond_combo": None,
            "search_btn": None
        }

        for hwnd, meta in self.controls.items():
            cls = meta["class"].lower()
            w = meta["width"]
            h = meta["height"]

            if "combobox" in cls:
                roles["cond_combo"] = hwnd
            elif "button" in cls and (w < 100 and h < 40):
                roles["search_btn"] = hwnd

        return roles

    def set_parameters_and_query(self, cond_index=0, date_str="20260924", time_str="090500"):
        roles = self.identify_roles()

        if roles["cond_combo"]:
            user32.SendMessageW(roles["cond_combo"], CB_SETCURSEL, cond_index, 0)
            user32.SendMessageW(user32.GetParent(roles["cond_combo"]), WM_COMMAND, (1 << 16) | 0, roles["cond_combo"])

        if roles["search_btn"]:
            user32.PostMessageW(roles["search_btn"], BM_CLICK, 0, 0)
            time.sleep(0.6)