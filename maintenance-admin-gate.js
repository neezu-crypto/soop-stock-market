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

const app = getApps().find((item) => item.name === '[DEFAULT]') || initializeApp(firebaseConfig);
const auth = getAuth(app);
const functions = getFunctions(app, 'us-central1');
const checkAccess = httpsCallable(functions, 'streamerFanPageMaintenanceAccess');
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

// 서비스 일시정지 플래그: 통합 관리 센터의 "서비스 일시정지" 세션이 시장 전용 DB의 servicePause에 쓴다.
// active가 명시적으로 false일 때만 모두에게 열고, 값이 없거나 읽지 못하면 안내 화면을 유지한다(기본 일시정지).
const PAUSE_FLAG_URL = 'https://soop-stock-market-rtdb.firebaseio.com/servicePause.json';
// 메인만 보기(preview, 2026-11-27): 일시정지 + mode:'preview'면 덮개 대신 상단 띠를 보이고 메인 화면만 둘러보게 한다.
// 모든 기능(클릭·입력·제출)은 막고, 앱은 window.__seriesAppReady가 풀릴 때까지 데이터를 읽지 않는다.
const PREVIEW_MAIN_URL = new URL('./', import.meta.url).href;
const PREVIEW_GATE_PARAMS = [];
const PAUSE_POLL_MS = 20 * 1000;
const PAUSE_FETCH_TIMEOUT_MS = 5000;

let unlocked = false;
let adminUnlocked = false;
let pauseKnown = false;
let paused = true;
let locked = false;
let gate;
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
  return mode === 'preview' && !PREVIEW_GATE_PARAMS.some((key) => params.has(key));
}


function render(message, canLogin = true) {
  if (!gate) return;
  gate.querySelector('[data-maintenance-status]').textContent = message;
  gate.querySelector('[data-maintenance-login]').disabled = !canLogin;
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

// 일시정지 상태와 관리자 확인 결과로 안내 화면을 보이거나 숨긴다. 확인 전에는 화면은 숨기되 입력은 막아 둔다.
function applyState() {
  if (adminUnlocked || (pauseKnown && !paused)) {
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
async function pauseFetchHeaders() {
  try {
    // 주식 화면은 Firebase 10.7.0 SDK로 앱·App Check를 만든다. 다른 버전 SDK로 App Check를 만들면
    // 같은 id의 reCAPTCHA 위젯이 충돌하므로 반드시 화면과 같은 10.7.0 모듈로 기존 인스턴스를 가져온다.
    const pageAppSdk = await import('https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js');
    let app = pageAppSdk.getApps().find((item) => item.name === '[DEFAULT]');
    for (let i = 0; !app && i < 15; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      app = pageAppSdk.getApps().find((item) => item.name === '[DEFAULT]');
    }
    if (!app) return {};
    const appCheckSdk = await import('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-check.js');
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
    paused = !(value && value.active === false);
    mode = value && value.mode === 'preview' ? 'preview' : 'gate';
    pauseKnown = true;
  } catch (error) {
    console.error('서비스 일시정지 상태 확인 실패:', error);
    // 처음 한 번도 확인하지 못했다면 안내 화면을 보여 주고, 이미 알던 상태는 그대로 둔다.
    if (!pauseKnown) { paused = true; pauseKnown = true; }
  }
  applyState();
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
  gate.innerHTML = `<div class="series-maintenance-card"><div aria-hidden="true" style="font-size:40px">🛠️</div><h1>더 나은 서비스를 위해 수정 중이에요</h1><p data-maintenance-status>더 원활한 서비스를 위해 지금 수정 작업을 하고 있어요. 이용에 불편을 드려 죄송합니다. 작업이 끝나면 다시 열어 드릴게요.</p><div class="series-maintenance-links"><strong>지금 이용할 수 있는 서비스</strong><a href="https://neezu-crypto.github.io/streamer-fanpage/" rel="noopener">스트리머 팬페이지</a><a href="https://neezu-crypto.github.io/streamer-fanpage/viewer-stats.html" rel="noopener">스트리머 고점체크</a><a href="https://neezu-crypto.github.io/streamer-gallery/" rel="noopener">스트리머 갤러리</a><a href="https://neezu-crypto.github.io/streamer-messenger/" rel="noopener">스트리머 메신저</a></div><button type="button" data-maintenance-login>관리자 Google 로그인</button><a href="https://www.sooplive.com/station/skftodwocks2" rel="noopener">개발자 방송국에서 공지 확인하기</a></div>`;
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
  banner.querySelector('[data-preview-admin]').addEventListener('click', () => {
    gate.querySelector('[data-maintenance-login]').click();
  });
  gate.querySelector('[data-maintenance-login]').addEventListener('click', async () => {
    render('Google 계정 로그인을 기다리고 있습니다.', false);
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error('관리자 로그인 실패:', error);
      render('로그인하지 못했습니다. 관리자 Google 계정으로 다시 시도해 주세요.');
    }
  });
}

async function verify(user) {
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

createGate();
lockPage();
void readPauseFlag();
setInterval(() => { void readPauseFlag(); }, PAUSE_POLL_MS);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void readPauseFlag(); });
onAuthStateChanged(auth, (user) => { void verify(user); });

