const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  INITIAL_CASH,
  STOCK_FREEZE_THRESHOLD,
  STOCK_FREEZE_CANDLE_COUNT,
  STOCK_DELIST_DEADLINE_MS,
} = require("./common");
const { checkPlayQuota } = require("./playTime");

// ── 매매 파라미터 (기존 클라이언트 로직과 동일) ──────────────
const TRADE_COOLDOWN_MS   = 1000;   // 연속 거래 최소 간격
const IMPACT_PER_QTY      = 0.001;  // 수량당 시장 충격
const SPREAD              = 0.0005; // 매수/매도 스프레드
const SELL_FEE            = 0.003;  // 매도 수수료
const MAX_QTY_PER_ORDER   = 10000;  // 1회 주문 최대 수량
const MAX_CANDLE_MINUTES  = 360;    // 분봉 보관 기간(분)
const RANKING_DEBOUNCE_MS = 30000;  // 랭킹 반영 최소 간격

function currentMinuteTs() {
  return Math.floor(Date.now() / 60000) * 60;
}

/**
 * 동결 판정 — 최근 STOCK_FREEZE_CANDLE_COUNT개의 1분봉 종가가 "전부"
 * STOCK_FREEZE_THRESHOLD 이상이면 동결한다. 평균이 아니라 "전부 다" 조건을
 * 쓰는 이유는 순간적인 한 번의 거래(조작)로는 통과할 수 없고, 여러 분에
 * 걸쳐 값을 유지해야 하므로 단발성 펌프에 강하기 때문이다. 매수로 가격이
 * 오를 때만 의미가 있으므로 매수 체결 후에만 호출한다.
 */
async function maybeFreezeStock(db, stockId, triggerUid) {
  const candleSnap = await db.ref(`candlesticks/${stockId}`).get();
  const candles = candleSnap.val();
  if (!candles) return;

  const sorted = Object.values(candles).sort((a, b) => b.t - a.t); // 최신순
  if (sorted.length < STOCK_FREEZE_CANDLE_COUNT) return;

  const recentN = sorted.slice(0, STOCK_FREEZE_CANDLE_COUNT);
  const allAboveThreshold = recentN.every((c) => c.c >= STOCK_FREEZE_THRESHOLD);
  if (!allAboveThreshold) return;

  const now = Date.now();
  await db.ref(`stocks/${stockId}`).transaction((currentStock) => {
    if (!currentStock || currentStock.frozenAt) return currentStock; // 이미 동결됨 → 변경 없음
    return {
      ...currentStock,
      frozenAt:         now,
      freezeDeadline:   now + STOCK_DELIST_DEADLINE_MS,
      freezeTriggerUid: triggerUid,
    };
  });
}

/**
 * 신규 유저 초기 자산 지급. 클라이언트는 로그인 직후(대개 익명 로그인 직후)
 * 이 함수를 호출한다 — users/{uid}가 아직 없을 때만 INITIAL_CASH를 지급하고,
 * 이미 있으면 아무 것도 하지 않는(idempotent) 안전한 동작이라 여러 번
 * 호출돼도 문제없다.
 */
const initializeUser = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const db      = admin.database();
  const userRef = db.ref(`users/${auth.uid}`);

  // trade()와 동일한 이유로 진짜 값을 먼저 읽어둔다 — 트랜잭션 콜백의
  // currentUser가 캐시 미스로 null이 들어와도 "신규 유저"로 오판해 기존
  // 데이터를 덮어쓰지 않도록 하기 위함.
  const trueUser = (await userRef.get()).val();

  const userTx = await userRef.transaction((currentUser) => {
    const user = currentUser || trueUser;
    if (user) return user; // 이미 있으면 그대로 둔다
    return { cash: INITIAL_CASH, stocks: {} };
  });

  return { ok: true, cash: userTx.snapshot.val()?.cash ?? INITIAL_CASH };
});

/**
 * 매매 체결 (buy/sell)
 * 클라이언트는 stockId/type/qty만 전달하고, 가격 계산·잔고 검증·기록은
 * 전부 서버(Admin SDK)에서 처리한다 — 클라이언트가 stocks/users를 직접
 * 쓰지 못하도록 database.rules.json에서 해당 경로 쓰기 권한을 막아둔다.
 */
