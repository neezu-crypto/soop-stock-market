const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();

setGlobalOptions({
  // Pick the region closest to your users/DB if desired.
  // region: "asia-northeast3"
});

function isAdminAuth(auth) {
  return !!auth?.token?.email && auth.token.email === "skftodwocks2@gmail.com";
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

exports.trade = onCall({ cors: true }, async (req) => {
  const auth = req.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "Login required.");

  const uid = auth.uid;
  const stockId = String(req.data?.stockId || "").trim();
  const side = String(req.data?.side || "").trim(); // 'buy'|'sell'
  const qty = clampInt(req.data?.qty, 1, 100);
  if (!stockId) throw new HttpsError("invalid-argument", "stockId required.");
  if (side !== "buy" && side !== "sell") throw new HttpsError("invalid-argument", "side must be buy|sell.");
  if (!qty) throw new HttpsError("invalid-argument", "qty must be 1..100.");

  // Load configs + current state
  const db = admin.database();
  const [cfgSnap, stockSnap] = await Promise.all([
    db.ref("siteConfig").get(),
    db.ref(`stocks/${stockId}`).get()
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
    const marketOpen = isWithinHours({ open, close }, now);
    if (!marketOpen) throw new HttpsError("failed-precondition", "Market closed.");
  }

  if (!stockSnap.exists()) {
    throw new HttpsError("not-found", "Unknown stock.");
  }
  const stock = stockSnap.val();
  const currentPrice = Number(stock.price || 0);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    throw new HttpsError("failed-precondition", "Stock price unavailable.");
  }

  // Circuit breaker / freeze (admin bypass)
  const frozenMap = siteConfig.frozenStocks || {};
  const frozenUntil = Number(frozenMap?.[stockId] || 0);
  if (frozenUntil > Date.now() && !isAdminAuth(auth)) {
    throw new HttpsError("failed-precondition", "Circuit breaker active.");
  }

  // Pricing parameters (server authority)
  const sellConfig = siteConfig.sellConfig || {};
  const basePrice = Number(sellConfig.basePrice ?? 10000);
  const scalePrice = Number(sellConfig.scalePrice ?? 90000);
  const impactCoef = Number(sellConfig.impact ?? 0.0005);
  const spread = Number(sellConfig.spread ?? 0.001);
  const fee = Number(sellConfig.fee ?? 0.003);

  let sellPressure = 1;
  if (side === "sell") {
    sellPressure = 1 + (Math.max(0, currentPrice - basePrice) / scalePrice);
  }
  const impact = impactCoef * (Math.log2(1 + qty)) * sellPressure;

  // Apply impact to *current* price snapshot
  const newPrice = side === "buy"
    ? Math.max(1, Math.round(currentPrice * (1 + impact)))
    : Math.max(1, Math.round(currentPrice * (1 - impact)));
  const tradePrice = side === "buy"
    ? Math.max(1, Math.round(newPrice * (1 + spread)))
    : Math.max(1, Math.round(newPrice * (1 - spread)));

  // 1회 최대 거래 1억원 제한 (admin bypass)
  if (!isAdminAuth(auth)) {
    if (side === "buy") {
      const est = tradePrice * qty;
      if (est > 100000000) throw new HttpsError("failed-precondition", "Trade amount limit exceeded.");
    } else {
      const est = Math.round(tradePrice * qty * (1 - fee));
      if (est > 100000000) throw new HttpsError("failed-precondition", "Trade amount limit exceeded.");
    }
  }

  // Update user atomically (per-user transaction)
  const userRef = db.ref(`users/${uid}`);
  const userTx = await userRef.transaction((cur) => {
    const u = cur || { cash: 1000000, stocks: {} };
    const cash = Number(u.cash ?? 1000000);
    const stocks = (u.stocks && typeof u.stocks === "object") ? u.stocks : {};
    const us = stocks?.[stockId] || { qty: 0, avg: 0 };
    const haveQty = Number(us.qty || 0);
    const haveAvg = Number(us.avg || 0);

    if (side === "buy") {
      const total = tradePrice * qty;
      if (cash < total && !isAdminAuth(auth)) return; // abort

      // 10종목 제한 (admin bypass)
      if (!isAdminAuth(auth) && haveQty === 0) {
        const ownedCount = Object.values(stocks).filter((s) => (s?.qty || 0) > 0).length;
        if (ownedCount >= 10) return;
      }

      const totalCost = (haveQty * haveAvg) + total;
      const newQty = haveQty + qty;
      return {
        ...u,
        cash: cash - total,
        stocks: { ...stocks, [stockId]: { qty: newQty, avg: Math.round(totalCost / newQty) } },
        lastTradeTime: admin.database.ServerValue.TIMESTAMP
      };
    }

    // sell
    if (haveQty < qty && !isAdminAuth(auth)) return;
    const receive = Math.round(tradePrice * qty * (1 - fee));
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
      lastTradeTime: admin.database.ServerValue.TIMESTAMP
    };
  }, { applyLocally: false });

  if (!userTx.committed) {
    throw new HttpsError("failed-precondition", "User validation failed (cash/holdings/limits).");
  }

  // Update stock + candlestick (best-effort; will retry on contention)
  const stockRef = db.ref(`stocks/${stockId}`);
  await stockRef.transaction((cur) => {
    if (!cur) return cur;
    const prevPrice = Number(cur.price || currentPrice);
    const { history: _h, ...rest } = cur;
    const addBuy = side === "buy" ? qty : 0;
    const addSell = side === "sell" ? qty : 0;
    const nextPrice = newPrice;
    return {
      ...rest,
      price: nextPrice,
      volume: (Number(cur.volume || 0) + qty),
      buyVol: (Number(cur.buyVol || 0) + addBuy),
      sellVol: (Number(cur.sellVol || 0) + addSell),
      change: prevPrice > 0 ? (((nextPrice - prevPrice) / prevPrice) * 100).toFixed(2) : "0.00"
    };
  }, { applyLocally: false });

  // Candle aggregation per minute
  const ts = Math.floor(Date.now() / 60000) * 60; // seconds
  const candleRef = db.ref(`candlesticks/${stockId}/${ts}`);
  await candleRef.transaction((cur) => {
    if (!cur) {
      return { o: tradePrice, h: tradePrice, l: tradePrice, c: tradePrice, v: qty, t: ts };
    }
    return {
      ...cur,
      h: Math.max(Number(cur.h || tradePrice), tradePrice),
      l: Math.min(Number(cur.l || tradePrice), tradePrice),
      c: tradePrice,
      v: Number(cur.v || 0) + qty,
      t: ts
    };
  }, { applyLocally: false });

  // Audit log (optional, helpful)
  const tradeId = db.ref("tradeHistory").push().key;
  if (tradeId) {
    await db.ref(`tradeHistory/${tradeId}`).set({
      uid,
      stockId,
      side,
      qty,
      prevPrice: currentPrice,
      newPrice,
      tradePrice,
      impact,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });
  }

  return {
    ok: true,
    stockId,
    side,
    qty,
    tradePrice,
    newPrice,
    tradeId: tradeId || null
  };
});

