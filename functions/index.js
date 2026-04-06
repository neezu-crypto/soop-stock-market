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
      if (cash < total && !isAdminAuth(auth)) return undefined; // abort

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
  });

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
  });

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
  });

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

