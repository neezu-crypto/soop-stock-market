const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  STREAMER_ID_RE,
  URL_RE,
  MAX_BANNER_REQUEST_DAYS,
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
// 홍보 배너 신청 (우측 랭킹 배너) — 신청은 카카오 연동(또는 관리자) 유저만,
// 실제 적용은 방송 후원을 관리자가 확인해 승인해야만 이뤄진다.
// ══════════════════════════════════════════════════════════

function buildBannerPreview(streamerId) {
  const prefix = streamerId.slice(0, 2);
  return {
    previewImg:  `https://stimg.sooplive.com/LOGO/${prefix}/${streamerId}/${streamerId}.jpg`,
    stationLink: `https://www.sooplive.com/station/${streamerId}`,
  };
}

/**
 * 홍보 배너 신청 접수. 카카오 연동된(또는 관리자) 유저만 호출 가능.
 * 월 구독 이용권을 예약해 신청만 접수하고, 노출은 관리자가 검수한 뒤
 * actionApproveBannerRequest에서 시작한다. 과거 별풍선 방식의 대기 신청은
 * 관리자 검수 화면에서 결제 방식이 구분되도록 유지한다.
 *
 * nickname은 최상단 고정 노출 신청(pinRequests)과 동일하게 "이미 상장된
 * 종목명"이어야 한다 — 신청 시점에 기존 상장 종목인지 미리 확인해 없으면
 * 상장 신청을 먼저 하도록 안내한다.
 */
const submitBannerRequest = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const db = admin.database();
  await requireLinkedUser(db, auth.uid, auth);
  await requireNotInMaintenance(db, auth);
  await assertNotBanned(db, auth);

  const nickname   = String(request.data?.nickname || "").trim();
  const streamerId = String(request.data?.streamerId || "").trim().toLowerCase();
  const days        = parseInt(request.data?.days, 10);

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

  const { previewImg, stationLink } = buildBannerPreview(streamerId);
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
    product: "banner",
    units: days,
    requestId: request.data?.requestId,
    requestData,
    auth,
  });
});

async function actionListBannerRequests(db) {
  const snap = await db.ref("bannerRequests").get();
  const data = snap.val() || {};
  const requests = Object.entries(data)
    .map(([id, r]) => ({ id, ...r }))
    .filter((r) => isRequestActionable(r))
    .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));
  return { ok: true, requests };
}

