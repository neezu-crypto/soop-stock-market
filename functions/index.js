const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp({
  databaseURL: "https://soop-stock-market-default-rtdb.firebaseio.com",
});

setGlobalOptions({
  // region: "asia-northeast3"
});

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
