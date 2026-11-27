import { getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-functions.js';

const firebaseConfig = {
  apiKey: 'AIzaSyAZcjQPHphENs-Bb7IfdL2qTtOMhJrRP54',
  authDomain: 'soop-stock-market.firebaseapp.com',
  databaseURL: 'https://soop-stock-market-default-rtdb.firebaseio.com',
  projectId: 'soop-stock-market',
  storageBucket: 'soop-stock-market.firebasestorage.app',
  messagingSenderId: '997788925900',
  appId: '1:997788925900:web:b58db2970489bf18a3a769'
};

// 서비스 일시정지 플래그: 통합 관리 센터의 "서비스 일시정지" 세션이 쓰는 {active, updatedAt}.
// active가 true면 안내 화면을 보이고, false면 모두에게 연다. 값이 없거나 읽지 못하면 이 서비스의 기본 상태를 따른다.
// SERVICE_ID / PAUSE_FLAG_URL / DEFAULT_PAUSED 는 서비스마다 다르다(나머지 코드는 시리즈 공통).
// series-kit maintenance-gate — 원본은 비공개 저장소 series-kit, 이 파일을 직접 고치지 말 것(tools/sync.mjs로 생성).
const SERVICE_ID = 'stockMarket';
const PAUSE_FLAG_URL = 'https://soop-stock-market-rtdb.firebaseio.com/servicePause.json';
const DEFAULT_PAUSED = true;
const PREVIEW_GATE_PARAMS = [];
const PREVIEW_ENABLED = true;
const WATCH = 'poll';
const APPCHECK = true;
const PAGE_SDK = '10.7.0';
const OWN_APP = true;
const LAZY_ADMIN_CHECK = false;
const OPEN_SERVICE_LINKS = "<a href=\"https://neezu-crypto.github.io/streamer-fanpage/\" rel=\"noopener\">스트리머 팬페이지</a><a href=\"https://neezu-crypto.github.io/streamer-fanpage/viewer-stats.html\" rel=\"noopener\">스트리머 고점체크</a><a href=\"https://neezu-crypto.github.io/streamer-gallery/\" rel=\"noopener\">스트리머 갤러리</a><a href=\"https://neezu-crypto.github.io/streamer-messenger/\" rel=\"noopener\">스트리머 메신저</a>";
// 메인만 보기(preview, 2026-11-27): 일시정지 + mode:'preview'면 덮개 대신 상단 띠를 보이고 메인 화면만 둘러보게 한다.
// 모든 기능(클릭·입력·제출)은 막고, 앱은 window.__seriesAppReady가 풀릴 때까지 데이터를 읽지 않는다.
// PREVIEW_MAIN_URL: 메인 주소(쿼리 없이). PREVIEW_GATE_PARAMS: 이 쿼리가 있으면 preview여도 점검 안내 화면(OBS 장면 등).
const PREVIEW_MAIN_URL = new URL('./', import.meta.url).href;
const PAUSE_POLL_MS = 20 * 1000;
const PAUSE_FETCH_TIMEOUT_MS = 5000;
const PAGE_APP_WAIT_MS = 4000;

let unlocked = false;
let adminUnlocked = false;
let pauseKnown = false;
let paused = DEFAULT_PAUSED;
let locked = false;
let gate;
let auth;
let adminCheckPendingUser = null;
let checkAccess;
let mode = 'gate';
let previewOn = false;
let banner;
let toastTimer = 0;
let appReadyResolve;
// 앱 시작 코드는 이 약속을 기다린 뒤 로그인·데이터 읽기를 시작한다(메인만 보기 중에는 풀리지 않음).
window.__seriesAppReady = new Promise((resolve) => { appReadyResolve = resolve; });

function isPreviewAllowedLink(link) {
  if (!link) return false;
  const href = link.getAttribute('href') || '';
  if (href.startsWith('#')) return true;
  try {
    const url = new URL(href, location.href);
    if (url.origin !== location.origin) return true;
    return /(terms|privacy)[^/]*\.html$/.test(url.pathname);
  } catch { return false; }
}

function previewToast() {
  if (!banner) return;
  const note = banner.querySelector('[data-preview-note]');
  note.textContent = '점검 중이라 지금은 이용할 수 없어요';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { note.textContent = '화면만 둘러볼 수 있어요'; }, 2200);
}

