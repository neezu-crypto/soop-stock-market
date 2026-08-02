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
 * @param {() => boolean} deps.getIsAdmin - 서버 확인(whoAmI)으로 캐시된 관리자 여부 (09번/13번)
 * @param {() => void} deps.closeChartModal - 차트 하단 배너 신청 모달을 열 때 차트창을 먼저 닫기 위함
 * @param {() => string|null} deps.getCurrentChartStockId - 지금 열려 있는 차트 모달의 종목ID (없으면 null)
 * @param {object} deps.callables - httpsCallable로 미리 생성된 콜러블 참조 모음
 */
export function initPromotions({ getMyData, getAllStocks, auth, getIsAdmin, closeChartModal, getCurrentChartStockId, db, dbRef, dbGet, dbQuery, orderByChild, limitToLast, startAt, callables }) {
    const {
        submitBannerRequestCallable,
        submitChartBannerRequestCallable,
        submitCardBannerRequestCallable,
        submitPinRequestCallable,
        submitRelayRoomRequestCallable,
        submitCashChargeRequestCallable,
        submitTreasureChestPurchaseRequestCallable,
        openTreasureChestCallable,
        unfreezeWithCashCallable,
        submitUnfreezeDonationRequestCallable,
        submitListingRequestCallable,
        checkProfitRankingCallable,
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

    // 자산충전/홍보/중계방/고정노출 등 로그인(계정 보호) 유저 전용 기능의
    // 공통 게이트 — 실제 차단은 서버(requireLinkedUser)가 하지만, 폼을 다
    // 작성한 뒤에야 막히면 답답하므로 모달을 열기 전에 미리 안내한다.
    function requireLoginOrPrompt() {
        const myData = getMyData();
        const isLinked = !!(myData?.kakaoLinked || myData?.googleLinked || myData?.streamerVerified) || getIsAdmin();
        if (isLinked) return true;
        window.openAccountProtectModal();
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
        // 점검모드 중엔 여기 모이는 8종 셀프 신청(배너/차트배너/고정노출/중계방/
        // 상장신청/자산충전/동결해제 등) 전부를 한 곳에서 막는다 — index.html이
        // window.blockIfMaintenance를 노출해둔다.
        if (window.blockIfMaintenance && window.blockIfMaintenance()) return;

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
    const BANNER_COST_PER_DAY = 250000; // 1일당 차감되는 게임자산 (서버 값과 동일하게 유지)

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
    // ── 종목 카드 프로필 배너 신청 (10주 이상 보유자 전용) ──────────
    // 우측 배너와 동일한 신청 방식(닉네임 검색+아이디+기간 → 즉시 적용)을
    // 재사용하되, "해당 종목을 10주 이상 보유했는지"를 클라이언트에서도
    // 미리 확인해 보여준다 — 실제 차단은 서버(submitCardBannerRequest)가
    // 최종 판정하므로 이건 어디까지나 UX 편의용 사전 안내다.
    const CARD_BANNER_COST_PER_DAY    = 250000; // 서버 값과 동일하게 유지(표시용)
    const CARD_BANNER_MIN_HOLDING_QTY = 10;

    window.openCardBannerModal = (prefillStockName) => {
        if (!requireLoginOrPrompt()) return;
        populateCardBannerStockDatalist();
        const nameInput = document.getElementById('card-banner-stock-name');
        if (prefillStockName && nameInput) nameInput.value = prefillStockName;
        checkCardBannerEligibility();
        document.getElementById('card-banner-modal').classList.add('active');
    };
    window.closeCardBannerModal = () => document.getElementById('card-banner-modal').classList.remove('active');

    const updateCardBannerCost = setupCostCalculator({ unitInputId: 'card-banner-days', costElId: 'card-banner-cost', pricePerDay: CARD_BANNER_COST_PER_DAY });

    const updateCardBannerPreview = setupImagePreview({
        inputId: 'card-banner-streamer-id',
        placeholderId: 'card-banner-preview-placeholder',
        imgId: 'card-banner-preview-img',
        displayStyle: 'block',
        buildUrl: (streamerId) => isValidSoopId(streamerId)
            ? `https://stimg.sooplive.com/LOGO/${streamerId.slice(0, 2)}/${streamerId}/${streamerId}.jpg`
            : null,
        invalidText: '미리보기',
        errorText: '이미지 없음',
    });

    function populateCardBannerStockDatalist() {
        const datalist = document.getElementById('card-banner-stock-datalist');
        if (!datalist) return;
        datalist.innerHTML = getAllStocks()
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(s => `<option value="${s.name.replace(/"/g, '&quot;')}"></option>`)
            .join('');
    }

    // 입력한 종목명의 상장 여부 + 내 보유 수량(10주 이상인지)을 함께 확인해
    // 미리 안내하고, 자격 미달이면 신청 버튼을 잠근다.
    function checkCardBannerEligibility() {
        const name      = document.getElementById('card-banner-stock-name')?.value.trim() || '';
        const warning   = document.getElementById('card-banner-not-listed-warning');
        const eligBox   = document.getElementById('card-banner-eligibility');
        const submitBtn = document.getElementById('card-banner-submit-btn');
        if (!warning || !eligBox || !submitBtn) return;

        if (!name) {
            warning.style.display = 'none';
            eligBox.style.display = 'none';
            submitBtn.disabled = false;
            return;
        }

        const stock = getAllStocks().find(s => s.name === name);
        if (!stock) {
            warning.style.display = 'block';
            eligBox.style.display = 'none';
            submitBtn.disabled = true;
            return;
        }
        warning.style.display = 'none';

        const myQty = (getMyData()?.stocks || {})[stock.id]?.qty || 0;
        const isEligible = myQty >= CARD_BANNER_MIN_HOLDING_QTY;
        eligBox.style.display = 'block';
        if (isEligible) {
            eligBox.style.background = 'rgba(74,222,128,0.1)';
            eligBox.style.border = '1px solid rgba(74,222,128,0.4)';
            eligBox.style.color = '#4ade80';
            eligBox.innerText = `✅ 현재 보유: ${myQty}주 — 신청 가능`;
        } else {
            eligBox.style.background = 'rgba(239,68,68,0.1)';
            eligBox.style.border = '1px solid rgba(239,68,68,0.4)';
            eligBox.style.color = '#fca5a5';
            eligBox.innerText = `🔒 현재 보유: ${myQty}주 — ${CARD_BANNER_MIN_HOLDING_QTY}주 이상 필요`;
        }
        submitBtn.disabled = !isEligible;
    }
    document.getElementById('card-banner-stock-name')?.addEventListener('input', checkCardBannerEligibility);

    window.submitCardBannerRequest = async function() {
        await submitRequestForm({
            submitBtnId: 'card-banner-submit-btn',
            submitLabel: '신청하기',
            validateAndBuild() {
                const nickname   = document.getElementById('card-banner-stock-name').value.trim();
                const streamerId = document.getElementById('card-banner-streamer-id').value.trim().toLowerCase();
                const days       = parseInt(document.getElementById('card-banner-days').value, 10);
                if (!nickname) { alert('종목명을 입력해주세요.'); return null; }
                const stock = getAllStocks().find(s => s.name === nickname);
                if (!stock) {
                    alert('상장되지 않은 종목명이에요.');
                    return null;
                }
                const myQty = (getMyData()?.stocks || {})[stock.id]?.qty || 0;
                if (myQty < CARD_BANNER_MIN_HOLDING_QTY) {
                    alert(`이 상품은 해당 종목을 ${CARD_BANNER_MIN_HOLDING_QTY}주 이상 보유해야 신청할 수 있습니다. 현재 보유: ${myQty}주`);
                    return null;
                }
                if (!isValidSoopId(streamerId)) { alert('아이디는 영문 소문자/숫자 2~20자로 입력해주세요.'); return null; }
                if (!Number.isInteger(days) || days < 1 || days > 7) { alert('노출 기간은 1~7일 사이로 입력해주세요.'); return null; }
                return { nickname, streamerId, days };
            },
            callable: submitCardBannerRequestCallable,
            onSuccess(result) {
                alert(`✅ ${result.data.chargedAmount.toLocaleString()}원이 차감되고 종목 카드에 홍보가 즉시 등록됐습니다!\n노출 종료일: ${result.data.endDate}\n\n⚠️ 보유 수량이 10주 미만으로 떨어지면 자동으로 삭제됩니다.`);
            },
            resetFn() {
                document.getElementById('card-banner-stock-name').value = '';
                document.getElementById('card-banner-streamer-id').value = '';
                document.getElementById('card-banner-days').value = '7';
                updateCardBannerPreview();
                updateCardBannerCost();
                checkCardBannerEligibility();
            },
            closeFn: window.closeCardBannerModal,
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
        populateChartAdStockDatalist();
        checkChartAdStockListed();
        document.getElementById('chart-ad-modal').classList.add('active');
    };
    window.closeChartAdModal = () => document.getElementById('chart-ad-modal').classList.remove('active');

    // 배너가 붙는 대상은 항상 "지금 열어둔 그 종목"(stockId)으로 고정되지만,
    // 닉네임(홍보할 스트리머)도 우측 배너와 동일하게 이미 상장된 종목명이어야
    // 한다 — 상장 여부가 검수 포인트였으므로 신청 시점에 걸러지면 승인 없이
    // 바로 등록할 수 있다.
    function populateChartAdStockDatalist() {
        const datalist = document.getElementById('chart-ad-stock-datalist');
        if (!datalist) return;
        datalist.innerHTML = getAllStocks()
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(s => `<option value="${s.name.replace(/"/g, '&quot;')}"></option>`)
            .join('');
    }

    function checkChartAdStockListed() {
        const name       = document.getElementById('chart-ad-nickname')?.value.trim() || '';
        const warning    = document.getElementById('chart-ad-not-listed-warning');
        const submitBtn  = document.getElementById('chart-ad-submit-btn');
        const isListed   = name && getAllStocks().some(s => s.name === name);
        if (warning)   warning.style.display = (name && !isListed) ? 'block' : 'none';
        if (submitBtn) submitBtn.disabled    = name ? !isListed : false;
    }
    document.getElementById('chart-ad-nickname')?.addEventListener('input', checkChartAdStockListed);

    // ── 중계방 홍보 신청 (종목명 검색 + 아이디 입력 → 실시간 미리보기 → 신청) ──
    // 우측 홍보 배너와 동일하게 자유 닉네임 대신 이미 상장된 종목명만 받는다
    // (datalist 자동완성 + 실시간 검증) — 상장 여부가 유일한 검수 포인트였으므로
    // 신청 시점에 걸러지면 관리자 승인 없이 바로 등록할 수 있다.
    const RELAY_ROOM_COST_PER_HOUR = 150000; // 1시간당 차감되는 게임자산 (서버 값과 동일하게 유지)

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
        checkPinStockListed();
        document.getElementById('pin-modal').classList.add('active');
    };
    window.closePinModal = () => document.getElementById('pin-modal').classList.remove('active');

    function checkPinStockListed() {
        const name       = document.getElementById('pin-stock-name')?.value.trim() || '';
        const warning    = document.getElementById('pin-not-listed-warning');
        const submitBtn  = document.getElementById('pin-submit-btn');
        const isListed   = name && getAllStocks().some(s => s.name === name);
        if (warning)   warning.style.display = (name && !isListed) ? 'block' : 'none';
        if (submitBtn) submitBtn.disabled    = name ? !isListed : false;
    }
    document.getElementById('pin-stock-name')?.addEventListener('input', checkPinStockListed);

    const PIN_COST_PER_HOUR = 250000; // 1시간당 차감되는 게임자산 (서버 값과 동일하게 유지)
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
                checkPinStockListed();
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

    // ── 보물상자 (자산 충전 — 후원창 구매 신청 → 관리자 승인 → 직접 개봉) ──
    // 서버(functions/common.js)와 동일한 값을 표시용으로만 들고 있는다 —
    // 최종 검증/차감은 항상 서버가 한다.
    const TREASURE_CHEST_BALLOON_PRICE        = 33;
    const TREASURE_CHEST_MAX_BUY_COUNT        = 200;
    const TREASURE_CHEST_BULK_BONUS_THRESHOLD = 10;
    const TREASURE_CHEST_BULK_BONUS_RATE      = 0.10;
    const TREASURE_CHEST_DONATION_URL = 'https://st.sooplive.com/app/gift_starballoon.php?szBjId=skftodwocks2&szWork=BJ_STATION&sys_type=web&location=station';

    window.openAssetChargeModal = () => {
        if (!requireLoginOrPrompt()) return;
        document.getElementById('asset-charge-modal').classList.add('active');
    };
    window.closeAssetChargeModal = () => document.getElementById('asset-charge-modal').classList.remove('active');

    function computeChestPurchase(chestCount) {
        const bonusChestCount = chestCount >= TREASURE_CHEST_BULK_BONUS_THRESHOLD
            ? Math.floor(chestCount * TREASURE_CHEST_BULK_BONUS_RATE)
            : 0;
        return { bonusChestCount, totalChestCount: chestCount + bonusChestCount, starBalloons: chestCount * TREASURE_CHEST_BALLOON_PRICE };
    }

    window.renderChestQty = function() {
        const input = document.getElementById('chest-qty-input');
        let chestCount = parseInt(input.value, 10);
        if (!Number.isInteger(chestCount) || chestCount < 1) chestCount = 1;
        if (chestCount > TREASURE_CHEST_MAX_BUY_COUNT) chestCount = TREASURE_CHEST_MAX_BUY_COUNT;
        input.value = chestCount;

        const { bonusChestCount, totalChestCount, starBalloons } = computeChestPurchase(chestCount);
        document.getElementById('chest-balloon-cost').innerText = starBalloons.toLocaleString();
        document.getElementById('chest-total-count').innerText  = totalChestCount.toLocaleString();
        const bonusEl = document.getElementById('chest-bonus-text');
        if (bonusChestCount > 0) {
            bonusEl.style.display = 'block';
            bonusEl.innerText = `🎉 보너스 ${bonusChestCount}개 추가 지급!`;
        } else {
            bonusEl.style.display = 'none';
        }
    };

    window.adjustChestQty = function(delta) {
        const input = document.getElementById('chest-qty-input');
        const next  = Math.min(TREASURE_CHEST_MAX_BUY_COUNT, Math.max(1, (parseInt(input.value, 10) || 1) + delta));
        input.value = next;
        window.renderChestQty();
    };

    window.openTreasureChestBuyModal = () => {
        window.closeAssetChargeModal();
        document.getElementById('chest-qty-input').value = '1';
        window.renderChestQty();
        document.getElementById('treasure-chest-buy-modal').classList.add('active');
    };
    window.closeTreasureChestBuyModal = () => document.getElementById('treasure-chest-buy-modal').classList.remove('active');
    window.backToAssetChargeModal = () => {
        window.closeTreasureChestBuyModal();
        window.closeTreasureChestOpenModal();
        window.openAssetChargeModal();
    };

    window.submitTreasureChestPurchase = async function() {
        await submitRequestForm({
            submitBtnId: 'chest-buy-submit-btn',
            submitLabel: '🎁 구매하기',
            validateAndBuild() {
                const nickname   = document.getElementById('chest-buy-nickname').value.trim();
                const soopId     = document.getElementById('chest-buy-soopid').value.trim().toLowerCase();
                const chestCount = parseInt(document.getElementById('chest-qty-input').value, 10);
                if (!nickname) { alert('닉네임을 입력해주세요.'); return null; }
                if (!isValidSoopId(soopId)) { alert('아이디는 영문 소문자/숫자 2~20자로 입력해주세요.'); return null; }
                if (!Number.isInteger(chestCount) || chestCount < 1 || chestCount > TREASURE_CHEST_MAX_BUY_COUNT) {
                    alert(`구매 개수는 1~${TREASURE_CHEST_MAX_BUY_COUNT}개 사이로 입력해주세요.`);
                    return null;
                }
                return { nickname, soopId, chestCount };
            },
            callable: submitTreasureChestPurchaseRequestCallable,
            onSuccess(result) {
                alert(`✅ 신청이 접수됐습니다! 후원창에서 별풍선 ${result.data.starBalloons.toLocaleString()}개를 후원해주세요.\n관리자가 확인 후 보물상자 ${result.data.totalChestCount.toLocaleString()}개를 지급합니다.`);
                window.open(TREASURE_CHEST_DONATION_URL, '_blank');
            },
            resetFn() {
                document.getElementById('chest-buy-nickname').value = '';
                document.getElementById('chest-buy-soopid').value = '';
                document.getElementById('chest-qty-input').value = '1';
                window.renderChestQty();
            },
            closeFn: window.closeTreasureChestBuyModal,
        });
    };

    // 상자를 열 때 아이콘 중심에서 톡 터지며 흩어지는 파티클 — 복권 긁기
    // 연출(lottery-particle-burst)과 동일한 키프레임을 재사용한다.
    function spawnChestParticles(el, big) {
        el.style.position = 'relative';
        const colors = big ? ['#facc15', '#fbbf24', '#fde68a'] : ['#a855f7', '#c084fc', '#e9d5ff'];
        const count  = big ? 20 : 10;
        for (let i = 0; i < count; i++) {
            const p = document.createElement('span');
            p.className = 'chest-particle';
            const angle = (Math.PI * 2 * i) / count + (Math.random() * 0.6 - 0.3);
            const dist  = 40 + Math.random() * (big ? 40 : 22);
            p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
            p.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
            p.style.background = colors[i % colors.length];
            el.appendChild(p);
            setTimeout(() => p.remove(), 750);
        }
    }

    window.openTreasureChestOpenModal = () => {
        window.closeAssetChargeModal();
        const myData = getMyData();
        document.getElementById('chest-owned-count').innerText = (myData?.treasureChests || 0).toLocaleString();
        const icon = document.getElementById('chest-open-icon');
        icon.className = 'chest-icon';
        icon.innerText = '🎁';
        document.getElementById('chest-open-result-text').innerText = '';
        const btn = document.getElementById('chest-open-btn');
        btn.style.display = 'block';
        btn.disabled = false;
        btn.innerText = '📦 열기';
        document.getElementById('treasure-chest-open-modal').classList.add('active');
    };
    window.closeTreasureChestOpenModal = () => document.getElementById('treasure-chest-open-modal').classList.remove('active');

    window.openTreasureChest = async function() {
        if (window.blockIfMaintenance && window.blockIfMaintenance()) return;
        const myData = getMyData();
        if (!(myData?.treasureChests > 0)) { alert('보유한 보물상자가 없습니다.'); return; }

        const btn      = document.getElementById('chest-open-btn');
        const icon     = document.getElementById('chest-open-icon');
        const resultEl = document.getElementById('chest-open-result-text');
        btn.disabled = true;
        btn.innerText = '여는 중...';
        icon.className = 'chest-icon shaking';
        resultEl.innerText = '';

        try {
            const result = await openTreasureChestCallable();
            const { reward, isBig, remaining } = result.data;
            setTimeout(() => {
                icon.className = `chest-icon opened${isBig ? ' big-win' : ''}`;
                icon.innerText = isBig ? '💎' : '💰';
                spawnChestParticles(icon, isBig);
                resultEl.innerHTML = isBig
                    ? `<span style="color:#facc15;font-weight:900;">💎 대박! ${reward.toLocaleString()}원 당첨!</span>`
                    : `<span style="color:#4ade80;font-weight:800;">🎉 ${reward.toLocaleString()}원 당첨!</span>`;
                document.getElementById('chest-owned-count').innerText = (remaining || 0).toLocaleString();
                if (remaining > 0) {
                    btn.disabled = false;
                    btn.innerText = '📦 다음 상자 열기';
                } else {
                    btn.style.display = 'none';
                }
            }, 500); // 흔들리는 연출이 끝날 때까지 대기한 뒤 결과 표시
        } catch (e) {
            icon.className = 'chest-icon';
            alert(e?.message || '상자 개봉 중 오류가 발생했습니다.');
            btn.disabled = false;
            btn.innerText = '📦 열기';
        }
    };

    // ── 차트 하단 배너 신청 (이미지/링크 직접 입력 → 실시간 미리보기 → 신청) ──
    const CHART_BANNER_COST_PER_DAY = 500000; // 1일당 차감되는 게임자산 (서버 값과 동일하게 유지)

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
                const days       = parseInt(document.getElementById('chart-ad-days').value, 10);
                if (!nickname) { alert('홍보할 스트리머 닉네임을 입력해주세요.'); return null; }
                if (!getAllStocks().some(s => s.name === nickname)) {
                    alert('상장되지 않은 종목명이에요. 먼저 종목 상장 신청을 해주세요.');
                    return null;
                }
                if (!isValidSoopId(streamerId)) { alert('아이디는 영문 소문자/숫자 2~20자로 입력해주세요.'); return null; }
                if (!isValidUrl(bannerImg)) { alert('배너 이미지 링크를 올바르게 입력해주세요.'); return null; }
                if (!Number.isInteger(days) || days < 1 || days > 7) { alert('노출 기간은 1~7일 사이로 입력해주세요.'); return null; }
                // 홍보 페이지 링크는 서버가 streamerId로 방송국 주소를 자동 생성한다 — 별도 입력 불필요.
                return { stockId: pendingChartAdStockId, nickname, streamerId, bannerImg, days };
            },
            callable: submitChartBannerRequestCallable,
            onSuccess(result) {
                alert(`✅ ${result.data.chargedAmount.toLocaleString()}원이 차감되고 노출 기간이 예약됐습니다!\n노출 종료일: ${result.data.endDate}\n배너 이미지는 관리자 확인 후 노출됩니다.`);
            },
            resetFn() {
                document.getElementById('chart-ad-nickname').value = '';
                document.getElementById('chart-ad-streamer-id').value = '';
                document.getElementById('chart-ad-img-url').value = '';
                document.getElementById('chart-ad-days').value = '7';
                updateChartAdPreview();
                updateChartAdCost();
                checkChartAdStockListed();
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
        if (window.blockIfMaintenance && window.blockIfMaintenance()) return;
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
        if (window.blockIfMaintenance && window.blockIfMaintenance()) return;
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

    // ── 내 손익 랭킹 ──────────────────────────────────────────
    // "보기"(무료)와 "공식 게시"(유료)를 분리한다 — 순위가 궁금해서 캐주얼하게
    // 열어보는 행위 자체에 비용을 매기면 오히려 재접속을 유도해야 할 기능이
    // 재접속을 억제하는 역설이 생긴다. rankings/profitEntries는 인기 TOP5와
    // 동일하게 이미 공개 읽기 경로라, 내 실현손익(이미 클라이언트가 들고
    // 있는 값)과 조합하면 서버 호출 없이 "지금 게시하면 몇 등일지"를 무료로
    // 보여줄 수 있다. 실제로 순위표에 내 이름을 올리는(다른 유저에게 보이는)
    // 행위만 유료로 남긴다.
    window.openProfitRankingModal = () => {
        if (!requireLoginOrPrompt()) return;
        document.getElementById('profit-ranking-modal').classList.add('active');
    };
    window.closeProfitRankingModal = () => document.getElementById('profit-ranking-modal').classList.remove('active');

    // 공유 카드 모달이 참고할 "가장 최근 조회 결과" — 미리보기든 공식 게시든
    // renderProfitRankingResult를 거칠 때마다 갱신된다.
    let lastProfitRankingData = null;

    function renderProfitRankingResult({ myRank, myProfit, myAnonId, top, isPreview }) {
        lastProfitRankingData = { myRank, myProfit, myAnonId, top, isPreview };

        const resultEl = document.getElementById('profit-ranking-result');
        const rankEl    = document.getElementById('profit-ranking-my-rank');
        const profitEl  = document.getElementById('profit-ranking-my-profit');
        const statusEl  = document.getElementById('profit-ranking-status');
        const listEl    = document.getElementById('profit-ranking-list');

        resultEl.style.display = 'block';
        rankEl.innerText = `${myRank.toLocaleString()}위`;
        const sign  = myProfit > 0 ? '+' : '';
        const color = myProfit > 0 ? '#4ade80' : myProfit < 0 ? '#f87171' : '#94a3b8';
        profitEl.innerHTML = `${myAnonId} · 순수 매매 손익 <b style="color:${color};">${sign}${myProfit.toLocaleString()}원</b>`;
        if (statusEl) {
            statusEl.innerText = isPreview ? '🔍 예상 순위 (아직 순위표에 게시되지 않음)' : '✅ 순위표에 게시됨 — 다른 유저에게도 보여요';
            statusEl.style.color = isPreview ? '#fbbf24' : '#4ade80';
        }

        listEl.innerHTML = top.map((item, i) => {
            const isMe = item.anonId === myAnonId;
            const s = item.value > 0 ? '+' : '';
            const c = item.value > 0 ? '#4ade80' : item.value < 0 ? '#f87171' : '#94a3b8';
            return `
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:8px;background:${isMe ? 'rgba(56,189,248,0.15)' : 'rgba(255,255,255,0.03)'};border:1px solid ${isMe ? '#38bdf8' : 'transparent'};font-size:13px;">
                    <span style="color:#94a3b8;width:28px;flex-shrink:0;">${i + 1}위</span>
                    <span style="flex:1;color:${isMe ? '#38bdf8' : 'white'};font-weight:${isMe ? '700' : '400'};">${item.anonId}${isMe ? ' (나)' : ''}</span>
                    <span style="color:${c};font-weight:700;white-space:nowrap;">${s}${item.value.toLocaleString()}원</span>
                </div>`;
        }).join('');
    }

    // 서버(profitRanking.js)의 anonIdFor와 동일한 규칙(uid 뒤 6자리) — 미리보기
    // 단계에서도 top10 중 "나"를 하이라이트할 수 있도록 클라이언트에서 재현.
    function myAnonIdPreview() {
        const uid = auth.currentUser?.uid || '';
        return `트레이더-${uid.slice(-6).toUpperCase()}`;
    }

    window.previewMyProfitRank = async function() {
        const btn = document.getElementById('profit-ranking-preview-btn');
        btn.disabled = true;
        btn.innerText = '조회 중...';
        try {
            const myData = getMyData();
            const myProfit = Math.round(myData?.realizedPL || 0);

            const topSnap = await dbGet(dbQuery(dbRef(db, 'rankings/profitEntries'), orderByChild('value'), limitToLast(10)));
            const topRaw = [];
            topSnap.forEach(child => topRaw.push(child.val()));
            topRaw.sort((a, b) => b.value - a.value);

            const higherSnap = await dbGet(dbQuery(dbRef(db, 'rankings/profitEntries'), orderByChild('value'), startAt(myProfit + 1)));
            const myRank = higherSnap.size + 1;

            renderProfitRankingResult({ myRank, myProfit, myAnonId: myAnonIdPreview(), top: topRaw, isPreview: true });
        } catch (e) {
            alert(e?.message || '예상 순위 조회 중 오류가 발생했습니다.');
        } finally {
            btn.disabled = false;
            btn.innerText = '🔍 무료로 예상 순위 보기';
        }
    };

    window.checkProfitRanking = async function() {
        if (window.blockIfMaintenance && window.blockIfMaintenance()) return;
        const btn = document.getElementById('profit-ranking-check-btn');
        btn.disabled = true;
        btn.innerText = '게시 중...';
        try {
            const { data } = await checkProfitRankingCallable();
            renderProfitRankingResult({ myRank: data.myRank, myProfit: data.myProfit, myAnonId: data.myAnonId, top: data.top, isPreview: false });
        } catch (e) {
            alert(e?.message || '랭킹 게시 중 오류가 발생했습니다.');
        } finally {
            btn.disabled = false;
            btn.innerText = '💰 50만원으로 공식 게시';
        }
    };

    // ── 손익 랭킹 공유용 카드 ──────────────────────────────────
    // 저장/공유 API는 의도적으로 넣지 않는다 — 유저가 직접 스크린샷해서
    // 원하는 곳에 공유하는 방식이라, "화면에 예쁘게 띄우는 것"까지만
    // 신경 쓰면 된다. 세로 비율(9:16)로 만들어 모바일 전체화면 캡처에도
    // 잘 맞도록 함.

    function escapeCaption(str) {
        const div = document.createElement('div');
        div.innerText = str;
        return div.innerHTML;
    }

    // 크루 이름 문자열을 고정된 색상(hue)으로 변환 — 같은 크루면 항상 같은 색.
    function crewNameToHue(name) {
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360;
        return Math.abs(hash) % 360;
    }

    // 보유 종목 중 [크루명] 프리픽스가 붙은 것 중 평가금액이 가장 큰 크루를 고른다.
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

    window.selectShareTheme = function(theme) {
        document.querySelectorAll('.share-theme-btn').forEach(b => {
            const isActive = b.dataset.theme === theme;
            b.style.border = isActive ? '2px solid #38bdf8' : '1px solid #475569';
            b.style.opacity = isActive ? '1' : '0.7';
            b.dataset.active = isActive ? '1' : '0';
        });
        renderShareCard();
    };

    function selectedShareTheme() {
        return document.querySelector('.share-theme-btn[data-active="1"]')?.dataset.theme || 'default';
    }

    window.renderShareCard = function() {
        const data = lastProfitRankingData;
        const card = document.getElementById('profit-share-card');
        if (!data || !card) return;

        const crewName = detectMyCrew();
        const { bg, accent } = themeColors(selectedShareTheme(), crewName);

        const showAnonId = document.getElementById('share-opt-anonid')?.checked;
        const showTop3   = document.getElementById('share-opt-top3')?.checked;
        const showDate    = document.getElementById('share-opt-date')?.checked;
        const showCrew    = !!crewName && document.getElementById('share-opt-crew')?.checked;
        const caption     = (document.getElementById('share-opt-caption')?.value || '').trim();

        const sign  = data.myProfit > 0 ? '+' : '';
        const color = data.myProfit > 0 ? '#4ade80' : data.myProfit < 0 ? '#f87171' : '#94a3b8';
        const statusLabel = data.isPreview ? '🔍 예상치 (미게시)' : '✅ 공식 게시됨';
        const statusColor = data.isPreview ? '#fbbf24' : '#4ade80';
        const dateStr = new Date().toLocaleDateString('ko-KR');

        card.style.background = bg;
        card.innerHTML = `
            <div style="text-align:center;font-size:11px;font-weight:800;letter-spacing:1px;color:${accent};text-transform:uppercase;margin-bottom:4px;">SOOP STOCK</div>
            <div style="text-align:center;font-size:11px;color:${statusColor};font-weight:700;margin-bottom:16px;">${statusLabel}</div>
            ${showCrew ? `<div style="text-align:center;margin-bottom:10px;"><span style="display:inline-block;background:rgba(255,255,255,0.12);color:${accent};font-size:11px;font-weight:700;padding:4px 10px;border-radius:100px;">[${escapeCaption(crewName)}] 소속 트레이더</span></div>` : ''}
            <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;">
                <div style="font-size:13px;color:#94a3b8;margin-bottom:6px;">내 순위</div>
                <div style="font-size:48px;font-weight:900;color:${accent};line-height:1;">${data.myRank}위</div>
                <div style="font-size:22px;font-weight:800;color:${color};margin-top:12px;">${sign}${data.myProfit.toLocaleString()}원</div>
                ${showAnonId ? `<div style="font-size:12px;color:#94a3b8;margin-top:8px;">${data.myAnonId}</div>` : ''}
            </div>
            ${showTop3 ? `
            <div style="margin-top:16px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.15);">
                ${data.top.slice(0, 3).map((item, i) => {
                    const s = item.value > 0 ? '+' : '';
                    const c = item.value > 0 ? '#4ade80' : item.value < 0 ? '#f87171' : '#94a3b8';
                    return `<div style="display:flex;justify-content:space-between;font-size:11px;color:#cbd5e1;padding:3px 0;">
                        <span>${i + 1}위 ${item.anonId}</span>
                        <span style="color:${c};">${s}${item.value.toLocaleString()}원</span>
                    </div>`;
                }).join('')}
            </div>` : ''}
            ${caption ? `<div style="text-align:center;font-size:12px;color:#f8fafc;margin-top:14px;font-style:italic;">"${escapeCaption(caption)}"</div>` : ''}
            ${showDate ? `<div style="text-align:center;font-size:10px;color:#64748b;margin-top:${caption ? '8px' : '14px'};">${dateStr}</div>` : ''}
        `;
    };

    window.openShareCardModal = function() {
        if (!lastProfitRankingData) {
            alert('먼저 손익 랭킹을 확인해주세요.');
            return;
        }
        const crewName = detectMyCrew();
        const crewLabel = document.getElementById('share-opt-crew-label');
        const crewThemeBtn = document.getElementById('share-theme-crew-btn');
        if (crewLabel) crewLabel.style.display = crewName ? 'flex' : 'none';
        if (crewThemeBtn) crewThemeBtn.style.display = crewName ? 'inline-block' : 'none';

        document.getElementById('profit-share-card-modal')?.classList.add('active');
        window.selectShareTheme('default'); // 테마 버튼 상태 초기화 + 카드 렌더링까지 겸함
    };
    window.closeShareCardModal = function() {
        document.getElementById('profit-share-card-modal')?.classList.remove('active');
    };

    // ── 보유 자산 공유용 카드 ──────────────────────────────────
    // 손익 랭킹 카드와 뼈대(테마·토글·캡션·저장 API 없음)는 동일하되, 매매
    // 실력(realizedPL)이 아니라 "지금 포트폴리오가 이렇게 생겼다"는 스냅샷이라
    // 총수익률 같은 값은 의도적으로 넣지 않는다 — 출석 보상·계정보호
    // 보너스·후원 당첨금까지 현금에 섞여 있어, 총자산 증가율을 매매 실력처럼
    // 보여주면 오해를 줄 수 있다(실력 자랑은 손익 랭킹 카드 쪽 역할).
    function computeMyPortfolioSummary() {
        const myData = getMyData();
        const allStocks = getAllStocks();
        const cash = myData?.cash || 0;
        const holdings = Object.entries(myData?.stocks || {})
            .filter(([, pos]) => pos?.qty > 0)
            .map(([id, pos]) => {
                const stock = allStocks.find(s => s.id === id);
                if (!stock) return null;
                const currentPrice = stock.price || 0;
                const profitPct = pos.avg ? ((currentPrice - pos.avg) / pos.avg) * 100 : 0;
                return {
                    name: stock.name,
                    qty: pos.qty,
                    avg: pos.avg,
                    value: currentPrice * pos.qty,
                    profitPct,
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.value - a.value);
        const stockValue = holdings.reduce((sum, h) => sum + h.value, 0);
        return { cash, stockValue, totalAssets: cash + stockValue, holdings };
    }

    window.selectAssetShareTheme = function(theme) {
        document.querySelectorAll('.asset-share-theme-btn').forEach(b => {
            const isActive = b.dataset.theme === theme;
            b.style.border = isActive ? '2px solid #38bdf8' : '1px solid #475569';
            b.style.opacity = isActive ? '1' : '0.7';
            b.dataset.active = isActive ? '1' : '0';
        });
        renderAssetShareCard();
    };

    function selectedAssetShareTheme() {
        return document.querySelector('.asset-share-theme-btn[data-active="1"]')?.dataset.theme || 'default';
    }

    window.renderAssetShareCard = function() {
        const summary = computeMyPortfolioSummary();
        const card = document.getElementById('asset-share-card');
        if (!card) return;

        const crewName = detectMyCrew();
        const { bg, accent } = themeColors(selectedAssetShareTheme(), crewName);

        const showTop3   = document.getElementById('asset-share-opt-top3')?.checked;
        const showDetail = document.getElementById('asset-share-opt-detail')?.checked;
        const showDate   = document.getElementById('asset-share-opt-date')?.checked;
        const showCrew   = !!crewName && document.getElementById('asset-share-opt-crew')?.checked;
        const caption    = (document.getElementById('asset-share-opt-caption')?.value || '').trim();
        const dateStr    = new Date().toLocaleDateString('ko-KR');

        card.style.background = bg;
        card.innerHTML = `
            <div style="text-align:center;font-size:11px;font-weight:800;letter-spacing:1px;color:${accent};text-transform:uppercase;margin-bottom:4px;">SOOP STOCK</div>
            <div style="text-align:center;font-size:11px;color:#94a3b8;font-weight:700;margin-bottom:16px;">내 포트폴리오</div>
            ${showCrew ? `<div style="text-align:center;margin-bottom:10px;"><span style="display:inline-block;background:rgba(255,255,255,0.12);color:${accent};font-size:11px;font-weight:700;padding:4px 10px;border-radius:100px;">[${escapeCaption(crewName)}] 소속 트레이더</span></div>` : ''}
            <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;">
                <div style="font-size:13px;color:#94a3b8;margin-bottom:6px;">총 자산</div>
                <div style="font-size:34px;font-weight:900;color:${accent};line-height:1;">${Math.floor(summary.totalAssets).toLocaleString()}원</div>
            </div>
            ${showTop3 ? `
            <div style="margin-top:16px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.15);">
                ${summary.holdings.slice(0, 3).map((h) => {
                    const s = h.profitPct > 0 ? '+' : '';
                    const c = h.profitPct > 0 ? '#4ade80' : h.profitPct < 0 ? '#f87171' : '#94a3b8';
                    return `<div style="padding:3px 0;">
                        <div style="display:flex;justify-content:space-between;font-size:11px;color:#cbd5e1;">
                            <span>${escapeCaption(h.name)}</span>
                            <span style="color:${c};">${s}${h.profitPct.toFixed(1)}%</span>
                        </div>
                        ${showDetail ? `<div style="font-size:10px;color:#64748b;">${h.qty}주 · 평단 ${h.avg.toLocaleString()}원</div>` : ''}
                    </div>`;
                }).join('')}
            </div>` : ''}
            ${caption ? `<div style="text-align:center;font-size:12px;color:#f8fafc;margin-top:14px;font-style:italic;">"${escapeCaption(caption)}"</div>` : ''}
            ${showDate ? `<div style="text-align:center;font-size:10px;color:#64748b;margin-top:${caption ? '8px' : '14px'};">${dateStr}</div>` : ''}
        `;
    };

    window.openAssetShareCardModal = function() {
        const myData = getMyData();
        if (!myData) {
            alert('데이터 로딩 중입니다. 잠시 후 다시 시도해주세요.');
            return;
        }
        const crewName = detectMyCrew();
        const crewLabel = document.getElementById('asset-share-opt-crew-label');
        const crewThemeBtn = document.getElementById('asset-share-theme-crew-btn');
        if (crewLabel) crewLabel.style.display = crewName ? 'flex' : 'none';
        if (crewThemeBtn) crewThemeBtn.style.display = crewName ? 'inline-block' : 'none';

        document.getElementById('asset-share-card-modal')?.classList.add('active');
        window.selectAssetShareTheme('default'); // 테마 버튼 상태 초기화 + 카드 렌더링까지 겸함
    };
    window.closeAssetShareCardModal = function() {
        document.getElementById('asset-share-card-modal')?.classList.remove('active');
    };
}
