const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp({
  databaseURL: "https://soop-stock-market-default-rtdb.firebaseio.com",
});

setGlobalOptions({
  // region: "asia-northeast3"
});

const ADMIN_EMAIL = "skftodwocks2@gmail.com"; // 관리자 페이지와 동일 계정

// ── 매매 파라미터 (기존 클라이언트 로직과 동일) ──────────────
const TRADE_COOLDOWN_MS   = 1000;   // 연속 거래 최소 간격
const IMPACT_PER_QTY      = 0.001;  // 수량당 시장 충격
const SPREAD              = 0.0005; // 매수/매도 스프레드
const SELL_FEE            = 0.003;  // 매도 수수료
const MAX_QTY_PER_ORDER   = 10000;  // 1회 주문 최대 수량
const MAX_CANDLE_MINUTES  = 360;    // 분봉 보관 기간(분)

function currentMinuteTs() {
  return Math.floor(Date.now() / 60000) * 60;
}

/**
 * 매매 체결 (buy/sell)
 * 클라이언트는 stockId/type/qty만 전달하고, 가격 계산·잔고 검증·기록은
 * 전부 서버(Admin SDK)에서 처리한다 — 클라이언트가 stocks/users를 직접
 * 쓰지 못하도록 database.rules.json에서 해당 경로 쓰기 권한을 막아둔다.
 */
exports.trade = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const uid      = auth.uid;
  const stockId  = String(request.data?.stockId || "").trim();
  const type     = String(request.data?.type || "").trim().toLowerCase();
  const qty      = Math.floor(Number(request.data?.qty));

  if (!stockId) throw new HttpsError("invalid-argument", "stockId가 필요합니다.");
  if (type !== "buy" && type !== "sell") {
    throw new HttpsError("invalid-argument", "type은 buy 또는 sell 이어야 합니다.");
  }
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_ORDER) {
    throw new HttpsError("invalid-argument", "수량이 올바르지 않습니다.");
  }

  const db       = admin.database();
  const stockRef = db.ref(`stocks/${stockId}`);
  const userRef  = db.ref(`users/${uid}`);
  const impact   = IMPACT_PER_QTY * qty;

  // 1) 종목 가격/거래량 갱신 (경합 시 자동 재시도되는 RTDB 트랜잭션)
  let finalTradePrice = 0;

  const stockTx = await stockRef.transaction((currentStock) => {
    if (!currentStock) return currentStock; // 종목 없음 → abort

    const newPrice = type === "buy"
      ? Math.round(currentStock.price * (1 + impact))
      : Math.round(currentStock.price * (1 - impact));
    finalTradePrice = type === "buy"
      ? Math.round(newPrice * (1 + SPREAD))
      : Math.round(newPrice * (1 - SPREAD));

    let history = currentStock.history || [currentStock.price];
    history = [...history, newPrice];
    if (history.length > 20) history.shift();

    return {
      ...currentStock,
      price:  newPrice,
      history,
      volume: (currentStock.volume || 0) + qty,
      change: (((newPrice - history[0]) / history[0]) * 100).toFixed(2),
    };
  });

  if (!stockTx.committed || !stockTx.snapshot.exists()) {
    throw new HttpsError("not-found", "종목을 찾을 수 없습니다.");
  }

  // 2) 유저 잔고/보유수량 갱신 (쿨다운·잔액·보유량 검증 포함)
  let abortReason = null;

  const userTx = await userRef.transaction((currentUser) => {
    const now  = Date.now();
    const user = currentUser || { cash: 1000000, stocks: {} };

    if (user.lastTradeTime && now - user.lastTradeTime < TRADE_COOLDOWN_MS) {
      abortReason = "COOLDOWN";
      return; // abort
    }

    const stocks = { ...(user.stocks || {}) };
    const pos    = stocks[stockId] || { qty: 0, avg: 0 };

    if (type === "buy") {
      const totalCost = finalTradePrice * qty;
      if ((user.cash || 0) < totalCost) {
        abortReason = "INSUFFICIENT_CASH";
        return;
      }
      const newQty = pos.qty + qty;
      stocks[stockId] = {
        qty: newQty,
        avg: Math.round((pos.qty * pos.avg + totalCost) / newQty),
      };
      user.cash = (user.cash || 0) - totalCost;
    } else {
      if (pos.qty < qty) {
        abortReason = "INSUFFICIENT_STOCK";
        return;
      }
      const totalSellAmount = Math.round(finalTradePrice * qty * (1 - SELL_FEE));
      const newQty = pos.qty - qty;
      stocks[stockId] = { qty: newQty, avg: newQty === 0 ? 0 : pos.avg };
      user.cash = (user.cash || 0) + totalSellAmount;
    }

    user.stocks        = stocks;
    user.lastTradeTime = now;
    return user;
  });

  if (abortReason === "COOLDOWN") {
    throw new HttpsError("resource-exhausted", "거래가 너무 빠릅니다! 잠시 후 다시 시도해주세요.");
  }
  if (abortReason === "INSUFFICIENT_CASH") {
    throw new HttpsError("failed-precondition", "잔액이 부족합니다!");
  }
  if (abortReason === "INSUFFICIENT_STOCK") {
    throw new HttpsError("failed-precondition", "보유 주식이 부족합니다!");
  }
  if (!userTx.committed) {
    throw new HttpsError("aborted", "거래 처리 중 문제가 발생했습니다. 다시 시도해주세요.");
  }

  // 3) 분봉 캔들 갱신 (best-effort — 실패해도 매매 결과에는 영향 없음)
  try {
    const ts = currentMinuteTs();
    await db.ref(`candlesticks/${stockId}/${ts}`).transaction((current) => {
      if (!current) {
        return { o: finalTradePrice, h: finalTradePrice, l: finalTradePrice, c: finalTradePrice, v: qty, t: ts };
      }
      return {
        ...current,
        h: Math.max(current.h, finalTradePrice),
        l: Math.min(current.l, finalTradePrice),
        c: finalTradePrice,
        v: current.v + qty,
        t: ts,
      };
    });

    const cutoff = Math.floor(Date.now() / 60000 - MAX_CANDLE_MINUTES) * 60;
    const oldSnap = await db.ref(`candlesticks/${stockId}`).get();
    if (oldSnap.exists()) {
      const data    = oldSnap.val();
      const updates = {};
      Object.keys(data).forEach((tsKey) => {
        if (parseInt(tsKey, 10) < cutoff) updates[tsKey] = null;
      });
      if (Object.keys(updates).length > 0) {
        await db.ref(`candlesticks/${stockId}`).update(updates);
      }
    }
  } catch (e) {
    // 캔들 갱신 실패는 무시 (다음 거래 때 재시도됨)
  }

  const finalUser = userTx.snapshot.val();
  return {
    ok:       true,
    price:    finalTradePrice,
    cash:     finalUser.cash,
    position: (finalUser.stocks || {})[stockId] || { qty: 0, avg: 0 },
  };
});

