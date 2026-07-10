// ══════════════════════════════════════════════════════════════
// 최근 7일 자산 변동 — users/{uid}/assetHistory(서버가 하루 1번 기록한
// {totalAssets,cash,stockValue,at} 스냅샷)를 그대로 읽어와 캔들/스파크라인
// 렌더링은 전부 클라이언트에서 계산한다. 하루 1점만 기록되므로 "캔들"은
// 실제 일중 시가/고가/저가가 아니라 전일 종가→오늘 값을 이은 단순화된
// 형태다(당일 여러 번 기록하면 저장 비용이 유저 수만큼 커지므로 의도적으로
// 하루 1번만 기록). Chart.js + chartjs-chart-financial은 index.html에서
// 이미 전역 스크립트로 로드돼 있어 별도 import 없이 window.Chart를 쓴다.
// ══════════════════════════════════════════════════════════════

/**
 * @param {object} deps
 * @param {() => object|null} deps.getMyData
 * @param {() => Array} deps.getAllStocks
 */
export function initAssetHistory({ getMyData, getAllStocks }) {
    let chartInstance = null;
    let currentMode = 'candle'; // 'candle' | 'sparkline'

    function escapeCaption(str) {
        const div = document.createElement('div');
        div.innerText = str;
        return div.innerHTML;
    }

    function crewNameToHue(name) {
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360;
        return Math.abs(hash) % 360;
    }

    function detectMyCrew() {
        const myData = getMyData();
        const allStocks = getAllStocks();
        if (!myData?.stocks) return null;
        let best = null;
        Object.entries(myData.stocks).forEach(([id, pos]) => {
            if (!pos?.qty) return;
            const stock = allStocks.find(s => s.id === id);
            if (!stock) return;
            const m = stock.name.match(/^\[(.+?)\]/);
            if (!m) return;
            const value = (stock.price || 0) * pos.qty;
            if (!best || value > best.value) best = { crew: m[1], value };
        });
        return best ? best.crew : null;
    }

    function themeColors(themeKey, crewName) {
        if (themeKey === 'gold') return { bg: 'linear-gradient(160deg,#1c1509,#3b2a0f)', accent: '#fbbf24' };
        if (themeKey === 'crew' && crewName) {
            const hue = crewNameToHue(crewName);
            return { bg: `linear-gradient(160deg,hsl(${hue},45%,12%),hsl(${hue},40%,20%))`, accent: `hsl(${hue},85%,60%)` };
        }
        return { bg: 'linear-gradient(160deg,#0f172a,#1e293b)', accent: '#38bdf8' };
    }

    // ── 데이터 준비 ─────────────────────────────────────────────
    function getHistoryPoints() {
        const myData = getMyData();
        const hist = myData?.assetHistory || {};
        const dates = Object.keys(hist).sort();
        const last7 = dates.slice(-7);
        return last7.map(d => ({ date: d, ...hist[d] }));
    }

    function buildCandleData(points) {
        return points.map((p, i) => {
            const prevClose = i === 0 ? p.totalAssets : points[i - 1].totalAssets;
            const open  = prevClose;
            const close = p.totalAssets;
            return {
                x: new Date(p.date).getTime(),
                o: open, h: Math.max(open, close), l: Math.min(open, close), c: close,
            };
        });
    }

    function buildSparklineData(points) {
        return points.map(p => ({ x: new Date(p.date).getTime(), y: p.totalAssets }));
    }

    // ── 메인 모달 (캔들/스파크라인 토글) ────────────────────────
    function renderMainChart() {
        const canvas   = document.getElementById('asset-history-canvas');
        const emptyMsg = document.getElementById('asset-history-empty');
        if (!canvas) return;

        const points = getHistoryPoints();
        if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

        if (points.length < 2) {
            canvas.style.display = 'none';
            emptyMsg.style.display = 'flex';
            return;
        }
        canvas.style.display = '';
        emptyMsg.style.display = 'none';

        const timeScale = {
            type: 'time',
            time: { unit: 'day', displayFormats: { day: 'M/d' } },
            grid:  { color: 'rgba(51,65,85,0.3)', drawTicks: false },
            ticks: { color: '#94a3b8', font: { size: 11 } },
        };
        const valueScale = {
            position: 'right',
            grid:  { color: 'rgba(51,65,85,0.3)', drawTicks: false },
            ticks: { color: '#94a3b8', font: { size: 11 }, callback: (v) => v.toLocaleString() + '원' },
        };

        if (currentMode === 'candle') {
            chartInstance = new Chart(canvas, {
                type: 'candlestick',
                data: {
                    datasets: [{
                        label: '', data: buildCandleData(points),
                        color:       { up: '#ef4444', down: '#3b82f6', unchanged: '#94a3b8' },
                        borderColor: { up: '#ef4444', down: '#3b82f6', unchanged: '#94a3b8' },
                    }],
                },
                options: {
                    responsive: true, maintainAspectRatio: false, animation: false,
                    plugins: { legend: { display: false } },
                    scales: { x: timeScale, y: valueScale },
                },
            });
        } else {
            chartInstance = new Chart(canvas, {
                type: 'line',
                data: {
                    datasets: [{
                        label: '', data: buildSparklineData(points),
                        borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.15)',
                        fill: true, tension: 0.3, pointRadius: 3, pointBackgroundColor: '#38bdf8',
                    }],
                },
                options: {
                    responsive: true, maintainAspectRatio: false, animation: false,
                    plugins: { legend: { display: false } },
                    scales: { x: timeScale, y: valueScale },
                },
            });
        }
    }

    window.setAssetHistoryMode = function(mode) {
        currentMode = mode;
        document.querySelectorAll('.asset-history-mode-btn').forEach(b => {
            const isActive = b.dataset.mode === mode;
            b.style.background = isActive ? '#38bdf8' : '#334155';
            b.style.color      = isActive ? '#0f172a' : '#94a3b8';
        });
        renderMainChart();
    };

    window.openAssetHistoryModal = function() {
        document.getElementById('asset-history-modal')?.classList.add('active');
        window.setAssetHistoryMode(currentMode); // 버튼 상태 초기화 + 렌더링까지 겸함
    };
    window.closeAssetHistoryModal = function() {
        document.getElementById('asset-history-modal')?.classList.remove('active');
    };

    // ── 스크린샷 모드 (손익 랭킹·보유 자산 카드와 동일한 뼈대) ──
    window.selectAssetHistoryShareTheme = function(theme) {
        document.querySelectorAll('.asset-history-share-theme-btn').forEach(b => {
            const isActive = b.dataset.theme === theme;
            b.style.border = isActive ? '2px solid #38bdf8' : '1px solid #475569';
            b.style.opacity = isActive ? '1' : '0.7';
            b.dataset.active = isActive ? '1' : '0';
        });
        renderAssetHistoryShareCard();
    };

    function selectedAssetHistoryShareTheme() {
        return document.querySelector('.asset-history-share-theme-btn[data-active="1"]')?.dataset.theme || 'default';
    }

    let shareChartInstance = null;

    function renderAssetHistoryShareCard() {
        const points = getHistoryPoints();
        const card = document.getElementById('asset-history-share-card');
        if (!card) return;

        const crewName = detectMyCrew();
        const { bg, accent } = themeColors(selectedAssetHistoryShareTheme(), crewName);

        const showChangePct = document.getElementById('asset-history-opt-change')?.checked;
        const showDate       = document.getElementById('asset-history-opt-date')?.checked;
        const showCrew        = !!crewName && document.getElementById('asset-history-opt-crew')?.checked;
        const caption          = (document.getElementById('asset-history-opt-caption')?.value || '').trim();
        const dateStr = new Date().toLocaleDateString('ko-KR');

        const first = points[0]?.totalAssets ?? 0;
        const last  = points[points.length - 1]?.totalAssets ?? 0;
        const changePct = first ? ((last - first) / first) * 100 : 0;
        const changeSign  = changePct > 0 ? '+' : '';
        const changeColor = changePct > 0 ? '#4ade80' : changePct < 0 ? '#f87171' : '#94a3b8';

        card.style.background = bg;
        card.innerHTML = `
            <div style="text-align:center;font-size:11px;font-weight:800;letter-spacing:1px;color:${accent};text-transform:uppercase;margin-bottom:4px;">SOOP STOCK</div>
            <div style="text-align:center;font-size:11px;color:#94a3b8;font-weight:700;margin-bottom:16px;">최근 ${points.length}일 자산 변동</div>
            ${showCrew ? `<div style="text-align:center;margin-bottom:10px;"><span style="display:inline-block;background:rgba(255,255,255,0.12);color:${accent};font-size:11px;font-weight:700;padding:4px 10px;border-radius:100px;">[${escapeCaption(crewName)}] 소속 트레이더</span></div>` : ''}
            <div style="text-align:center;margin-bottom:10px;">
                <div style="font-size:26px;font-weight:900;color:${accent};line-height:1;">${Math.floor(last).toLocaleString()}원</div>
                ${showChangePct ? `<div style="font-size:13px;font-weight:800;color:${changeColor};margin-top:4px;">${changeSign}${changePct.toFixed(1)}%</div>` : ''}
            </div>
            <div style="flex:1;min-height:0;position:relative;"><canvas id="asset-history-share-canvas"></canvas></div>
            ${caption ? `<div style="text-align:center;font-size:12px;color:#f8fafc;margin-top:14px;font-style:italic;">"${escapeCaption(caption)}"</div>` : ''}
            ${showDate ? `<div style="text-align:center;font-size:10px;color:#64748b;margin-top:${caption ? '8px' : '14px'};">${dateStr}</div>` : ''}
        `;

        if (shareChartInstance) { shareChartInstance.destroy(); shareChartInstance = null; }
        if (points.length >= 2) {
            const canvas = document.getElementById('asset-history-share-canvas');
            shareChartInstance = new Chart(canvas, {
                type: 'line',
                data: {
                    datasets: [{
                        data: buildSparklineData(points),
                        borderColor: accent, backgroundColor: 'transparent',
                        fill: false, tension: 0.3, pointRadius: 0, borderWidth: 2,
                    }],
                },
                options: {
                    responsive: true, maintainAspectRatio: false, animation: false,
                    plugins: { legend: { display: false }, tooltip: { enabled: false } },
                    scales: { x: { display: false }, y: { display: false } },
                },
            });
        }
    }
    window.renderAssetHistoryShareCard = renderAssetHistoryShareCard;

    window.openAssetHistoryShareCardModal = function() {
        const points = getHistoryPoints();
        if (points.length < 2) {
            alert('아직 그래프로 보여드릴 데이터가 부족해요. 매일 접속하면 하루씩 쌓여요!');
            return;
        }
        const crewName = detectMyCrew();
        const crewLabel = document.getElementById('asset-history-opt-crew-label');
        const crewThemeBtn = document.getElementById('asset-history-share-theme-crew-btn');
        if (crewLabel) crewLabel.style.display = crewName ? 'flex' : 'none';
        if (crewThemeBtn) crewThemeBtn.style.display = crewName ? 'inline-block' : 'none';

        document.getElementById('asset-history-share-card-modal')?.classList.add('active');
        window.selectAssetHistoryShareTheme('default');
    };
    window.closeAssetHistoryShareCardModal = function() {
        document.getElementById('asset-history-share-card-modal')?.classList.remove('active');
    };
}
