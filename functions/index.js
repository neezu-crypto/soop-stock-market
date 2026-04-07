const fs = require("fs");
const path = require("path");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onValueWritten } = require("firebase-functions/v2/database");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();

setGlobalOptions({
  // Pick the region closest to your users/DB if desired.
  // region: "asia-northeast3"
});

const ADMIN_EMAIL = "skftodwocks2@gmail.com";

/** 메인 앱과 동일: 마지막 하트비트 후 이 시간 초과 세션은 집계에서 제외 (index.html 이전 countActivePresenceSessions 와 동일) */
const PRESENCE_TTL_MS = 6 * 60 * 1000;

function countActivePresenceSessionsFromVal(data, now = Date.now()) {
  if (!data || typeof data !== "object") return 0;
  let count = 0;
  for (const sessions of Object.values(data)) {
    if (!sessions || typeof sessions !== "object") continue;
    for (const v of Object.values(sessions)) {
      if (
        v &&
        typeof v.connectedAt === "number" &&
        now - v.connectedAt <= PRESENCE_TTL_MS
      ) {
        count++;
      }
    }
  }
  return count;
}

function isAdminAuth(auth) {
  const em = String(auth?.token?.email || "").toLowerCase();
  return em === ADMIN_EMAIL.toLowerCase();
}

function chunkObject(obj, maxKeys) {
  const keys = Object.keys(obj);
  const out = [];
  for (let i = 0; i < keys.length; i += maxKeys) {
    const part = {};
    keys.slice(i, i + maxKeys).forEach((k) => {
      part[k] = obj[k];
    });
    out.push(part);
  }
  return out;
}

function nowKstDate() {
  // KST time-based market-hours logic (Asia/Seoul)
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
}

function parseHm(str, fallback) {
  const s = typeof str === "string" ? str : fallback;
  const [h, m] = String(s).split(":").map((x) => Number(x));
  if (!Number.isFinite(h) || !Number.isFinite(m)) {
    const [fh, fm] = fallback.split(":").map((x) => Number(x));
    return { h: fh, m: fm };
  }
  return { h, m };
}

function isWithinHours({ open, close }, date) {
  const nowMins = date.getHours() * 60 + date.getMinutes();
  const o = parseHm(open, "00:00");
  const c = parseHm(close, "23:59");
  const openMins = o.h * 60 + o.m;
  const closeMins = c.h * 60 + c.m;
  if (openMins < closeMins) return nowMins >= openMins && nowMins < closeMins;
  return nowMins >= openMins || nowMins < closeMins; // overnight
}

function clampInt(n, min, max) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

/** 메인 앱 `window.trade`(주식)와 동일한 가격·임팩트 계산 — prevPrice는 트랜잭션 내 현재가 */
function computeStockTradePrices(side, prevPrice, qty, sellConfig, marketParams) {
  const basePrice = Math.max(1, Number(sellConfig.basePrice ?? 10000));
  const scalePrice = Math.max(1, Number(sellConfig.scalePrice ?? 90000));
  const impactCoef = Number(sellConfig.impact ?? 0.0005);
  const spread = Number(sellConfig.spread ?? 0.001);
  const impactRefPriceWon = Math.max(1, Number(marketParams?.impactRefPrice ?? 100000));
  const dampingFactor = Math.min(1, impactRefPriceWon / Math.max(1, prevPrice));
  const effectiveImpactCoef = impactCoef * dampingFactor;
  let sellPressure = 1;
  if (side === "sell") {
    sellPressure = 1 + (Math.max(0, prevPrice - basePrice) / scalePrice);
  }
  const impact = effectiveImpactCoef * Math.log2(1 + qty) * sellPressure;
  let rawNewPrice;
  if (side === "buy") {
    rawNewPrice = prevPrice * (1 + impact);
  } else {
    rawNewPrice = prevPrice * (1 - impact);
  }
  const newPrice = Math.max(1, Math.round(rawNewPrice));
  const tradePrice =
    side === "buy"
      ? Math.max(1, Math.round(newPrice * (1 + spread)))
      : Math.max(1, Math.round(newPrice * (1 - spread)));
  const changeStr = prevPrice > 0 ? (((rawNewPrice - prevPrice) / prevPrice) * 100).toFixed(2) : "0.00";
  return { newPrice, tradePrice, rawNewPrice, impact, changeStr };
}

