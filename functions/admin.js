const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { requireAdmin, findStockIdByName, bannerStatus, INITIAL_CASH } = require("./common");
const {
  actionListBannerRequests,
  actionApproveBannerRequest,
  actionRejectBannerRequest,
  actionListChartBannerRequests,
  actionApproveChartBannerRequest,
  actionRejectChartBannerRequest,
} = require("./bannerRequests");
const {
  actionListCashChargeRequests,
  actionApproveCashChargeRequest,
  actionRejectCashChargeRequest,
} = require("./cashCharge");
const {
  actionListPinRequests,
  actionListActivePins,
  actionApprovePinRequest,
  actionRejectPinRequest,
  actionDeletePin,
} = require("./pinRequests");
const {
  actionListRelayRoomRequests,
  actionListActiveRelayRooms,
  actionApproveRelayRoomRequest,
  actionRejectRelayRoomRequest,
  actionDeleteRelayRoom,
} = require("./relayRoom");
const {
  actionListUnfreezeDonationRequests,
  actionApproveUnfreezeDonationRequest,
  actionRejectUnfreezeDonationRequest,
  actionListFrozenStocks,
  actionForceUnfreezeStock,
} = require("./stockFreeze");
const {
  actionListListingRequests,
  actionApproveListingRequest,
  actionRejectListingRequest,
} = require("./listingRequests");

// ══════════════════════════════════════════════════════════
// 관리자 페이지 기능 — 전부 Admin SDK로 처리해 RTDB 규칙의
// 이메일 매칭 없이도 안전하게 동작한다 (아래 각 action 함수 참고)
// ══════════════════════════════════════════════════════════

async function actionUpdateSinglePrice(db, { stockId, price }) {
  if (!stockId) throw new HttpsError("invalid-argument", "stockId가 필요합니다.");
  const newPrice = Math.round(Number(price));
  if (!Number.isFinite(newPrice)) throw new HttpsError("invalid-argument", "정확한 가격을 입력해주세요.");

  const snap = await db.ref(`stocks/${stockId}`).get();
  if (!snap.exists()) throw new HttpsError("not-found", "종목을 찾을 수 없습니다.");
  const stock = snap.val();

  await db.ref().update({
    [`stocks/${stockId}/price`]: newPrice,
  });
  return { ok: true, name: stock.name, price: newPrice };
}

async function actionUpdateStockData(db, { stockId, price, bannerImg, link, bannerEndDate }) {
  if (!stockId) throw new HttpsError("invalid-argument", "stockId가 필요합니다.");
  const newPrice = Math.round(Number(price));
  if (!Number.isFinite(newPrice)) throw new HttpsError("invalid-argument", "가격은 숫자여야 합니다.");

  await db.ref().update({
    [`stocks/${stockId}/price`]:         newPrice,
    [`stocks/${stockId}/bannerImg`]:     String(bannerImg || ""),
    [`stocks/${stockId}/link`]:          String(link || ""),
    [`stocks/${stockId}/bannerEndDate`]: String(bannerEndDate || ""),
  });
  return { ok: true };
}

async function actionAdjustAllPrices(db, { percent }) {
  const pct = Number(percent);
  if (!Number.isFinite(pct)) throw new HttpsError("invalid-argument", "숫자를 입력해주세요.");

  const snap = await db.ref("stocks").get();
  const data = snap.val();
  if (!data) return { ok: true, count: 0 };

  const multiplier = 1 + pct / 100;
  const updates = {};
  Object.keys(data).forEach((id) => {
    const oldPrice = data[id].price;
    const newPrice = Math.round(oldPrice * multiplier);
    updates[`stocks/${id}/price`] = newPrice;
  });
  await db.ref().update(updates);
  return { ok: true, count: Object.keys(data).length };
}

async function actionResetAllPrices(db) {
  const snap = await db.ref("stocks").get();
  const data = snap.val();
  if (!data) return { ok: true, count: 0 };

  const RESET_PRICE = 10000;
  const updates = {};
  Object.keys(data).forEach((id) => {
    updates[`stocks/${id}/price`]  = RESET_PRICE;
    updates[`stocks/${id}/volume`] = 0; // 누적 거래량도 함께 리셋 — 안 지우면 랭킹(top5)에 리셋 이전 거래량이 그대로 남는다
  });
  updates["rankings/top5"] = null; // 위 volume 리셋과 함께 캐시된 랭킹도 비워 다음 거래부터 새로 집계되게 한다
  await db.ref().update(updates);
  return { ok: true, count: Object.keys(data).length };
}

