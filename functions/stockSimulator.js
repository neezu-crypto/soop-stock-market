const { HttpsError } = require("firebase-functions/v2/https");

// ══════════════════════════════════════════════════════════
// 주식매매 시뮬레이터 — 관리자 페이지 전용 테스트 도구. 키워드를 등록하면
// 종목명에 그 키워드가 포함된 종목들을 대상으로, trade.js와 동일한 가격
// 임팩트 공식으로 랜덤 매수/매도를 반복 체결해 "실제로 거래되는 것처럼"
// 가격·거래량·캔들·스파크라인을 움직인다.
//
// 상시 폴링 서버 함수(Cloud Scheduler)를 새로 만들지 않기 위해, 매매 반복은
// 관리자 페이지가 setInterval로 이 파일의 runStockSimTrade 액션을
// intervalSeconds마다 직접 반복 호출하는 "클라이언트 주도" 방식이다 —
// 관리자 페이지 탭이 열려 있는 동안만 동작하고, 탭을 닫으면 그냥 멈춘다
// (세션이 DB에 running으로 남아있어도 아무도 반복 호출을 안 하면 매매도
// 안 일어난다 — 안전한 실패 모드). 매 호출마다 서버가 세션 상태·종료
// 시각을 다시 검증하므로 클라이언트를 신뢰하지 않는다.
//
// 봇 거래는 진짜 유저 계정이 아니므로, 유저 보상과 직결된 부수효과
// (잭팟 기여·도전과제 지급·인기 TOP5 랭킹 반영)는 전부 건너뛴다 — 특히
// 잭팟은 목표 달성 시 "그 거래를 한 유저"에게 실제 현금이 지급되는
// 구조라, 봇 거래가 여기 섞이면 지급 대상이 없어 오류가 나거나 악용
// 소지가 생긴다. 가격/거래량/캔들/스파크라인처럼 "차트가 살아있어
// 보이게" 하는 시각적 요소만 실제 거래와 동일하게 갱신한다.
// ══════════════════════════════════════════════════════════

const IMPACT_PER_QTY = 0.001; // trade.js와 동일한 수량당 시장 충격
const MIN_QTY = 1;
const MAX_QTY = 10; // trade.js의 1회 주문 최대 수량과 동일하게 맞춤
const MAX_CANDLE_MINUTES = 360;
const SPARKLINE_MAX = 20;
const MIN_INTERVAL_SECONDS = 3;   // 너무 짧으면 사실상 도배라 최소치를 둔다
const MAX_SESSION_MINUTES = 24 * 60; // 종료 예약 상한(24시간) — 무한정 방치 방지
const MAX_SESSION_LIST = 50;

function currentMinuteTs() {
  return Math.floor(Date.now() / 60000) * 60;
}

function findMatchingStocks(stocksData, keyword) {
  const kw = keyword.toLowerCase();
  return Object.entries(stocksData || {})
    .filter(([, s]) => (s.name || "").toLowerCase().includes(kw))
    .map(([id, s]) => ({ id, name: s.name }));
}

async function actionCreateStockSimSession(db, { keyword, intervalSeconds, endMinutes }) {
  const kw = String(keyword || "").trim();
  if (!kw) throw new HttpsError("invalid-argument", "키워드를 입력해주세요.");

  const interval = parseInt(intervalSeconds, 10);
  if (!Number.isInteger(interval) || interval < MIN_INTERVAL_SECONDS) {
    throw new HttpsError("invalid-argument", `매매 간격은 ${MIN_INTERVAL_SECONDS}초 이상으로 입력해주세요.`);
  }

  const hasEndMinutes = endMinutes !== null && endMinutes !== undefined && endMinutes !== "";
  const endMin = hasEndMinutes ? parseInt(endMinutes, 10) : null;
  if (hasEndMinutes && (!Number.isInteger(endMin) || endMin < 1 || endMin > MAX_SESSION_MINUTES)) {
    throw new HttpsError("invalid-argument", `종료 예약은 1~${MAX_SESSION_MINUTES}분 사이로 입력해주세요.`);
  }

  const stocksSnap = await db.ref("stocks").get();
  const matched = findMatchingStocks(stocksSnap.val(), kw);
  if (matched.length === 0) {
    throw new HttpsError("failed-precondition", "키워드가 포함된 종목이 없습니다.");
  }

  const now = Date.now();
  const ref = db.ref("stockSimSessions").push();
  await ref.set({
    keyword: kw,
    intervalSeconds: interval,
    status: "running",
    createdAt: now,
    endAt: endMin != null ? now + endMin * 60000 : null,
    endMinutes: endMin,
    lastTradeAt: 0,
    tradeCount: 0,
  });

  return { ok: true, id: ref.key, matchedStocks: matched };
}

async function actionListStockSimSessions(db) {
  const snap = await db.ref("stockSimSessions").get();
  const data = snap.val() || {};
  const sessions = Object.entries(data)
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, MAX_SESSION_LIST);
  return { ok: true, sessions };
}

async function actionUpdateStockSimSession(db, { sessionId, intervalSeconds }) {
  if (!sessionId) throw new HttpsError("invalid-argument", "sessionId가 필요합니다.");
  const interval = parseInt(intervalSeconds, 10);
  if (!Number.isInteger(interval) || interval < MIN_INTERVAL_SECONDS) {
    throw new HttpsError("invalid-argument", `매매 간격은 ${MIN_INTERVAL_SECONDS}초 이상으로 입력해주세요.`);
  }

  const sessionRef = db.ref(`stockSimSessions/${sessionId}`);
  const snap = await sessionRef.get();
  if (!snap.exists()) throw new HttpsError("not-found", "세션을 찾을 수 없습니다.");
  if (snap.val().status !== "running") throw new HttpsError("failed-precondition", "이미 종료된 세션입니다.");

  await sessionRef.update({ intervalSeconds: interval });
  return { ok: true };
}