exports.trade = onCall({ cors: true, timeoutSeconds: 60, memory: "512MiB" }, async (req) => {
  const auth = req.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "Login required.");

  const uid = auth.uid;
  const stockId = String(req.data?.stockId || "").trim();
  const side = String(req.data?.side || "").trim(); // 'buy'|'sell'
  const qty = clampInt(req.data?.qty, 1, 100);
  if (!stockId) throw new HttpsError("invalid-argument", "stockId required.");
  if (side !== "buy" && side !== "sell") throw new HttpsError("invalid-argument", "side must be buy|sell.");
  if (!qty) throw new HttpsError("invalid-argument", "qty must be 1..100.");

  const db = admin.database();
  const [cfgSnap, preUserSnap] = await Promise.all([db.ref("siteConfig").get(), db.ref(`users/${uid}`).get()]);

  const siteConfig = cfgSnap.exists() ? cfgSnap.val() : {};
  if (siteConfig.maintenance === true && !isAdminAuth(auth)) {
    throw new HttpsError("failed-precondition", "Maintenance mode.");
  }

  const mh = siteConfig.marketHours;
  if (mh?.enabled && !isAdminAuth(auth)) {
    const now = nowKstDate();
    const open = mh.open || "09:00";
    const close = mh.close || "04:00";
    const marketOpen = isWithinHours({ open, close }, now);
    if (!marketOpen) throw new HttpsError("failed-precondition", "Market closed.");
  }

  const frozenMap = siteConfig.frozenStocks || {};
  const frozenUntil = Number(frozenMap?.[stockId] || 0);
  if (frozenUntil > Date.now() && !isAdminAuth(auth)) {
    throw new HttpsError("failed-precondition", "Circuit breaker active.");
  }

  const sellConfig = siteConfig.sellConfig || {};
  const marketParams = siteConfig.marketParams || {};
  const fee = Number(sellConfig.fee ?? 0.003);

  const preUser = preUserSnap.exists() ? preUserSnap.val() : { cash: 1000000, stocks: {}, coins: {} };
  const preCash = Number(preUser.cash ?? 1000000);
  const preStocks = preUser.stocks && typeof preUser.stocks === "object" ? preUser.stocks : {};
  const preBook = preStocks[stockId] || { qty: 0, avg: 0 };
  const preHaveQty = Math.floor(Number(preBook.qty || 0));

  const stockRef = db.ref(`stocks/${stockId}`);
  const preStockSnap = await stockRef.get();
  let stockRollbackVal = null;
  if (preStockSnap.exists()) {
    stockRollbackVal = JSON.parse(JSON.stringify(preStockSnap.val()));
  }

  let lastImpact = 0;
  let lastTradePrice = 0;
  let lastNewPrice = 0;
  let lastPrevPrice = 0;

  const stockTx = await stockRef.transaction((cur) => {
    if (!cur || typeof cur !== "object") return undefined;
    const row = cur;
    let prevPrice = Number(row.price);
    if (!Number.isFinite(prevPrice) || prevPrice <= 0) prevPrice = 10000;

    const { newPrice, tradePrice, impact, changeStr } = computeStockTradePrices(
      side,
      prevPrice,
      qty,
      sellConfig,
      marketParams
    );
    lastImpact = impact;
    lastTradePrice = tradePrice;
    lastNewPrice = newPrice;
    lastPrevPrice = prevPrice;

    if (side === "buy") {
      const totalBuyPrice = tradePrice * qty;
      if (preCash < totalBuyPrice && !isAdminAuth(auth)) return undefined;
      if (preHaveQty === 0 && !isAdminAuth(auth)) {
        const ownedCount = Object.values(preStocks).filter((s) => Math.floor(Number(s?.qty || 0)) > 0).length;
        if (ownedCount >= 10) return undefined;
      }
    } else {
      if (preHaveQty < qty && !isAdminAuth(auth)) return undefined;
    }

    const { history: _h, ...rest } = row;
    const addBuy = side === "buy" ? qty : 0;
    const addSell = side === "sell" ? qty : 0;
    const baseVol = Number(row.volume);
    const baseBuy = Number(row.buyVol);
    const baseSell = Number(row.sellVol);
    return {
      ...rest,
      price: newPrice,
      volume: (Number.isFinite(baseVol) ? baseVol : 0) + qty,
      buyVol: (Number.isFinite(baseBuy) ? baseBuy : 0) + addBuy,
      sellVol: (Number.isFinite(baseSell) ? baseSell : 0) + addSell,
      change: changeStr
    };
  });

  if (!stockTx.committed) {
    throw new HttpsError("failed-precondition", "Stock update failed (validation or contention).");
  }

  const userRef = db.ref(`users/${uid}`);
  const userTx = await userRef.transaction((cur) => {
    const u = cur || { cash: 1000000, stocks: {}, coins: {} };
    const cash = Number(u.cash ?? 1000000);
    const stocks = u.stocks && typeof u.stocks === "object" ? u.stocks : {};
    const coins = u.coins && typeof u.coins === "object" ? u.coins : {};
    const us = stocks?.[stockId] || { qty: 0, avg: 0 };
    const haveQty = Math.floor(Number(us.qty || 0));
    const haveAvg = Math.round(Number(us.avg || 0));

    if (side === "buy") {
      const total = lastTradePrice * qty;
      if (cash < total && !isAdminAuth(auth)) return undefined;
      if (!isAdminAuth(auth) && haveQty === 0) {
        const ownedCount = Object.values(stocks).filter((s) => Math.floor(Number(s?.qty || 0)) > 0).length;
        if (ownedCount >= 10) return undefined;
      }
      const totalCost = haveQty * haveAvg + total;
      const newQty = haveQty + qty;
      return {
        ...u,
        cash: cash - total,
        stocks: { ...stocks, [stockId]: { qty: newQty, avg: Math.round(totalCost / newQty) } },
        coins,
        lastTradeTime: admin.database.ServerValue.TIMESTAMP
      };
    }

    if (haveQty < qty && !isAdminAuth(auth)) return undefined;
    const receive = Math.round(lastTradePrice * qty * (1 - fee));
    const newQty = haveQty - qty;
    const nextStocks = { ...stocks };
    if (newQty <= 0) {
      nextStocks[stockId] = null;
    } else {
      nextStocks[stockId] = { qty: newQty, avg: haveAvg };
    }
    return {
      ...u,
      cash: cash + receive,
      stocks: nextStocks,
      coins,
      lastTradeTime: admin.database.ServerValue.TIMESTAMP
    };
  });

  if (!userTx.committed) {
    if (stockRollbackVal != null) {
      try {
        await stockRef.transaction(() => stockRollbackVal);
      } catch (e) {
        console.error("[trade] stock rollback failed", e?.message || e);
      }
    }
    throw new HttpsError("failed-precondition", "User validation failed (cash/holdings/limits).");
  }

  const ts = Math.floor(Date.now() / 60000) * 60;
  const candleRef = db.ref(`candlesticks/${stockId}/${ts}`);
  await candleRef.transaction((cur) => {
    if (!cur) {
      return { o: lastTradePrice, h: lastTradePrice, l: lastTradePrice, c: lastTradePrice, v: qty, t: ts };
    }
    return {
      ...cur,
      h: Math.max(Number(cur.h || lastTradePrice), lastTradePrice),
      l: Math.min(Number(cur.l || lastTradePrice), lastTradePrice),
      c: lastTradePrice,
      v: Number(cur.v || 0) + qty,
      t: ts
    };
  });

  const tradeId = db.ref("tradeHistory").push().key;
  if (tradeId) {
    await db.ref(`tradeHistory/${tradeId}`).set({
      uid,
      stockId,
      side,
      qty,
      prevPrice: lastPrevPrice,
      newPrice: lastNewPrice,
      tradePrice: lastTradePrice,
      impact: lastImpact,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });
  }

  return {
    ok: true,
    stockId,
    side,
    qty,
    tradePrice: lastTradePrice,
    newPrice: lastNewPrice,
    tradeId: tradeId || null
  };
});

