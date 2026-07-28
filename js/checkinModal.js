// 출석 체크 "광고보고 2배 받기" — 관리자 시범 기능. 기존 출석 체크(바로 지급,
// index.html의 claimDailyAttendance)는 그대로 두고, 관리자에 한해 이 모달을
// 열어 "오늘 그대로 받기" / "광고보고 2배 받기" 중 고르게 한다.
//
// 주의: 웹용 IMA SDK(HTML5)엔 애초에 "보상형(rewarded)" 광고 포맷이나 REWARD
// 이벤트가 존재하지 않는다(구글 공식 AdEvent.Type 목록 기준 — REWARD는
// 모바일(Android/iOS) SDK 전용 개념). 웹에서 "광고 보고 보상"은 SDK가 지원하는
// 기능이 아니라, 그냥 평범한 선형(linear) 영상 광고를 재생하고 다 보면
// (ALL_ADS_COMPLETED) 우리 쪽에서 보상을 주기로 정한 것일 뿐이다.
// cust_params=sample_ct=rewardedvideo처럼 실제로 존재하지 않는 파라미터를 쓰면
// 매번 no-fill로 실패하므로, 구글 공식 샘플 태그(sample_ct=linear)를 쓴다.
// 실제 Google Ad Manager 계정에서 발급받은 태그가 생기면 이 상수만 바꾸면 된다.

