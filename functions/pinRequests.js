const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  MAX_PIN_HOURS,
  MAX_PINNED_SLOTS,
  findStockIdByName,
  requireLinkedUser,
  requireNotInMaintenance,
  grantAchievement,
  assertNotBanned
} = require("./common");
const {
  isSubscriptionEntitlementRequest,
  reserveMonthlyBenefit,
  rejectSubscriptionRequest,
  rejectExpiredSubscriptionRequest,
  isSubscriptionApprovalRetryable,
  isRequestActionable,
  commitSubscriptionApproval,
} = require("./subscriptionBenefits");

// ══════════════════════════════════════════════════════════
// 최상단 고정 노출 신청 — 종목 리스트 최상위에 최대 3개까지 고정 노출
// (가격순 정렬과 무관하게 항상 맨 위에 표시된다)
//
// 우측/차트 배너와 달리 미상장 스트리머를 새로 등록하는 기능이 아니라
// "이미 리스트에 있는 종목 카드"를 위로 올리는 기능이므로, 닉네임/아이디
// 입력이 아니라 기존 상장 종목명을 그대로 신청 대상으로 받는다.
// ══════════════════════════════════════════════════════════

/**
 * 최상단 고정 노출 신청 접수. 로그인(익명 포함)한 누구나 호출 가능. 대상은
 * 반드시 이미 상장된 종목이어야 한다(오타로 새 종목이 생기지 않도록 미리
 * 확인). 월 구독 이용권을 예약해 신청만 접수하며, 슬롯 반영은 관리자가 검수하고
 * 승인(actionApprovePinRequest)한 뒤 시작한다. 과거 별풍선 방식 신청도 관리자
 * 검수 화면에서 결제 방식이 구분되도록 유지한다.
 */
const submitPinRequest = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const db = admin.database();
  await requireLinkedUser(db, auth.uid, auth);
  await requireNotInMaintenance(db, auth);
  await assertNotBanned(db, auth);

  const stockName = String(request.data?.stockName || "").trim();
  const hours     = parseInt(request.data?.hours, 10);

  if (!stockName) throw new HttpsError("invalid-argument", "종목명을 입력해주세요.");
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_PIN_HOURS) {
    throw new HttpsError("invalid-argument", `노출 시간은 1~${MAX_PIN_HOURS}시간 사이로 입력해주세요.`);
  }

  // 고정 노출은 이미 상장된 종목만 가능 — 오타로 새 종목이 생기지 않도록 미리 확인.
  if (!(await findStockIdByName(db, stockName))) {
    throw new HttpsError("not-found", "해당 종목명을 찾을 수 없습니다. 정확한 종목명을 입력해주세요.");
  }

  const requestData = {
    stockName,
    hours,
  };
  return reserveMonthlyBenefit(db, {
    uid: auth.uid,
    product: "pin",
    units: hours,
    requestId: request.data?.requestId,
    requestData,
    auth,
  });
});

async function actionListPinRequests(db) {
  const snap = await db.ref("pinRequests").get();
  const data = snap.val() || {};
  const requests = Object.entries(data)
    .map(([id, r]) => ({ id, ...r }))
    .filter((r) => isRequestActionable(r))
    .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));
  return { ok: true, requests };
}

/** 현재 고정 노출 중인(만료 전) 종목 목록 — 관리자 페이지의 슬롯 현황 표시용. */
async function actionListActivePins(db) {
  const snap = await db.ref("stocks").get();
  const data = snap.val() || {};
  const now  = Date.now();
  const pins = Object.entries(data)
    .filter(([, s]) => s.pinnedUntil && s.pinnedUntil > now)
    .map(([id, s]) => ({ stockId: id, name: s.name, pinnedUntil: s.pinnedUntil }))
    .sort((a, b) => b.pinnedUntil - a.pinnedUntil);
  return { ok: true, pins, maxSlots: MAX_PINNED_SLOTS };
}

