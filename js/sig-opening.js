/*
 * 오목지면시그 시그니처 오프닝 — 스트리머 게임시리즈 공용 브랜드 모먼트.
 * 모든 애니메이션은 performance.now() 기준 시간축으로 직접 계산한다.
 */

var OJM_SIG_LAST_SHOWN_KEY = 'ojmSigSplashLastShown_stockMarket_v1';
var OJM_SIG_INTERVAL_MS = 24 * 60 * 60 * 1000;
var OJM_SIG_DURATION_MS = 3400;
var ojmSigStarted = false;

function ojmPlaySigOpening(onDone) {
  var stage = document.getElementById('sig-opening-stage');
  if (!stage) { if (typeof onDone === 'function') onDone(); return; }
  var series = stage.querySelector('.sig-series');
  var seriesTag = stage.querySelector('.sig-series-tag');
  var reelTrack = stage.querySelector('.sig-reel-track');
  var underline = stage.querySelector('.sig-series-under');
  var titleFrame = stage.querySelector('.sig-title-frame');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var rafId = null;
  var now = function () {
    return (window.performance && typeof window.performance.now === 'function')
      ? window.performance.now() : Date.now();
  };
  var requestFrame = window.requestAnimationFrame || function (callback) {
    return window.setTimeout(function () { callback(now()); }, 16);
  };
  var cancelFrame = window.cancelAnimationFrame || window.clearTimeout;
  var startedAt = now();

  function clamp01(value) { return Math.max(0, Math.min(1, value)); }
  function smoothStep(value) {
    value = clamp01(value);
    return value * value * (3 - 2 * value);
  }
  function easeOutCubic(value) {
    value = clamp01(value);
    return 1 - Math.pow(1 - value, 3);
  }
  function progress(elapsed, start, duration) {
    if (elapsed < start) return 0;
    if (reduceMotion) return 1;
    return clamp01((elapsed - start) / duration);
  }
  function applyTimeline(timestamp) {
    var elapsed = Math.max(0, timestamp - startedAt);
    var seriesIn = progress(elapsed, 0, 700);
    var seriesOut = progress(elapsed, 2300, 500);
    series.style.opacity = String(elapsed < 2300 ? seriesIn : 1 - seriesOut);
    series.style.transform = 'translateY(' + (elapsed < 2300
      ? 18 * (1 - easeOutCubic(seriesIn)) : -14 * seriesOut) + 'px)';

    var tagProgress = progress(elapsed, 0, 450);
    seriesTag.style.opacity = String(tagProgress);
    seriesTag.style.transform = 'translateY(' + (18 * (1 - easeOutCubic(tagProgress))) + 'px)';

    var reelProgress = progress(elapsed, 500, 1000);
    var reelStep = Math.min(5, Math.floor(reelProgress * 5 + 0.000001));
    reelTrack.style.transform = 'translateY(' + (-44 * reelStep) + 'px)';

    var underlineProgress = progress(elapsed, 1500, 500);
    underline.style.width = (180 * smoothStep(underlineProgress)) + 'px';

    var titleProgress = progress(elapsed, 2600, 600);
    titleFrame.style.opacity = String(titleProgress);
    titleFrame.style.transform = 'translateY(' + (18 * (1 - easeOutCubic(titleProgress))) + 'px)';
    if (!finished) rafId = requestFrame(applyTimeline);
  }
  function resetInlineStyles() {
    [series, seriesTag, reelTrack, underline, titleFrame].forEach(function (element) {
      element.removeAttribute('style');
    });
  }

  stage.classList.remove('is-leaving');
  stage.classList.add('is-js-timeline', 'is-playing');
  var finished = false;
  rafId = requestFrame(applyTimeline);
  var timer = setTimeout(finish, OJM_SIG_DURATION_MS);
  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (rafId !== null) cancelFrame(rafId);
    stage.removeEventListener('click', finish);
    stage.removeEventListener('keydown', onKeydown);
    stage.classList.add('is-leaving');
    setTimeout(function () {
      stage.classList.remove('is-js-timeline', 'is-playing', 'is-leaving');
      resetInlineStyles();
      if (typeof onDone === 'function') onDone();
    }, reduceMotion ? 0 : 400);
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

// 로그인·종목 데이터 초기화와 무관하게 오프닝을 즉시 띄워, 모든 로딩을
// 오프닝 하위 레이어에서 동시에 진행한다.
ojmMaybeShowBootSplash();
