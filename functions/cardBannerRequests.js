const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  STREAMER_ID_RE,
  MAX_BANNER_REQUEST_DAYS,
  CARD_BANNER_MIN_HOLDING_QTY,
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
// 종목 카드 프로필 배너 — 우측 랭킹 배너와 신청 방식(닉네임+아이디+기간)은
// 동일하지만, "이 종목을 실제로 대량 보유한 유저만" 신청할 수 있다는 점이
// 다르다. 노출 위치도 사이드 배너 레일이 아니라 종목 리스트 카드 자체(원형
// 프로필 사진)라 노출 빈도가 훨씬 높다. 되팔기(신청만 하고 바로 매도)를
// 막기 위해, 신청 이후 보유 수량이 CARD_BANNER_MIN_HOLDING_QTY 미만으로
// 떨어지면 trade.js가 자동으로 배너를 삭제한다(신청 모달에 이 규칙을 미리
// 고지).
//
// 월 구독 이용권을 예약해 신청만 접수한다. 적용은 관리자가 검수한 뒤
// actionApproveCardBannerRequest에서 처리한다. 이 신청은 기존에 관리자 승인
// 단계가 없어 승인 흐름을 추가했으며, 과거 별풍선 방식 기록도 구분해 처리한다.
// ══════════════════════════════════════════════════════════

function buildCardBannerPreview(streamerId) {
  const prefix = streamerId.slice(0, 2);
  return {
    previewImg:  `https://stimg.sooplive.com/LOGO/${prefix}/${streamerId}/${streamerId}.jpg`,
    stationLink: `https://www.sooplive.com/station/${streamerId}`,
  };
}

/** 이미 홍보 중(만료 전)인 종목에 본인이 재신청하면, 남은 기간에 이어서 연장한다. */
function computeCardBannerEndDate(existingStock, days) {
  let baseDate = new Date();
  if (existingStock?.cardBannerImg && existingStock.cardBannerEndDate) {
    const existingEnd = new Date(existingStock.cardBannerEndDate);
    existingEnd.setHours(23, 59, 59, 999);
    if (existingEnd > baseDate) baseDate = existingEnd;
  }
  const endDate = new Date(baseDate);
  endDate.setDate(endDate.getDate() + days);
  return endDate.toISOString().split("T")[0];
}

const submitCardBannerRequest = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const db = admin.database();
  await requireLinkedUser(db, auth.uid, auth);
  await requireNotInMaintenance(db, auth);
  await assertNotBanned(db, auth);

  const nickname   = String(request.data?.nickname || "").trim();
  const streamerId = String(request.data?.streamerId || "").trim().toLowerCase();
  const days       = parseInt(request.data?.days, 10);

  if (!nickname) throw new HttpsError("invalid-argument", "종목명을 입력해주세요.");
  if (!STREAMER_ID_RE.test(streamerId)) {
    throw new HttpsError("invalid-argument", "아이디는 영문 소문자/숫자 2~20자여야 합니다.");
  }
  if (!Number.isInteger(days) || days < 1 || days > MAX_BANNER_REQUEST_DAYS) {
    throw new HttpsError("invalid-argument", `노출 기간은 1~${MAX_BANNER_REQUEST_DAYS}일 사이로 입력해주세요.`);
  }

  const targetId = await findStockIdByName(db, nickname);
  if (!targetId) {
    throw new HttpsError(
      "failed-precondition",
      "현재 상장되지 않은 종목입니다. 먼저 종목 상장 신청을 통해 상장한 뒤 다시 신청해주세요."
    );
  }

  // 실제 소유주만 신청 가능 — 되팔기 방지 규칙과 짝을 이루는 최소 보유 수량 검증.
  // (최종 판정은 승인 시점에 다시 한다 — 신청 후 승인 전에 매도했을 수 있음.)
  const qtySnap = await db.ref(`users/${auth.uid}/stocks/${targetId}/qty`).get();
  const qty = qtySnap.val() || 0;
  if (qty < CARD_BANNER_MIN_HOLDING_QTY) {
    throw new HttpsError(
      "failed-precondition",
      `이 상품은 해당 종목을 ${CARD_BANNER_MIN_HOLDING_QTY}주 이상 보유해야 신청할 수 있습니다. 현재 보유: ${qty}주`
    );
  }

  const { previewImg, stationLink } = buildCardBannerPreview(streamerId);
  const requestData = {
    nickname,
    stockId:      targetId,
    streamerId,
    previewImg,
    stationLink,
    days,
  };
  return reserveMonthlyBenefit(db, {
    uid: auth.uid,
    product: "cardBanner",
    units: days,
    requestId: request.data?.requestId,
    requestData,
    auth,
  });
});

async function actionListCardBannerRequests(db) {
  const snap = await db.ref("cardBannerRequests").get();
  const data = snap.val() || {};
  const requests = Object.entries(data)
    .map(([id, r]) => ({ id, ...r }))
    .filter((r) => isRequestActionable(r))
    .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));
  return { ok: true, requests };
}