async function actionApprovePinRequest(db, { requestId, hours, stockName }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");

  const reqSnap = await db.ref(`pinRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();
  if (isSubscriptionEntitlementRequest(reqData)) {
    if (reqData.status === "approved") return { ok: true, alreadyProcessed: true, pinnedUntil: reqData.approvedPinnedUntil || 0 };
    if (!isSubscriptionApprovalRetryable(reqData)) throw new HttpsError("failed-precondition", "이미 처리된 신청입니다.");
    if (await rejectExpiredSubscriptionRequest(db, "pinRequests", requestId, reqData)) {
      throw new HttpsError("failed-precondition", "통합 구독이 만료되어 신청을 거절했습니다. 이용권 반환 상태를 확인해주세요.");
    }
  }
  const hoursNum = isSubscriptionEntitlementRequest(reqData) ? Number(reqData.hours) : parseInt(hours, 10);
  if (!Number.isFinite(hoursNum) || hoursNum < 1 || hoursNum > MAX_PIN_HOURS) {
    throw new HttpsError("invalid-argument", `고정 노출 시간은 1~${MAX_PIN_HOURS}시간 사이여야 합니다.`);
  }

  // 관리자가 오타 등을 발견해 승인 직전 종목명을 고칠 수 있다 — 없으면 신청 당시 값 사용
  const finalStockName = String(stockName || "").trim() || reqData.stockName;

  // 신청 이후 종목명이 바뀌었거나 삭제됐을 수 있으므로 승인 시점에 다시 확인한다.
  // 고정 노출은 이미 상장된 종목만 대상이므로 자동 상장은 하지 않는다.
  const targetId = await findStockIdByName(db, finalStockName);
  if (!targetId) {
    throw new HttpsError("not-found", "해당 종목명을 찾을 수 없습니다. 종목이 삭제됐거나 이름이 바뀌었을 수 있습니다.");
  }
  const existingStock = (await db.ref(`stocks/${targetId}`).get()).val();

  const now = Date.now();
  const isAlreadyPinned = existingStock?.pinnedUntil && existingStock.pinnedUntil > now;

  if (!isAlreadyPinned) {
    // 새로 슬롯을 차지하는 경우에만 최대 슬롯 수를 확인한다 — 이미 고정
    // 중인 종목의 재신청(연장)은 슬롯을 새로 차지하는 게 아니므로 제외.
    const stocksSnap  = await db.ref("stocks").get();
    const stocksData  = stocksSnap.val() || {};
    const activeCount = Object.values(stocksData).filter((s) => s.pinnedUntil && s.pinnedUntil > now).length;
    if (activeCount >= MAX_PINNED_SLOTS) {
      throw new HttpsError(
        "resource-exhausted",
        `최상단 고정 슬롯이 이미 가득 찼습니다 (최대 ${MAX_PINNED_SLOTS}개). 기존 고정이 만료되거나 해제된 뒤 승인해주세요.`
      );
    }
  }

  // 이미 고정 중인 종목의 재신청은 남은 시간에 이어서 연장한다(우측 배너와 동일한 원칙).
  const baseTime     = isAlreadyPinned ? existingStock.pinnedUntil : now;
  const pinnedUntil  = baseTime + hoursNum * 3600000;

  const updates = {
    [`stocks/${targetId}/pinnedUntil`]:       pinnedUntil,
    [`pinnedStocks/${targetId}`]:             true, // 클라이언트가 항상 실시간 구독하도록 하는 마커
    [`pinRequests/${requestId}/stockName`]:   finalStockName,
    [`pinRequests/${requestId}/status`]:      "approved",
    [`pinRequests/${requestId}/reviewedAt`]:  Date.now(),
    [`pinRequests/${requestId}/approvedPinnedUntil`]: pinnedUntil,
  };
  const approval = await commitSubscriptionApproval(db, "pinRequests", requestId, reqData, updates);
  if (approval.alreadyProcessed) return { ok: true, alreadyProcessed: true, pinnedUntil: approval.request?.approvedPinnedUntil || pinnedUntil };
  if (reqData.requesterUid) await grantAchievement(db, reqData.requesterUid, "first_support");

  return { ok: true, pinnedUntil };
}

async function actionRejectPinRequest(db, { requestId }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");

  const reqSnap = await db.ref(`pinRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();
  if (isSubscriptionEntitlementRequest(reqData) && reqData.status === "rejected") {
    return { ok: true, alreadyProcessed: true, refundStatus: reqData.refundStatus, refundUnits: reqData.refundUnits || 0 };
  }
  return rejectSubscriptionRequest(db, "pinRequests", requestId, reqData);
}

/** 관리자가 고정 노출을 만료 전에 직접 해제해 슬롯을 비운다. */
async function actionDeletePin(db, { stockId }) {
  if (!stockId) throw new HttpsError("invalid-argument", "stockId가 필요합니다.");
  await db.ref().update({
    [`stocks/${stockId}/pinnedUntil`]: null,
    [`pinnedStocks/${stockId}`]:       null,
  });
  return { ok: true };
}

module.exports = {
  submitPinRequest,
  actionListPinRequests,
  actionListActivePins,
  actionApprovePinRequest,
  actionRejectPinRequest,
  actionDeletePin,
};