exports.liquidateAll = onCall({ cors: true, timeoutSeconds: 540, memory: "1GiB" }, async (req) => {
  const auth = req.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "Login required.");

  const uid = auth.uid;
  const stockId = String(req.data?.stockId || "").trim();
  const market = String(req.data?.market || "stock").trim().toLowerCase(); // stock | coin
  if (!stockId) throw new HttpsError("invalid-argument", "stockId required.");
  if (market !== "stock" && market !== "coin") {
    throw new HttpsError("invalid-argument", "market must be stock|coin.");
  }

  const db = admin.database();
  const stockPath = market === "coin" ? "coins" : "stocks";
  const userBookPath = market === "coin" ? "coins" : "stocks";
  const candleRoot = market === "coin" ? "coinCandles" : "candlesticks";

  const [cfgSnap, stockSnap] = await Promise.all([
    db.ref("siteConfig").get(),
    db.ref(`${stockPath}/${stockId}`).get(),
  ]);
  const siteConfig = cfgSnap.exists() ? cfgSnap.val() : {};
  if (siteConfig.maintenance === true && !isAdminAuth(auth)) {
    throw new HttpsError("failed-precondition", "Maintenance mode.");
  }
  const mh = siteConfig.marketHours;
  if (mh?.enabled && !isAdminAuth(auth)) {
    const now = nowKstDate();
    const open = mh.open || "09:00";
    const close = mh.close || "04:00";
    if (!isWithinHours({ open, close }, now)) {
      throw new HttpsError("failed-precondition", "Market closed.");
    }
  }
  if (!stockSnap.exists()) throw new HttpsError("not-found", "Unknown symbol.");

  const bookSnap = await db.ref(`users/${uid}/${userBookPath}/${stockId}`).get();
  const qty = Math.floor(Number(bookSnap.val()?.qty || 0));
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new HttpsError("failed-precondition", "No holdings.");
  }

  const sellConfig = siteConfig.sellConfig || {};
  const marketParams = siteConfig.marketParams || {};
  const basePrice = Number(sellConfig.basePrice ?? 10000);
  const scalePrice = Number(sellConfig.scalePrice ?? 90000);
  const impactCoef = Number(sellConfig.impact ?? 0.0005);
  const spread = Number(sellConfig.spread ?? 0.001);
  const fee = Number(sellConfig.fee ?? 0.003);
  const impactRefPriceWon = Math.max(1, Number(marketParams.impactRefPrice ?? 100000));
  const coinMul = Number(marketParams.coinImpactMultiplier ?? 1.85);
  const extraLiquidationFee = 0.08;

  let tradePrice = 0;
  let nextPrice = 0;
  const stockRef = db.ref(`${stockPath}/${stockId}`);
  const stockTx = await stockRef.transaction((cur) => {
    if (!cur) return cur;
    const prevPrice = Math.max(1, Number(cur.price || 1));
    let sellPressure = 1;
    if (market !== "coin") {
      sellPressure = 1 + (Math.max(0, prevPrice - basePrice) / scalePrice);
    }
    const dampingFactor = market === "coin" ? 1 : Math.min(1, impactRefPriceWon / Math.max(1, prevPrice));
    let impact = impactCoef * dampingFactor * Math.log2(1 + qty) * sellPressure;
    if (market === "coin") impact *= Number.isFinite(coinMul) && coinMul > 0 ? coinMul : 1.85;
    nextPrice = Math.max(1, Math.round(prevPrice * (1 - impact)));
    tradePrice = Math.max(1, Math.round(nextPrice * (1 - spread)));
    return {
      ...cur,
      price: nextPrice,
      volume: Number(cur.volume || 0) + qty,
      buyVol: Number(cur.buyVol || 0),
      sellVol: Number(cur.sellVol || 0) + qty,
      change: prevPrice > 0 ? (((nextPrice - prevPrice) / prevPrice) * 100).toFixed(market === "coin" ? 4 : 2) : "0.00",
    };
  });
  if (!stockTx.committed || !tradePrice) {
    throw new HttpsError("aborted", "Price update contention.");
  }

  const receive = Math.round(tradePrice * qty * (1 - fee - extraLiquidationFee));
  const userRef = db.ref(`users/${uid}`);
  const userTx = await userRef.transaction((cur) => {
    const u = cur || { cash: 1000000, stocks: {}, coins: {} };
    const cash = Number(u.cash ?? 1000000);
    const stocks = u.stocks && typeof u.stocks === "object" ? u.stocks : {};
    const coins = u.coins && typeof u.coins === "object" ? u.coins : {};
    const book = market === "coin" ? coins : stocks;
    const pos = book?.[stockId] || { qty: 0, avg: 0 };
    const haveQty = Math.floor(Number(pos.qty || 0));
    if (haveQty < qty && !isAdminAuth(auth)) return;
    const newQty = haveQty - qty;
    const nextBook = { ...book };
    if (newQty <= 0) nextBook[stockId] = null;
    else nextBook[stockId] = { qty: newQty, avg: Number(pos.avg || 0) };
    return {
      ...u,
      cash: cash + receive,
      stocks: market === "coin" ? stocks : nextBook,
      coins: market === "coin" ? nextBook : coins,
      lastTradeTime: admin.database.ServerValue.TIMESTAMP,
    };
  });
  if (!userTx.committed) throw new HttpsError("aborted", "Holdings changed during liquidation.");

  const ts = Math.floor(Date.now() / 60000) * 60;
  await db.ref(`${candleRoot}/${stockId}/${ts}`).transaction((cur) => {
    if (!cur) return { o: tradePrice, h: tradePrice, l: tradePrice, c: tradePrice, v: qty, t: ts };
    return {
      ...cur,
      h: Math.max(Number(cur.h || tradePrice), tradePrice),
      l: Math.min(Number(cur.l || tradePrice), tradePrice),
      c: tradePrice,
      v: Number(cur.v || 0) + qty,
      t: ts,
    };
  });

  return {
    ok: true,
    stockId,
    market,
    soldQty: qty,
    totalReceived: receive,
    chunks: 1,
  };
});

