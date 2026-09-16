/*
 * 오목지면시그 시그니처 오프닝 — 스트리머 게임시리즈 공용 브랜드 모먼트.
 * 이 페이지 전용 localStorage 타임스탬프를 사용해 24시간에 한 번 표시한다.
 */

var OJM_SIG_LAST_SHOWN_KEY = 'ojmSigSplashLastShown_stockMarket_v1';
var OJM_SIG_INTERVAL_MS = 24 * 60 * 60 * 1000;
var OJM_SIG_DURATION_MS = 3400;
var ojmSigStarted = false;

function ojmPlaySigOpening(onDone) {
  var stage = document.getElementById('sig-opening-stage');
  if (!stage) { onDone(); return; }
  stage.classList.add('is-playing');

  var finished = false;
  var timer = setTimeout(finish, OJM_SIG_DURATION_MS);
  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    stage.removeEventListener('click', finish);
    stage.removeEventListener('keydown', onKeydown);
    stage.classList.add('is-leaving');
    setTimeout(function () {
      stage.classList.remove('is-playing', 'is-leaving');
      onDone();
    }, 400);
  }
  function onKeydown(e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); finish(); }
  }
  stage.addEventListener('click', finish);
  stage.addEventListener('keydown', onKeydown);
}

function ojmMaybeShowBootSplash(onDone) {
  if (ojmSigStarted) {
    if (typeof onDone === 'function') onDone();
    return;
  }
  ojmSigStarted = true;
  var now = Date.now();
  var lastShownAt = 0;
  try { lastShownAt = Number(localStorage.getItem(OJM_SIG_LAST_SHOWN_KEY)) || 0; } catch (e) {}
  if (lastShownAt > 0 && now >= lastShownAt && now - lastShownAt < OJM_SIG_INTERVAL_MS) {
    if (typeof onDone === 'function') onDone();
    return;
  }
  ojmPlaySigOpening(function () {
    try { localStorage.setItem(OJM_SIG_LAST_SHOWN_KEY, String(Date.now())); } catch (e) {}
    if (typeof onDone === 'function') onDone();
  });
}

// 이 스크립트는 오프닝 레이어 직후에 로드된다. 로그인·종목 데이터 초기화와
// 무관하게 24시간 주기 오프닝을 즉시 시작해, 모든 로딩을 하위 레이어에서 진행한다.
ojmMaybeShowBootSplash();
