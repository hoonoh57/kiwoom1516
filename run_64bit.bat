@echo off
chcp 65001 > nul
cd /d "E:\2026\gemini\kiwoom1516"

echo ========================================================
echo [Launch] 64-bit Kiwoom 1516 Analysis Core
echo [Bridge Target] E:\Python310-32\python.exe
echo ========================================================

python main_app_64bit.py

if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Process finished with exit code %ERRORLEVEL%
    pause
)