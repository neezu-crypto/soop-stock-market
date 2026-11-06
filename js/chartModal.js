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
export function initChartModal({ db, getAllStocks, getChangePercent, getChartBanners }) {

    // ══════════════════════════════════════════════════════════
    // 차트 모달 상태
    // ══════════════════════════════════════════════════════════
    let chartModalStockId    = null;   // 현재 열린 종목 ID
    let chartTimeframeMin    = 10;     // 보여줄 기간 (분)
    let chartIntervalMin     = 1;      // 분봉 단위 (분)
    let candleChartInstance  = null;   // Chart.js 인스턴스
    let candleDataCache      = [];     // Firebase에서 받은 원시 캔들 배열
    let chartIsLoading       = false;  // 중복 fetch 방지
    let bannerRequestId = 0;
    let bannerExpiryTimer = null;
    // 공통 배너는 한 번에 하나만 노출되고 변경 빈도가 낮다. 모달을 열 때마다
    // 함수 왕복 → 이미지 다운로드를 직렬로 기다리지 않도록 페이지 체류 중 캐시한다.
    const CHART_BANNER_CACHE_TTL_MS = 60 * 1000;
    let cachedChartBanners = null;
    let chartBannerCachedAt = 0;
    let chartBannerFetchPromise = null;
    const warmedBannerImages = new Set();

    function preloadBannerImage(source) {
        const url = String(source || '').trim();
        if (!url || warmedBannerImages.has(url)) return;
        warmedBannerImages.add(url);
        const image = new Image();
        image.decoding = 'async';
        // fetchPriority를 지원하는 브라우저에서는 모달 진입 전 이미지 요청을
        // 우선 처리한다. 미지원 브라우저는 일반 선로딩으로 자연스럽게 동작한다.
        image.fetchPriority = 'high';
        image.src = url;
    }

    function warmBannerImages(banners) {
        (Array.isArray(banners) ? banners : []).forEach((banner) => preloadBannerImage(banner?.img));
    }

    async function loadSharedChartBanners({ force = false } = {}) {
        const isFresh = cachedChartBanners !== null && (Date.now() - chartBannerCachedAt) < CHART_BANNER_CACHE_TTL_MS;
        if (!force && isFresh) return cachedChartBanners;
        if (chartBannerFetchPromise) return chartBannerFetchPromise;
        chartBannerFetchPromise = getChartBanners()
            .then((response) => {
                cachedChartBanners = Array.isArray(response.data?.banners) ? response.data.banners : [];
                chartBannerCachedAt = Date.now();
                warmBannerImages(cachedChartBanners);
                return cachedChartBanners;
            })
            .finally(() => { chartBannerFetchPromise = null; });
        return chartBannerFetchPromise;
    }

    // 사용자가 차트를 열기 전부터 공통 배너와 이미지를 준비한다.
    // 실패해도 모달 진입 시 기존 재시도 경로가 그대로 동작한다.
    void loadSharedChartBanners().catch(() => {});

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

        // 모든 차트에서 공통 광고 목록을 표시한다.
        fetchChartBanner();
    };

    async function fetchChartBanner() {
        const requestId = ++bannerRequestId;
        clearTimeout(bannerExpiryTimer);
        const linkEl = document.getElementById('chart-ad-link');
        const imgEl = document.getElementById('chart-ad-img');
        const emptyEl = document.getElementById('chart-ad-empty');
        const emptyTextEl = document.getElementById('chart-ad-empty-text');
        const emptyCtaEl = document.getElementById('chart-ad-empty-cta');
        function showMessage(message, allowApply) {
            linkEl.style.display = 'none';
            emptyEl.style.display = 'flex';
            emptyEl.style.cursor = allowApply ? 'pointer' : 'default';
            emptyEl.onclick = allowApply ? () => window.openChartAdModal() : null;
            emptyTextEl.textContent = message;
            emptyCtaEl.style.display = allowApply ? '' : 'none';
        }

        function render(banners) {
            if (requestId !== bannerRequestId || !chartModalStockId) return;
            const now = Date.now();
            const active = banners.filter(b => !b.expiresAt || b.expiresAt > now);
            if (!active.length) {
                clearTimeout(bannerExpiryTimer);
                showMessage('이 자리에 내 방송국을 홍보해보세요!', true);
                return;
            }
            const banner = active[0];
            preloadBannerImage(banner.img);
            imgEl.src = banner.img;
            imgEl.alt = banner.name ? `${banner.name} 광고 배너` : '광고 배너';
            if (banner.link) linkEl.href = banner.link;
            else linkEl.removeAttribute('href');
            linkEl.style.display = 'flex';
            emptyEl.style.display = 'none';

            const expiresAt = Number(banner.expiresAt);
            if (banner.expiresAt == null || !Number.isFinite(expiresAt)) return;
            const scheduleExpiry = () => {
                const remaining = expiresAt - Date.now();
                if (remaining <= 0) { render(banners); return; }
                bannerExpiryTimer = setTimeout(scheduleExpiry, Math.min(remaining, 2147483647));
            };
            scheduleExpiry();
        }

        // 캐시가 있으면 그 즉시 그린다. 최신화는 배경에서만 진행해 배너가
        // 매 모달 진입마다 사라졌다가 다시 나타나는 현상을 없앤다.
        const cachedBeforeRefresh = cachedChartBanners;
        const hasCachedBanner = cachedBeforeRefresh !== null;
        if (hasCachedBanner) render(cachedBeforeRefresh);
        else showMessage('배너를 불러오는 중…', false);

        try {
            const banners = await loadSharedChartBanners({ force: !hasCachedBanner });
            if (!hasCachedBanner || banners !== cachedBeforeRefresh) render(banners);
        } catch (e) {
            if (!hasCachedBanner && requestId === bannerRequestId && chartModalStockId) {
                showMessage('배너를 불러오지 못했어요. 차트를 다시 열어주세요.', false);
            }
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

        // 동결/동결임박 상태에 따라 안내 배너 표시 + 거래 버튼 비활성화
        // (임박 판정 기준값은 index.html 카드 뱃지와 동일하게 유지 — 실제
        // 동결 판정(연속 5개 1분봉)은 서버에서만 하고, 여기서는 근접 여부만
        // 근사치로 보여준다.)
        const isFrozen     = !!s.frozenAt;
        const isNearFreeze = !isFrozen && (s.price || 0) >= 1000000;
        const frozenBanner     = document.getElementById('cm-frozen-banner');
        const nearFreezeBanner = document.getElementById('cm-near-freeze-banner');
        if (frozenBanner)     frozenBanner.style.display     = isFrozen ? 'block' : 'none';
        if (nearFreezeBanner) nearFreezeBanner.style.display = isNearFreeze ? 'block' : 'none';

        if (isFrozen) {
            const deadlineEl = document.getElementById('cm-frozen-deadline');
            if (deadlineEl) {
                const msLeft = (s.freezeDeadline || 0) - Date.now();
                if (msLeft > 0) {
                    const hoursLeft = Math.floor(msLeft / 3600000);
                    const minsLeft  = Math.floor((msLeft % 3600000) / 60000);
                    deadlineEl.textContent = `⏰ ${hoursLeft}시간 ${minsLeft}분 내에 해제되지 않으면 상장폐지되어 보유 주식이 전액 소멸됩니다.`;
                } else {
                    deadlineEl.textContent = '⏰ 상장폐지 처리 대기 중입니다.';
                }
            }
        }
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
        bannerRequestId++;
        clearTimeout(bannerExpiryTimer);
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