async function actionUploadStocks(db, { names }) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new HttpsError("invalid-argument", "이름을 입력해주세요.");
  }
  const uniqueNames = [...new Set(names.map((n) => String(n).trim()))].filter((n) => n !== "");
  if (uniqueNames.length === 0) throw new HttpsError("invalid-argument", "이름을 입력해주세요.");

  const stocks = {};
  uniqueNames.forEach((name, i) => {
    stocks[`id_${Date.now()}_${i}`] = { name, price: 10000 };
  });
  await db.ref("stocks").update(stocks);
  return { ok: true, count: uniqueNames.length };
}

async function actionDeleteStocks(db, { names }) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new HttpsError("invalid-argument", "삭제할 이름을 입력해주세요.");
  }
  const namesToDelete = names.map((n) => String(n).trim()).filter((n) => n !== "");
  const snap = await db.ref("stocks").get();
  const data = snap.val();
  if (!data) return { ok: true, count: 0 };

  const updates = {};
  let foundCount = 0;
  Object.entries(data).forEach(([id, stock]) => {
    if (namesToDelete.includes(stock.name)) {
      updates[`stocks/${id}`] = null;
      updates[`chartBanner/${id}`] = null; // 종목 삭제 시 연결된 차트 배너도 함께 삭제(orphan 방지)
      foundCount++;
    }
  });
  if (foundCount > 0) await db.ref().update(updates);
  return { ok: true, count: foundCount };
}

async function actionCleanupDuplicateStocks(db) {
  const snap = await db.ref("stocks").get();
  const data = snap.val();
  if (!data) return { ok: true, count: 0 };

  const deleteUpdates = {};
  let duplicateFoundCount = 0;
  const commonTags = ["BJ", "TV", "S2", "H_", "T1", "DK", "공식", "S", "P"];
  const stockList = Object.entries(data)
    .map(([id, stock]) => {
      const name = stock.name.trim();
      let pureName = name;
      commonTags.forEach((tag) => { pureName = pureName.replace(new RegExp(tag, "gi"), ""); });
      pureName = pureName.replace(/[^ㄱ-ㅎ가-힣a-zA-Z0-9]/g, "").toLowerCase();
      return { id, originalName: name, pureName };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  for (let i = 0; i < stockList.length; i++) {
    const master = stockList[i];
    if (deleteUpdates[`stocks/${master.id}`] === null) continue;
    if (master.pureName.length < 2) continue;
    for (let j = i + 1; j < stockList.length; j++) {
      const target = stockList[j];
      if (deleteUpdates[`stocks/${target.id}`] === null) continue;
      let isMatch = false;
      if (master.pureName === target.pureName) isMatch = true;
      else if (target.originalName.includes(master.originalName)) {
        const diffLength = target.originalName.length - master.originalName.length;
        if (diffLength > 0 && diffLength <= 4) isMatch = true;
      }
      if (isMatch && master.pureName !== target.pureName) {
        if (master.originalName.includes("BJ") && target.originalName.includes("BJ")) isMatch = false;
      }
      if (isMatch) {
        deleteUpdates[`stocks/${target.id}`] = null;
        deleteUpdates[`chartBanner/${target.id}`] = null; // 종목 삭제 시 연결된 차트 배너도 함께 삭제(orphan 방지)
        duplicateFoundCount++;
      }
    }
  }

  if (duplicateFoundCount > 0) await db.ref().update(deleteUpdates);
  return { ok: true, count: duplicateFoundCount };
}

/**
 * 우측 랭킹 배너(stocks/{id})와 차트 하단 배너(chartBanner/{id})를 한데 모아
 * 진행중/만료 목록으로 분류한다. 관리자 페이지의 통합 배너 관리 탭에서 사용.
 */
async function actionListActiveBanners(db) {
  const [stocksSnap, chartSnap] = await Promise.all([
    db.ref("stocks").get(),
    db.ref("chartBanner").get(),
  ]);
  const stocksData = stocksSnap.val() || {};
  const chartData  = chartSnap.val()  || {};

  const items = [];
  Object.entries(stocksData).forEach(([id, s]) => {
    if (!s.bannerImg) return;
    const { active, daysLeft } = bannerStatus(s.bannerEndDate);
    items.push({
      type: "ranking", stockId: id, name: s.name || id, stockName: s.name || id,
      img: s.bannerImg, link: s.link || "", endDate: s.bannerEndDate || "",
      active, daysLeft,
    });
  });
  Object.entries(chartData).forEach(([id, c]) => {
    // chartBanner는 예전에 전체 종목 공동 노출용 평면 필드(img/link/endDate/name)로
    // 쓰이던 경로라, 과거 잔재가 최상위에 남아있으면 문자열 값이 종목ID처럼
    // 섞여 들어올 수 있다 — 실제 종목별 배너 객체가 아니면 건너뛴다.
    if (!c || typeof c !== "object") return;
    const { active, daysLeft } = bannerStatus(c.endDate);
    // name(광고주 닉네임, 관리자가 자유롭게 수정 가능)과 stockName(실제 종목의
    // 현재 표시명, stocks/{id}.name)을 분리해서 넘긴다 — 닉네임을 나중에
    // 수정해도 "실제 어느 종목에 붙어있는지"는 항상 정확히 알 수 있도록.
    items.push({
      type: "chart", stockId: id,
      name: c.name || (stocksData[id] && stocksData[id].name) || id,
      stockName: (stocksData[id] && stocksData[id].name) || "(삭제된 종목)",
      img: c.img, link: c.link || "", endDate: c.endDate || "",
      active, daysLeft,
    });
  });

  return {
    ok: true,
    active:  items.filter((i) => i.active).sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity)),
    expired: items.filter((i) => !i.active).sort((a, b) => (b.daysLeft ?? -Infinity) - (a.daysLeft ?? -Infinity)),
  };
}

