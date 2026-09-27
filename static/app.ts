// static/app.ts
import { 
    createChart, 
    IChartApi, 
    ISeriesApi, 
    CandlestickData, 
    Time, 
    SeriesMarker,
    LineData,
    ColorType
} from 'https://unpkg.com/lightweight-charts@5.0.2/dist/lightweight-charts.standalone.production.mjs';

interface RawCandle {
    date: string;
    time: string; // "0901"
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface StockItem {
    종목코드: string;
    종목명: string;
    '1분간': string;
    '3분간': string;
    '60분간': string;
    '기간 내 최고수익률(MFE)': string;
    '검색시점 거래량': string;
    기타?: string;
}

interface TradeSignal {
    time: Time;
    position: 'aboveBar' | 'belowBar';
    color: string;
    shape: 'arrowUp' | 'arrowDown';
    text: string;
}

class QuantTradingPlatform {
    private chart: IChartApi;
    private candleSeries: ISeriesApi<"Candlestick">;
    private volumeSeries: ISeriesApi<"Histogram">;
    private overlaySeriesMap: Map<string, ISeriesApi<"Line">> = new Map();
    
    private currentCandles: RawCandle[] = [];
    private captureTime: string = "0903";

    constructor() {
        this.initChart();
        this.bindEvents();
    }

    private initChart(): void {
        const container = document.getElementById('chart-container') as HTMLElement;
        this.chart = createChart(container, {
            layout: {
                background: { type: ColorType.Solid, color: '#141414' },
                textColor: '#d1d4dc',
            },
            grid: {
                vertLines: { color: '#232731' },
                horzLines: { color: '#232731' },
            },
            timeScale: {
                timeVisible: true,
                secondsVisible: false,
                borderColor: '#2b2b43',
            },
            rightPriceScale: {
                borderColor: '#2b2b43',
                scaleMargins: { top: 0.1, bottom: 0.25 },
            },
            crosshair: {
                mode: 1,
            },
        });

        // 메인 캔들스틱 시리즈 (국내 기준: 양봉 빨강, 음봉 파랑)
        this.candleSeries = this.chart.addCandlestickSeries({
            upColor: '#ef5350',
            downColor: '#26a69a',
            borderVisible: false,
            wickUpColor: '#ef5350',
            wickDownColor: '#26a69a',
        });

        // 거래량 히스토그램 시리즈 (하단 배치)
        this.volumeSeries = this.chart.addHistogramSeries({
            color: '#26a69a',
            priceFormat: { type: 'volume' },
            priceScaleId: '', // 별도 볼륨 스케일
        });
        this.volumeSeries.priceScale().applyOptions({
            scaleMargins: { top: 0.8, bottom: 0 },
        });

        window.addEventListener('resize', () => {
            this.chart.applyOptions({
                width: container.clientWidth,
                height: container.clientHeight
            });
        });
    }

    private bindEvents(): void {
        const btnCapture = document.getElementById('btn-capture') as HTMLButtonElement;
        btnCapture.addEventListener('click', () => this.executeCapture());

        const selStrategy = document.getElementById('sel-strategy') as HTMLSelectElement;
        selStrategy.addEventListener('change', () => this.applyStrategyAndMarkers());
    }

    private parseTimeToUTCTimestamp(dateStr: string, timeStr: string): Time {
        // YYYYMMDD + HHMM -> Unix Timestamp
        const year = parseInt(dateStr.substring(0, 4), 10);
        const month = parseInt(dateStr.substring(4, 6), 10) - 1;
        const day = parseInt(dateStr.substring(6, 8), 10);
        const hour = parseInt(timeStr.substring(0, 2), 10);
        const min = parseInt(timeStr.substring(2, 4), 10);
        const dt = new Date(Date.UTC(year, month, day, hour - 9, min)); // KST(UTC+9) 보정
        return (dt.getTime() / 1000) as Time;
    }

    public async executeCapture(): Promise<void> {
        const cond = (document.getElementById('edit-cond') as HTMLInputElement).value;
        const date = (document.getElementById('edit-date') as HTMLInputElement).value;
        const time = (document.getElementById('edit-time') as HTMLInputElement).value;

        this.captureTime = time.substring(0, 4);
        this.log(`[1516 캡처 요청] 조건식: ${cond}, 일자: ${date}, 시간: ${time}`);

        try {
            const resp = await fetch('/api/capture', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cond: parseInt(cond), date, time })
            });
            const res = await resp.json();
            if (res.status !== 'success') {
                this.log(`[캡처 에러] ${res.message}`);
                return;
            }

