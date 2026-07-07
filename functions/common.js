const { HttpsError } = require("firebase-functions/v2/https");

// ── 전역 공통 상수 ────────────────────────────────────────────
const ADMIN_EMAIL              = "skftodwocks2@gmail.com"; // 관리자 페이지와 동일 계정
const INITIAL_CASH             = 200000;   // 익명 최초 접속 시 지급되는 시작 자금
const KAKAO_LINK_BONUS         = 800000;   // 카카오 최초 연동 시 추가 지급 (합산 시 기존 100만원과 동일)
const STREAMER_ID_RE           = /^[a-z0-9]{2,20}$/;
const URL_RE                   = /^https?:\/\/.+/i;
const MAX_BANNER_REQUEST_DAYS  = 7;        // 신청 시 신청자가 고를 수 있는 노출 기간 상한
const BANNER_COST_PER_DAY      = 2000000;  // 우측 랭킹 배너 신청 1일당 차감되는 게임자산
const CHART_BANNER_COST_PER_DAY = 4000000; // 차트 하단 배너 신청 1일당 차감되는 게임자산
const MAX_PIN_HOURS            = 12;       // 최상단 고정 노출 신청 시 고를 수 있는 시간 상한
const PIN_COST_PER_HOUR        = 500000;   // 최상단 고정 노출 1시간당 차감되는 게임자산
const MAX_PINNED_SLOTS         = 3;        // 동시에 고정 노출 가능한 최대 종목 수

// ── 플레이타임 제한 관련 상수 ──────────────────────────────────
const ANON_DAILY_SECONDS       = 15 * 60;  // 익명 유저 하루 무료 이용 시간
const KAKAO_DAILY_SECONDS      = 60 * 60;  // 카카오 연동 유저 하루 무료 이용 시간
const PLAYTIME_BASE_RATE       = 0.10;     // 기준단가 = 총자산(현금+평가금액) × 이 비율 (1시간, 할증 전)
const PLAYTIME_SURCHARGE_STEP  = 0.10;     // 당일 n번째 추가 구매마다 할증률 +10%p
const PLAYTIME_SURCHARGE_MAX   = 0.50;     // 할증률 상한 (5번째 이상은 +50%로 고정)
const MAX_PLAYTIME_BUY_HOURS   = 12;       // 1회 요청으로 구매 가능한 시간 상한
const MAX_HEARTBEAT_GAP_SECONDS = 90;      // 하트비트 1회당 인정되는 최대 경과 시간(절전/재접속 등 이상치 방지)

const MAX_RELAY_ROOM_HOURS     = 8;        // 중계방 홍보 신청 시 고를 수 있는 시간 상한 (최소 1시간)
const RELAY_ROOM_COST_PER_HOUR = 300000;   // 중계방 홍보 1시간당 차감되는 게임자산
const MAX_RELAY_ROOMS          = 3;        // 동시에 등록 가능한 최대 중계방 수

function requireAdmin(auth) {
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  if (auth.token?.email !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "관리자 권한이 없습니다.");
  }
}

/**
 * 자산충전/배너/중계방/고정노출 등 "로그인 유저 전용" 셀프 서비스 신청에서
 * 공통으로 쓰는 게이트. 이 앱의 익명 로그인은 접속 시 자동으로 이뤄지므로,
 * 여기서 말하는 "로그인"은 실제로는 카카오 연동(또는 관리자 Google 계정)을
 * 뜻한다 — 매크로/도배성 신청을 어렵게 하고, 실제 신원이 있는 유저만
 * 게임자산을 실제 홍보 슬롯으로 바꿀 수 있게 하기 위함.
 */
async function requireLinkedUser(db, uid, auth) {
  if (auth.token?.email === ADMIN_EMAIL) return; // 관리자는 이미 Google 로그인 상태
  const user = (await db.ref(`users/${uid}`).get()).val();
  if (!user?.kakaoLinked) {
    throw new HttpsError(
      "permission-denied",
      "로그인이 필요한 기능입니다. 카카오 연동 후 이용해주세요."
    );
  }
}