/** 진행중/만료 탭에서 배너 내용을 직접 수정(연장 포함)한다. */
async function actionUpdateBanner(db, { type, stockId, name, img, link, endDate }) {
  if (!stockId) throw new HttpsError("invalid-argument", "stockId가 필요합니다.");
  const bannerImg = String(img || "").trim();
  if (!bannerImg) throw new HttpsError("invalid-argument", "배너 이미지 링크를 입력해주세요.");

  if (type === "chart") {
    await db.ref(`chartBanner/${stockId}`).set({
      name:    String(name || "").trim(),
      img:     bannerImg,
      link:    String(link || "").trim(),
      endDate: String(endDate || "").trim(),
    });
  } else {
    await db.ref().update({
      [`stocks/${stockId}/bannerImg`]:     bannerImg,
      [`stocks/${stockId}/link`]:          String(link || "").trim(),
      [`stocks/${stockId}/bannerEndDate`]: String(endDate || "").trim(),
    });
  }
  return { ok: true };
}

/** 진행중/만료 탭에서 배너를 완전히 제거한다. */
async function actionDeleteBanner(db, { type, stockId }) {
  if (!stockId) throw new HttpsError("invalid-argument", "stockId가 필요합니다.");
  if (type === "chart") {
    await db.ref(`chartBanner/${stockId}`).remove();
  } else {
    await db.ref().update({
      [`stocks/${stockId}/bannerImg`]:     null,
      [`stocks/${stockId}/link`]:          null,
      [`stocks/${stockId}/bannerEndDate`]: null,
    });
  }
  return { ok: true };
}

async function calcTop5(db) {
  const [usersSnap, stocksSnap] = await Promise.all([
    db.ref("users").get(),
    db.ref("stocks").get(),
  ]);
  const usersData  = usersSnap.val()  || {};
  const stocksData = stocksSnap.val() || {};
  const ownership  = {};
  Object.values(usersData).forEach((user) => {
    if (!user.stocks) return;
    Object.entries(user.stocks).forEach(([stockId, info]) => {
      const qty = parseInt(info.qty) || 0;
      if (qty > 0) ownership[stockId] = (ownership[stockId] || 0) + qty;
    });
  });
  return Object.entries(ownership)
    .map(([id, totalQty]) => {
      const stock = stocksData[id] || {};
      return { id, name: stock.name || id, price: stock.price || 0, totalQty };
    })
    .sort((a, b) => b.totalQty - a.totalQty)
    .slice(0, 5);
}