/**
 * 액면분할: Admin SDK로 stocks + 전 users 스캔·갱신 (클라이언트 users/ 대량 읽기 실패 시 대안)
 * kind: "threshold" | "top100"
 */
exports.adminStockSplit = onCall(
  { cors: true, timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    if (!isAdminAuth(request.auth)) {
      throw new HttpsError("permission-denied", "Admin only.");
    }

    const kind = String(request.data?.kind || "threshold").toLowerCase();
    const ratioN = Math.floor(Number(request.data?.ratioN));
    if (!Number.isFinite(ratioN) || ratioN < 2) {
      throw new HttpsError("invalid-argument", "ratioN must be an integer >= 2.");
    }

    const thresholdWon =
      kind === "threshold" ? Math.floor(Number(request.data?.thresholdWon)) : NaN;
    if (kind === "threshold" && (!Number.isFinite(thresholdWon) || thresholdWon < 1)) {
      throw new HttpsError(
        "invalid-argument",
        "thresholdWon is required for kind=threshold."
      );
    }

    const db = admin.database();
    const splitTs = Date.now();

    await db.ref("siteConfig/maintenance").set(true);

    try {
      const stocksSnap = await db.ref("stocks").once("value");
      const stocksData = stocksSnap.val() || {};

      let splittable = [];
      if (kind === "top100") {
        const top100Ids = new Set(
          Object.entries(stocksData)
            .sort(([, a], [, b]) => (Number(b?.price) || 0) - (Number(a?.price) || 0))
            .slice(0, 100)
            .map(([id]) => id)
        );
        splittable = [...top100Ids];
      } else {
        Object.entries(stocksData).forEach(([id, s]) => {
          const price = Number(s?.price) || 0;
          if (price >= thresholdWon && price >= ratioN) splittable.push(id);
        });
      }

      if (splittable.length === 0) {
        await db.ref("siteConfig/maintenance").set(false);
        return {
          ok: true,
          skipped: true,
          reason: "no_splittable",
          kind,
          stocksUpdated: 0,
          userHoldingPathsUpdated: 0,
          events: [],
        };
      }

      const targetSet = new Set(splittable);
      const events = [];

      splittable.forEach((id) => {
        const s = stocksData[id];
        const oldPrice = Number(s?.price) || 0;
        const newPrice = Math.max(1, Math.floor(oldPrice / ratioN));
        events.push({
          stockId: id,
          stockName: (s && s.name) || id,
          thresholdWon: kind === "threshold" ? thresholdWon : 0,
          ratioN,
          oldPrice,
          newPrice,
        });
      });

      const PAR = 20;
      for (let i = 0; i < splittable.length; i += PAR) {
        const slice = splittable.slice(i, i + PAR);
        await Promise.all(
          slice.map((id) => {
            const s = stocksData[id];
            const oldPrice = Number(s?.price) || 0;
            const newPrice = Math.max(1, Math.floor(oldPrice / ratioN));
            const history = (s?.history || [s?.price]).map((p) =>
              Math.max(1, Math.floor((Number(p) || 0) / ratioN))
            );
            return db.ref(`stocks/${id}`).update({
              price: newPrice,
              history,
              change: s?.change != null ? s.change : 0,
              lastSplitTimestamp: splitTs,
            });
          })
        );
      }

      const usersSnap = await db.ref("users").once("value");
      const usersData = usersSnap.val() || {};

      const holdingUpdates = {};
      Object.entries(usersData).forEach(([uid, user]) => {
        if (!user?.stocks || typeof user.stocks !== "object") return;
        Object.entries(user.stocks).forEach(([stockId, info]) => {
          if (!targetSet.has(stockId) || !info) return;
          const q = Math.floor(Number(info.qty) || 0);
          if (q <= 0) return;
          const newQty = Math.floor(q * ratioN);
          const newAvg = Math.max(1, Math.floor((Number(info.avg) || 0) / ratioN));
          holdingUpdates[`users/${uid}/stocks/${stockId}`] = { qty: newQty, avg: newAvg };
        });
      });

      const chunks = chunkObject(holdingUpdates, 400);
      for (const chunk of chunks) {
        await db.ref().update(chunk);
      }

      try {
        await db.ref(`adminActivityLogs/dailyAutoSplit/${Date.now()}`).set({
          type: "dailyAutoSplit",
          adminEmail: ADMIN_EMAIL,
          kind,
          thresholdWon: kind === "threshold" ? thresholdWon : null,
          ratioN,
          events,
          userHoldingPathsUpdated: Object.keys(holdingUpdates).length,
          createdAt: splitTs,
          via: "adminStockSplit",
        });
      } catch (logErr) {
        console.warn("[adminStockSplit] adminActivityLogs:", logErr?.message || logErr);
      }

      await db.ref("siteConfig/maintenance").set(false);

      return {
        ok: true,
        skipped: false,
        kind,
        stocksUpdated: splittable.length,
        userHoldingPathsUpdated: Object.keys(holdingUpdates).length,
        events,
      };
    } catch (e) {
      await db.ref("siteConfig/maintenance").set(false).catch(() => {});
      console.error("[adminStockSplit]", e);
      throw new HttpsError("internal", e?.message || String(e));
    }
  }
);