export function initCheckinModal({ claimCallable, getTodayRewardAmount }) {
    const backdrop    = document.getElementById('checkin-modal');
    const plainBtn     = document.getElementById('checkin-claim-plain-btn');
    const adBtn        = document.getElementById('checkin-claim-ad-btn');
    const plainLabel   = document.getElementById('checkin-plain-label');
    const adLabel      = document.getElementById('checkin-ad-label');
    const adStage      = document.getElementById('checkin-ad-stage');
    const adContainer  = document.getElementById('checkin-ad-container');
    const adVideo      = document.getElementById('checkin-ad-video');
    const statusEl     = document.getElementById('checkin-modal-status');
    if (!backdrop || !plainBtn || !adBtn) return;

    const SAMPLE_AD_TAG =
        'https://pubads.g.doubleclick.net/gampad/ads?iu=/21775744923/external/single_ad_samples' +
        '&sz=640x480&cust_params=sample_ct%3Dlinear&ciu_szs=300x250%2C728x90&gdfp_req=1&output=vast' +
        '&unviewed_position_start=1&env=vp&correlator=';

    let imaLoadPromise = null;
    function loadImaSdk() {
        if (window.google?.ima) return Promise.resolve();
        if (imaLoadPromise) return imaLoadPromise;
        imaLoadPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://imasdk.googleapis.com/js/sdkloader/ima3.js';
            script.onload = () => resolve();
            script.onerror = () => { imaLoadPromise = null; reject(new Error('광고 SDK를 불러오지 못했습니다.')); };
            document.head.appendChild(script);
        });
        return imaLoadPromise;
    }

    let adsLoader = null;
    let adsManager = null;
    let adDisplayContainer = null;
    let adResizeHandler = null;

    function isMobileDevice() {
        return /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent);
    }

    // 모바일에서 광고 시작 시 자동 전체화면 — Fullscreen API는 사용자 클릭
    // 핸들러 안에서 동기적으로 호출해야만 브라우저가 허용하므로, adBtn 클릭
    // 핸들러 맨 앞(비동기 대기 전)에서 호출한다. iOS Safari 구버전은 일반
    // div의 requestFullscreen을 지원하지 않아 video의 webkitEnterFullscreen으로
    // 폴백한다.
    function requestAdFullscreen() {
        if (!isMobileDevice() || !adContainer) return;
        const req = adContainer.requestFullscreen || adContainer.webkitRequestFullscreen ||
            adContainer.mozRequestFullScreen || adContainer.msRequestFullscreen;
        if (req) {
            try { req.call(adContainer); return; } catch (e) { /* 폴백으로 진행 */ }
        }
        if (adVideo?.webkitEnterFullscreen) {
            try { adVideo.webkitEnterFullscreen(); } catch (e) { /* noop */ }
        }
    }

    function exitAdFullscreen() {
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement ||
            document.mozFullScreenElement || document.msFullscreenElement;
        if (!fsEl) return;
        const exit = document.exitFullscreen || document.webkitExitFullscreen ||
            document.mozCancelFullScreen || document.msExitFullscreen;
        if (exit) { try { exit.call(document); } catch (e) { /* noop */ } }
    }

    let adRequestSettled = true;
    let adTimeoutId = null;
    function clearAdTimeout() {
        if (adTimeoutId) { clearTimeout(adTimeoutId); adTimeoutId = null; }
    }

    // 광고 완료·에러·모달 닫기 등 모든 종료 경로를 이 함수 하나로 묶는다 —
    // 전체화면 해제도 반드시 여기서 같이 처리한다.
    function cleanupAd() {
        adRequestSettled = true;
        clearAdTimeout();
        exitAdFullscreen();
        if (adResizeHandler) { window.removeEventListener('resize', adResizeHandler); adResizeHandler = null; }
        if (adsManager) { try { adsManager.destroy(); } catch (e) { /* noop */ } adsManager = null; }
        if (adsLoader) { try { adsLoader.destroy(); } catch (e) { /* noop */ } adsLoader = null; }
        adDisplayContainer = null;
        if (adStage) adStage.style.display = 'none';
        if (adVideo?.pause) adVideo.pause();
    }

    function setStatus(text) { if (statusEl) statusEl.innerText = text || ''; }

    function refreshLabels() {
        const base = getTodayRewardAmount ? getTodayRewardAmount() : 0;
        plainLabel.innerText = `오늘 ${base.toLocaleString()}원 받기`;
        adLabel.innerText = `광고보고 ${(base * 2).toLocaleString()}원 받기`;
    }

    window.openCheckinModal = function() {
        refreshLabels();
        setStatus('');
        plainBtn.disabled = false;
        adBtn.disabled = false;
        cleanupAd();
        backdrop.classList.add('active');
        loadImaSdk().catch(() => { /* 클릭 시점에 다시 시도 — 지금은 조용히 무시 */ });
    };

    window.closeCheckinModal = function() {
        backdrop.classList.remove('active');
        cleanupAd();
    };

    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) window.closeCheckinModal(); });

    function claim(watchedAd) {
        plainBtn.disabled = true;
        adBtn.disabled = true;
        claimCallable({ watchedAd: !!watchedAd })
            .then((result) => {
                setStatus(`✅ ${(result.data.reward || 0).toLocaleString()}원을 받았습니다!`);
                setTimeout(window.closeCheckinModal, 900);
            })
            .catch((e) => {
                setStatus(e?.message || '오류가 발생했습니다.');
                plainBtn.disabled = false;
                adBtn.disabled = false;
            });
    }

    plainBtn.addEventListener('click', () => claim(false));

    // IMA SDK가 네트워크 자체 실패(DNS 차단 등) 상황에서 AD_ERROR 이벤트를 우리
    // 리스너까지 깔끔하게 전달하지 못하는 경우가 있어, 일정 시간 안에 광고가
    // 뜨지도 실패 이벤트가 오지도 않으면 강제로 에러 처리하는 타임아웃
    // 안전장치를 둔다 — 단, 이 타임아웃은 "로딩" 단계만 지키고 ADS_MANAGER_LOADED
    // (로딩 성공)가 오면 즉시 해제해야 한다. 안 그러면 광고 영상 길이와 겹쳐
    // 실제로 광고가 끝까지 재생됐는데도 타임아웃이 먼저 발동해 adsManager를
    // 파괴하고 완료 이벤트를 놓치는 버그가 생긴다.

    // 광고 차단기 감지 — 광고 차단 확장/브라우저 내장 차단 기능은 대부분
    // "adsbygoogle", "ads", "advertisement" 같은 흔한 클래스명을 가진 엘리먼트를
    // CSS로 숨기거나 크기를 0으로 만드는 방식(코스메틱 필터)으로 동작한다. 실제
    // 광고 요청은 전혀 안 하고, 화면에만 잠깐 미끼(bait) 엘리먼트를 넣어서 그게
    // 숨겨지는지로 판별한다 — 네트워크/DNS 문제와는 별개의, 차단기 전용 신호.
    function detectAdBlocker() {
        return new Promise((resolve) => {
            try {
                const bait = document.createElement('div');
                bait.className = 'adsbygoogle ad ads ad-banner advertisement banner-ad';
                bait.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:2px;height:2px;';
                document.body.appendChild(bait);
                setTimeout(() => {
                    const blocked = !bait.offsetParent || bait.offsetHeight === 0 || bait.clientHeight === 0 ||
                        window.getComputedStyle(bait).display === 'none' || window.getComputedStyle(bait).visibility === 'hidden';
                    if (bait.parentNode) bait.parentNode.removeChild(bait);
                    resolve(blocked);
                }, 100);
            } catch (e) {
                resolve(false);
            }
        });
    }

    function onAdError(errorEvent) {
        if (adRequestSettled) return;
        adRequestSettled = true;
        clearAdTimeout();
        let detail = '';
        try {
            const err = errorEvent?.getError?.();
            if (err) {
                detail = ` [${err.getErrorCode()}] ${err.getMessage()}`;
                console.error('출석체크 광고 오류', err.getErrorCode(), err.getMessage(), err);
            }
        } catch (e) { /* noop */ }
        cleanupAd();
        plainBtn.disabled = false;
        adBtn.disabled = false;
        detectAdBlocker().then((blocked) => {
            setStatus(blocked
                ? '광고 차단 기능이 감지되었습니다. 꺼주신 뒤 다시 시도해주세요.'
                : '광고를 불러오지 못했습니다.' + detail);
        });
    }

    function onAdRewardEarned() {
        if (adRequestSettled) return;
        adRequestSettled = true;
        clearAdTimeout();
        cleanupAd();
        claim(true);
    }

    adBtn.addEventListener('click', () => {
        adBtn.disabled = true;
        plainBtn.disabled = true;
        if (adStage) adStage.style.display = '';
        setStatus('광고를 불러오는 중...');
        adRequestSettled = false;
        clearAdTimeout();
        adTimeoutId = setTimeout(onAdError, 15000); // 로딩 단계만 지킴 — 로드 성공 시 ADS_MANAGER_LOADED에서 해제

        // 640x360 같은 고정값 대신, 실제 화면에 렌더링된 컨테이너 크기를 그대로
        // 쓴다 — 하드코딩하면 IMA가 그리는 오버레이 텍스트/로고가 실제 컨테이너
        // 크기와 안 맞아 잘려 보인다.
        function getAdContainerSize() {
            return { width: adContainer.clientWidth || 640, height: adContainer.clientHeight || 360 };
        }

        function proceed() {
            try {
                // adDisplayContainer.initialize()는 브라우저 자동재생 정책 때문에
                // 반드시 "사용자 클릭 핸들러 안에서 동기적으로" 호출해야 한다 —
                // SDK가 이미 로드돼 있으면(모달 열릴 때 미리 로드 시도함) 여기서
                // 바로 동기 실행된다.
                adDisplayContainer = new google.ima.AdDisplayContainer(adContainer, adVideo);
                adDisplayContainer.initialize();
                requestAdFullscreen();

                adsLoader = new google.ima.AdsLoader(adDisplayContainer);
                adsLoader.addEventListener(google.ima.AdErrorEvent.Type.AD_ERROR, onAdError, false);
                adsLoader.addEventListener(google.ima.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED, (event) => {
                    clearAdTimeout();
                    adsManager = event.getAdsManager(adVideo);
                    adsManager.addEventListener(google.ima.AdErrorEvent.Type.AD_ERROR, onAdError);
                    // 웹 IMA SDK엔 REWARD 이벤트가 없으므로, 광고를 끝까지 재생
                    // 완료했다는 신호(ALL_ADS_COMPLETED)를 보상 지급 시점으로 취급한다.
                    adsManager.addEventListener(google.ima.AdEvent.Type.ALL_ADS_COMPLETED, onAdRewardEarned);
                    adResizeHandler = () => {
                        if (!adsManager) return;
                        const size = getAdContainerSize();
                        try { adsManager.resize(size.width, size.height, google.ima.ViewMode.NORMAL); } catch (e) { /* noop */ }
                    };
                    window.addEventListener('resize', adResizeHandler);
                    try {
                        const initSize = getAdContainerSize();
                        adsManager.init(initSize.width, initSize.height, google.ima.ViewMode.NORMAL);
                        adsManager.start();
                    } catch (adErr) {
                        onAdError(adErr);
                    }
                }, false);

                const adsRequest = new google.ima.AdsRequest();
                adsRequest.adTagUrl = SAMPLE_AD_TAG + Date.now();
                const slotSize = getAdContainerSize();
                adsRequest.linearAdSlotWidth = slotSize.width;
                adsRequest.linearAdSlotHeight = slotSize.height;
                adsRequest.nonLinearAdSlotWidth = slotSize.width;
                adsRequest.nonLinearAdSlotHeight = Math.round(slotSize.height * 0.4);
                adsLoader.requestAds(adsRequest);
            } catch (e) {
                onAdError(e);
            }
        }

        if (window.google?.ima) {
            proceed();
        } else {
            loadImaSdk().then(proceed).catch(onAdError);
        }
    });
}
