const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  STREAMER_ID_RE,
  URL_RE,
  MAX_BANNER_REQUEST_DAYS,
  BANNER_COST_PER_DAY,
  CHART_BANNER_COST_PER_DAY,
  chargeUserCash,
  creditUserCash,
  findStockIdByName,
  requireLinkedUser,
  requireNotInMaintenance,
  grantAchievement,
} = require("./common");

// ══════════════════════════════════════════════════════════
// 홍보 배너 신청 (우측 랭킹 배너) — 신청은 카카오 연동(또는 관리자) 유저만,
// 승인/거절은 관리자만
// ══════════════════════════════════════════════════════════

function buildBannerPreview(streamerId) {
  const prefix = streamerId.slice(0, 2);
  return {
    previewImg:  `https://stimg.sooplive.com/LOGO/${prefix}/${streamerId}/${streamerId}.jpg`,
    stationLink: `https://www.sooplive.com/station/${streamerId}`,
  };
}

/** 이미 홍보 중(만료 전)인 종목에 재신청하면, 오늘부터 새로 계산하지 않고 남은 기간에 이어서 연장한다. */
function computeBannerEndDate(existingStock, days) {
  let baseDate = new Date();
  if (existingStock?.bannerImg && existingStock.bannerEndDate) {
    const existingEnd = new Date(existingStock.bannerEndDate);
    existingEnd.setHours(23, 59, 59, 999);
    if (existingEnd > baseDate) baseDate = existingEnd;
  }
  const endDate = new Date(baseDate);
  endDate.setDate(endDate.getDate() + days);
  return endDate.toISOString().split("T")[0];
}

/**
 * 홍보 배너 신청. 카카오 연동된(또는 관리자) 유저만 호출 가능.
 *
 * nickname은 최상단 고정 노출 신청(pinRequests)과 동일하게 "이미 상장된
 * 종목명"이어야 한다 — 예전엔 아무 텍스트나 받아 관리자가 매번 "이 닉네임이
 * 진짜 상장된 스트리머가 맞는지" 검수한 뒤 승인해야 했다. 이제는 신청
 * 시점에 기존 상장 종목인지 바로 확인해 없으면 상장 신청을 먼저 하도록
 * 안내하고, 있으면 검수 없이 즉시 배너를 적용한다(관리자 승인 단계 자체가
 * 불필요해짐 — "종목이 실재하는가"가 유일한 검수 포인트였는데, 상장 신청
 * 승인 시점에 이미 한 번 걸러졌기 때문).
 */
const submitBannerRequest = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const db = admin.database();
  await requireLinkedUser(db, auth.uid, auth);
  await requireNotInMaintenance(db, auth);

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
  const existingStock = (await db.ref(`stocks/${targetId}`).get()).val();
  const endDateStr = computeBannerEndDate(existingStock, days);

  const cost = days * BANNER_COST_PER_DAY;
  await chargeUserCash(db, auth.uid, cost);
  await grantAchievement(db, auth.uid, "first_support");

  const { previewImg, stationLink } = buildBannerPreview(streamerId);
  const ref = db.ref("bannerRequests").push();
  const now = Date.now();

  await db.ref().update({
    [`stocks/${targetId}/bannerImg`]:     previewImg,
    [`stocks/${targetId}/bannerEndDate`]: endDateStr,
    [`stocks/${targetId}/link`]:          stationLink,
    [`bannerRequests/${ref.key}`]: {
      nickname,
      stockId:       targetId,
      streamerId,
      previewImg,
      stationLink,
      days,
      chargedAmount: cost,
      status:        "approved", // 관리자 승인 단계 없이 즉시 적용 — 기록은 이력 확인용으로 남긴다
      requestedAt:   now,
      reviewedAt:    now,
      requesterUid:  auth.uid,
    },
  });

  return { ok: true, id: ref.key, chargedAmount: cost, endDate: endDateStr };
});

async function actionListBannerRequests(db) {
  const snap = await db.ref("bannerRequests").get();
  const data = snap.val() || {};
  const requests = Object.entries(data)
    .map(([id, r]) => ({ id, ...r }))
    .filter((r) => r.status === "pending")
    .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));
  return { ok: true, requests };
}