function blockPreview(event) {
  if (!previewOn || banner?.contains(event.target)) return;
  const target = event.target instanceof Element ? event.target : null;
  if (event.type === 'keydown') {
    const field = target && target.closest('input, textarea, select, [contenteditable="true"]');
    const navKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Tab', 'Escape'];
    if (!field && navKeys.includes(event.key)) return;
    if (!field && event.key !== 'Enter' && event.key !== ' ') return;
  } else if (event.type === 'click' && isPreviewAllowedLink(target && target.closest('a[href]'))) {
    return;
  } else if (event.type === 'pointerdown' && !(target && target.closest('input, textarea, select, button, [contenteditable="true"]'))) {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.type === 'click' || event.type === 'submit') previewToast();
}

function setPreview(on) {
  if (previewOn === on) return;
  previewOn = on;
  const types = ['click', 'pointerdown', 'keydown', 'submit', 'focusin'];
  if (on) {
    document.documentElement.dataset.seriesPreview = '1';
    window.__seriesPreview = true;
    types.forEach((t) => document.addEventListener(t, t === 'focusin' ? blurField : blockPreview, true));
    if (banner) banner.style.display = 'flex';
  } else {
    document.documentElement.removeAttribute('data-series-preview');
    window.__seriesPreview = false;
    types.forEach((t) => document.removeEventListener(t, t === 'focusin' ? blurField : blockPreview, true));
    if (banner) banner.style.display = 'none';
  }
}

function blurField(event) {
  if (!previewOn || banner?.contains(event.target)) return;
  if (event.target instanceof HTMLElement && event.target.matches('input, textarea, select, [contenteditable="true"]')) event.target.blur();
}

function wantsPreview() {
  const params = new URLSearchParams(location.search);
  // PREVIEW_ENABLED: 앱 시작이 __seriesAppReady를 기다리게 바뀐 서비스만 메인만 보기를 쓴다(아니면 점검 안내 화면).
  return PREVIEW_ENABLED && mode === 'preview' && !PREVIEW_GATE_PARAMS.some((key) => params.has(key));
}

let adminLoginStarted = false;
function render(message, canLogin = true) {
  if (!gate) return;
  gate.querySelector('[data-maintenance-status]').textContent = message;
  gate.querySelector('[data-maintenance-login]').disabled = !canLogin;
  // 메인만 보기에서는 점검 화면이 숨겨져 있으므로, 관리자 로그인 진행 중 안내를 상단 띠에도 보인다.
  if (previewOn && banner && adminLoginStarted) {
    clearTimeout(toastTimer);
    banner.querySelector('[data-preview-note]').textContent = message;
  }
}