async function actionPreviewRankings(db) {
  return { ok: true, top5: await calcTop5(db) };
}

async function actionSaveRankings(db) {
  const top5 = await calcTop5(db);
  const payload = {
    savedAt: new Date().toISOString(),
    items: top5.map((s, i) => ({ rank: i + 1, id: s.id, name: s.name, price: s.price, totalQty: s.totalQty })),
  };
  await db.ref("rankings/top5").set(payload);
  return { ok: true, top5 };
}

function isInactiveUser(user) {
  const isDefaultCash = (user.cash ?? INITIAL_CASH) === INITIAL_CASH;
  const hasNoStocks   = !user.stocks || Object.keys(user.stocks).length === 0;
  const hasZeroStocks = user.stocks && Object.values(user.stocks).every((s) => (s.qty || 0) === 0);
  return isDefaultCash && (hasNoStocks || hasZeroStocks);
}

async function getInactiveUserIds(db) {
  const snap = await db.ref("users").get();
  const data = snap.val() || {};
  return Object.entries(data)
    .filter(([, user]) => isInactiveUser(user))
    .map(([uid]) => uid);
}

async function actionPreviewInactiveUsers(db) {
  const inactive = await getInactiveUserIds(db);
  return { ok: true, count: inactive.length };
}

async function actionCleanupInactiveUsers(db) {
  const inactive = await getInactiveUserIds(db);
  if (inactive.length === 0) return { ok: true, count: 0 };

  const BATCH = 500;
  for (let i = 0; i < inactive.length; i += BATCH) {
    const batch   = inactive.slice(i, i + BATCH);
    const updates = {};
    batch.forEach((uid) => { updates[`users/${uid}`] = null; });
    await db.ref().update(updates);
  }
  return { ok: true, count: inactive.length };
}

// ── 점검모드 ────────────────────────────────────────────────
// 관리자가 실시간으로 켜고 끌 수 있는 "소프트 점검모드". 코드 배포가
// 필요한 LONG_MAINTENANCE(index.html의 전체 화면 차단)와 달리, 페이지는
// 그대로 보여주고 거래·홍보 신청 등 게임 상태를 바꾸는 활동만 클라이언트
// 단에서 막는다. 켜는 즉시 시작하지 않고 30초의 유예를 둬서 지금 막
// 거래 중인 유저가 놀라지 않게 한다.
const MAINTENANCE_COUNTDOWN_MS = 30 * 1000;

async function actionSetMaintenanceMode(db, { active }) {
  const isActive = !!active;
  if (isActive) {
    await db.ref("maintenance").set({
      active:  true,
      startAt: Date.now() + MAINTENANCE_COUNTDOWN_MS,
    });
  } else {
    await db.ref("maintenance").set({ active: false });
  }
  return { ok: true, active: isActive };
}

/**
 * 손익 랭킹 조회 — 유저가 "내 손익 랭킹" 확인 시마다 갱신되는
 * rankings/profitEntries를 관리자가 통째로 확인한다. 익명 표시(anonId)
 * 만으로는 어뷰징 의심 계정을 특정할 수 없으므로 uid를 함께 반환한다.
 */
async function actionListProfitRankings(db) {
  const snap = await db.ref("rankings/profitEntries").get();
  const data = snap.val() || {};
  const entries = Object.entries(data)
    .map(([uid, r]) => ({ uid, ...r }))
    .sort((a, b) => (b.value || 0) - (a.value || 0));
  return { ok: true, entries };
}

/**
 * 관리자 페이지 상단 알람용 — 승인 대기(status:"pending") 건수를 섹션별로
 * 집계한다. 각 섹션 패널이 이미 개별적으로 pending 목록을 불러오지만,
 * 페이지 진입 시점에 "지금 뭐가 밀려있는지"를 한눈에 보여주는 용도라
 * 별도로 가볍게 카운트만 뽑는다.
 */