            this.renderTable(res.data);
            this.log(`[캡처 완료] 총 ${res.data.length}개 종목 로드 완료.`);
        } catch (e: any) {
            this.log(`[통신 실패] ${e.message}`);
        }
    }

    private renderTable(items: StockItem[]): void {
        const tbody = document.getElementById('table-body') as HTMLElement;
        tbody.innerHTML = '';

        items.forEach((item, idx) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${idx + 1}</td>
                <td class="font-mono font-bold text-sky-400">${item.종목코드 || '-'}</td>
                <td class="font-semibold">${item.종목명}</td>
                <td>${item['1분간'] || ''}</td>
                <td>${item['3분간'] || ''}</td>
                <td class="${this.getColorClass(item['60분간'])}">${item['60분간'] || ''}</td>
                <td class="text-amber-400 font-bold">${item['기간 내 최고수익률(MFE)'] || ''}</td>
                <td>${item['검색시점 거래량'] || ''}</td>
            `;

            tr.addEventListener('dblclick', () => {
                const date = (document.getElementById('edit-date') as HTMLInputElement).value;
                const tf = (document.getElementById('sel-tf') as HTMLSelectElement).value;
                this.loadStockChart(item.종목코드, item.종목명, date, parseInt(tf));
            });

            tbody.appendChild(tr);
        });
    }

    private getColorClass(val: string): string {
        if (!val) return '';
        if (val.includes('+')) return 'text-rose-500 font-bold';
        if (val.includes('-')) return 'text-blue-400';
        return '';
    }

    public async loadStockChart(code: string, name: string, date: string, timeframe: number): Promise<void> {
        if (!code) {
            this.log(`[경고] ${name} 종목코드가 없습니다.`);
            return;
        }

        this.log(`[CybosPlus 분봉 조회] ${name} (${code}) ${timeframe}분봉 수신 중...`);

        try {
            const resp = await fetch(`/api/chart?code=${code}&date=${date}&timeframe=${timeframe}`);
            const res = await resp.json();
            if (res.status !== 'success') {
                this.log(`[CybosPlus 에러] ${res.message}`);
                return;
            }

            this.currentCandles = res.candles;
            const chartTitle = document.getElementById('chart-title') as HTMLElement;
            chartTitle.innerText = `${name} (${code}) - ${date} [${timeframe}분봉]`;

            // Lightweight Charts 캔들 & 거래량 바인딩
            const candleData: CandlestickData[] = [];
            const volumeData: any[] = [];

            this.currentCandles.forEach(c => {
                const t = this.parseTimeToUTCTimestamp(c.date, c.time);
                candleData.push({
                    time: t,
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close,
                });
                volumeData.push({
                    time: t,
                    value: c.volume,
                    color: c.close >= c.open ? 'rgba(239, 83, 80, 0.4)' : 'rgba(38, 166, 154, 0.4)',
                });
            });

            this.candleSeries.setData(candleData);
            this.volumeSeries.setData(volumeData);

            this.applyStrategyAndMarkers();
            this.chart.timeScale().fitContent();

            this.log(`[차트 렌더 완료] ${name} 분봉 ${this.currentCandles.length}개 캔들 로드.`);
        } catch (e: any) {
            this.log(`[차트 로드 실패] ${e.message}`);
        }
    }

    private applyStrategyAndMarkers(): void {
        if (!this.currentCandles || this.currentCandles.length === 0) return;

        const selStrategy = (document.getElementById('sel-strategy') as HTMLSelectElement).value;
        const markers: SeriesMarker<Time>[] = [];

        // 1. 포착시점 탐색
        let entryIdx = -1;
        for (let i = 0; i < this.currentCandles.length; i++) {
            if (this.currentCandles[i].time >= this.captureTime) {
                entryIdx = i;
                break;
            }
        }

        if (entryIdx === -1) return;

        const entryCandle = this.currentCandles[entryIdx];
        const entryTime = this.parseTimeToUTCTimestamp(entryCandle.date, entryCandle.time);
        const entryPrice = entryCandle.close;

        // 포착 마커 추가
        markers.push({
            time: entryTime,
            position: 'belowBar',
            color: '#ffeb3b',
            shape: 'arrowUp',
            text: `포착/진입 @ ${entryPrice.toLocaleString()}`,
        });

        // 2. 전략 시뮬레이션
        let exitIdx = -1;
        let exitPrice = 0;
        let exitReason = '';

        if (selStrategy === 'hold60') {
            const tf = parseInt((document.getElementById('sel-tf') as HTMLSelectElement).value);
            const bars = Math.max(1, Math.floor(60 / tf));
            exitIdx = Math.min(this.currentCandles.length - 1, entryIdx + bars);
            exitPrice = this.currentCandles[exitIdx].close;
            exitReason = '60분 경과 타임컷';
        } else if (selStrategy === 'mfe5_cut2') {
            for (let i = entryIdx + 1; i < this.currentCandles.length; i++) {
                const c = this.currentCandles[i];
                const highGain = ((c.high - entryPrice) / entryPrice) * 100;
                const lowGain = ((c.low - entryPrice) / entryPrice) * 100;

                if (highGain >= 5.0) {
                    exitIdx = i;
                    exitPrice = entryPrice * 1.05;
                    exitReason = 'MFE +5% 익절';
                    break;
                } else if (lowGain <= -2.0) {
                    exitIdx = i;
                    exitPrice = entryPrice * 0.98;
                    exitReason = '-2% 손절';
                    break;
                }
            }
            if (exitIdx === -1) {
                exitIdx = this.currentCandles.length - 1;
                exitPrice = this.currentCandles[exitIdx].close;
                exitReason = '장마감 청산';
            }
        }

        if (exitIdx !== -1) {
            const exitCandle = this.currentCandles[exitIdx];
            const exitTime = this.parseTimeToUTCTimestamp(exitCandle.date, exitCandle.time);
            const pnl = ((exitPrice - entryPrice) / entryPrice) * 100;

            markers.push({
                time: exitTime,
                position: 'aboveBar',
                color: pnl >= 0 ? '#ef5350' : '#2196f3',
                shape: 'arrowDown',
                text: `청산(${exitReason}) @ ${exitPrice.toLocaleString()} (${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}%)`,
            });

            this.log(`[전략 실행: ${selStrategy}] 진입: ${entryPrice.toLocaleString()} -> 청산: ${exitPrice.toLocaleString()} | 수익률: ${pnl.toFixed(2)}% (${exitReason})`);
        }

        // Lightweight Charts Marker 설정
        this.candleSeries.setMarkers(markers);
    }

    private log(msg: string): void {
        const consoleEl = document.getElementById('log-console') as HTMLElement;
        const line = document.createElement('div');
        line.innerText = msg;
        consoleEl.appendChild(line);
        consoleEl.scrollTop = consoleEl.scrollHeight;
    }
}

// 부팅 인스턴스화
window.addEventListener('DOMContentLoaded', () => {
    new QuantTradingPlatform();
});