/**
 * presence/{uid}/{sessionId} 변경 시 전체 presence를 읽어 TTL 기준 활성 세션 수를 집계하고
 * siteStats/connectionCount 에 스칼라로 기록 — 클라이언트는 이 노드만 구독해 다운로드 절감.
 */
exports.updateConnectionCount = onValueWritten(
  "/presence/{uid}/{sessionId}",
  async () => {
    const db = admin.database();
    try {
      const snap = await db.ref("presence").get();
      const data = snap.exists() ? snap.val() : {};
      const count = countActivePresenceSessionsFromVal(data);
      await db.ref("siteStats/connectionCount").set(count);
    } catch (e) {
      console.error("[updateConnectionCount]", e?.message || e);
    }
  }
);

// ── RTDB 보안규칙: 장 운영 시간에 따라 open(기존 규칙) / closed(쓰기 전부 관리자만) 전환 ──
const RULES_OPEN_PATH = path.join(__dirname, "rules/open.json");

let cachedOpenRulesStr = null;
let cachedClosedRulesStr = null;

function loadOpenRulesString() {
  if (!cachedOpenRulesStr) {
    cachedOpenRulesStr = fs.readFileSync(RULES_OPEN_PATH, "utf8");
  }
  return cachedOpenRulesStr;
}

