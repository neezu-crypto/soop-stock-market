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
    updates[`stocks/${id}/price`] = RESET_PRICE;
  });
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
    if (namesToDelete.includes(stock.name)) { updates[`stocks/${id}`] = null; foundCount++; }
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
      if (isMatch) { deleteUpdates[`stocks/${target.id}`] = null; duplicateFoundCount++; }
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
      type: "ranking", stockId: id, name: s.name || id,
      img: s.bannerImg, link: s.link || "", endDate: s.bannerEndDate || "",
      active, daysLeft,
    });
  });
  Object.entries(chartData).forEach(([id, c]) => {
    const { active, daysLeft } = bannerStatus(c.endDate);
    items.push({
      type: "chart", stockId: id, name: c.name || (stocksData[id] && stocksData[id].name) || id,
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
    default:
      throw new HttpsError("invalid-argument", `알 수 없는 action: ${action}`);
  }
});

module.exports = { adminAction };
