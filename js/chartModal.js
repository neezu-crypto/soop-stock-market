import { ref, get } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-database.js";

// ══════════════════════════════════════════════════════════════
// 분봉 차트 모달 — 종목 카드 클릭 시 열리는 캔들 차트 + 모달 내 거래.
// index.html의 핵심 상태(allStocks/myData)에는 읽기 전용으로만 접근하므로
// (여기서 직접 재할당하지 않으므로) getAllStocks 접근자로 안전하게 분리했다.
// ══════════════════════════════════════════════════════════════

// candlesticks/{stockId}/{minuteTs} = { o, h, l, c, v, t }
// 분봉 기록·정리는 매매 처리(functions/trade.js의 trade 콜러블)에서 서버가 수행한다.

/**
 * n분봉으로 집계: 1분봉 배열 → n분봉 배열
 * intervalMin: 1 | 3 | 5 | 10 | 30
 */
function aggregateCandles(rawCandles, intervalMin) {
    if (intervalMin <= 1) return rawCandles;
    const intervalSec = intervalMin * 60;
    const buckets = {};
    rawCandles.forEach(c => {
        const bucketTs = Math.floor(c.t / intervalSec) * intervalSec;
        if (!buckets[bucketTs]) {
            buckets[bucketTs] = { o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, t: bucketTs };
        } else {
            buckets[bucketTs].h  = Math.max(buckets[bucketTs].h, c.h);
            buckets[bucketTs].l  = Math.min(buckets[bucketTs].l, c.l);
            buckets[bucketTs].c  = c.c;
            buckets[bucketTs].v += c.v;
        }
    });
    return Object.values(buckets).sort((a, b) => a.t - b.t);
}

/**
 * 기간 필터: 현재 시각 기준 timeframeMin 이내 캔들만 반환
 */
function filterByTimeframe(candles, timeframeMin) {
    const cutoffSec = Math.floor(Date.now() / 1000) - timeframeMin * 60;
    return candles.filter(c => c.t >= cutoffSec);
}

/**
 * 차트 모달 초기화 — index.html(main 스크립트)이 시작 시 1회 호출한다.
 * @param {object} deps
 * @param {import('firebase/database').Database} deps.db
 * @param {() => Array} deps.getAllStocks - 현재 allStocks 배열을 반환하는 접근자(재할당에도 항상 최신값)
 * @param {(id: string) => string} deps.getChangePercent
 * @returns {{ closeChartModal: () => void, getCurrentStockId: () => string|null }} 다른 모듈(promotions.js)에서
 *   차트 모달을 닫거나, 현재 열려 있는 종목(차트 하단 배너 신청 대상)을 알아야 할 때 사용
 */