// ══════════════════════════════════════════════════════════
// 관리자 페이지 기능 — 전부 Admin SDK로 처리해 RTDB 규칙의
// 이메일 매칭 없이도 안전하게 동작한다 (아래 각 action 함수 참고)
// ══════════════════════════════════════════════════════════

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

async function actionUpdateSinglePrice(db, { stockId, price }) {
  if (!stockId) throw new HttpsError("invalid-argument", "stockId가 필요합니다.");
  const newPrice = Math.round(Number(price));
  if (!Number.isFinite(newPrice)) throw new HttpsError("invalid-argument", "정확한 가격을 입력해주세요.");

  const snap = await db.ref(`stocks/${stockId}`).get();
  if (!snap.exists()) throw new HttpsError("not-found", "종목을 찾을 수 없습니다.");
  const stock = snap.val();

  let history = stock.history || [stock.price];
  history = [...history, newPrice];
  if (history.length > 10) history.shift();

  await db.ref().update({
    [`stocks/${stockId}/price`]:   newPrice,
    [`stocks/${stockId}/history`]: history,
    [`stocks/${stockId}/change`]:  (((newPrice - history[0]) / history[0]) * 100).toFixed(2),
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
    let history = data[id].history || [oldPrice];
    history = [...history, newPrice];
    if (history.length > 10) history.shift();
    updates[`stocks/${id}/price`]   = newPrice;
    updates[`stocks/${id}/history`] = history;
    updates[`stocks/${id}/change`]  = (((newPrice - history[0]) / history[0]) * 100).toFixed(2);
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
    updates[`stocks/${id}/price`]   = RESET_PRICE;
    updates[`stocks/${id}/history`] = [RESET_PRICE, RESET_PRICE];
    updates[`stocks/${id}/change`]  = "0.00";
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
    stocks[`id_${Date.now()}_${i}`] = { name, price: 10000, change: 0, history: [10000, 10000] };
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

async function actionAddBannerToStock(db, { nickname, imgUrl, linkUrl, days }) {
  const targetNickname = String(nickname || "").trim();
  const img            = String(imgUrl || "").trim();
  const daysNum         = parseInt(days, 10);
  if (!targetNickname || !img || !daysNum) {
    throw new HttpsError("invalid-argument", "닉네임, 이미지 주소, 노출 기간(일)은 필수 입력 항목입니다.");
  }
  const targetId = await findStockIdByName(db, targetNickname);
  if (!targetId) throw new HttpsError("not-found", `'${targetNickname}'을 찾을 수 없습니다.`);

  const endDate = new Date();
  endDate.setDate(endDate.getDate() + daysNum);
  const endDateStr = endDate.toISOString().split("T")[0];

  await db.ref().update({
    [`stocks/${targetId}/bannerImg`]:     img,
    [`stocks/${targetId}/bannerEndDate`]: endDateStr,
    [`stocks/${targetId}/link`]:          String(linkUrl || "").trim() || `https://www.sooplive.co.kr/station/${targetId}`,
  });
  return { ok: true, endDate: endDateStr };
}

async function actionSaveChartBanner(db, { nickname, name, img, link, days }) {
  const targetNickname = String(nickname || "").trim();
  const bannerImg       = String(img || "").trim();
  const bannerLink      = String(link || "").trim();
  const daysNum         = parseInt(days, 10);
  if (!targetNickname) throw new HttpsError("invalid-argument", "배너를 노출할 대상 스트리머 닉네임을 입력해주세요.");
  if (!bannerImg)      throw new HttpsError("invalid-argument", "배너 이미지 URL을 입력해주세요.");
  if (!bannerLink)     throw new HttpsError("invalid-argument", "이동 링크를 입력해주세요.");
  if (!Number.isFinite(daysNum) || daysNum < 1) {
    throw new HttpsError("invalid-argument", "노출 기간(일)을 올바르게 입력해주세요.");
  }

  const targetId = await findStockIdByName(db, targetNickname);
  if (!targetId) throw new HttpsError("not-found", `'${targetNickname}'을 찾을 수 없습니다.`);

  const endDate = new Date();
  endDate.setDate(endDate.getDate() + daysNum);
  const endDateStr = endDate.toISOString().split("T")[0];

  await db.ref(`chartBanner/${targetId}`).set({
    name: String(name || "").trim(),
    img:  bannerImg,
    link: bannerLink,
    endDate: endDateStr,
  });
  return { ok: true, stockId: targetId, endDate: endDateStr };
}

async function actionDeleteChartBanner(db, { stockId }) {
  if (!stockId) throw new HttpsError("invalid-argument", "stockId가 필요합니다.");
  await db.ref(`chartBanner/${stockId}`).remove();
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
  const isDefaultCash = (user.cash ?? 1000000) === 1000000;
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
exports.adminAction = onCall({ cors: true, timeoutSeconds: 120, memory: "256MiB" }, async (request) => {
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
    case "addBannerToStock":       return actionAddBannerToStock(db, payload);
    case "saveChartBanner":        return actionSaveChartBanner(db, payload);
    case "deleteChartBanner":      return actionDeleteChartBanner(db, payload);
    case "previewRankings":        return actionPreviewRankings(db);
    case "saveRankings":           return actionSaveRankings(db);
    case "previewInactiveUsers":   return actionPreviewInactiveUsers(db);
    case "cleanupInactiveUsers":   return actionCleanupInactiveUsers(db);
    default:
      throw new HttpsError("invalid-argument", `알 수 없는 action: ${action}`);
  }
});