async function actionEndStockSimSession(db, { sessionId }) {
  if (!sessionId) throw new HttpsError("invalid-argument", "sessionId가 필요합니다.");
  const sessionRef = db.ref(`stockSimSessions/${sessionId}`);
  const snap = await sessionRef.get();
  if (!snap.exists()) throw new HttpsError("not-found", "세션을 찾을 수 없습니다.");
  if (snap.val().status === "running") {
    await sessionRef.update({ status: "ended", endedAt: Date.now() });
  }
  return { ok: true };
}

async function executeSimulatedTrade(db, stockId, type, qty) {
  const stockRef = db.ref(`stocks/${stockId}`);
  const impact = IMPACT_PER_QTY * qty;
  let finalPrice = 0;

  const stockTx = await stockRef.transaction((currentStock) => {
    if (!currentStock || currentStock.frozenAt) return currentStock; // 없거나 동결 중 → 변경 없음(abort 취급)
    const newPrice = type === "buy"
      ? Math.round(currentStock.price * (1 + impact))
      : Math.round(currentStock.price * (1 - impact));
    finalPrice = newPrice;
    return { ...currentStock, price: newPrice, volume: (currentStock.volume || 0) + qty };
  });

  if (!stockTx.committed || !stockTx.snapshot.exists() || !finalPrice) return null;

  try {
    const ts = currentMinuteTs();
    await db.ref(`candlesticks/${stockId}/${ts}`).transaction((current) => {
      if (!current) return { o: finalPrice, h: finalPrice, l: finalPrice, c: finalPrice, v: qty, t: ts };
      return {
        ...current,
        h: Math.max(current.h, finalPrice),
        l: Math.min(current.l, finalPrice),
        c: finalPrice,
        v: current.v + qty,
        t: ts,
      };
    });
    const cutoff = Math.floor(Date.now() / 60000 - MAX_CANDLE_MINUTES) * 60;
    const oldSnap = await db.ref(`candlesticks/${stockId}`).get();
    if (oldSnap.exists()) {
      const data = oldSnap.val();
      const updates = {};
      Object.keys(data).forEach((tsKey) => { if (parseInt(tsKey, 10) < cutoff) updates[tsKey] = null; });
      if (Object.keys(updates).length > 0) await db.ref(`candlesticks/${stockId}`).update(updates);
    }
  } catch (e) { /* 캔들 갱신 실패는 무시 (다음 매매 때 재시도됨) */ }

  try {
    await db.ref(`sparklines/${stockId}`).transaction((current) => {
      const buf = Array.isArray(current) ? current.slice() : [];
      buf.push(finalPrice);
      if (buf.length > SPARKLINE_MAX) buf.shift();
      return buf;
    });
  } catch (e) { /* 무시 */ }

  return { price: finalPrice };
}

/**
 * 시뮬레이션 매매 1건 체결 — 관리자 페이지가 세션의 intervalSeconds마다
 * 반복 호출한다. 호출될 때마다 세션 상태·종료 시각·키워드 일치 종목을
 * 서버에서 새로 확인하므로, 클라이언트가 보내는 값은 sessionId뿐이다.
 */
async function actionRunStockSimTrade(db, { sessionId }) {
  if (!sessionId) throw new HttpsError("invalid-argument", "sessionId가 필요합니다.");

  const sessionRef = db.ref(`stockSimSessions/${sessionId}`);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists()) throw new HttpsError("not-found", "세션을 찾을 수 없습니다.");
  const session = sessionSnap.val();

  if (session.status !== "running") {
    return { ok: true, ended: true, reason: "already-ended" };
  }

  const now = Date.now();
  if (session.endAt && now >= session.endAt) {
    await sessionRef.update({ status: "ended", endedAt: now });
    return { ok: true, ended: true, reason: "schedule" };
  }

  const stocksSnap = await db.ref("stocks").get();
  const matched = findMatchingStocks(stocksSnap.val(), session.keyword);
  if (matched.length === 0) {
    return { ok: true, ended: false, traded: false, reason: "no-match" };
  }

  const target = matched[Math.floor(Math.random() * matched.length)];
  const type  = Math.random() < 0.5 ? "buy" : "sell";
  const qty   = MIN_QTY + Math.floor(Math.random() * (MAX_QTY - MIN_QTY + 1));

  const result = await executeSimulatedTrade(db, target.id, type, qty);
  if (result) {
    await sessionRef.update({ lastTradeAt: now, tradeCount: (session.tradeCount || 0) + 1 });
  }

  return {
    ok: true,
    ended: false,
    traded: !!result,
    stockName: target.name,
    type,
    qty,
    price: result?.price,
    reason: result ? undefined : "frozen-or-missing",
  };
}

module.exports = {
  actionCreateStockSimSession,
  actionListStockSimSessions,
  actionUpdateStockSimSession,
  actionEndStockSimSession,
  actionRunStockSimTrade,
  executeSimulatedTrade, // tradingBot.js가 시세/캔들/스파크라인 갱신 로직을 그대로 재사용
};