/**
 * open 규칙을 복제한 뒤, `.write`가 false가 아닌 곳은 전부 관리자만 쓰기로 바꿉니다.
 * - siteStats/connectionCount 등 `.write: false`는 유지
 * - presence/{uid}/{sessionId} 본인 하트비트는 유지 (연결 수·UI용)
 */
function buildClosedRulesObjectFromOpen(openRulesParsed) {
  const adminWrite =
    "auth != null && auth.token.email != null && auth.token.email.matches(/^skftodwocks2@gmail\\.com$/i)";
  const clone = JSON.parse(JSON.stringify(openRulesParsed));

  function walk(n, pathParts) {
    if (!n || typeof n !== "object") return;
    for (const k of Object.keys(n)) {
      if (k === ".write") {
        if (n[k] === false) continue;
        if (
          pathParts[0] === "presence" &&
          pathParts.length === 3 &&
          pathParts[1] === "$uid" &&
          pathParts[2] === "$sessionId"
        ) {
          continue;
        }
        n[k] = adminWrite;
      } else if (
        typeof n[k] === "object" &&
        n[k] !== null &&
        !Array.isArray(n[k])
      ) {
        walk(n[k], pathParts.concat(k));
      }
    }
  }

  walk(clone.rules, []);
  return clone;
}