async function actionApproveBannerRequest(db, { requestId, days, nickname }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");
  const daysNum = parseInt(days, 10);
  if (!Number.isFinite(daysNum) || daysNum < 1) {
    throw new HttpsError("invalid-argument", "노출 기간(일)을 올바르게 입력해주세요.");
  }

  const reqSnap = await db.ref(`bannerRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();

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

  await db.ref().update({
    [`stocks/${targetId}/bannerImg`]:     reqData.previewImg,
    [`stocks/${targetId}/bannerEndDate`]: endDateStr,
    [`stocks/${targetId}/link`]:          reqData.stationLink,
    [`bannerRequests/${requestId}/nickname`]:   finalNickname,
    [`bannerRequests/${requestId}/status`]:     "approved",
    [`bannerRequests/${requestId}/reviewedAt`]: Date.now(),
  });

  return { ok: true, endDate: endDateStr };
}

async function actionRejectBannerRequest(db, { requestId }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");

  const reqSnap = await db.ref(`bannerRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();

  // 신청 시 차감된 게임자산을 전액 환불한다.
  if (reqData.status === "pending") {
    await creditUserCash(db, reqData.requesterUid, reqData.chargedAmount);
  }

  await db.ref(`bannerRequests/${requestId}`).update({
    status:     "rejected",
    reviewedAt: Date.now(),
  });
  return { ok: true };
}

// ══════════════════════════════════════════════════════════
// 차트 하단 배너 신청 — 신청은 누구나, 승인/거절은 관리자만
// ══════════════════════════════════════════════════════════

/**
 * 차트 하단 배너 신청. 이 배너는 신청자가 지금 열어둔 "그 종목"의 차트
 * 하단에 붙는 것이 목적이므로, 대상은 클라이언트가 넘긴 stockId로
 * 고정한다 — 닉네임으로 종목을 찾거나 없으면 새로 상장하지 않는다(예전엔
 * 그래서 신청자가 입력한 닉네임과 종목명이 다르면 의도치 않은 새 종목이
 * 생성됐다). 닉네임(홍보할 스트리머)도 우측 랭킹 배너와 동일하게 이미
 * 상장된 종목명이어야 한다. 클릭 시 이동할 홍보 페이지 링크는 우측 랭킹
 * 배너와 동일하게 streamerId 기준 방송국 페이지로 자동 생성하고 별도
 * 입력을 받지 않는다.
 *
 * 슬롯(노출 기간)은 신청 즉시 확정한다(비용 차감 + chartBanner 노드에
 * 기간/닉네임/링크 예약) — 관리자가 매번 기간·비용을 검수할 필요가 없다.
 * 다만 배너 이미지는 신청자가 직접 올리는 임의의 이미지라 부적절한 이미지가
 * 검수 없이 바로 노출될 위험이 있으므로, img 필드만은 비워둔 채 예약하고
 * 관리자가 이미지를 확인해 승인(actionApproveChartBannerRequest)해야
 * 실제로 화면에 뜬다 — 승인 시 이미 확정된 기간을 그대로 쓰고 새로
 * 늘리지 않는다.
 */
const submitChartBannerRequest = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const db = admin.database();
  await requireLinkedUser(db, auth.uid, auth);
  await requireNotInMaintenance(db, auth);

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

  // 이 종목에 이미지 승인 대기 중인 예약(img 없음, 만료 전)이 있으면 중복
  // 신청을 막는다 — 안 막으면 여러 명이 동시에 결제하고 마지막 신청이
  // chartBanner/{stockId} 예약을 덮어써 앞선 결제자만 손해를 본다.
  const existingChartBannerSnap = await db.ref(`chartBanner/${stockId}`).get();
  const existingChartBanner = existingChartBannerSnap.val();
  if (existingChartBanner && !existingChartBanner.img) {
    const stillReserved = !existingChartBanner.endDate
      || (() => { const d = new Date(existingChartBanner.endDate); d.setHours(23, 59, 59, 999); return d >= new Date(); })();
    if (stillReserved) {
      throw new HttpsError(
        "already-exists",
        "이 종목은 이미 배너 홍보 승인 검수중입니다. 승인/거절 처리된 뒤 다시 신청해주세요."
      );
    }
  }

  const cost = days * CHART_BANNER_COST_PER_DAY;
  await chargeUserCash(db, auth.uid, cost);
  await grantAchievement(db, auth.uid, "first_support");

  const endDate = new Date();
  endDate.setDate(endDate.getDate() + days);
  const endDateStr = endDate.toISOString().split("T")[0];

  const ref = db.ref("chartBannerRequests").push();
  const now = Date.now();

  await db.ref().update({
    // img는 의도적으로 비워둔다 — 관리자가 이미지를 승인하기 전까지는
    // js/chartModal.js의 "!data.img" 체크에 걸려 "모집 안내" 상태로 보인다.
    [`chartBanner/${stockId}`]: { name: nickname, link: promoLink, endDate: endDateStr },
    [`chartBannerRequests/${ref.key}`]: {
      stockId,
      stockName, // 신청 시점 종목명 스냅샷 (관리자 목록 표시용)
      nickname,
      streamerId,
      bannerImg,
      promoLink,
      days,
      endDate:       endDateStr, // 승인 시 이 값을 그대로 써서 기간이 새로 늘어나지 않게 한다
      chargedAmount: cost,
      status:        "pending", // 이미지 승인 대기 — 슬롯 자체는 이미 예약 완료
      requestedAt:   now,
      requesterUid:  auth.uid,
    },
  });

  return { ok: true, id: ref.key, chargedAmount: cost, stockId, endDate: endDateStr };
});

