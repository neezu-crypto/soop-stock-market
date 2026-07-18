const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const {
  STREAMER_ID_RE,
  STOCK_UNFREEZE_PRICE,
  STOCK_FREEZE_COOLDOWN_MS,
  STOCK_DELIST_DEADLINE_MS,
  UNFREEZE_CASH_COST,
  UNFREEZE_CASH_REWARD,
  UNFREEZE_DONATION_REWARD,
  requireAdmin,
  requireLinkedUser,
  requireNotInMaintenance,
  chargeUserCash,
  creditUserCash,
  grantAchievement,
} = require("./common");

// ══════════════════════════════════════════════════════════
// 종목 거래 동결(서킷브레이커) — 동결 판정 자체는 functions/trade.js에서
// 매수 체결마다 확인한다(최근 5개 1분봉 종가가 전부 100만원 이상이면 동결).
// 이 파일은 "동결 해제"와 "미해제 시 상장폐지" 만 다룬다.
//
// 해제 경로 2가지 (선착순 1명, 공동모금 아님):
//   1) 게임자산 100만원 지출 → 즉시 셀프서비스, 200만원 보상(순이익 100만원)
//   2) 라이브 방송 후원(별풍선 50개) → 신청 후 관리자 검수, 100만원 보상
// 공통 제약:
//   - 동결 후 5분간(STOCK_FREEZE_COOLDOWN_MS)은 누구도 해제 불가 — 즉시
//     자기해제를 막고, 다른 유저가 발견해 경쟁할 시간을 만들어 "빠른 후원이
//     이득"이라는 학습 효과를 의도한다.
//   - 동결을 유발한 계정(freezeTriggerUid) 본인은 해제할 수 없다 — 셀프
//     펌핑 후 게임자산으로 즉시 자기 해제해 순이익을 반복 획득하는 차익거래
//     방지.
// ══════════════════════════════════════════════════════════

function assertUnfreezable(stock, uid) {
  if (!stock || !stock.frozenAt) {
    throw new HttpsError("failed-precondition", "이 종목은 현재 동결 상태가 아닙니다.");
  }
  const elapsed = Date.now() - stock.frozenAt;
  if (elapsed < STOCK_FREEZE_COOLDOWN_MS) {
    const remainingSec = Math.ceil((STOCK_FREEZE_COOLDOWN_MS - elapsed) / 1000);
    throw new HttpsError("failed-precondition", `동결 직후에는 해제할 수 없습니다. ${remainingSec}초 후 다시 시도해주세요.`);
  }
  if (stock.freezeTriggerUid && stock.freezeTriggerUid === uid) {
    throw new HttpsError("permission-denied", "동결을 유발한 계정은 본인이 직접 해제할 수 없습니다.");
  }
}

/** 해제 성공 시 다른 유저들에게 보여줄 공지(닉네임 등 개인정보는 담지 않는다). */
async function announceUnfreeze(db, { stockId, stockName, method, rewardAmount }) {
  await db.ref("lastUnfreezeEvent").set({
    stockId,
    stockName,
    method, // 'cash' | 'donation'
    rewardAmount,
    at: Date.now(),
  });
}

/**
 * 게임자산으로 즉시 동결 해제 (셀프서비스, 관리자 검수 없음).
 * 100만원을 내고 200만원을 돌려받는 구조라 순이익은 있지만, 쿨다운과
 * "유발자 본인 불가" 제약 때문에 자기펌핑→자기해제 차익거래는 막혀 있다.
 */
const unfreezeWithCash = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const db = admin.database();
  await requireLinkedUser(db, auth.uid, auth);
  await requireNotInMaintenance(db, auth);

  const stockId = String(request.data?.stockId || "").trim();
  if (!stockId) throw new HttpsError("invalid-argument", "stockId가 필요합니다.");

  const stockSnap = await db.ref(`stocks/${stockId}`).get();
  if (!stockSnap.exists()) throw new HttpsError("not-found", "종목을 찾을 수 없습니다.");
  const stock = stockSnap.val();
  assertUnfreezable(stock, auth.uid);

  await chargeUserCash(db, auth.uid, UNFREEZE_CASH_COST);
  await creditUserCash(db, auth.uid, UNFREEZE_CASH_REWARD);

  await db.ref().update({
    [`stocks/${stockId}/price`]:            STOCK_UNFREEZE_PRICE,
    [`stocks/${stockId}/frozenAt`]:         null,
    [`stocks/${stockId}/freezeDeadline`]:   null,
    [`stocks/${stockId}/freezeTriggerUid`]: null,
  });

  await announceUnfreeze(db, {
    stockId, stockName: stock.name || stockId, method: "cash", rewardAmount: UNFREEZE_CASH_REWARD,
  });
  await grantAchievement(db, auth.uid, "unfreeze_hero");

  return { ok: true, rewardAmount: UNFREEZE_CASH_REWARD };
});

