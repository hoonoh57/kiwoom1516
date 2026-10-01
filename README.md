# Kiwoom 1516 Visual Quant Workbench

키움 1516 성과검증 목록과 Cybos Plus 캔들을 조회하여 S4~S4.3을 비교하는 Windows 로컬 분석 도구입니다.
FastAPI 웹 UI와 별도의 PyQt 데스크톱 UI, 32비트 데이터 수집 브리지를 포함합니다.

**S4.4는 채택 보류 상태입니다.** 일반 실행은 비활성화되어 있고 실패한 실험의 재현 코드만 보존합니다.
기존 S4~S4.3의 지표·평가 함수와 회귀 검증용 원본은 유지합니다. 상세 내용은 [전략 기록](docs/S4.4.md)을 참고하세요.

## 실행 환경

- Windows, 로그인된 키움 1516 창 및 Cybos Plus 연결
- 웹/데스크톱: 64비트 Python (현재 로컬 환경: Python 3.13)
- 데이터 브리지: 별도의 32비트 Python (현재 코드의 경로: `E:\Python310-32\python.exe`)
- 오프라인 JavaScript 테스트: Node.js 18 이상, 별도 npm 패키지 설치 불필요

32비트 Python 경로가 다르면 `web_server.py`와 `main_app_64bit.py`의 `PYTHON_32_EXE`를 로컬 환경에 맞게 설정해야 합니다.
가상환경 자체는 공유하지 않습니다. 의존성 파일은 기존 환경의 직접 의존성을 기록했으며 새 환경에서의 전체 설치 검증은 별도로 필요합니다.

```powershell
# 64비트 Python으로 실행
python -m venv venv
.\venv\Scripts\python.exe -m pip install -r requirements.txt

# 32비트 브리지에 별도로 설치
& 'E:\Python310-32\python.exe' -m pip install -r requirements-bridge.txt

# 웹 UI: http://127.0.0.1:8000
.\venv\Scripts\python.exe web_server.py
```

데스크톱 UI는 같은 64비트 환경에 `requirements-desktop.txt`를 설치한 뒤 `main_app_64bit.py`로 실행합니다.
`run_web.bat` / `run_64bit.bat`는 스크립트 폴더에서 실행되며 현재 PATH의 `python`을 사용하므로, 먼저 해당 환경을 활성화하세요.
웹 차트 및 스타일은 HTML에 지정된 외부 CDN을 사용합니다. `.env` 파일을 자동으로 로드하는 기능은 현재 없습니다.

## 검증과 데이터 분석

```powershell
node --test tests/strategy_s44.test.cjs tests/audit_downloader.test.cjs
node scripts/audit_s44.cjs 'C:\path\to\strategy-audit-example.json'
```

`tests/fixtures/app.pre-s44.js`는 원본 전략 코드이며 다운로드한 시장 데이터가 아닙니다.
이 파일과 `static/app.js`는 원본 동일성 검증을 위해 `.gitattributes`에서 줄바꿈 변환을 금지합니다.
실제 캔들 자료와 분석 결과는 로컬에서만 관리합니다. 오프라인 재현 스크립트는 주문을 전송하지 않습니다.

## 저장소에 포함하지 않는 자료

`.gitignore`는 다음 자료를 제외합니다.

- `venv/`, Python 캐시, 빌드 및 테스트 산출물
- `reports/`, `data/`, `exports/`, `downloads/` 등 로컬 데이터 폴더
- `strategy-audit-*.json`, `*.replay.json`, 로그, 로컬 데이터베이스
- `.env` 및 환경별 값, 자격증명 폴더, 개인키·인증서, 로컬 설정
- IDE 및 에이전트의 로컬 설정

실제 계좌번호, 비밀번호, API 토큰은 소스에 입력하지 마세요. 주문 엔진의 계좌번호 기본값은 비워 두며 필요 시 호출부에서 전달합니다.
`.gitignore`는 임의 이름의 파일 내용까지 검사하지 않으므로, 새 자료를 추가할 때는 스테이징 목록과 내용을 확인하세요.

```powershell
git status --short --ignored
git diff --cached --stat
git diff --cached --check
git diff --cached
```

대상 원격 저장소는 `https://github.com/hoonoh57/kiwoom1516.git`입니다.
실제 업로드는 커밋 작성자와 스테이징 내용을 확인한 뒤 별도로 진행합니다.


## S4.3R Python P0

`s43r_engine.py`는 주문 기능이 없는 봉 단위 전략 엔진입니다. `evaluate()` 재생과 `S43REngine.step()`이 같은 지표·상태기계를 사용합니다. 원본 대조 결과와 사용법은 [S4.3R 명세서](docs/S4.3R_SPEC.md)에 있습니다.

```powershell
python -m unittest discover -s tests -p test_s43r_engine.py -v
```

고정 학습자료 20일 × 572종목 × 조기진입 ON/OFF·MACD 0.20/0.30 = 2,288개 설정별 결과를 Node.js 원본과 비교합니다. 실제 학습 파일은 로컬 `data/`에 필요합니다. 2026-09-30 이후 자료는 이 비교에서 제외합니다. P1 시세 수집 및 P2 주문 연동은 아직 구현하지 않았습니다.