function getClosedRulesString() {
  if (!cachedClosedRulesStr) {
    const open = JSON.parse(loadOpenRulesString());
    cachedClosedRulesStr = JSON.stringify(buildClosedRulesObjectFromOpen(open));
  }
  return cachedClosedRulesStr;
}

/** siteConfig.marketHours 기준: 비활성화면 항상 open, 활성화면 KST open~close 안이면 open */
function computeMarketRulesModeFromMarketHours(mh) {
  if (!mh || !mh.enabled) return "open";
  const now = nowKstDate();
  const open = mh.open || "09:00";
  const close = mh.close || "04:00";
  return isWithinHours({ open, close }, now) ? "open" : "closed";
}

async function syncDatabaseRulesFromMarketHours() {
  const db = admin.database();
  const mhSnap = await db.ref("siteConfig/marketHours").get();
  const mh = mhSnap.exists() ? mhSnap.val() : null;
  const mode = computeMarketRulesModeFromMarketHours(mh);

  const stateRef = db.ref("siteConfig/_functions/lastMarketRulesMode");
  const stSnap = await stateRef.get();
  const prev = stSnap.exists() ? String(stSnap.val()) : null;
  if (prev === mode) {
    return { skipped: true, mode };
  }

  const rulesStr =
    mode === "closed" ? getClosedRulesString() : loadOpenRulesString().trim();

  await admin.database().setRules(rulesStr);
  await stateRef.set(mode);
  console.log(`[syncDatabaseRulesFromMarketHours] applied mode=${mode}`);
  return { skipped: false, mode };
}

/** 매분: 장 마감/오픈 전환 시 규칙 적용 (동일 모드면 setRules 생략) */
exports.syncDatabaseRulesForMarketHours = onSchedule(
  {
    schedule: "every 1 minutes",
    region: "asia-northeast3",
    timeoutSeconds: 120,
  },
  async () => {
    try {
      await syncDatabaseRulesFromMarketHours();
    } catch (e) {
      console.error("[syncDatabaseRulesForMarketHours]", e?.message || e);
    }
  }
);

/** 관리자가 marketHours를 바꾸면 즉시 재평가 */
exports.onMarketHoursWriteSyncDatabaseRules = onValueWritten(
  "/siteConfig/marketHours",
  async () => {
    try {
      await syncDatabaseRulesFromMarketHours();
    } catch (e) {
      console.error("[onMarketHoursWriteSyncDatabaseRules]", e?.message || e);
    }
  }
);