/**
 * 라이브 방송 후원(별풍선 50개) 확인 후 관리자가 승인하는 방식의 동결 해제
 * 신청. 신청 시점엔 아무것도 차감/지급하지 않는다(실제 후원이 방송에서
 * 별도로 확인돼야 하므로 cashCharge와 동일한 패턴).
 */
const submitUnfreezeDonationRequest = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const db = admin.database();
  await requireLinkedUser(db, auth.uid, auth);
  await requireNotInMaintenance(db, auth);

  const stockId  = String(request.data?.stockId || "").trim();
  const nickname = String(request.data?.nickname || "").trim();
  const soopId   = String(request.data?.soopId || "").trim().toLowerCase();

  if (!stockId) throw new HttpsError("invalid-argument", "stockId가 필요합니다.");
  if (!nickname) throw new HttpsError("invalid-argument", "닉네임을 입력해주세요.");
  if (!STREAMER_ID_RE.test(soopId)) {
    throw new HttpsError("invalid-argument", "아이디는 영문 소문자/숫자 2~20자여야 합니다.");
  }

  const stockSnap = await db.ref(`stocks/${stockId}`).get();
  if (!stockSnap.exists()) throw new HttpsError("not-found", "종목을 찾을 수 없습니다.");
  const stock = stockSnap.val();
  assertUnfreezable(stock, auth.uid);

  const ref = db.ref("unfreezeDonationRequests").push();
  await ref.set({
    stockId,
    stockName: stock.name || stockId,
    nickname,
    soopId,
    status:       "pending",
    requestedAt:  Date.now(),
    requesterUid: auth.uid,
  });

  return { ok: true, id: ref.key };
});

async function actionListUnfreezeDonationRequests(db) {
  const snap = await db.ref("unfreezeDonationRequests").get();
  const data = snap.val() || {};
  const requests = Object.entries(data)
    .map(([id, r]) => ({ id, ...r }))
    .filter((r) => r.status === "pending")
    .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));
  return { ok: true, requests };
}