async function actionApproveBannerRequest(db, { requestId, days, nickname }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");

  const reqSnap = await db.ref(`bannerRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();
  if (isSubscriptionEntitlementRequest(reqData)) {
    if (reqData.status === "approved") return { ok: true, alreadyProcessed: true, endDate: reqData.approvedEndDate || "" };
    if (!isSubscriptionApprovalRetryable(reqData)) throw new HttpsError("failed-precondition", "이미 처리된 신청입니다.");
    if (await rejectExpiredSubscriptionRequest(db, "bannerRequests", requestId, reqData)) {
      throw new HttpsError("failed-precondition", "통합 구독이 만료되어 신청을 거절했습니다. 이용권 반환 상태를 확인해주세요.");
    }
  }
  const daysNum = isSubscriptionEntitlementRequest(reqData) ? Number(reqData.days) : parseInt(days, 10);
  if (!Number.isFinite(daysNum) || daysNum < 1 || daysNum > MAX_BANNER_REQUEST_DAYS) {
    throw new HttpsError("invalid-argument", `노출 기간은 1~${MAX_BANNER_REQUEST_DAYS}일 사이여야 합니다.`);
  }

  // 관리자가 오타 등을 발견해 승인 직전 닉네임을 고칠 수 있다 — 없으면 신청 당시 값 사용
  const finalNickname = String(nickname || "").trim() || reqData.nickname;

  // 신청 시점에 이미 상장 종목인지 확인했으므로 보통은 reqData.stockId를 그대로 쓰면
  // 되지만, 관리자가 승인 시 이름을 다른 값으로 고쳤거나(그 이름도 반드시 기존
  // 상장 종목이어야 함) 신청이 이 검증이 생기기 전(예전 방식)에 접수됐을 수 있어
  // 이름이 바뀌었으면 다시 조회한다. 더 이상 없는 종목을 자동 상장하지 않는다 —
  // 상장되지 않은 이름이면 승인 자체를 막아 "검수 없이 아무 이름이나 배너로
  // 등록되는" 예전 허점을 닫는다.
  const targetId = (nickname && nickname.trim() && nickname.trim() !== reqData.nickname)
    ? await findStockIdByName(db, finalNickname)
    : (reqData.stockId || await findStockIdByName(db, finalNickname));
  if (!targetId) {
    throw new HttpsError(
      "failed-precondition",
      `"${finalNickname}"은(는) 상장되지 않은 종목입니다. 종목명을 정확히 고치거나, 먼저 상장 신청을 승인한 뒤 다시 시도해주세요.`
    );
  }
  const existingStock = (await db.ref(`stocks/${targetId}`).get()).val();

  // 이미 홍보 중(만료 전)인 아이디로 재신청한 경우, 오늘부터 새로 계산하지 않고
  // 남은 기간에 이어서 연장한다.
  let baseDate = new Date();
  if (existingStock?.bannerImg && existingStock.bannerEndDate) {
    const existingEnd = new Date(existingStock.bannerEndDate);
    existingEnd.setHours(23, 59, 59, 999);
    if (existingEnd > baseDate) baseDate = existingEnd;
  }
  const endDate = new Date(baseDate);
  endDate.setDate(endDate.getDate() + daysNum);
  const endDateStr = endDate.toISOString().split("T")[0];

  const updates = {
    [`stocks/${targetId}/bannerImg`]:     reqData.previewImg,
    [`stocks/${targetId}/bannerEndDate`]: endDateStr,
    [`stocks/${targetId}/link`]:          reqData.stationLink,
    [`bannerRequests/${requestId}/nickname`]:   finalNickname,
    [`bannerRequests/${requestId}/status`]:     "approved",
    [`bannerRequests/${requestId}/reviewedAt`]: Date.now(),
    [`bannerRequests/${requestId}/approvedEndDate`]: endDateStr,
  };
  const approval = await commitSubscriptionApproval(db, "bannerRequests", requestId, reqData, updates);
  if (approval.alreadyProcessed) return { ok: true, alreadyProcessed: true, endDate: approval.request?.approvedEndDate || endDateStr };
  if (reqData.requesterUid) await grantAchievement(db, reqData.requesterUid, "first_support");

  return { ok: true, endDate: endDateStr };
}

async function actionRejectBannerRequest(db, { requestId }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");

  const reqSnap = await db.ref(`bannerRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();
  if (isSubscriptionEntitlementRequest(reqData) && reqData.status === "rejected") {
    return { ok: true, alreadyProcessed: true, refundStatus: reqData.refundStatus, refundUnits: reqData.refundUnits || 0 };
  }
  return rejectSubscriptionRequest(db, "bannerRequests", requestId, reqData);
}

// ══════════════════════════════════════════════════════════
// 차트 하단 배너 신청 — 신청은 누구나, 승인/거절은 관리자만
// ══════════════════════════════════════════════════════════

/**
 * 차트 하단 배너 신청 접수. 이 배너는 신청자가 지금 열어둔 "그 종목"의 차트
 * 하단에 붙는 것이 목적이므로, 대상은 클라이언트가 넘긴 stockId로
 * 고정한다 — 닉네임으로 종목을 찾거나 없으면 새로 상장하지 않는다. 닉네임
 * (홍보할 스트리머)도 우측 랭킹 배너와 동일하게 이미 상장된 종목명이어야
 * 한다. 클릭 시 이동할 홍보 페이지 링크는 streamerId 기준 방송국 페이지로
 * 자동 생성하고 별도 입력을 받지 않는다.
 *
 * 월 구독 이용권을 예약해 신청만 접수한다. 노출은 관리자가 검수하고
 * actionApproveChartBannerRequest에서 승인해야 시작한다. 과거 별풍선 방식의
 * 대기 신청은 관리자 검수 화면에서 결제 방식이 구분되도록 유지한다.
 */
const submitChartBannerRequest = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const db = admin.database();
  await requireLinkedUser(db, auth.uid, auth);
  await requireNotInMaintenance(db, auth);
  await assertNotBanned(db, auth);

  const stockId    = String(request.data?.stockId || "").trim();
  const nickname   = String(request.data?.nickname || "").trim();
  const streamerId = String(request.data?.streamerId || "").trim().toLowerCase();
  const bannerImg  = String(request.data?.bannerImg || "").trim();
  const days        = parseInt(request.data?.days, 10);

  if (!stockId) throw new HttpsError("invalid-argument", "배너를 등록할 종목의 차트를 먼저 열어주세요.");
  if (!nickname) throw new HttpsError("invalid-argument", "홍보할 스트리머 닉네임을 입력해주세요.");
  if (!STREAMER_ID_RE.test(streamerId)) {
    throw new HttpsError("invalid-argument", "아이디는 영문 소문자/숫자 2~20자여야 합니다.");
  }
  if (!URL_RE.test(bannerImg)) {
    throw new HttpsError("invalid-argument", "배너 이미지 링크를 올바르게 입력해주세요.");
  }
  if (!Number.isInteger(days) || days < 1 || days > MAX_BANNER_REQUEST_DAYS) {
    throw new HttpsError("invalid-argument", `노출 기간은 1~${MAX_BANNER_REQUEST_DAYS}일 사이로 입력해주세요.`);
  }

  // 홍보 페이지 링크는 별도 입력 없이 아이디 기준 방송국 페이지로 자동 연결한다.
  const promoLink = `https://www.sooplive.com/station/${streamerId}`;

  const stockSnap = await db.ref(`stocks/${stockId}`).get();
  if (!stockSnap.exists()) {
    throw new HttpsError("not-found", "종목을 찾을 수 없습니다. 새로고침 후 다시 시도해주세요.");
  }
  const stockName = stockSnap.val().name || stockId;

  if (!(await findStockIdByName(db, nickname))) {
    throw new HttpsError(
      "failed-precondition",
      "현재 상장되지 않은 종목입니다. 먼저 종목 상장 신청을 통해 상장한 뒤 다시 신청해주세요."
    );
  }

  const requestData = {
    stockId,
    stockName, // 신청 시점 종목명 스냅샷 (관리자 목록 표시용)
    nickname,
    streamerId,
    bannerImg,
    promoLink,
    days,
  };
  return reserveMonthlyBenefit(db, {
    uid: auth.uid,
    product: "chartBanner",
    units: days,
    requestId: request.data?.requestId,
    requestData,
    auth,
  }).then((result) => ({ ...result, stockId }));
});

