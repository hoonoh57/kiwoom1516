# -*- coding: utf-8 -*-
import os
import sys
import json
import asyncio
import subprocess
from typing import List
from fastapi import FastAPI, Query, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import uvicorn

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
PYTHON_32_EXE = r"E:\Python310-32\python.exe"
WORKER_SCRIPT = os.path.join(CURRENT_DIR, "worker_bridge_32bit.py")

app = FastAPI(title="Kiwoom 1516 Visual Quant Workbench")

STATIC_DIR = os.path.join(CURRENT_DIR, "static")
os.makedirs(STATIC_DIR, exist_ok=True)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

class CaptureRequest(BaseModel):
    cond: int = 92
    date: str = "20260907"
    time: str = "090300"

def run_subprocess_32bit(args: List[str]) -> dict:
    if not os.path.exists(PYTHON_32_EXE):
        raise HTTPException(status_code=500, detail=f"32bit Python not found: {PYTHON_32_EXE}")

    cmd = [PYTHON_32_EXE, WORKER_SCRIPT] + args
    creationflags = 0x08000000 if sys.platform == "win32" else 0

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=CURRENT_DIR,
        creationflags=creationflags
    )
    stdout_bytes, stderr_bytes = proc.communicate(timeout=60)

    stdout_str = ""
    if stdout_bytes:
        try:
            stdout_str = stdout_bytes.decode("utf-8")
        except UnicodeDecodeError:
            stdout_str = stdout_bytes.decode("cp949", errors="replace")

    if proc.returncode != 0:
        err_msg = stderr_bytes.decode("cp949", errors="replace")
        raise HTTPException(status_code=500, detail=f"Worker Error: {err_msg.strip()}")

    if not stdout_str.strip():
        raise HTTPException(status_code=500, detail="Empty response")

    return json.loads(stdout_str.strip())

@app.get("/")
def get_index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

@app.post("/api/capture")
async def api_capture(req: CaptureRequest):
    loop = asyncio.get_event_loop()
    args = ["--mode", "capture", "--cond", str(req.cond), "--date", req.date, "--time", req.time]
    res = await loop.run_in_executor(None, run_subprocess_32bit, args)
    return res

@app.get("/api/dual_chart")
async def api_dual_chart(
    code: str = Query(..., description="Stock Code"),
    date: str = Query(..., description="Target Date YYYYMMDD"),
    timeframe: int = Query(3, description="Timeframe value"),
    unit: str = Query("m", description="m for minute, T for tick")
):
    loop = asyncio.get_event_loop()
    args = ["--mode", "dual_chart", "--code", code, "--date", date, "--timeframe", str(timeframe), "--unit", unit]
    res = await loop.run_in_executor(None, run_subprocess_32bit, args)
    return res

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000, access_log=False)