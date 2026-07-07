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

function requireAdmin(auth) {
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  if (auth.token?.email !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "관리자 권한이 없습니다.");
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
  requireAdmin,
  findStockIdByName,
  bannerStatus,
  chargeUserCash,
  creditUserCash,
};
