// ══════════════════════════════════════════════════════════════
// 홍보성 셀프 신청 5종 (우측 배너 / 차트 하단 배너 / 중계방 / 최상단 고정
// 노출 / 자산 충전) — 전부 myData/allStocks를 읽기만 하고 재할당하지
// 않으므로(단방향 의존성) index.html의 핵심 상태와 안전하게 분리했다.
// ══════════════════════════════════════════════════════════════

/**
 * @param {object} deps
 * @param {() => object|null} deps.getMyData
 * @param {() => Array} deps.getAllStocks
 * @param {import('firebase/auth').Auth} deps.auth
 * @param {string} deps.ADMIN_EMAIL
 * @param {() => void} deps.closeChartModal - 차트 하단 배너 신청 모달을 열 때 차트창을 먼저 닫기 위함
 * @param {() => string|null} deps.getCurrentChartStockId - 지금 열려 있는 차트 모달의 종목ID (없으면 null)
 * @param {object} deps.callables - httpsCallable로 미리 생성된 콜러블 참조 모음
 */
export function initPromotions({ getMyData, getAllStocks, auth, ADMIN_EMAIL, closeChartModal, getCurrentChartStockId, callables }) {
    const {
        submitBannerRequestCallable,
        submitChartBannerRequestCallable,
        submitPinRequestCallable,
        submitRelayRoomRequestCallable,
        submitCashChargeRequestCallable,
        unfreezeWithCashCallable,
        submitUnfreezeDonationRequestCallable,
        submitListingRequestCallable,
    } = callables;

    // 차트 하단 배너는 "지금 열어둔 그 종목"에 붙이는 게 목적이라, 모달을 여는
    // 순간(=차트가 열려 있는 순간) 종목ID를 붙잡아둔다. 닉네임 입력값으로 종목을
    // 찾거나 새로 상장하던 예전 방식은 닉네임이 종목명과 다르면 의도치 않은
    // 새 종목이 생기는 문제가 있었다.
    let pendingChartAdStockId = null;

    // ── 모달 ─────────────────────────────────────────────────────
    window.openPromoModal    = () => {
        if (!requireLoginOrPrompt()) return;
        populatePromoStockDatalist();
        checkPromoStockListed();
        document.getElementById('promo-modal').classList.add('active');
    };
    window.closePromoModal   = () => document.getElementById('promo-modal').classList.remove('active');

    // ── 신청 폼 공통 유틸 (아이디/URL 검증, 이미지 미리보기, 기간→비용 계산, 제출) ──
    const SOOP_ID_RE = /^[a-z0-9]{2,20}$/;
    const isValidSoopId = (v) => SOOP_ID_RE.test(v);
    const isValidUrl    = (v) => /^https?:\/\/.+/i.test(v);

    // 자산충전/홍보/중계방/고정노출 등 로그인(카카오 연동) 유저 전용 기능의
    // 공통 게이트 — 실제 차단은 서버(requireLinkedUser)가 하지만, 폼을 다
    // 작성한 뒤에야 막히면 답답하므로 모달을 열기 전에 미리 안내한다.
    function requireLoginOrPrompt() {
        const myData = getMyData();
        const isLinked = myData?.kakaoLinked || auth.currentUser?.email === ADMIN_EMAIL;
        if (isLinked) return true;
        if (confirm('로그인이 필요한 기능입니다.\n카카오 연동하고 계속하시겠어요?')) {
            window.loginWithKakao();
        }
        return false;
    }

    // 기간(일) 입력에 맞춰 "일수 × 단가" 비용을 실시간으로 표시
    function setupCostCalculator({ unitInputId, costElId, pricePerDay }) {
        function update() {
            const unitInput = document.getElementById(unitInputId);
            const costEl    = document.getElementById(costElId);
            if (!unitInput || !costEl) return;
            const units = parseInt(unitInput.value, 10);
            const cost = Number.isInteger(units) && units > 0 ? units * pricePerDay : 0;
            costEl.innerText = `${cost.toLocaleString()}원`;
        }
        document.getElementById(unitInputId)?.addEventListener('input', update);
        update();
        return update;
    }

    // 입력값(아이디 또는 이미지 URL)에 맞춰 미리보기 이미지를 로드/표시
    function setupImagePreview({ inputId, placeholderId, imgId, displayStyle, buildUrl, invalidText, errorText }) {
        function update() {
            const input       = document.getElementById(inputId);
            const placeholder = document.getElementById(placeholderId);
            const img         = document.getElementById(imgId);
            if (!input || !placeholder || !img) return;

            const url = buildUrl(input.value.trim().toLowerCase());
            if (!url) {
                img.style.display = 'none';
                img.src = '';
                placeholder.style.display = displayStyle;
                placeholder.innerHTML = invalidText;
                return;
            }
            placeholder.style.display = displayStyle;
            placeholder.innerText = '로딩중...';
            img.onload  = () => { placeholder.style.display = 'none'; img.style.display = 'block'; };
            img.onerror = () => { placeholder.style.display = displayStyle; placeholder.innerText = errorText; img.style.display = 'none'; };
            img.src = url;
        }
        document.getElementById(inputId)?.addEventListener('input', update);
        return update;
    }

    // 검증 → 버튼 비활성화 → 서버 호출 → 안내 → 필드 초기화 → 모달 닫기의 공통 뼈대.
    // validateAndBuild()는 유효하면 payload 객체를, 무효하면(이미 alert를 띄운 뒤) null을 반환한다.
    async function submitRequestForm({ submitBtnId, submitLabel, validateAndBuild, callable, onSuccess, resetFn, closeFn }) {
        const submitBtn = document.getElementById(submitBtnId);
        const payload = validateAndBuild();
        if (!payload) return;

        submitBtn.disabled = true;
        submitBtn.innerText = '신청 중...';
        try {
            const result = await callable(payload);
            onSuccess(result);
            if (resetFn) resetFn();
            if (closeFn) closeFn();
        } catch (e) {
            alert(e?.message || '신청 중 오류가 발생했습니다.');
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerText = submitLabel;
        }
    }

    // ── 홍보 배너 신청 (종목명 검색 + 아이디 입력 → 실시간 미리보기 → 신청) ──
    // 예전엔 닉네임을 자유 텍스트로 받아 관리자가 신청마다 "진짜 스트리머가
    // 맞는지" 검수해야 했다. 이제는 최상단 고정 노출 신청과 동일하게 이미
    // 상장된 종목명만 받고(datalist 자동완성 + 실시간 검증), 상장되지 않은
    // 이름이면 제출을 막고 종목 상장 신청부터 하도록 안내한다 — 관리자는
    // 노출 기간/비용만 보면 되므로 검수 부담이 크게 줄어든다.
    const BANNER_COST_PER_DAY = 1000000; // 1일당 차감되는 게임자산 (서버 값과 동일하게 유지)

    const updatePromoCost = setupCostCalculator({ unitInputId: 'promo-days', costElId: 'promo-cost', pricePerDay: BANNER_COST_PER_DAY });

    const updatePromoPreview = setupImagePreview({
        inputId: 'promo-streamer-id',
        placeholderId: 'promo-preview-placeholder',
        imgId: 'promo-preview-img',
        displayStyle: 'block',
        buildUrl: (streamerId) => isValidSoopId(streamerId)
            ? `https://stimg.sooplive.com/LOGO/${streamerId.slice(0, 2)}/${streamerId}/${streamerId}.jpg`
            : null,
        invalidText: '미리보기',
        errorText: '이미지 없음',
    });

    function populatePromoStockDatalist() {
        const datalist = document.getElementById('promo-stock-datalist');
        if (!datalist) return;
        datalist.innerHTML = getAllStocks()
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(s => `<option value="${s.name.replace(/"/g, '&quot;')}"></option>`)
            .join('');
    }

    // 입력한 종목명이 실제 상장 종목인지 실시간으로 확인해, 없으면 경고 +
    // 상장 신청 유도 문구를 보여주고 신청 버튼을 잠근다.
    function checkPromoStockListed() {
        const name       = document.getElementById('promo-stock-name')?.value.trim() || '';
        const warning    = document.getElementById('promo-not-listed-warning');
        const submitBtn  = document.getElementById('promo-submit-btn');
        const isListed   = name && getAllStocks().some(s => s.name === name);
        if (warning)   warning.style.display = (name && !isListed) ? 'block' : 'none';
        if (submitBtn) submitBtn.disabled    = name ? !isListed : false; // 빈 입력은 제출 시점에 별도 안내
    }
    document.getElementById('promo-stock-name')?.addEventListener('input', checkPromoStockListed);

    window.submitBannerRequest = async function() {
        await submitRequestForm({
            submitBtnId: 'promo-submit-btn',
            submitLabel: '신청하기',
            validateAndBuild() {
                const nickname   = document.getElementById('promo-stock-name').value.trim();
                const streamerId = document.getElementById('promo-streamer-id').value.trim().toLowerCase();
                const days       = parseInt(document.getElementById('promo-days').value, 10);
                if (!nickname) { alert('종목명을 입력해주세요.'); return null; }
                if (!getAllStocks().some(s => s.name === nickname)) {
                    alert('상장되지 않은 종목명이에요. 먼저 종목 상장 신청을 해주세요.');
                    return null;
                }
                if (!isValidSoopId(streamerId)) { alert('아이디는 영문 소문자/숫자 2~20자로 입력해주세요.'); return null; }
                if (!Number.isInteger(days) || days < 1 || days > 7) { alert('노출 기간은 1~7일 사이로 입력해주세요.'); return null; }
                return { nickname, streamerId, days };
            },
            callable: submitBannerRequestCallable,
            onSuccess(result) {
                alert(`✅ ${result.data.chargedAmount.toLocaleString()}원이 차감되고 배너가 즉시 등록됐습니다!\n노출 종료일: ${result.data.endDate}`);
            },
            resetFn() {
                document.getElementById('promo-stock-name').value = '';
                document.getElementById('promo-streamer-id').value = '';
                document.getElementById('promo-days').value = '7';
                updatePromoPreview();
                updatePromoCost();
                checkPromoStockListed();
            },
            closeFn: window.closePromoModal,
        });
    };
    window.openChartAdModal  = () => {
        if (!requireLoginOrPrompt()) return;
        const stockId = getCurrentChartStockId(); // closeChartModal()이 초기화하기 전에 먼저 붙잡아둔다
        if (!stockId) { alert('종목의 차트를 먼저 열어주세요.'); return; }
        const stock = getAllStocks().find(s => s.id === stockId);
        pendingChartAdStockId = stockId;
        document.getElementById('chart-ad-target-stock').innerText = stock?.name || stockId;
        closeChartModal();   // 차트창 먼저 닫기
        document.getElementById('chart-ad-modal').classList.add('active');
    };
    window.closeChartAdModal = () => document.getElementById('chart-ad-modal').classList.remove('active');

    // ── 중계방 홍보 신청 (종목명 검색 + 아이디 입력 → 실시간 미리보기 → 신청) ──
    // 우측 홍보 배너와 동일하게 자유 닉네임 대신 이미 상장된 종목명만 받는다
    // (datalist 자동완성 + 실시간 검증) — 상장 여부가 유일한 검수 포인트였으므로
    // 신청 시점에 걸러지면 관리자 승인 없이 바로 등록할 수 있다.
    const RELAY_ROOM_COST_PER_HOUR = 300000; // 1시간당 차감되는 게임자산 (서버 값과 동일하게 유지)

    window.openRelayRoomModal  = () => {
        if (!requireLoginOrPrompt()) return;
        populateRelayStockDatalist();
        checkRelayStockListed();
        document.getElementById('relay-room-modal').classList.add('active');
    };
    window.closeRelayRoomModal = () => document.getElementById('relay-room-modal').classList.remove('active');

    const updateRelayCost = setupCostCalculator({ unitInputId: 'relay-hours', costElId: 'relay-cost', pricePerDay: RELAY_ROOM_COST_PER_HOUR });

    const updateRelayPreview = setupImagePreview({
        inputId: 'relay-streamer-id',
        placeholderId: 'relay-preview-placeholder',
        imgId: 'relay-preview-img',
        displayStyle: 'block',
        buildUrl: (streamerId) => isValidSoopId(streamerId)
            ? `https://stimg.sooplive.com/LOGO/${streamerId.slice(0, 2)}/${streamerId}/${streamerId}.jpg`
            : null,
        invalidText: '미리보기',
        errorText: '이미지 없음',
    });

    function populateRelayStockDatalist() {
        const datalist = document.getElementById('relay-stock-datalist');
        if (!datalist) return;
        datalist.innerHTML = getAllStocks()
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(s => `<option value="${s.name.replace(/"/g, '&quot;')}"></option>`)
            .join('');
    }

    function checkRelayStockListed() {
        const name       = document.getElementById('relay-stock-name')?.value.trim() || '';
        const warning    = document.getElementById('relay-not-listed-warning');
        const submitBtn  = document.getElementById('relay-submit-btn');
        const isListed   = name && getAllStocks().some(s => s.name === name);
        if (warning)   warning.style.display = (name && !isListed) ? 'block' : 'none';
        if (submitBtn) submitBtn.disabled    = name ? !isListed : false;
    }
    document.getElementById('relay-stock-name')?.addEventListener('input', checkRelayStockListed);

    window.submitRelayRoomRequest = async function() {
        await submitRequestForm({
            submitBtnId: 'relay-submit-btn',
            submitLabel: '신청하기',
            validateAndBuild() {
                const stockName  = document.getElementById('relay-stock-name').value.trim();
                const streamerId = document.getElementById('relay-streamer-id').value.trim().toLowerCase();
                const hours      = parseInt(document.getElementById('relay-hours').value, 10);
                if (!stockName) { alert('종목명을 입력해주세요.'); return null; }
                if (!getAllStocks().some(s => s.name === stockName)) {
                    alert('상장되지 않은 종목명이에요. 먼저 종목 상장 신청을 해주세요.');
                    return null;
                }
                if (!isValidSoopId(streamerId)) { alert('아이디는 영문 소문자/숫자 2~20자로 입력해주세요.'); return null; }
                if (!Number.isInteger(hours) || hours < 1 || hours > 8) { alert('홍보 시간은 1~8시간 사이로 입력해주세요.'); return null; }
                return { stockName, streamerId, hours };
            },
            callable: submitRelayRoomRequestCallable,
            onSuccess(result) {
                alert(`✅ ${result.data.chargedAmount.toLocaleString()}원이 차감되고 중계방에 즉시 등록됐습니다!`);
            },
            resetFn() {
                document.getElementById('relay-stock-name').value = '';
                document.getElementById('relay-streamer-id').value = '';
                document.getElementById('relay-hours').value = '1';
                updateRelayPreview();
                updateRelayCost();
                checkRelayStockListed();
            },
            closeFn: window.closeRelayRoomModal,
        });
    };

    // ── 최상단 고정 노출 신청 (기존 상장 종목 검색 → 시간 선택 → 신청) ──
    // 배너 신청과 달리 미상장 스트리머를 새로 등록하는 게 아니라 "이미 리스트에
    // 있는 종목 카드"를 맨 위로 올리는 기능이므로, 닉네임/아이디 대신 종목명
    // 검색(datalist 자동완성)으로 대상을 고른다.
    function populatePinStockDatalist() {
        const datalist = document.getElementById('pin-stock-datalist');
        if (!datalist) return;
        datalist.innerHTML = getAllStocks()
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(s => `<option value="${s.name.replace(/"/g, '&quot;')}"></option>`)
            .join('');
    }

    window.openPinModal = () => {
        if (!requireLoginOrPrompt()) return;
        populatePinStockDatalist();
        document.getElementById('pin-modal').classList.add('active');
    };
    window.closePinModal = () => document.getElementById('pin-modal').classList.remove('active');

    const PIN_COST_PER_HOUR = 500000; // 1시간당 차감되는 게임자산 (서버 값과 동일하게 유지)
    const updatePinCost = setupCostCalculator({ unitInputId: 'pin-hours', costElId: 'pin-cost', pricePerDay: PIN_COST_PER_HOUR });

    window.submitPinRequest = async function() {
        await submitRequestForm({
            submitBtnId: 'pin-submit-btn',
            submitLabel: '신청하기',
            validateAndBuild() {
                const stockName = document.getElementById('pin-stock-name').value.trim();
                const hours     = parseInt(document.getElementById('pin-hours').value, 10);
                if (!stockName) { alert('고정할 종목명을 입력해주세요.'); return null; }
                if (!getAllStocks().some(s => s.name === stockName)) {
                    alert('해당 종목명을 찾을 수 없습니다. 목록에서 정확한 종목명을 선택해주세요.');
                    return null;
                }
                if (!Number.isInteger(hours) || hours < 1 || hours > 12) { alert('노출 시간은 1~12시간 사이로 입력해주세요.'); return null; }
                return { stockName, hours };
            },
            callable: submitPinRequestCallable,
            onSuccess(result) {
                alert(`✅ ${result.data.chargedAmount.toLocaleString()}원이 차감되고 최상단에 즉시 고정 노출됐습니다!`);
            },
            resetFn() {
                document.getElementById('pin-stock-name').value = '';
                document.getElementById('pin-hours').value = '1';
                updatePinCost();
            },
            closeFn: window.closePinModal,
        });
    };

    // ── 종목 상장 신청 (검색해도 없는 스트리머를 검색어로 바로 신청) ──
    // 무료 기능이라 비용 계산이 없고, 신청 즉시 상장되지 않고 관리자 승인 후
    // 상장되는 건 최상단 고정 노출 등 다른 셀프 신청과 동일한 원칙.
    window.openListingModal = (prefillName = '') => {
        if (!requireLoginOrPrompt()) return;
        document.getElementById('listing-stock-name').value = prefillName;
        document.getElementById('listing-modal').classList.add('active');
    };
    window.closeListingModal = () => document.getElementById('listing-modal').classList.remove('active');

    const MAX_LISTING_NAME_LENGTH = 12; // 서버 MAX_STOCK_NAME_LENGTH와 동일하게 유지

    window.submitListingRequest = async function() {
        await submitRequestForm({
            submitBtnId: 'listing-submit-btn',
            submitLabel: '신청하기',
            validateAndBuild() {
                const stockName = document.getElementById('listing-stock-name').value.trim();
                if (!stockName) { alert('상장을 원하는 종목명을 입력해주세요.'); return null; }
                if (stockName.length > MAX_LISTING_NAME_LENGTH) {
                    alert(`종목명은 ${MAX_LISTING_NAME_LENGTH}자 이하로 입력해주세요.`);
                    return null;
                }
                if (getAllStocks().some(s => s.name === stockName)) {
                    alert('이미 상장된 종목명입니다.');
                    return null;
                }
                return { stockName };
            },
            callable: submitListingRequestCallable,
            onSuccess() {
                alert('✅ 상장 신청이 접수됐습니다!\n관리자 검수 후 새 종목으로 상장됩니다.');
            },
            resetFn() {
                document.getElementById('listing-stock-name').value = '';
            },
            closeFn: window.closeListingModal,
        });
    };

    // ── 자산 충전 모달 (라이브 방송 후원 → 신청 → 관리자 승인) ──
    window.openCashChargeModal = () => {
        if (!requireLoginOrPrompt()) return;
        document.getElementById('cash-charge-modal').classList.add('active');
        showCashChargeInfo();
    };
    window.closeCashChargeModal = () => document.getElementById('cash-charge-modal').classList.remove('active');

    function showCashChargeInfo() {
        document.getElementById('cash-charge-step-info').style.display = 'block';
        document.getElementById('cash-charge-step-form').style.display = 'none';
    }
    window.showCashChargeInfo = showCashChargeInfo;

    window.showCashChargeRequestForm = function() {
        document.getElementById('cash-charge-step-info').style.display = 'none';
        document.getElementById('cash-charge-step-form').style.display = 'block';
    };

    window.submitCashChargeRequest = async function() {
        await submitRequestForm({
            submitBtnId: 'cash-charge-submit-btn',
            submitLabel: '신청 완료',
            validateAndBuild() {
                const nickname = document.getElementById('cash-charge-nickname').value.trim();
                const soopId   = document.getElementById('cash-charge-soopid').value.trim().toLowerCase();
                if (!nickname) { alert('닉네임을 입력해주세요.'); return null; }
                if (!isValidSoopId(soopId)) { alert('아이디는 영문 소문자/숫자 2~20자로 입력해주세요.'); return null; }
                return { nickname, soopId };
            },
            callable: submitCashChargeRequestCallable,
            onSuccess() {
                alert('✅ 신청이 접수됐습니다! 관리자가 방송에서 후원을 확인한 뒤 자산을 지급합니다.');
            },
            resetFn() {
                document.getElementById('cash-charge-nickname').value = '';
                document.getElementById('cash-charge-soopid').value = '';
            },
            closeFn: window.closeCashChargeModal,
        });
    };

    // ── 차트 하단 배너 신청 (이미지/링크 직접 입력 → 실시간 미리보기 → 신청) ──
    const CHART_BANNER_COST_PER_DAY = 2000000; // 1일당 차감되는 게임자산 (서버 값과 동일하게 유지)

    const updateChartAdCost = setupCostCalculator({ unitInputId: 'chart-ad-days', costElId: 'chart-ad-cost', pricePerDay: CHART_BANNER_COST_PER_DAY });

    const updateChartAdPreview = setupImagePreview({
        inputId: 'chart-ad-img-url',
        placeholderId: 'chart-ad-preview-placeholder',
        imgId: 'chart-ad-preview-img',
        displayStyle: 'flex',
        buildUrl: (url) => isValidUrl(url) ? url : null,
        invalidText: '🖼 배너 이미지 링크를 입력하면<br>여기에 미리보기가 표시됩니다',
        errorText: '이미지를 불러올 수 없습니다',
    });

    window.submitChartBannerRequest = async function() {
        await submitRequestForm({
            submitBtnId: 'chart-ad-submit-btn',
            submitLabel: '신청하기',
            validateAndBuild() {
                if (!pendingChartAdStockId) { alert('종목의 차트를 먼저 열어주세요.'); return null; }
                const nickname   = document.getElementById('chart-ad-nickname').value.trim();
                const streamerId = document.getElementById('chart-ad-streamer-id').value.trim().toLowerCase();
                const bannerImg  = document.getElementById('chart-ad-img-url').value.trim();
                const promoLink  = document.getElementById('chart-ad-promo-link').value.trim();
                const days       = parseInt(document.getElementById('chart-ad-days').value, 10);
                if (!nickname) { alert('닉네임을 입력해주세요.'); return null; }
                if (!isValidSoopId(streamerId)) { alert('아이디는 영문 소문자/숫자 2~20자로 입력해주세요.'); return null; }
                if (!isValidUrl(bannerImg)) { alert('배너 이미지 링크를 올바르게 입력해주세요.'); return null; }
                if (!isValidUrl(promoLink)) { alert('홍보 페이지 링크를 올바르게 입력해주세요.'); return null; }
                if (!Number.isInteger(days) || days < 1 || days > 7) { alert('노출 기간은 1~7일 사이로 입력해주세요.'); return null; }
                return { stockId: pendingChartAdStockId, nickname, streamerId, bannerImg, promoLink, days };
            },
            callable: submitChartBannerRequestCallable,
            onSuccess(result) {
                alert(`✅ ${result.data.chargedAmount.toLocaleString()}원이 차감되고 배너가 즉시 등록됐습니다!\n노출 종료일: ${result.data.endDate}`);
            },
            resetFn() {
                document.getElementById('chart-ad-nickname').value = '';
                document.getElementById('chart-ad-streamer-id').value = '';
                document.getElementById('chart-ad-img-url').value = '';
                document.getElementById('chart-ad-promo-link').value = '';
                document.getElementById('chart-ad-days').value = '7';
                updateChartAdPreview();
                updateChartAdCost();
                pendingChartAdStockId = null;
            },
            closeFn: window.closeChartAdModal,
        });
    };
    window.copyAdminEmail = async function(e) {
        const email    = 'skftodwocks2@gmail.com';
        const target   = e.target;
        const original = target.innerText;
        try {
            await navigator.clipboard.writeText(email);
        } catch (err) {
            const textarea = document.createElement('textarea');
            textarea.value = email;
            textarea.style.position = 'fixed';
            textarea.style.opacity  = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
        }
        target.innerText = '복사 완료! ✅';
        setTimeout(() => { target.innerText = original; }, 1500);
    };

    // ── 종목 거래 동결 해제 (게임자산 즉시 해제 / 방송 후원 신청) ──
    // 지금 열어둔 차트의 종목을 대상으로 한다 — 다른 신청과 동일한 패턴.
    let pendingUnfreezeStockId = null;

    window.openUnfreezeModal = () => {
        if (!requireLoginOrPrompt()) return;
        const stockId = getCurrentChartStockId();
        if (!stockId) { alert('종목의 차트를 먼저 열어주세요.'); return; }
        const stock = getAllStocks().find(s => s.id === stockId);
        if (!stock?.frozenAt) { alert('현재 동결된 종목이 아닙니다.'); return; }
        pendingUnfreezeStockId = stockId;
        document.getElementById('unfreeze-target-stock').innerText = stock.name || stockId;
        closeChartModal();
        document.getElementById('unfreeze-modal').classList.add('active');
    };
    window.closeUnfreezeModal = () => document.getElementById('unfreeze-modal').classList.remove('active');

    window.unfreezeWithCash = async function() {
        if (!pendingUnfreezeStockId) return alert('대상 종목을 찾을 수 없습니다.');
        if (!confirm('게임자산 100만원을 내고 즉시 해제하시겠습니까? (성공 시 200만원이 지급됩니다)')) return;

        const btn = document.getElementById('unfreeze-cash-btn');
        btn.disabled = true;
        btn.innerText = '처리 중...';
        try {
            const result = await unfreezeWithCashCallable({ stockId: pendingUnfreezeStockId });
            alert(`✅ 동결이 해제됐습니다! ${result.data.rewardAmount.toLocaleString()}원이 지급됐습니다.`);
            window.closeUnfreezeModal();
        } catch (e) {
            alert(e?.message || '해제 중 오류가 발생했습니다.');
        } finally {
            btn.disabled = false;
            btn.innerText = '게임자산 100만원으로 해제';
        }
    };

    window.submitUnfreezeDonationRequest = async function() {
        if (!pendingUnfreezeStockId) return alert('대상 종목을 찾을 수 없습니다.');
        const nickname = document.getElementById('unfreeze-donation-nickname').value.trim();
        const soopId   = document.getElementById('unfreeze-donation-soopid').value.trim().toLowerCase();
        if (!nickname) return alert('닉네임을 입력해주세요.');
        if (!isValidSoopId(soopId)) return alert('아이디는 영문 소문자/숫자 2~20자로 입력해주세요.');

        const btn = document.getElementById('unfreeze-donation-btn');
        btn.disabled = true;
        btn.innerText = '신청 중...';
        try {
            await submitUnfreezeDonationRequestCallable({ stockId: pendingUnfreezeStockId, nickname, soopId });
            alert('✅ 신청이 접수됐습니다! 관리자가 방송에서 후원을 확인한 뒤 처리합니다.');
            document.getElementById('unfreeze-donation-nickname').value = '';
            document.getElementById('unfreeze-donation-soopid').value = '';
            window.closeUnfreezeModal();
        } catch (e) {
            alert(e?.message || '신청 중 오류가 발생했습니다.');
        } finally {
            btn.disabled = false;
            btn.innerText = '신청하기';
        }
    };
}