async function actionListChartBannerRequests(db) {
  const snap = await db.ref("chartBannerRequests").get();
  const data = snap.val() || {};
  const requests = Object.entries(data)
    .map(([id, r]) => ({ id, ...r }))
    .filter((r) => r.status === "pending")
    .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));
  return { ok: true, requests };
}

/**
 * 배너 이미지 승인 — 신청 시점에 이미 슬롯(노출 기간/닉네임/링크)이
 * chartBanner/{stockId}에 예약돼 있으므로, 여기서는 img만 채워 넣어
 * 실제로 화면에 뜨게 한다. reqData.endDate(신청 시점에 확정된 기간)가
 * 있으면 그대로 쓰고, 없는 예전 방식 신청만 관리자가 입력한 기간으로
 * 새로 계산한다.
 */
async function actionApproveChartBannerRequest(db, { requestId, days, nickname, bannerImg, promoLink }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");

  const reqSnap = await db.ref(`chartBannerRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();

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
    const daysNum = parseInt(days, 10);
    if (!Number.isFinite(daysNum) || daysNum < 1) {
      throw new HttpsError("invalid-argument", "노출 기간(일)을 올바르게 입력해주세요.");
    }
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + daysNum);
    endDateStr = endDate.toISOString().split("T")[0];
  }

  await db.ref().update({
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
  });

  return { ok: true, stockId: targetId, endDate: endDateStr };
}

async function actionRejectChartBannerRequest(db, { requestId }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");

  const reqSnap = await db.ref(`chartBannerRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();

  const updates = {
    [`chartBannerRequests/${requestId}/status`]:     "rejected",
    [`chartBannerRequests/${requestId}/reviewedAt`]: Date.now(),
  };

  if (reqData.status === "pending") {
    await creditUserCash(db, reqData.requesterUid, reqData.chargedAmount);

    // 이미지 승인 전에 신청 시점에 예약해둔 슬롯이 있으면 함께 정리한다 —
    // img가 아직 비어있고(=미승인 상태) 이 신청의 링크와 일치할 때만
    // 지운다(그 사이 다른 경로로 승인된 배너를 실수로 지우지 않기 위함).
    if (reqData.stockId) {
      const bannerSnap = await db.ref(`chartBanner/${reqData.stockId}`).get();
      const banner = bannerSnap.val();
      if (banner && !banner.img && banner.link === reqData.promoLink) {
        updates[`chartBanner/${reqData.stockId}`] = null;
      }
    }
  }

  await db.ref().update(updates);
  return { ok: true };
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