function blockInteraction(event) {
  if (!locked || gate?.contains(event.target)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function lockPage() {
  if (locked) return;
  locked = true;
  unlocked = false;
  document.addEventListener('click', blockInteraction, true);
  document.addEventListener('pointerdown', blockInteraction, true);
  document.addEventListener('keydown', blockInteraction, true);
  document.addEventListener('submit', blockInteraction, true);
}

function unlockPage() {
  locked = false;
  unlocked = true;
  setPreview(false);
  appReadyResolve();
  document.removeEventListener('click', blockInteraction, true);
  document.removeEventListener('pointerdown', blockInteraction, true);
  document.removeEventListener('keydown', blockInteraction, true);
  document.removeEventListener('submit', blockInteraction, true);
  if (gate) gate.style.display = 'none';
  document.documentElement.removeAttribute('data-series-maintenance');
}

// 일시정지 상태와 관리자 확인 결과로 안내 화면을 보이거나 숨긴다.
// 상태를 아직 모르는 동안에는 기본 상태가 일시정지인 서비스만 입력을 막고, 화면은 확인 뒤에 보인다.
function applyState() {
  if (adminUnlocked || !paused) {
    unlockPage();
    return;
  }
  if (pauseKnown && wantsPreview()) {
    // 메인 주소가 아니면(쿼리·다른 페이지) 메인으로 옮긴다.
    const here = location.href.split('#')[0];
    if (here !== PREVIEW_MAIN_URL && here !== PREVIEW_MAIN_URL + 'index.html') { location.replace(PREVIEW_MAIN_URL); return; }
    if (locked) {
      locked = false;
      ['click', 'pointerdown', 'keydown', 'submit'].forEach((t) => document.removeEventListener(t, blockInteraction, true));
    }
    if (gate) gate.style.display = 'none';
    setPreview(true);
    return;
  }
  setPreview(false);
  lockPage();
  if (gate) gate.style.display = pauseKnown ? 'grid' : 'none';
  // 점검 안내 화면은 기존처럼 덮개 뒤에서 앱을 시작한다(관리자 우회 뒤 바로 쓰도록).
  if (pauseKnown) appReadyResolve();
}

// RTDB App Check 강제에 대비해 점검 플래그 REST 조회에도 App Check 토큰을 붙인다.
// 페이지의 기본 앱이 뜰 때까지 잠깐 기다리고, 실패하면 토큰 없이 조회한다(강제 전 동작과 동일).
const GATE_APPCHECK_SITE_KEY = '6Ld0AfAtAAAAABcCio4_5AoiCdrjfM7_4riWiYXR';
// PAGE_SDK: 화면이 쓰는 Firebase SDK 버전. 다른 버전으로 App Check를 만들면 reCAPTCHA 위젯이 충돌하므로
// 반드시 화면과 같은 버전 모듈로 기존 앱을 가져온다(주식 10.7.0). APPCHECK가 false면 토큰 없이 조회.
async function pauseFetchHeaders() {
  if (!APPCHECK) return {};
  try {
    const pageAppSdk = await import(`https://www.gstatic.com/firebasejs/${PAGE_SDK}/firebase-app.js`);
    let app = pageAppSdk.getApps().find((item) => item.name === '[DEFAULT]');
    for (let i = 0; !app && i < 15; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      app = pageAppSdk.getApps().find((item) => item.name === '[DEFAULT]');
    }
    if (!app) return {};
    const appCheckSdk = await import(`https://www.gstatic.com/firebasejs/${PAGE_SDK}/firebase-app-check.js`);
    const appCheck = appCheckSdk.initializeAppCheck(app, { provider: new appCheckSdk.ReCaptchaEnterpriseProvider(GATE_APPCHECK_SITE_KEY), isTokenAutoRefreshEnabled: true });
    const result = await Promise.race([
      appCheckSdk.getToken(appCheck, false),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
    ]);
    return result && result.token ? { 'X-Firebase-AppCheck': result.token } : {};
  } catch (error) {
    return {};
  }
}

async function readPauseFlag() {
  try {
    const response = await fetch(`${PAUSE_FLAG_URL}?t=${Date.now()}`, { headers: await pauseFetchHeaders(), cache: 'no-store', signal: AbortSignal.timeout(PAUSE_FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value = await response.json();
    paused = value && typeof value.active === 'boolean' ? value.active : DEFAULT_PAUSED;
    mode = value && value.mode === 'preview' ? 'preview' : 'gate';
    pauseKnown = true;
  } catch (error) {
    console.error(`서비스 일시정지 상태 확인 실패(${SERVICE_ID}):`, error);
    // 아직 한 번도 확인하지 못했다면 기본 상태를 따르고, 이미 알던 상태는 그대로 둔다.
    if (!pauseKnown) { paused = DEFAULT_PAUSED; pauseKnown = true; }
  }
  applyState();
  if (LAZY_ADMIN_CHECK && paused && !adminUnlocked && adminCheckPendingUser && auth && auth.currentUser === adminCheckPendingUser) void verify(adminCheckPendingUser);
}

// WATCH 'realtime': 첫 확인 뒤 실시간 연결로 값이 바뀔 때만 받는다(읽기 절약·즉시 반영), 실패하면 주기 확인.
// WATCH 'poll': 20초마다·탭으로 돌아올 때 다시 읽는다. WATCH 'once': 접속할 때 1회만(새로고침해야 반영, 비용 절감).
let pausePollTimer = 0;
let pauseWatching = false;
function startPausePolling() {
  if (!pausePollTimer) pausePollTimer = setInterval(() => { void readPauseFlag(); }, PAUSE_POLL_MS);
}
async function watchPauseFlag(app) {
  try {
    const { getDatabase, ref, onValue } = await import('https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js');
    onValue(ref(getDatabase(app), `servicePause/${SERVICE_ID}`), (snapshot) => {
      pauseWatching = true;
      if (pausePollTimer) { clearInterval(pausePollTimer); pausePollTimer = 0; }
      const value = snapshot.val();
      paused = value && typeof value.active === 'boolean' ? value.active : DEFAULT_PAUSED;
      mode = value && value.mode === 'preview' ? 'preview' : 'gate';
      pauseKnown = true;
      applyState();
      if (LAZY_ADMIN_CHECK && paused && !adminUnlocked && adminCheckPendingUser && auth && auth.currentUser === adminCheckPendingUser) void verify(adminCheckPendingUser);
    }, (error) => {
      console.warn(`서비스 일시정지 실시간 확인 실패(${SERVICE_ID}), 주기 확인으로 전환:`, error && error.message);
      pauseWatching = false;
      startPausePolling();
    });
  } catch (error) {
    startPausePolling();
  }
}

function createGate() {
  const style = document.createElement('style');
  style.textContent = `
    #series-maintenance-gate{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;background:#101522;color:#f4f6ff;font:16px/1.7 system-ui,sans-serif}
    #series-maintenance-gate .series-maintenance-card{width:min(100%,560px);padding:40px 28px;border:1px solid #38435a;border-radius:20px;background:#1a2232;text-align:center;box-shadow:0 22px 60px #0008}
    #series-maintenance-gate h1{margin:8px 0 16px;font-size:clamp(24px,5vw,32px);line-height:1.3}
    #series-maintenance-gate p{margin:8px 0;color:#d3dbea}
    #series-maintenance-gate button{margin-top:18px;border:0;border-radius:10px;padding:12px 18px;background:#4285f4;color:white;font:inherit;font-weight:700;cursor:pointer}
    #series-maintenance-gate button:disabled{opacity:.6;cursor:wait}
    #series-maintenance-gate a{display:block;margin-top:16px;color:#a8caff}
    #series-maintenance-gate .series-maintenance-links{margin:22px 0 0;padding:16px;border:1px solid #38435a;border-radius:14px;background:#141b29}
    #series-maintenance-gate .series-maintenance-links strong{display:block;margin-bottom:6px;color:#f4f6ff;font-size:14px}
    #series-maintenance-gate .series-maintenance-links a{margin-top:6px;font-weight:700}
  `;
  document.head.append(style);
  gate = document.createElement('section');
  gate.id = 'series-maintenance-gate';
  gate.style.display = 'none';
  gate.setAttribute('role', 'dialog');
  gate.setAttribute('aria-modal', 'true');
  gate.innerHTML = `<div class="series-maintenance-card"><div aria-hidden="true" style="font-size:40px">🛠️</div><h1>더 나은 서비스를 위해 수정 중이에요</h1><p data-maintenance-status>더 원활한 서비스를 위해 지금 수정 작업을 하고 있어요. 이용에 불편을 드려 죄송합니다. 작업이 끝나면 다시 열어 드릴게요.</p><div class="series-maintenance-links"><strong>지금 이용할 수 있는 서비스</strong>${OPEN_SERVICE_LINKS}</div><button type="button" data-maintenance-login>관리자 Google 로그인</button><a href="https://www.sooplive.com/station/skftodwocks2" rel="noopener">개발자 방송국에서 공지 확인하기</a></div>`;
  document.documentElement.append(gate);
  const bannerStyle = document.createElement('style');
  bannerStyle.textContent = `
    #series-preview-banner{position:fixed;top:0;left:0;right:0;z-index:2147483646;display:none;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;padding:8px 12px;background:#1a2232;color:#f4f6ff;font:600 14px/1.4 system-ui,sans-serif;box-shadow:0 2px 10px #0005}
    #series-preview-banner button{border:0;border-radius:8px;padding:4px 10px;background:#38435a;color:#d3dbea;font:inherit;font-size:12px;cursor:pointer}
    html[data-series-preview] body{padding-top:44px !important}
    html[data-series-preview] .series-live-area{visibility:hidden}
    @media (max-width:520px){#series-preview-banner{font-size:13px;gap:6px}}
  `;
  document.head.append(bannerStyle);
  banner = document.createElement('div');
  banner.id = 'series-preview-banner';
  banner.setAttribute('role', 'status');
  banner.innerHTML = '<span>🔧 지금은 점검 중이에요 · <span data-preview-note>화면만 둘러볼 수 있어요</span></span><button type="button" data-preview-admin>관리자</button>';
  document.documentElement.append(banner);
  // 띠의 [관리자]는 점검 화면 버튼의 사용 가능 여부(확인 중이면 꺼짐)와 상관없이 바로 로그인 창을 연다.
  banner.querySelector('[data-preview-admin]').addEventListener('click', () => { void adminLogin(); });
  gate.querySelector('[data-maintenance-login]').addEventListener('click', () => { void adminLogin(); });
}

async function adminLogin() {
  adminLoginStarted = true;
  if (!auth) {
    render('페이지를 준비하고 있습니다. 잠시 후 다시 시도해 주세요.', false);
    return;
  }
  render('Google 계정 로그인을 기다리고 있습니다.', false);
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await signInWithPopup(auth, provider);
  } catch (error) {
    console.error('관리자 로그인 실패:', error);
    render('로그인하지 못했습니다. 관리자 Google 계정으로 다시 시도해 주세요.');
  }
}

async function verify(user) {
  // LAZY_ADMIN_CHECK: 점검 중이 아닐 때는 관리자 확인 호출을 하지 않는다(서버 호출 절약). 점검으로 바뀌면 그때 확인한다.
  if (LAZY_ADMIN_CHECK && user && !user.isAnonymous && (!pauseKnown || !paused)) { adminCheckPendingUser = user; return; }
  adminCheckPendingUser = null;
  if (!user || user.isAnonymous) {
    adminUnlocked = false;
    applyState();
    render('더 원활한 서비스를 위해 지금 수정 작업을 하고 있어요. 이용에 불편을 드려 죄송합니다. 작업이 끝나면 다시 열어 드릴게요.');
    return;
  }
  render('관리자 권한을 확인하고 있습니다.', false);
  try {
    const result = await checkAccess({});
    if (result.data?.isAdmin === true) {
      adminUnlocked = true;
      applyState();
      return;
    }
    adminUnlocked = false;
    applyState();
    render('이 계정은 관리자 계정이 아닙니다. 관리자 계정으로 로그인해 주세요.');
  } catch (error) {
    console.error('관리자 권한 확인 실패:', error);
    render('관리자 권한을 확인하지 못했습니다. 연결을 확인한 뒤 다시 로그인해 주세요.');
  }
}

// 페이지가 만든 기본 Firebase 앱을 기다려 같은 로그인 상태를 쓴다.
// 일정 시간 안에 만들어지지 않으면 같은 설정으로 직접 만든다.
// OWN_APP: 화면 SDK 버전이 달라(주식 10.7.0) 같은 앱을 공유할 수 없으면 처음부터 자기 앱을 만든다.
function connectToPageFirebase(startedAt = Date.now()) {
  let app = OWN_APP ? null : getApps().find((item) => item.name === '[DEFAULT]');
  if (!app && (OWN_APP || Date.now() - startedAt >= PAGE_APP_WAIT_MS)) app = getApps().find((item) => item.name === '[DEFAULT]') || initializeApp(firebaseConfig);
  if (!app) {
    window.setTimeout(() => connectToPageFirebase(startedAt), 50);
    return;
  }
  auth = getAuth(app);
  checkAccess = httpsCallable(getFunctions(app, 'us-central1'), 'streamerFanPageMaintenanceAccess');
  onAuthStateChanged(auth, (user) => { void verify(user); });
  if (WATCH === 'realtime') void watchPauseFlag(app);
}

createGate();
if (DEFAULT_PAUSED) lockPage();
render('페이지를 준비하고 있습니다.', false);
void readPauseFlag();
if (WATCH !== 'once') {
  startPausePolling();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !pauseWatching) void readPauseFlag(); });
}
connectToPageFirebase();
