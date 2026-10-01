@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo ========================================================
echo [Launch] 64-bit FastAPI & Lightweight Chart Platform
echo [Target Bridge] E:\Python310-32\python.exe
echo ========================================================

python web_server.py

if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Web server terminated with code %ERRORLEVEL%
    pause
)