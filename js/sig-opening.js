/*
 * 오목지면시그 시그니처 오프닝 — 스트리머 게임시리즈 공용 브랜드 모먼트.
 * 최초 방문 시 1회 표시하며, localStorage 플래그를 자매 게임과 공유한다.
 */

var OJM_SIG_SEEN_KEY = 'ojmSigSplashSeen_v1';
var OJM_SIG_DURATION_MS = 3400;

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
  var seen = false;
  try { seen = localStorage.getItem(OJM_SIG_SEEN_KEY) === '1'; } catch (e) {}
  if (seen) { onDone(); return; }
  ojmPlaySigOpening(function () {
    try { localStorage.setItem(OJM_SIG_SEEN_KEY, '1'); } catch (e) {}
    onDone();
  });
}