async function findStockIdByName(db, name) {
  const snap = await db.ref("stocks").get();
  const data = snap.val() || {};
  let targetId = null;
  Object.entries(data).forEach(([id, s]) => { if (s.name === name) targetId = id; });
  return targetId;
}

/** endDate 문자열로 활성/만료 여부와 남은 일수를 계산한다. 빈 값이면 무기한(항상 활성). */
function bannerStatus(endDateStr) {
  if (!endDateStr) return { active: true, daysLeft: null };
  const end = new Date(endDateStr);
  end.setHours(23, 59, 59, 999);
  const daysLeft = Math.ceil((end - new Date()) / 86400000);
  return { active: daysLeft >= 0, daysLeft };
}

/**
 * 유저 게임자산(cash)에서 cost만큼 차감한다. 잔액 부족 시 예외를 던진다.
 * trueUser 선조회는 Admin SDK 트랜잭션 콜백에 currentUser가 null(캐시 미스)로
 * 들어와도 "신규 유저 기본값"으로 오판하지 않기 위함 — 트랜잭션 콜백이 활성
 * 리스너 없는 경로는 캐시하지 않는 Admin SDK 특성 때문에 null을 받을 수 있다.
 */
async function chargeUserCash(db, uid, cost) {
  const userRef  = db.ref(`users/${uid}`);
  const trueUser = (await userRef.get()).val();
  let insufficient = false;

  const userTx = await userRef.transaction((currentUser) => {
    const user = currentUser || trueUser || { cash: INITIAL_CASH, stocks: {} };
    if ((user.cash || 0) < cost) {
      insufficient = true;
      return; // abort
    }
    return { ...user, cash: user.cash - cost };
  });

  if (insufficient) {
    throw new HttpsError("failed-precondition", `게임자산이 부족합니다! (필요 금액: ${cost.toLocaleString()}원)`);
  }
  if (!userTx.committed) {
    throw new HttpsError("aborted", "신청 처리 중 문제가 발생했습니다. 다시 시도해주세요.");
  }
}

/** 유저 게임자산(cash)에 amount만큼 더한다 (배너 신청 환불, 카카오 연동 보너스, 자산 충전 승인 등에 재사용). */
async function creditUserCash(db, uid, amount) {
  if (!uid || !amount) return;
  const userRef  = db.ref(`users/${uid}`);
  const trueUser = (await userRef.get()).val();
  await userRef.transaction((currentUser) => {
    const user = currentUser || trueUser;
    if (!user) return currentUser; // 지급 대상 유저 데이터가 없으면 그대로 둔다
    return { ...user, cash: (user.cash || 0) + amount };
  });
}

module.exports = {
  ADMIN_EMAIL,
  INITIAL_CASH,
  KAKAO_LINK_BONUS,
  STREAMER_ID_RE,
  URL_RE,
  MAX_BANNER_REQUEST_DAYS,
  BANNER_COST_PER_DAY,
  CHART_BANNER_COST_PER_DAY,
  MAX_PIN_HOURS,
  PIN_COST_PER_HOUR,
  MAX_PINNED_SLOTS,
  ANON_DAILY_SECONDS,
  KAKAO_DAILY_SECONDS,
  PLAYTIME_BASE_RATE,
  PLAYTIME_SURCHARGE_STEP,
  PLAYTIME_SURCHARGE_MAX,
  MAX_PLAYTIME_BUY_HOURS,
  MAX_HEARTBEAT_GAP_SECONDS,
  MAX_RELAY_ROOM_HOURS,
  RELAY_ROOM_COST_PER_HOUR,
  MAX_RELAY_ROOMS,
  requireAdmin,
  requireLinkedUser,
  findStockIdByName,
  bannerStatus,
  chargeUserCash,
  creditUserCash,
};