async function actionListChartBannerRequests(db) {
  const snap = await db.ref("chartBannerRequests").get();
  const data = snap.val() || {};
  const requests = Object.entries(data)
    .map(([id, r]) => ({ id, ...r }))
    .filter((r) => isRequestActionable(r))
    .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));
  return { ok: true, requests };
}

/**
 * 배너 이미지 승인 — 신청 접수 시점엔 슬롯을 예약하지 않으므로, 승인 시점의
 * days(관리자가 검수하며 고칠 수 있음)로 노출 기간을 계산해 slot(chartBanner
 * /{stockId})과 이미지를 한 번에 확정한다.
 */
async function actionApproveChartBannerRequest(db, { requestId, days, nickname, bannerImg, promoLink }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");

  const reqSnap = await db.ref(`chartBannerRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();
  if (isSubscriptionEntitlementRequest(reqData)) {
    if (reqData.status === "approved") return { ok: true, alreadyProcessed: true, stockId: reqData.stockId, endDate: reqData.approvedEndDate || "" };
    if (!isSubscriptionApprovalRetryable(reqData)) throw new HttpsError("failed-precondition", "이미 처리된 신청입니다.");
    if (await rejectExpiredSubscriptionRequest(db, "chartBannerRequests", requestId, reqData)) {
      throw new HttpsError("failed-precondition", "통합 구독이 만료되어 신청을 거절했습니다. 이용권 반환 상태를 확인해주세요.");
    }
  }

  // 관리자가 승인 직전 신청 내용을 검수하며 고칠 수 있다 — 없으면 신청 당시 값 사용
  const finalNickname  = String(nickname  || "").trim() || reqData.nickname;
  const finalBannerImg = String(bannerImg || "").trim() || reqData.bannerImg;
  const finalPromoLink = String(promoLink || "").trim() || reqData.promoLink;

  // 대상 종목은 신청 시점에 고정된 stockId 그대로 사용한다 — 닉네임으로 종목을
  // 찾거나 새로 상장하지 않는다(닉네임은 신청자 확인용일 뿐 종목 식별용이 아님).
  const targetId = reqData.stockId;
  if (!targetId) {
    throw new HttpsError("failed-precondition", "이 신청은 대상 종목 정보가 없는 예전 방식 신청입니다. 거절 후 다시 신청받아주세요.");
  }
  const stockSnap = await db.ref(`stocks/${targetId}`).get();
  if (!stockSnap.exists()) {
    throw new HttpsError("not-found", "대상 종목이 삭제됐습니다. 거절해주세요.");
  }

  let endDateStr = reqData.endDate;
  if (!endDateStr) {
    const daysNum = isSubscriptionEntitlementRequest(reqData) ? Number(reqData.days) : parseInt(days, 10);
    if (!Number.isFinite(daysNum) || daysNum < 1 || daysNum > MAX_BANNER_REQUEST_DAYS) {
      throw new HttpsError("invalid-argument", `노출 기간은 1~${MAX_BANNER_REQUEST_DAYS}일 사이여야 합니다.`);
    }
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + daysNum);
    endDateStr = endDate.toISOString().split("T")[0];
  }

  const updates = {
    [`chartBanner/${targetId}`]: {
      name:    finalNickname,
      img:     finalBannerImg,
      link:    finalPromoLink,
      endDate: endDateStr,
    },
    [`chartBannerRequests/${requestId}/nickname`]:   finalNickname,
    [`chartBannerRequests/${requestId}/bannerImg`]:  finalBannerImg,
    [`chartBannerRequests/${requestId}/promoLink`]:  finalPromoLink,
    [`chartBannerRequests/${requestId}/status`]:     "approved",
    [`chartBannerRequests/${requestId}/reviewedAt`]: Date.now(),
    [`chartBannerRequests/${requestId}/approvedEndDate`]: endDateStr,
  };
  const approval = await commitSubscriptionApproval(db, "chartBannerRequests", requestId, reqData, updates);
  if (approval.alreadyProcessed) return { ok: true, alreadyProcessed: true, stockId: targetId, endDate: approval.request?.approvedEndDate || endDateStr };
  if (reqData.requesterUid) await grantAchievement(db, reqData.requesterUid, "first_support");

  return { ok: true, stockId: targetId, endDate: endDateStr };
}

async function actionRejectChartBannerRequest(db, { requestId }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");

  const reqSnap = await db.ref(`chartBannerRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();
  if (isSubscriptionEntitlementRequest(reqData) && reqData.status === "rejected") {
    return { ok: true, alreadyProcessed: true, refundStatus: reqData.refundStatus, refundUnits: reqData.refundUnits || 0 };
  }
  return rejectSubscriptionRequest(db, "chartBannerRequests", requestId, reqData);
}

module.exports = {
  submitBannerRequest,
  actionListBannerRequests,
  actionApproveBannerRequest,
  actionRejectBannerRequest,
  submitChartBannerRequest,
  actionListChartBannerRequests,
  actionApproveChartBannerRequest,
  actionRejectChartBannerRequest,
};