async function actionGetPendingSummary(db) {
  const sections = [
    { key: "banner",      sectionId: "section-banner",      label: "배너 광고",       paths: ["bannerRequests", "chartBannerRequests"] },
    { key: "cashcharge",  sectionId: "section-cashcharge",  label: "자산 충전 신청", paths: ["cashChargeRequests"] },
    { key: "pin",         sectionId: "section-pin",         label: "최상단 고정 노출", paths: ["pinRequests"] },
    { key: "listing",     sectionId: "section-listing",     label: "종목 상장 신청", paths: ["listingRequests"] },
    { key: "relay",       sectionId: "section-relay",       label: "중계방 홍보",     paths: ["relayRoomRequests"] },
    { key: "freeze",      sectionId: "section-freeze",      label: "동결 해제(방송 후원)", paths: ["unfreezeDonationRequests"] },
  ];

  const allPaths = [...new Set(sections.flatMap((s) => s.paths))];
  const snaps = await Promise.all(allPaths.map((p) => db.ref(p).get()));
  const countByPath = {};
  allPaths.forEach((p, i) => {
    const data = snaps[i].val() || {};
    countByPath[p] = Object.values(data).filter((r) => r.status === "pending").length;
  });

  const items = sections.map((s) => ({
    key: s.key,
    sectionId: s.sectionId,
    label: s.label,
    count: s.paths.reduce((sum, p) => sum + countByPath[p], 0),
  }));

  return { ok: true, items, totalCount: items.reduce((sum, i) => sum + i.count, 0) };
}

const PURCHASE_HISTORY_LIMIT = 300; // 오래된 이력까지 매번 전부 내려보내지 않도록 최신 N건만 반환

/**
 * 유저 구매 현황 — 우측/차트 배너·최상단 고정·중계방·플레이타임 충전처럼
 * 게임자산을 직접 차감해 즉시 적용되는 5가지 셀프 상품의 구매 이력을
 * 한 화면에서 통합 조회한다. 각 기능별 패널은 "신규/진행중/만료"만
 * 보여주도록 설계돼 있어, 시간이 지나 만료·삭제된 과거 구매까지 한눈에
 * 보긴 어려웠던 빈틈을 메운다. (자산 충전은 반대로 "지급"이라 구매가
 * 아니므로, 종목 상장 신청은 무료라 제외 — 각각 별도 패널에서 확인 가능)
 */
async function actionListPurchaseHistory(db) {
  const [bannerSnap, chartBannerSnap, pinSnap, relaySnap, playTimeSnap] = await Promise.all([
    db.ref("bannerRequests").get(),
    db.ref("chartBannerRequests").get(),
    db.ref("pinRequests").get(),
    db.ref("relayRoomRequests").get(),
    db.ref("playTimePurchases").get(),
  ]);

  const purchases = [];

  Object.entries(bannerSnap.val() || {}).forEach(([id, r]) => purchases.push({
    id, type: "banner", typeLabel: "📢 우측 배너",
    label: `${r.nickname || "-"} (${r.days || 0}일)`,
    amount: r.chargedAmount || 0, uid: r.requesterUid, status: r.status,
    at: r.requestedAt || 0,
  }));

  Object.entries(chartBannerSnap.val() || {}).forEach(([id, r]) => purchases.push({
    id, type: "chartBanner", typeLabel: "🖼 차트 하단 배너",
    label: `${r.stockName || r.nickname || "-"} (${r.days || 0}일)`,
    amount: r.chargedAmount || 0, uid: r.requesterUid, status: r.status,
    at: r.requestedAt || 0,
  }));

  Object.entries(pinSnap.val() || {}).forEach(([id, r]) => purchases.push({
    id, type: "pin", typeLabel: "📌 최상단 고정",
    label: `${r.stockName || "-"} (${r.hours || 0}시간)`,
    amount: r.chargedAmount || 0, uid: r.requesterUid, status: r.status,
    at: r.requestedAt || 0,
  }));

  Object.entries(relaySnap.val() || {}).forEach(([id, r]) => purchases.push({
    id, type: "relayRoom", typeLabel: "🎥 중계방",
    label: `${r.nickname || "-"} (${r.hours || 0}시간)`,
    amount: r.chargedAmount || 0, uid: r.requesterUid, status: r.status,
    at: r.requestedAt || 0,
  }));

  Object.entries(playTimeSnap.val() || {}).forEach(([id, r]) => purchases.push({
    id, type: "playTime", typeLabel: "⏱ 플레이타임 충전",
    label: `${r.hours || 0}시간`,
    amount: r.chargedAmount || 0, uid: r.uid, status: "approved",
    at: r.purchasedAt || 0,
  }));

  purchases.sort((a, b) => b.at - a.at);

  return { ok: true, purchases: purchases.slice(0, PURCHASE_HISTORY_LIMIT), totalCount: purchases.length };
}