const trade = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
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

  const db = admin.database();
  await checkPlayQuota(db, uid, auth);

  const stockRef = db.ref(`stocks/${stockId}`);
  const userRef  = db.ref(`users/${uid}`);
  const impact   = IMPACT_PER_QTY * qty;

  // 0) 사전 검증 (쿨다운 · 매도 보유량 — 가격과 무관하게 판정 가능한 것만)
  //    종목 가격 트랜잭션은 무거운 데다 실패 시 되돌려야 하므로, 가격을 몰라도
  //    확정적으로 판단 가능한 위반은 가격을 건드리기 전에 미리 걸러낸다.
  //    Admin SDK는 활성 리스너가 없는 경로는 캐시하지 않아 트랜잭션 콜백에
  //    currentUser가 null로 들어올 수 있어, 여기서 미리 읽어둔 실제 값을
  //    콜백 안에서도 기본값 대신 사용한다(진짜 신규 유저라 서버 값도 null인
  //    경우에만 기본값 사용).
  const trueUser = (await userRef.get()).val();
  {
    const now      = Date.now();
    const preUser  = trueUser || { cash: INITIAL_CASH, stocks: {} };
    if (preUser.lastTradeTime && now - preUser.lastTradeTime < TRADE_COOLDOWN_MS) {
      throw new HttpsError("resource-exhausted", "거래가 너무 빠릅니다! 잠시 후 다시 시도해주세요.");
    }
    if (type === "sell") {
      const pos = (preUser.stocks || {})[stockId] || { qty: 0 };
      if (pos.qty < qty) {
        throw new HttpsError("failed-precondition", "보유 주식이 부족합니다!");
      }
    }
  }

  // 0.5) 동결 상태 확인 — 동결된 종목은 매수/매도 모두 차단
  const trueStock = (await stockRef.get()).val();
  if (trueStock?.frozenAt) {
    throw new HttpsError(
      "failed-precondition",
      `"${trueStock.name || stockId}" 종목은 현재 거래가 동결되어 있습니다. 동결 해제 후 다시 시도해주세요.`
    );
  }

  // 1) 종목 가격/거래량 갱신 (경합 시 자동 재시도되는 RTDB 트랜잭션)
  //    위 사전 검증을 통과했더라도, 매수 잔액처럼 가격이 확정돼야 정확히
  //    판정되는 조건은 여전히 2단계(유저 트랜잭션)에서 최종 검증한다. 거기서
  //    실패하면(주로 사전검증 이후 끼어든 드문 동시성 충돌) 아래에서 이 변경을
  //    반드시 되돌린다 — 되돌릴 때는 절대값이 아니라 우리가 적용한 배율의
  //    역수를 나누고 수량을 빼는 상대적 보정을 사용해, 되돌리는 사이 다른
  //    유저의 거래가 같은 종목에 끼어들어도 그 변화를 지우지 않고 우리 몫만
  //    정확히 걷어낸다.
  let finalTradePrice = 0;

  const stockTx = await stockRef.transaction((currentStock) => {
    if (!currentStock) return currentStock; // 종목 없음 → abort

    const newPrice = type === "buy"
      ? Math.round(currentStock.price * (1 + impact))
      : Math.round(currentStock.price * (1 - impact));
    finalTradePrice = type === "buy"
      ? Math.round(newPrice * (1 + SPREAD))
      : Math.round(newPrice * (1 - SPREAD));

    return {
      ...currentStock,
      price:  newPrice,
      volume: (currentStock.volume || 0) + qty,
    };
  });

  if (!stockTx.committed || !stockTx.snapshot.exists()) {
    throw new HttpsError("not-found", "종목을 찾을 수 없습니다.");
  }

  async function revertStockChange() {
    await stockRef.transaction((currentStock) => {
      if (!currentStock) return currentStock;
      const revertedPrice = type === "buy"
        ? Math.round(currentStock.price / (1 + impact))
        : Math.round(currentStock.price / (1 - impact));
      return {
        ...currentStock,
        price:  revertedPrice,
        volume: Math.max(0, (currentStock.volume || 0) - qty),
      };
    });
  }

  // 2) 유저 잔고/보유수량 갱신 (쿨다운·잔액·보유량 최종 검증 및 반영)
  //    trueUser는 0단계에서 이미 읽어둔 값 — currentUser가 null(캐시 미스)일
  //    때 기본값 대신 사용한다.
  let abortReason = null;

  const userTx = await userRef.transaction((currentUser) => {
    const now  = Date.now();
    const user = currentUser || trueUser || { cash: INITIAL_CASH, stocks: {} };

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

  if (abortReason || !userTx.committed) {
    await revertStockChange();
  }
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

  // 3.5) 동결 판정 (best-effort — 매수로 가격이 오를 때만 의미가 있음)
  if (type === "buy") {
    try {
      await maybeFreezeStock(db, stockId, uid);
    } catch (e) {
      // 동결 판정 실패는 무시 (다음 매수 때 재시도됨)
    }
  }

  // 4) 거래량 랭킹 갱신 (best-effort — 실패해도 매매 결과에는 영향 없음)
  //    클라이언트가 직접 rankings/top5를 덮어쓰던 방식은 조작 가능한 구멍이라
  //    서버로 이전. totalQty는 델타 누적이 아니라 stocks/{id}.volume(누적 거래량)
  //    절대값을 그대로 사용해 드리프트가 생기지 않는다. 너무 잦은 쓰기를 막기
  //    위해 마지막 저장 후 RANKING_DEBOUNCE_MS 이내면 건너뛴다.
  try {
    const updatedStock = stockTx.snapshot.val();
    await db.ref("rankings/top5").transaction((current) => {
      const now = Date.now();
      if (current && current.savedAt && now - current.savedAt < RANKING_DEBOUNCE_MS) {
        return; // 너무 빠름 → 이번 반영은 건너뜀 (abort)
      }
      const itemMap = {};
      ((current && current.items) || []).forEach((item) => { itemMap[item.id] = item; });
      itemMap[stockId] = {
        id:       stockId,
        name:     updatedStock.name,
        price:    finalTradePrice,
        totalQty: updatedStock.volume || 0,
      };
      const newTop5 = Object.values(itemMap)
        .sort((a, b) => b.totalQty - a.totalQty)
        .slice(0, 5);
      newTop5.forEach((item, i) => { item.rank = i + 1; });
      return { savedAt: now, items: newTop5 };
    });
  } catch (e) {
    // 랭킹 갱신 실패는 무시 (다음 거래 때 재시도됨)
  }

  const finalUser = userTx.snapshot.val();
  return {
    ok:       true,
    price:    finalTradePrice,
    cash:     finalUser.cash,
    position: (finalUser.stocks || {})[stockId] || { qty: 0, avg: 0 },
  };
});

module.exports = { initializeUser, trade };