async function actionApproveUnfreezeDonationRequest(db, { requestId }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");

  const reqSnap = await db.ref(`unfreezeDonationRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();
  if (reqData.status !== "pending") {
    throw new HttpsError("failed-precondition", "이미 처리된 신청입니다.");
  }

  const stockSnap = await db.ref(`stocks/${reqData.stockId}`).get();
  if (!stockSnap.exists()) throw new HttpsError("not-found", "대상 종목이 삭제됐습니다. 거절해주세요.");
  const stock = stockSnap.val();
  assertUnfreezable(stock, reqData.requesterUid);

  await creditUserCash(db, reqData.requesterUid, UNFREEZE_DONATION_REWARD);
  await grantAchievement(db, reqData.requesterUid, "unfreeze_hero");

  await db.ref().update({
    [`stocks/${reqData.stockId}/price`]:            STOCK_UNFREEZE_PRICE,
    [`stocks/${reqData.stockId}/frozenAt`]:         null,
    [`stocks/${reqData.stockId}/freezeDeadline`]:   null,
    [`stocks/${reqData.stockId}/freezeTriggerUid`]: null,
    [`unfreezeDonationRequests/${requestId}/status`]:     "approved",
    [`unfreezeDonationRequests/${requestId}/reviewedAt`]: Date.now(),
  });

  await announceUnfreeze(db, {
    stockId: reqData.stockId, stockName: stock.name || reqData.stockId,
    method: "donation", rewardAmount: UNFREEZE_DONATION_REWARD,
  });

  return { ok: true, rewardAmount: UNFREEZE_DONATION_REWARD };
}

async function actionRejectUnfreezeDonationRequest(db, { requestId }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");
  const reqSnap = await db.ref(`unfreezeDonationRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  if (reqSnap.val().status !== "pending") {
    throw new HttpsError("failed-precondition", "이미 처리된 신청입니다.");
  }
  // 신청 시점에 아무것도 차감하지 않았으므로 환불할 것도 없다.
  await db.ref(`unfreezeDonationRequests/${requestId}`).update({
    status:     "rejected",
    reviewedAt: Date.now(),
  });
  return { ok: true };
}

/** 관리자 페이지 — 현재 동결 중인 종목 목록 (남은 상장폐지 유예시간 포함). */
async function actionListFrozenStocks(db) {
  const snap = await db.ref("stocks").get();
  const data = snap.val() || {};
  const now  = Date.now();
  const frozen = Object.entries(data)
    .filter(([, s]) => s.frozenAt)
    .map(([id, s]) => ({
      stockId: id,
      name: s.name || id,
      price: s.price,
      frozenAt: s.frozenAt,
      freezeDeadline: s.freezeDeadline,
      canUnfreezeAt: s.frozenAt + STOCK_FREEZE_COOLDOWN_MS,
      msUntilDelist: Math.max(0, (s.freezeDeadline || now) - now),
    }))
    .sort((a, b) => a.freezeDeadline - b.freezeDeadline);
  return { ok: true, frozen };
}

/**
 * 관리자가 직접 강제로 동결을 해제한다(보상 지급 없음) — 운영상 예외 처리용.
 */
async function actionForceUnfreezeStock(db, { stockId }) {
  if (!stockId) throw new HttpsError("invalid-argument", "stockId가 필요합니다.");
  await db.ref().update({
    [`stocks/${stockId}/price`]:            STOCK_UNFREEZE_PRICE,
    [`stocks/${stockId}/frozenAt`]:         null,
    [`stocks/${stockId}/freezeDeadline`]:   null,
    [`stocks/${stockId}/freezeTriggerUid`]: null,
  });
  return { ok: true };
}

/**
 * 종목 삭제(상장폐지) 시 보유자 지분을 전액 소멸시키고 관련 orphan 데이터를
 * 정리한다. 삭제 직전 스냅샷(stock)을 delistedStocksLog에 남겨, 완전히
 * 사라지는 stocks/{id}와 달리 관리자 페이지에서 이력을 조회할 수 있게 한다.
 */
async function delistStock(db, stockId, stock) {
  const usersSnap = await db.ref("users").get();
  const usersData = usersSnap.val() || {};
  const updates = {};
  Object.entries(usersData).forEach(([uid, user]) => {
    if (user?.stocks?.[stockId]) {
      updates[`users/${uid}/stocks/${stockId}`] = null; // 보유 주식 전액 소멸(환급 없음)
    }
  });
  updates[`stocks/${stockId}`]       = null;
  updates[`chartBanner/${stockId}`]  = null;
  updates[`pinnedStocks/${stockId}`] = null;
  updates[`delistedStocksLog/${stockId}`] = {
    name:             stock?.name || stockId,
    priceAtDelist:    stock?.price || 0,
    frozenAt:         stock?.frozenAt || null,
    freezeDeadline:   stock?.freezeDeadline || null,
    freezeTriggerUid: stock?.freezeTriggerUid || null,
    delistedAt:       Date.now(),
  };
  await db.ref().update(updates);
}

/**
 * 상장폐지까지 유예시간(12시간)이 지나도록 해제되지 않은 종목을 정리하는
 * 스케줄 함수. 10분 간격으로 실행 — 유저 활동에 의존하지 않고 정확한
 * 시점에 상장폐지를 집행하기 위해 (플레이타임 제한 때문에 유저가 하루
 * 중 대부분 시간 접속해 있지 않아 "누군가 접속했을 때만 확인"하는 방식은
 * 신뢰할 수 없다).
 */
const checkFrozenStockDelistings = onSchedule("every 10 minutes", async () => {
  const db = admin.database();
  const snap = await db.ref("stocks").get();
  const data = snap.val() || {};
  const now = Date.now();

  const toDelist = Object.entries(data)
    .filter(([, s]) => s.frozenAt && s.freezeDeadline && s.freezeDeadline <= now);

  for (const [stockId, stock] of toDelist) {
    await delistStock(db, stockId, stock);
  }
});

/** 관리자 페이지 — 상장폐지 이력 조회 (최신순). */
async function actionListDelistedStocks(db) {
  const snap = await db.ref("delistedStocksLog").get();
  const data = snap.val() || {};
  const items = Object.entries(data)
    .map(([stockId, d]) => ({ stockId, ...d }))
    .sort((a, b) => (b.delistedAt || 0) - (a.delistedAt || 0));
  return { ok: true, items };
}

module.exports = {
  unfreezeWithCash,
  submitUnfreezeDonationRequest,
  actionListUnfreezeDonationRequests,
  actionApproveUnfreezeDonationRequest,
  actionRejectUnfreezeDonationRequest,
  actionListFrozenStocks,
  actionForceUnfreezeStock,
  actionListDelistedStocks,
  checkFrozenStockDelistings,
};