async function actionApproveCardBannerRequest(db, { requestId, days, nickname }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");

  const reqSnap = await db.ref(`cardBannerRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();
  if (isSubscriptionEntitlementRequest(reqData)) {
    if (reqData.status === "approved") return { ok: true, alreadyProcessed: true, endDate: reqData.approvedEndDate || "" };
    if (!isSubscriptionApprovalRetryable(reqData)) throw new HttpsError("failed-precondition", "이미 처리된 신청입니다.");
    if (await rejectExpiredSubscriptionRequest(db, "cardBannerRequests", requestId, reqData)) {
      throw new HttpsError("failed-precondition", "통합 구독이 만료되어 신청을 거절했습니다. 이용권 반환 상태를 확인해주세요.");
    }
  }
  const daysNum = isSubscriptionEntitlementRequest(reqData) ? Number(reqData.days) : parseInt(days, 10);
  if (!Number.isFinite(daysNum) || daysNum < 1 || daysNum > MAX_BANNER_REQUEST_DAYS) {
    throw new HttpsError("invalid-argument", `노출 기간은 1~${MAX_BANNER_REQUEST_DAYS}일 사이여야 합니다.`);
  }

  const finalNickname = String(nickname || "").trim() || reqData.nickname;
  const targetId = (nickname && nickname.trim() && nickname.trim() !== reqData.nickname)
    ? await findStockIdByName(db, finalNickname)
    : (reqData.stockId || await findStockIdByName(db, finalNickname));
  if (!targetId) {
    throw new HttpsError(
      "failed-precondition",
      `"${finalNickname}"은(는) 상장되지 않은 종목입니다. 종목명을 정확히 고치거나, 먼저 상장 신청을 승인한 뒤 다시 시도해주세요.`
    );
  }

  // 신청 후 승인 전에 매도해 최소 보유 수량 미달이 됐을 수 있으므로 승인 시점에 다시 확인한다.
  const qtySnap = await db.ref(`users/${reqData.requesterUid}/stocks/${targetId}/qty`).get();
  const qty = qtySnap.val() || 0;
  if (qty < CARD_BANNER_MIN_HOLDING_QTY) {
    throw new HttpsError(
      "failed-precondition",
      `신청자가 더 이상 최소 보유 수량(${CARD_BANNER_MIN_HOLDING_QTY}주)을 충족하지 않습니다(현재 ${qty}주). 거절해주세요.`
    );
  }

  const existingStock = (await db.ref(`stocks/${targetId}`).get()).val();
  if (existingStock?.cardBannerHolderUid && existingStock.cardBannerHolderUid !== reqData.requesterUid) {
    const endStr = existingStock.cardBannerEndDate;
    const stillActive = endStr && new Date(new Date(endStr).setHours(23, 59, 59, 999)).getTime() >= Date.now();
    if (stillActive) {
      throw new HttpsError("already-exists", "이미 다른 유저가 이 종목의 카드 홍보를 진행 중입니다. 만료 후 승인해주세요.");
    }
  }

  const endDateStr = computeCardBannerEndDate(existingStock, daysNum);

  const updates = {
    [`stocks/${targetId}/cardBannerImg`]:       reqData.previewImg,
    [`stocks/${targetId}/cardBannerEndDate`]:   endDateStr,
    [`stocks/${targetId}/cardBannerLink`]:      reqData.stationLink,
    [`stocks/${targetId}/cardBannerHolderUid`]: reqData.requesterUid,
    [`cardBannerRequests/${requestId}/nickname`]:   finalNickname,
    [`cardBannerRequests/${requestId}/status`]:     "approved",
    [`cardBannerRequests/${requestId}/reviewedAt`]: Date.now(),
    [`cardBannerRequests/${requestId}/approvedEndDate`]: endDateStr,
  };
  const approval = await commitSubscriptionApproval(db, "cardBannerRequests", requestId, reqData, updates);
  if (approval.alreadyProcessed) return { ok: true, alreadyProcessed: true, endDate: approval.request?.approvedEndDate || endDateStr };
  if (reqData.requesterUid) await grantAchievement(db, reqData.requesterUid, "first_support");

  return { ok: true, endDate: endDateStr };
}

async function actionRejectCardBannerRequest(db, { requestId }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");

  const reqSnap = await db.ref(`cardBannerRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();
  if (isSubscriptionEntitlementRequest(reqData) && reqData.status === "rejected") {
    return { ok: true, alreadyProcessed: true, refundStatus: reqData.refundStatus, refundUnits: reqData.refundUnits || 0 };
  }
  return rejectSubscriptionRequest(db, "cardBannerRequests", requestId, reqData);
}

module.exports = {
  submitCardBannerRequest,
  actionListCardBannerRequests,
  actionApproveCardBannerRequest,
  actionRejectCardBannerRequest,
};