/**
 * 관리자 페이지 전용 액션 디스패처.
 * 클라이언트는 { action, payload }만 전달하고, 실제 stocks/users/rankings/
 * chartBanner 쓰기·users 읽기는 전부 여기서 Admin SDK로 처리한다.
 */
const adminAction = onCall({ cors: true, timeoutSeconds: 120, memory: "256MiB" }, async (request) => {
  requireAdmin(request.auth);

  const db      = admin.database();
  const action  = String(request.data?.action || "");
  const payload = request.data?.payload || {};

  switch (action) {
    case "updateSinglePrice":      return actionUpdateSinglePrice(db, payload);
    case "updateStockData":        return actionUpdateStockData(db, payload);
    case "adjustAllPrices":        return actionAdjustAllPrices(db, payload);
    case "resetAllPrices":         return actionResetAllPrices(db);
    case "uploadStocks":           return actionUploadStocks(db, payload);
    case "deleteStocks":           return actionDeleteStocks(db, payload);
    case "cleanupDuplicateStocks": return actionCleanupDuplicateStocks(db);
    case "listActiveBanners":      return actionListActiveBanners(db);
    case "updateBanner":           return actionUpdateBanner(db, payload);
    case "deleteBanner":           return actionDeleteBanner(db, payload);
    case "listCashChargeRequests":   return actionListCashChargeRequests(db);
    case "approveCashChargeRequest": return actionApproveCashChargeRequest(db, payload);
    case "rejectCashChargeRequest":  return actionRejectCashChargeRequest(db, payload);
    case "listPinRequests":    return actionListPinRequests(db);
    case "listActivePins":     return actionListActivePins(db);
    case "approvePinRequest":  return actionApprovePinRequest(db, payload);
    case "rejectPinRequest":   return actionRejectPinRequest(db, payload);
    case "deletePin":          return actionDeletePin(db, payload);
    case "listRelayRoomRequests":    return actionListRelayRoomRequests(db);
    case "listActiveRelayRooms":     return actionListActiveRelayRooms(db);
    case "approveRelayRoomRequest":  return actionApproveRelayRoomRequest(db, payload);
    case "rejectRelayRoomRequest":   return actionRejectRelayRoomRequest(db, payload);
    case "deleteRelayRoom":          return actionDeleteRelayRoom(db, payload);
    case "listUnfreezeDonationRequests":   return actionListUnfreezeDonationRequests(db);
    case "approveUnfreezeDonationRequest": return actionApproveUnfreezeDonationRequest(db, payload);
    case "rejectUnfreezeDonationRequest":  return actionRejectUnfreezeDonationRequest(db, payload);
    case "listFrozenStocks":               return actionListFrozenStocks(db);
    case "forceUnfreezeStock":             return actionForceUnfreezeStock(db, payload);
    case "listListingRequests":    return actionListListingRequests(db);
    case "approveListingRequest":  return actionApproveListingRequest(db, payload);
    case "rejectListingRequest":   return actionRejectListingRequest(db, payload);
    case "previewRankings":        return actionPreviewRankings(db);
    case "saveRankings":           return actionSaveRankings(db);
    case "previewInactiveUsers":   return actionPreviewInactiveUsers(db);
    case "cleanupInactiveUsers":   return actionCleanupInactiveUsers(db);
    case "listBannerRequests":     return actionListBannerRequests(db);
    case "approveBannerRequest":   return actionApproveBannerRequest(db, payload);
    case "rejectBannerRequest":    return actionRejectBannerRequest(db, payload);
    case "listChartBannerRequests":   return actionListChartBannerRequests(db);
    case "approveChartBannerRequest": return actionApproveChartBannerRequest(db, payload);
    case "rejectChartBannerRequest":  return actionRejectChartBannerRequest(db, payload);
    case "setMaintenanceMode":     return actionSetMaintenanceMode(db, payload);
    case "listProfitRankings":     return actionListProfitRankings(db);
    case "listPurchaseHistory":    return actionListPurchaseHistory(db);
    case "getPendingSummary":      return actionGetPendingSummary(db);
    default:
      throw new HttpsError("invalid-argument", `알 수 없는 action: ${action}`);
  }
});

module.exports = { adminAction };