export function initChartModal({ db, getAllStocks, getChangePercent }) {

    // ══════════════════════════════════════════════════════════
    // 차트 모달 상태
    // ══════════════════════════════════════════════════════════
    let chartModalStockId    = null;   // 현재 열린 종목 ID
    let chartTimeframeMin    = 10;     // 보여줄 기간 (분)
    let chartIntervalMin     = 1;      // 분봉 단위 (분)
    let candleChartInstance  = null;   // Chart.js 인스턴스
    let candleDataCache      = [];     // Firebase에서 받은 원시 캔들 배열
    let chartIsLoading       = false;  // 중복 fetch 방지

    // ── 차트 모달 열기 ───────────────────────────────────────────
    window.openChartModal = function(stockId) {
        const s = getAllStocks().find(x => x.id === stockId);
        if (!s) return;

        chartModalStockId = stockId;

        const overlay = document.getElementById('chart-modal-overlay');
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';

        updateChartModalHeader(s);

        // 탭 초기화
        document.querySelectorAll('.tf-tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.tf-tab[data-minutes="10"]').classList.add('active');
        document.querySelectorAll('.int-tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.int-tab[data-interval="1"]').classList.add('active');
        chartTimeframeMin = 10;
        chartIntervalMin  = 1;

        // 캐시 초기화 후 1회 fetch
        candleDataCache = [];
        if (candleChartInstance) { candleChartInstance.destroy(); candleChartInstance = null; }
        fetchCandles(stockId);

        // 하단 광고 배너 1회 fetch (종목별 개별 노출)
        fetchChartBanner(stockId);
    };

    // ── 차트 모달 하단 광고 배너 1회 fetch (종목별 개별 노출) ──
    // Firebase: chartBanner/{stockId} = { img, link, endDate }
    async function fetchChartBanner(stockId) {
        const linkEl  = document.getElementById('chart-ad-link');
        const imgEl   = document.getElementById('chart-ad-img');
        const emptyEl = document.getElementById('chart-ad-empty');

        // 초기화: 둘 다 숨기고 시작
        if (linkEl)  linkEl.style.display  = 'none';
        if (emptyEl) emptyEl.style.display = 'none';

        try {
            const snap = await get(ref(db, `chartBanner/${stockId}`));

            // 데이터 없거나 만료 → 모집 안내 표시
            if (!snap.exists() || !snap.val().img) {
                if (emptyEl) emptyEl.style.display = 'flex';
                return;
            }

            const data = snap.val();

            if (data.endDate) {
                const end = new Date(data.endDate);
                end.setHours(23, 59, 59, 999);
                if (end < new Date()) {
                    if (emptyEl) emptyEl.style.display = 'flex'; // 만료 → 모집 안내
                    return;
                }
            }

            // 광고 있음 → 배너 이미지 표시
            imgEl.src          = data.img;
            linkEl.href        = data.link || '#';
            linkEl.style.display = 'flex';

        } catch (e) {
            // fetch 실패 시 모집 안내 표시
            if (emptyEl) emptyEl.style.display = 'flex';
        }
    }

    function updateChartModalHeader(s) {
        const change = getChangePercent(s.id);
        const isUp   = parseFloat(change) >= 0;
        document.getElementById('cm-name').textContent   = s.name;
        const priceEl = document.getElementById('cm-price');
        priceEl.textContent  = `${(s.price || 0).toLocaleString()}원`;
        priceEl.className    = `stock-title-price ${isUp ? 'up' : 'down'}`;
        const changeEl = document.getElementById('cm-change');
        changeEl.textContent = `${isUp ? '+' : ''}${change}%`;
        changeEl.className   = `stock-title-change ${isUp ? 'up' : 'down'}`;

        // 동결 상태에 따라 안내 배너 표시 + 거래 버튼 비활성화
        const isFrozen  = !!s.frozenAt;
        const banner    = document.getElementById('cm-frozen-banner');
        if (banner) banner.style.display = isFrozen ? 'block' : 'none';
        ['cm-buy10', 'cm-buy1', 'cm-sell1', 'cm-sell10'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.disabled = isFrozen;
        });
    }

    // ── 차트 모달 닫기 ───────────────────────────────────────────
    function closeChartModal() {
        document.getElementById('chart-modal-overlay').classList.remove('active');
        document.body.style.overflow = '';
        if (candleChartInstance) { candleChartInstance.destroy(); candleChartInstance = null; }
        chartModalStockId = null;
        candleDataCache   = [];
        chartIsLoading    = false;
    }
    window.closeChartModal = closeChartModal;
    document.getElementById('chart-modal-close-btn').addEventListener('click', closeChartModal);
    document.getElementById('chart-modal-overlay').addEventListener('click', (e) => {
        if (e.target === document.getElementById('chart-modal-overlay')) closeChartModal();
    });

    // ── 기간 탭 ─────────────────────────────────────────────────
    document.querySelectorAll('.tf-tab').forEach(tab => {
        tab.addEventListener('click', function () {
            document.querySelectorAll('.tf-tab').forEach(t => t.classList.remove('active'));
            this.classList.add('active');
            chartTimeframeMin = parseInt(this.dataset.minutes);
            renderCandleChart();
        });
    });

    // ── 분봉 단위 탭 ─────────────────────────────────────────────
    document.querySelectorAll('.int-tab').forEach(tab => {
        tab.addEventListener('click', function () {
            document.querySelectorAll('.int-tab').forEach(t => t.classList.remove('active'));
            this.classList.add('active');
            chartIntervalMin = parseInt(this.dataset.interval);
            renderCandleChart();
        });
    });

    // ── Firebase 분봉 1회 읽기 (onValue 구독 없음) ──────────────
    // 모달을 열 때 단 1번만 get() 호출 → 이후 탭 전환은 캐시만 사용
    async function fetchCandles(stockId) {
        if (chartIsLoading) return;
        chartIsLoading = true;

        // 로딩 표시
        const emptyMsg = document.getElementById('chart-empty-msg');
        const canvas   = document.getElementById('candleChart');
        if (canvas)   canvas.style.display   = 'none';
        if (emptyMsg) {
            emptyMsg.style.display = 'flex';
            emptyMsg.innerHTML = `<div class="empty-icon">⏳</div><div>데이터 불러오는 중...</div>`;
        }

        try {
            const snap = await get(ref(db, `candlesticks/${stockId}`));
            if (snap.exists()) {
                const raw = snap.val();
                candleDataCache = Object.values(raw)
                    .map(c => ({ o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0, t: c.t }))
                    .sort((a, b) => a.t - b.t);
            } else {
                candleDataCache = [];
            }
        } catch (e) {
            console.warn('[candle] fetch 실패:', e.message);
            candleDataCache = [];
        } finally {
            chartIsLoading = false;
        }

        // 모달이 닫혔으면 렌더 스킵
        if (!chartModalStockId) return;

        // 빈 데이터 메시지 원복 후 차트 렌더
        if (emptyMsg) {
            emptyMsg.innerHTML = `
                <div class="empty-icon">📊</div>
                <div>거래 데이터가 아직 없습니다</div>
                <div style="font-size:12px;">첫 거래가 발생하면 분봉 차트가 생성됩니다</div>`;
        }
        renderCandleChart();
    }

    // ── 차트 렌더링 ──────────────────────────────────────────────
    function renderCandleChart() {
        const canvas   = document.getElementById('candleChart');
        const emptyMsg = document.getElementById('chart-empty-msg');
        if (!canvas) return;

        // 기간 + 분봉 필터링
        const filtered    = filterByTimeframe(candleDataCache, chartTimeframeMin);
        const aggregated  = aggregateCandles(filtered, chartIntervalMin);

        // 거래량 합계
        const totalVol = aggregated.reduce((sum, c) => sum + (c.v || 0), 0);
        document.getElementById('cm-volume').textContent = `거래량: ${totalVol.toLocaleString()}주`;

        // 데이터 범위 표시
        if (aggregated.length >= 2) {
            const from = new Date(aggregated[0].t * 1000);
            const to   = new Date(aggregated[aggregated.length - 1].t * 1000);
            const fmt  = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
            document.getElementById('cm-data-range').textContent = `${fmt(from)} ~ ${fmt(to)}`;
        } else {
            document.getElementById('cm-data-range').textContent = '데이터: -';
        }

        // 데이터 없음
        if (aggregated.length === 0) {
            canvas.style.display = 'none';
            emptyMsg.style.display = 'flex';
            if (candleChartInstance) { candleChartInstance.destroy(); candleChartInstance = null; }
            return;
        }
        canvas.style.display = '';
        emptyMsg.style.display = 'none';

        // Chart.js 데이터 변환
        const chartData = aggregated.map(c => ({
            x: c.t * 1000,   // ms
            o: c.o, h: c.h, l: c.l, c: c.c
        }));

        if (candleChartInstance) {
            // 데이터만 교체 (부드럽게)
            candleChartInstance.data.datasets[0].data = chartData;
            candleChartInstance.update('none');
            return;
        }

        // 최초 생성
        candleChartInstance = new Chart(canvas, {
            type: 'candlestick',
            data: {
                datasets: [{
                    label: '',
                    data: chartData,
                    color: {
                        up:   '#ef4444',
                        down: '#3b82f6',
                        unchanged: '#94a3b8',
                    },
                    borderColor: {
                        up:   '#ef4444',
                        down: '#3b82f6',
                        unchanged: '#94a3b8',
                    }
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        enabled: false,
                        external: (ctx) => {
                            const item = ctx.tooltip?.dataPoints?.[0]?.raw;
                            if (!item) return;
                            const t   = new Date(item.x);
                            const fmt = `${t.getHours()}:${String(t.getMinutes()).padStart(2,'0')}`;
                            const isUp = item.c >= item.o;
                            const color = isUp ? '#ef4444' : '#3b82f6';
                            document.getElementById('cm-ohlc-bar').innerHTML = `
                                <span>⏰ <b>${fmt}</b></span>
                                <span style="margin-left:10px">시 <span style="color:${color}">${item.o.toLocaleString()}</span></span>
                                <span style="margin-left:10px">고 <span style="color:#ef4444">${item.h.toLocaleString()}</span></span>
                                <span style="margin-left:10px">저 <span style="color:#3b82f6">${item.l.toLocaleString()}</span></span>
                                <span style="margin-left:10px">종 <span style="color:${color};font-weight:800">${item.c.toLocaleString()}</span></span>
                            `;
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: chartIntervalMin >= 30 ? 'hour' : 'minute',
                            displayFormats: { minute: 'HH:mm', hour: 'HH:mm' }
                        },
                        grid:  { color: 'rgba(51,65,85,0.3)', drawTicks: false },
                        ticks: { color: '#94a3b8', maxTicksLimit: 8, font: { size: 11 } }
                    },
                    y: {
                        position: 'right',
                        grid:  { color: 'rgba(51,65,85,0.3)', drawTicks: false },
                        ticks: {
                            color: '#94a3b8',
                            font:  { size: 11 },
                            callback: (v) => v.toLocaleString() + '원'
                        }
                    }
                }
            },
            plugins: [{
                id: 'crosshair',
                afterDraw: (chart) => {
                    if (chart.tooltip?._active?.length) {
                        const { ctx, chartArea: { top, bottom, left, right } } = chart;
                        const activePoint = chart.tooltip._active[0];
                        const x = activePoint.element.x;
                        const y = activePoint.element.y;
                        ctx.save();
                        ctx.setLineDash([3, 3]);
                        ctx.lineWidth = 1;
                        ctx.strokeStyle = 'rgba(148, 163, 184, 0.8)';
                        ctx.beginPath(); ctx.moveTo(x, top);   ctx.lineTo(x, bottom); ctx.stroke();
                        ctx.beginPath(); ctx.moveTo(left, y);  ctx.lineTo(right, y);  ctx.stroke();
                        ctx.restore();
                    }
                }
            }]
        });
    }

    // ── 모달 내 거래 ─────────────────────────────────────────────
    window.tradeFromModal = function(type, qty) {
        if (!chartModalStockId) return;
        window.trade(chartModalStockId, type, qty);
    };

    return { closeChartModal, getCurrentStockId: () => chartModalStockId };
}
