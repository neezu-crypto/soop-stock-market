const fs = require("fs");
const path = require("path");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onValueWritten } = require("firebase-functions/v2/database");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp({
  databaseURL: "https://soop-stock-market-default-rtdb.firebaseio.com",
});

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

/** index.html `isMarketOpen` / `isRegularMarket` 과 동일 (KST) */
function isMarketOpenServer(mh, dateKst) {
  if (!mh || !mh.enabled) return true;
  const open = mh.open || "00:00";
  const close = mh.close || "23:59";
  return isWithinHours({ open, close }, dateKst);
}

function isRegularMarketServer(mh, dateKst) {
  if (!mh || !mh.enabled) return true;
  if (!mh.regularOpen || !mh.regularClose) return true;
  const [roh, rom] = String(mh.regularOpen)
    .split(":")
    .map((x) => Number(x));
  const [rch, rcm] = String(mh.regularClose)
    .split(":")
    .map((x) => Number(x));
  if (!Number.isFinite(roh) || !Number.isFinite(rom) || !Number.isFinite(rch) || !Number.isFinite(rcm)) {
    return true;
  }
  const rOpenMins = roh * 60 + rom;
  const rCloseMins = rch * 60 + rcm;
  const nowMins = dateKst.getHours() * 60 + dateKst.getMinutes();
  if (rOpenMins < rCloseMins) return nowMins >= rOpenMins && nowMins < rCloseMins;
  return nowMins >= rOpenMins || nowMins < rCloseMins;
}

/** 정규장 1초 / 비정규장(장 운영 중) 30초 — 메인 앱 getTradeCooldownMs 와 동일 */
function getTradeCooldownMsFromConfig(mh, dateKst) {
  if (!mh || !mh.enabled) return 1000;
  if (!isMarketOpenServer(mh, dateKst)) return 0;
  if (isRegularMarketServer(mh, dateKst)) return 1000;
  return 30000;
}

/** soop-stocks-ranking-live.html sortByPriceDesc 와 동일 필터·정렬 + 동가 시 id 안정 정렬 */
const MARKET_RANK_SORT_VERSION = 1;

function buildPriceRankByIdFromMarketSnapshot(val) {
  if (!val || typeof val !== "object") return {};
  const rows = Object.entries(val).map(([id, raw]) => {
    if (!raw || typeof raw !== "object") return { id, price: NaN, name: "" };
    return { id, ...raw };
  });
  const filtered = rows.filter((s) => {
    const p = Number(s.price);
    const label = String(s.name || "").trim() || s.id;
    return Boolean(label) && Number.isFinite(p) && p > 0;
  });
  filtered.sort((a, b) => {
    const ap = Number(a.price) || 0;
    const bp = Number(b.price) || 0;
    if (bp !== ap) return bp - ap;
    return String(a.id).localeCompare(String(b.id));
  });
  const rankById = {};
  filtered.forEach((s, i) => {
    rankById[s.id] = i + 1;
  });
  return rankById;
}

/** 거래량 내림차순 상위 5종목 — 동량 시 id 문자열 순 */
function buildVolumeTop5FromMarketSnapshot(val) {
  if (!val || typeof val !== "object") return [];
  const rows = Object.entries(val).map(([id, raw]) => {
    if (!raw || typeof raw !== "object") return { id, volume: 0, name: "" };
    return { id, ...raw };
  });
  const filtered = rows.filter((s) => {
    const vol = Number(s.volume);
    const label = String(s.name || "").trim() || s.id;
    return Boolean(label) && Number.isFinite(vol) && vol > 0;
  });
  filtered.sort((a, b) => {
    const av = Number(a.volume) || 0;
    const bv = Number(b.volume) || 0;
    if (bv !== av) return bv - av;
    return String(a.id).localeCompare(String(b.id));
  });
  return filtered.slice(0, 5).map((s) =>
    stripUndefinedShallow({
      id: s.id,
      name: String(s.name || "").trim() || s.id,
      volume: Math.floor(Number(s.volume)) || 0,
    })
  );
}

/**
 * 클라이언트 조작 불가 — users/{uid}/lastTradeTime(서버 기록) 기준.
 * Admin 은 쿨다운 면제.
 */
function assertServerTradeCooldownAllowed(auth, siteConfig, preUser) {
  if (isAdminAuth(auth)) return;
  const mh = siteConfig.marketHours || {};
  const now = Date.now();
  const dateKst = nowKstDate();
  const cooldownMs = getTradeCooldownMsFromConfig(mh, dateKst);
  if (cooldownMs <= 0) return;
  const lt = Number(preUser && preUser.lastTradeTime);
  if (!Number.isFinite(lt) || lt <= 0) return;
  const elapsed = now - lt;
  if (elapsed < cooldownMs) {
    const rem = Math.max(1, Math.ceil((cooldownMs - elapsed) / 1000));
    throw new HttpsError("failed-precondition", `거래 쿨다운: ${rem}초 후 다시 시도하세요.`);
  }
}

/**
 * 관리자 제재(거래 제한) 강제 적용.
 * users/{uid}/moderation/tradeBlockedUntil(ms) 또는 레거시 users/{uid}/tradeBlockedUntil(ms) 지원.
 */
function assertUserTradeRestrictionAllowed(auth, preUser) {
  if (isAdminAuth(auth)) return;
  const now = Date.now();
  const moderationUntil = Number(preUser?.moderation?.tradeBlockedUntil || 0);
  const legacyUntil = Number(preUser?.tradeBlockedUntil || 0);
  const blockedUntil = Math.max(moderationUntil, legacyUntil);
  if (!Number.isFinite(blockedUntil) || blockedUntil <= now) return;
  const reason = String(preUser?.moderation?.tradeBlockedReason || preUser?.tradeBlockedReason || "").trim();
  const rem = Math.max(1, Math.ceil((blockedUntil - now) / 1000));
  const msg = reason
    ? `거래 제한 상태입니다. (${rem}초 후 해제, 사유: ${reason})`
    : `거래 제한 상태입니다. (${rem}초 후 해제)`;
  throw new HttpsError("failed-precondition", msg);
}

function clampInt(n, min, max) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

function finiteOr(n, fallback) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

/** RTDB는 value에 undefined가 있으면 트랜잭션 커밋이 실패할 수 있어 1단계에서 제거 */
function stripUndefinedShallow(obj) {
  const out = {};
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  Object.keys(obj).forEach((k) => {
    const v = obj[k];
    if (v !== undefined) out[k] = v;
  });
  return out;
}

/** 트랜잭션 콜백의 cur — 레거시로 숫자만 저장된 종목 노드도 처리 (숫자는 typeof object 아님 → 예전 코드는 항상 abort) */
function normalizeStockRow(cur) {
  if (cur == null) return null;
  if (typeof cur === "number") {
    const p = cur;
    if (Number.isFinite(p) && p > 0) return { price: p, volume: 0, buyVol: 0, sellVol: 0 };
    return null;
  }
  if (typeof cur === "string") {
    const p = Number(String(cur).trim());
    if (Number.isFinite(p) && p > 0) return { price: p, volume: 0, buyVol: 0, sellVol: 0 };
    return null;
  }
  if (typeof cur !== "object" || Array.isArray(cur)) return null;
  // 일부 export/도구 형식: { ".value": { ... } }
  if (Object.prototype.hasOwnProperty.call(cur, ".value")) {
    return normalizeStockRow(cur[".value"]);
  }
  return cur;
}

function jsonSanitizeForRtdb(obj) {
  try {
    return JSON.parse(
      JSON.stringify(obj, (_k, v) => {
        if (v === undefined) return undefined;
        if (typeof v === "number" && !Number.isFinite(v)) return null;
        return v;
      })
    );
  } catch (e) {
    return stripUndefinedShallow(obj);
  }
}

/** 메인 앱 `window.trade`와 동일한 가격·임팩트 계산 — prevPrice는 트랜잭션 내 현재가 */
function computeTradePrices(side, prevPrice, qty, sellConfig, marketParams, isCoin) {
  const basePrice = Math.max(1, finiteOr(sellConfig.basePrice, 10000));
  const scalePrice = Math.max(1, finiteOr(sellConfig.scalePrice, 90000));
  const impactCoef = finiteOr(sellConfig.impact, 0.0005);
  const stockSpread = finiteOr(sellConfig.spread, 0.001);
  const coinSpread = finiteOr(sellConfig.coinSpread, stockSpread);
  const spread = isCoin ? coinSpread : stockSpread;
  const impactRefPriceWon = Math.max(1, finiteOr(marketParams?.impactRefPrice, 100000));
  const stockSellImpactMultiplier = Math.max(1, finiteOr(marketParams?.stockSellImpactMultiplier, 1.2));
  const coinSellImpactMultiplier = Math.max(1, finiteOr(marketParams?.coinSellImpactMultiplier, 1.2));
  const dampingFactor = isCoin ? 1 : Math.min(1, impactRefPriceWon / Math.max(1, prevPrice));
  const effectiveImpactCoef = impactCoef * dampingFactor;
  let sellPressure = 1;
  if (side === "sell" && !isCoin) {
    sellPressure = 1 + (Math.max(0, prevPrice - basePrice) / scalePrice);
  }
  let impact = effectiveImpactCoef * Math.log2(1 + qty) * sellPressure;
  if (isCoin) {
    const coinMul = finiteOr(marketParams?.coinImpactMultiplier, 1.85);
    impact *= coinMul > 0 ? coinMul : 1.85;
  }
  if (side === "sell") {
    impact *= isCoin ? coinSellImpactMultiplier : stockSellImpactMultiplier;
  }
  if (!Number.isFinite(impact) || impact < 0) impact = 0;
  let rawNewPrice;
  if (side === "buy") {
    rawNewPrice = prevPrice * (1 + impact);
  } else {
    rawNewPrice = prevPrice * (1 - impact);
  }
  if (!Number.isFinite(rawNewPrice) || rawNewPrice <= 0) rawNewPrice = prevPrice;
  const newPrice = Math.max(1, Math.round(rawNewPrice));
  const tradePrice =
    side === "buy"
      ? Math.max(1, Math.round(newPrice * (1 + spread)))
      : Math.max(1, Math.round(newPrice * (1 - spread)));
  const changeStr =
    prevPrice > 0
      ? (((rawNewPrice - prevPrice) / prevPrice) * 100).toFixed(isCoin ? 4 : 2)
      : isCoin
        ? "0.0000"
        : "0.00";
  return { newPrice, tradePrice, rawNewPrice, impact, changeStr };
}

/** 메인 앱 checkCircuitBreaker 와 동일: 최근 10분 고저 대비 변동 ≥30% → siteConfig/frozenStocks (전 유저 동일 적용) */
const CB_VARIATION_PCT = 30;
const CB_FREEZE_MS = 180000;
const CB_COOLDOWN_MS = 600000;
const CB_RECENT_BUCKET_COUNT = 15;
const CB_WINDOW_SEC = 600;

async function maybeApplyStockVolatilityCircuitBreaker(db, stockId, auth) {
  if (isAdminAuth(auth)) return;
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  try {
    const [frozenSnap, coolSnap] = await Promise.all([
      db.ref(`siteConfig/frozenStocks/${stockId}`).get(),
      db.ref(`siteConfig/circuitBreakerLastTrigger/${stockId}`).get(),
    ]);
    if (frozenSnap.exists()) {
      const fu = Number(frozenSnap.val());
      if (Number.isFinite(fu) && fu > now) return;
    }
    if (coolSnap.exists()) {
      const lt = Number(coolSnap.val());
      if (Number.isFinite(lt) && now - lt < CB_COOLDOWN_MS) return;
    }

    const startSec = Math.floor(now / 60000) * 60;
    const keys = [];
    for (let i = 0; i < CB_RECENT_BUCKET_COUNT; i++) keys.push(startSec - i * 60);

    const snaps = await Promise.all(keys.map((ts) => db.ref(`candlesticks/${stockId}/${ts}`).get()));
    const candles = snaps
      .filter((s) => s.exists())
      .map((s) => {
        const c = s.val();
        return { h: Number(c.h), l: Number(c.l), t: Number(c.t) };
      })
      .sort((a, b) => a.t - b.t);

    const tenMinsAgo = nowSec - CB_WINDOW_SEC;
    const recent = candles.filter((c) => c.t >= tenMinsAgo);
    if (recent.length < 2) return;

    const high = Math.max(...recent.map((c) => c.h));
    const low = Math.min(...recent.map((c) => c.l));
    if (!(low > 0) || !Number.isFinite(high)) return;
    const variation = ((high - low) / low) * 100;
    if (variation < CB_VARIATION_PCT) return;

    const frozenUntilMs = now + CB_FREEZE_MS;
    await db.ref(`siteConfig/frozenStocks/${stockId}`).set(frozenUntilMs);
    await db.ref(`siteConfig/circuitBreakerLastTrigger/${stockId}`).set(now);
    console.warn("[trade] stock volatility circuit breaker", stockId, variation.toFixed(2));
  } catch (e) {
    console.error("[trade] maybeApplyStockVolatilityCircuitBreaker", stockId, e?.message || e);
  }
}

exports.trade = onCall({ cors: true, timeoutSeconds: 60, memory: "512MiB" }, async (req) => {
  const auth = req.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "Login required.");

  const uid = auth.uid;
  const stockId = String(req.data?.stockId || "").trim();
  const side = String(req.data?.side || "")
    .trim()
    .toLowerCase(); // 클라이언트·프록시에서 대소문자 섞여도 허용
  const qty = clampInt(req.data?.qty, 1, 100);
  const market = String(req.data?.market || "stock").trim().toLowerCase();
  const isCoin = market === "coin";

  if (!stockId) throw new HttpsError("invalid-argument", "stockId required.");
  if (side !== "buy" && side !== "sell") throw new HttpsError("invalid-argument", "side must be buy|sell.");
  if (!qty) throw new HttpsError("invalid-argument", "qty must be 1..100.");
  if (market !== "stock" && market !== "coin") {
    throw new HttpsError("invalid-argument", "market must be stock|coin.");
  }

  const STOCK_MAX_ORDER_WON = 100000000;
  const COIN_MAX_ORDER_WON = 100000000000;
  const maxOrderWon = isCoin ? COIN_MAX_ORDER_WON : STOCK_MAX_ORDER_WON;

  const db = admin.database();
  const [cfgSnap, preUserSnap] = await Promise.all([db.ref("siteConfig").get(), db.ref(`users/${uid}`).get()]);

  const siteConfig = cfgSnap.exists() ? cfgSnap.val() : {};
  if (siteConfig.maintenance === true && !isAdminAuth(auth)) {
    throw new HttpsError("failed-precondition", "Maintenance mode.");
  }

  const mh = siteConfig.marketHours;
  if (mh?.enabled && !isAdminAuth(auth)) {
    const nowKst = nowKstDate();
    const open = mh.open || "09:00";
    const close = mh.close || "04:00";
    const marketOpen = isWithinHours({ open, close }, nowKst);
    if (!marketOpen) throw new HttpsError("failed-precondition", "Market closed.");
  }

  if (!isCoin) {
    const frozenMap = siteConfig.frozenStocks || {};
    const frozenUntil = Number(frozenMap?.[stockId] || 0);
    if (frozenUntil > Date.now() && !isAdminAuth(auth)) {
      throw new HttpsError("failed-precondition", "Circuit breaker active.");
    }
  }

  const sellConfig = siteConfig.sellConfig || {};
  const marketParams = siteConfig.marketParams || {};
  const fee = Number(sellConfig.fee ?? 0.003);

  const preUser = preUserSnap.exists() ? preUserSnap.val() : { cash: 1000000, stocks: {}, coins: {} };
  assertUserTradeRestrictionAllowed(auth, preUser);
  assertServerTradeCooldownAllowed(auth, siteConfig, preUser);
  /** RTDB 트랜잭션 콜백에서 cur가 null로만 오는 경우 대비 */
  const userSeedForTx = JSON.parse(JSON.stringify(preUser));
  const preCash = Number(preUser.cash ?? 1000000);
  const preStocksMap = preUser.stocks && typeof preUser.stocks === "object" ? preUser.stocks : {};
  const preCoinsMap = preUser.coins && typeof preUser.coins === "object" ? preUser.coins : {};
  const preBookPos = isCoin ? preCoinsMap[stockId] || { qty: 0, avg: 0 } : preStocksMap[stockId] || { qty: 0, avg: 0 };
  const preHaveQty = Math.floor(Number(preBookPos.qty || 0));

  const stockPath = isCoin ? "coins" : "stocks";
  const candleRoot = isCoin ? "coinCandles" : "candlesticks";
  const instrumentRef = db.ref(`${stockPath}/${stockId}`);

  const preStockSnap = await instrumentRef.get();
  if (!preStockSnap.exists()) {
    throw new HttpsError("not-found", "종목을 찾을 수 없습니다.");
  }
  const rawPreVal = preStockSnap.val();
  const stockRollbackVal = JSON.parse(JSON.stringify(rawPreVal));
  const preRowForHint = normalizeStockRow(rawPreVal);
  if (!preRowForHint) {
    throw new HttpsError("failed-precondition", "종목 데이터 형식이 올바르지 않습니다.");
  }

  const prevPriceHint = Math.max(1, Number(preRowForHint.price || 0));
  const { tradePrice: estTradePrice } = computeTradePrices(
    side,
    prevPriceHint,
    qty,
    sellConfig,
    marketParams,
    isCoin
  );

  if (!isAdminAuth(auth)) {
    if (side === "buy") {
      const bookForLimit = isCoin ? preCoinsMap : preStocksMap;
      if (preHaveQty === 0) {
        const ownedCount = Object.values(bookForLimit).filter((s) => Math.floor(Number(s?.qty || 0)) > 0).length;
        if (ownedCount >= 10) {
          throw new HttpsError("failed-precondition", "종목한도");
        }
      }
      const estTotal = estTradePrice * qty;
      if (estTotal > maxOrderWon) {
        throw new HttpsError(
          "failed-precondition",
          isCoin ? "1회 최대 거래 금액(1000억원)을 초과합니다." : "1회 최대 거래 금액(1억원)을 초과합니다."
        );
      }
      if (preCash < estTotal) {
        throw new HttpsError("failed-precondition", "잔액이 부족합니다.");
      }
    } else {
      const estReceive = Math.round(estTradePrice * qty * (1 - fee));
      if (estReceive > maxOrderWon) {
        throw new HttpsError(
          "failed-precondition",
          isCoin ? "1회 최대 거래 금액(1000억원)을 초과합니다." : "1회 최대 거래 금액(1억원)을 초과합니다."
        );
      }
      if (preHaveQty < qty) {
        throw new HttpsError("failed-precondition", "보유 수량이 부족합니다.");
      }
    }
  }

  let lastImpact = 0;
  let lastTradePrice = 0;
  let lastNewPrice = 0;
  let lastPrevPrice = 0;

  let stockTx = { committed: false };
  for (let attempt = 0; attempt < 15; attempt++) {
    stockTx = await instrumentRef.transaction((cur) => {
      try {
        let effectiveCur = cur;
        if (effectiveCur == null && rawPreVal != null) {
          if (attempt === 0) {
            console.warn(
              "[trade] instrumentTx cur was null; seeding from pre-read snapshot",
              stockId,
              instrumentRef.toString()
            );
          }
          effectiveCur = rawPreVal;
        }

        const row = normalizeStockRow(effectiveCur);
        if (!row) {
          console.error("[trade] normalizeStockRow abort", stockId, {
            attempt,
            curType: cur === null ? "null" : typeof cur,
            curSample:
              cur != null && typeof cur === "object"
                ? Object.keys(cur).slice(0, 12)
                : String(cur).slice(0, 80),
          });
          return undefined;
        }

        let prevPrice = Number(row.price);
        if (!Number.isFinite(prevPrice) || prevPrice <= 0) prevPrice = isCoin ? 100000000 : 10000;

        const { newPrice, tradePrice, impact, changeStr } = computeTradePrices(
          side,
          prevPrice,
          qty,
          sellConfig,
          marketParams,
          isCoin
        );
        lastImpact = impact;
        lastTradePrice = tradePrice;
        lastNewPrice = newPrice;
        lastPrevPrice = prevPrice;

        const { history: _h, ...rest } = row;
        const addBuy = side === "buy" ? qty : 0;
        const addSell = side === "sell" ? qty : 0;
        const baseVol = Number(row.volume);
        const baseBuy = Number(row.buyVol);
        const baseSell = Number(row.sellVol);
        const merged = {
          ...rest,
          price: newPrice,
          volume: (Number.isFinite(baseVol) ? baseVol : 0) + qty,
          buyVol: (Number.isFinite(baseBuy) ? baseBuy : 0) + addBuy,
          sellVol: (Number.isFinite(baseSell) ? baseSell : 0) + addSell,
          change: changeStr
        };
        const out = jsonSanitizeForRtdb(stripUndefinedShallow(merged));
        if (!out || typeof out !== "object" || !Number.isFinite(Number(out.price))) {
          console.error("[trade] instrument write sanitize failed", stockId, { attempt, isCoin });
          return undefined;
        }
        return out;
      } catch (e) {
        console.error("[trade] instrumentTx callback error", stockId, e?.message || e);
        return undefined;
      }
    });
    if (stockTx.committed) break;
    await new Promise((r) => setTimeout(r, 35 * (attempt + 1)));
  }

  if (!stockTx.committed) {
    try {
      const snap = stockTx.snapshot;
      console.error("[trade] instrumentTx exhausted retries", stockId, {
        snapExists: snap?.exists?.(),
        valType: snap?.exists?.() ? typeof snap.val() : "n/a",
        isCoin,
      });
    } catch (logErr) {
      console.error("[trade] instrumentTx log failed", logErr?.message || logErr);
    }
    throw new HttpsError(
      "failed-precondition",
      isCoin
        ? "코인 시세 갱신에 실패했습니다. 잠시 후 다시 시도해 주세요."
        : "종목 시세 갱신에 실패했습니다. RTDB의 stocks/{종목ID} 노드가 객체 형태인지 확인하거나 잠시 후 다시 시도해 주세요."
    );
  }

  const userRef = db.ref(`users/${uid}`);
  let userTxSeeded = false;
  const userTx = await userRef.transaction((cur) => {
    let effectiveCur = cur;
    if (effectiveCur == null && preUserSnap.exists()) {
      effectiveCur = userSeedForTx;
      if (!userTxSeeded) {
        userTxSeeded = true;
        console.warn(
          "[trade] userTx cur was null; seeding from pre-read snapshot",
          uid,
          userRef.toString()
        );
      }
    }
    const u = effectiveCur != null ? effectiveCur : { cash: 1000000, stocks: {}, coins: {} };
    const cash = Number(u.cash ?? 1000000);
    const stocks = u.stocks && typeof u.stocks === "object" ? u.stocks : {};
    const coins = u.coins && typeof u.coins === "object" ? u.coins : {};

    if (isCoin) {
      const us = coins[stockId] || { qty: 0, avg: 0 };
      const haveQty = Math.floor(Number(us.qty || 0));
      const haveAvg = Math.round(Number(us.avg || 0));

      if (side === "buy") {
        const total = lastTradePrice * qty;
        if (cash < total && !isAdminAuth(auth)) return undefined;
        if (!isAdminAuth(auth) && haveQty === 0) {
          const ownedCount = Object.values(coins).filter((s) => Math.floor(Number(s?.qty || 0)) > 0).length;
          if (ownedCount >= 10) return undefined;
        }
        const totalCost = haveQty * haveAvg + total;
        const newQty = haveQty + qty;
        return {
          ...u,
          cash: cash - total,
          stocks,
          coins: { ...coins, [stockId]: { qty: newQty, avg: Math.round(totalCost / newQty) } },
          lastTradeTime: admin.database.ServerValue.TIMESTAMP
        };
      }

      if (haveQty < qty && !isAdminAuth(auth)) return undefined;
      const receive = Math.round(lastTradePrice * qty * (1 - fee));
      const newQty = haveQty - qty;
      const nextCoins = { ...coins };
      if (newQty <= 0) {
        nextCoins[stockId] = null;
      } else {
        nextCoins[stockId] = { qty: newQty, avg: haveAvg };
      }
      return {
        ...u,
        cash: cash + receive,
        stocks,
        coins: nextCoins,
        lastTradeTime: admin.database.ServerValue.TIMESTAMP
      };
    }

    const us = stocks[stockId] || { qty: 0, avg: 0 };
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
        await instrumentRef.transaction(() => stockRollbackVal);
      } catch (e) {
        console.error("[trade] instrument rollback failed", e?.message || e);
      }
    }
    throw new HttpsError("failed-precondition", "User validation failed (cash/holdings/limits).");
  }

  const ts = Math.floor(Date.now() / 60000) * 60;
  const candleRef = db.ref(`${candleRoot}/${stockId}/${ts}`);
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

  if (!isCoin) {
    await maybeApplyStockVolatilityCircuitBreaker(db, stockId, auth);
  }

  const tradeId = db.ref("tradeHistory").push().key;
  if (tradeId) {
    await db.ref(`tradeHistory/${tradeId}`).set({
      uid,
      stockId,
      side,
      qty,
      market: isCoin ? "coin" : "stock",
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
    market: isCoin ? "coin" : "stock",
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

  const [cfgSnap, stockSnap, preUserSnapForCooldown] = await Promise.all([
    db.ref("siteConfig").get(),
    db.ref(`${stockPath}/${stockId}`).get(),
    db.ref(`users/${uid}`).get(),
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

  const preUserForCooldown = preUserSnapForCooldown.exists() ? preUserSnapForCooldown.val() : {};
  assertUserTradeRestrictionAllowed(auth, preUserForCooldown);
  assertServerTradeCooldownAllowed(auth, siteConfig, preUserForCooldown);

  const bookSnap = await db.ref(`users/${uid}/${userBookPath}/${stockId}`).get();
  const qty = Math.floor(Number(bookSnap.val()?.qty || 0));
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new HttpsError("failed-precondition", "No holdings.");
  }

  const userRef = db.ref(`users/${uid}`);

  const sellConfig = siteConfig.sellConfig || {};
  const marketParams = siteConfig.marketParams || {};
  const basePrice = Number(sellConfig.basePrice ?? 10000);
  const scalePrice = Number(sellConfig.scalePrice ?? 90000);
  const impactCoef = Number(sellConfig.impact ?? 0.0005);
  const stockSpread = Number(sellConfig.spread ?? 0.001);
  const coinSpread = Number(sellConfig.coinSpread ?? stockSpread);
  const spread = market === "coin" ? coinSpread : stockSpread;
  const fee = Number(sellConfig.fee ?? 0.003);
  const impactRefPriceWon = Math.max(1, Number(marketParams.impactRefPrice ?? 100000));
  const coinMul = Number(marketParams.coinImpactMultiplier ?? 1.85);
  const stockSellImpactMultiplier = Math.max(1, Number(marketParams.stockSellImpactMultiplier ?? 1.2));
  const coinSellImpactMultiplier = Math.max(1, Number(marketParams.coinSellImpactMultiplier ?? 1.2));
  const extraLiquidationFee = 0.08;

  const rawInstrumentVal = stockSnap.val();
  let tradePrice = 0;
  let nextPrice = 0;
  const stockRef = db.ref(`${stockPath}/${stockId}`);
  const stockTx = await stockRef.transaction((cur) => {
    let effectiveCur = cur;
    if (effectiveCur == null && rawInstrumentVal != null) {
      effectiveCur = rawInstrumentVal;
    }
    const row = normalizeStockRow(effectiveCur);
    if (!row) return undefined;
    const prevPrice = Math.max(1, Number(row.price || 0));
    let sellPressure = 1;
    if (market !== "coin") {
      sellPressure = 1 + (Math.max(0, prevPrice - basePrice) / scalePrice);
    }
    const dampingFactor = market === "coin" ? 1 : Math.min(1, impactRefPriceWon / Math.max(1, prevPrice));
    let impact = impactCoef * dampingFactor * Math.log2(1 + qty) * sellPressure;
    if (market === "coin") impact *= Number.isFinite(coinMul) && coinMul > 0 ? coinMul : 1.85;
    impact *= market === "coin" ? coinSellImpactMultiplier : stockSellImpactMultiplier;
    nextPrice = Math.max(1, Math.round(prevPrice * (1 - impact)));
    tradePrice = Math.max(1, Math.round(nextPrice * (1 - spread)));
    const { history: _h, ...rest } = row;
    const baseVol = Number(row.volume);
    const baseBuy = Number(row.buyVol);
    const baseSell = Number(row.sellVol);
    const merged = {
      ...rest,
      price: nextPrice,
      volume: (Number.isFinite(baseVol) ? baseVol : 0) + qty,
      buyVol: Number.isFinite(baseBuy) ? baseBuy : 0,
      sellVol: (Number.isFinite(baseSell) ? baseSell : 0) + qty,
      change:
        prevPrice > 0
          ? (((nextPrice - prevPrice) / prevPrice) * 100).toFixed(market === "coin" ? 4 : 2)
          : market === "coin"
            ? "0.0000"
            : "0.00",
    };
    return jsonSanitizeForRtdb(stripUndefinedShallow(merged));
  });
  if (!stockTx.committed || !tradePrice) {
    throw new HttpsError("aborted", "Price update contention.");
  }

  const receive = Math.round(tradePrice * qty * (1 - fee - extraLiquidationFee));
  const preUserSnap = await userRef.get();
  const userSeedForTx = preUserSnap.exists()
    ? JSON.parse(JSON.stringify(preUserSnap.val()))
    : { cash: 1000000, stocks: {}, coins: {} };
  let userTxSeeded = false;
  const userTx = await userRef.transaction((cur) => {
    let effectiveCur = cur;
    if (effectiveCur == null && preUserSnap.exists()) {
      effectiveCur = userSeedForTx;
      if (!userTxSeeded) {
        userTxSeeded = true;
        console.warn("[liquidateAll] userTx cur was null; seeding from pre-read snapshot", uid);
      }
    }
    const u = effectiveCur != null ? effectiveCur : { cash: 1000000, stocks: {}, coins: {} };
    const cash = Number(u.cash ?? 1000000);
    const stocks = u.stocks && typeof u.stocks === "object" ? u.stocks : {};
    const coins = u.coins && typeof u.coins === "object" ? u.coins : {};
    const book = market === "coin" ? coins : stocks;
    const pos = book?.[stockId] || { qty: 0, avg: 0 };
    const haveQty = Math.floor(Number(pos.qty || 0));
    if (haveQty < qty && !isAdminAuth(auth)) return undefined;
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

  if (market === "stock") {
    await maybeApplyStockVolatilityCircuitBreaker(db, stockId, auth);
  }

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
 * tradeHistory 하위를 한 번에 set(null) 하면 RTDB WRITE_TOO_BIG 에 걸릴 수 있어
 * 키 단위로 나눠 multi-path update 로 삭제한다.
 */
async function purgeTradeHistoryBatched(db, initialBatchSize = 60) {
  let batchSize = Math.max(5, Math.floor(Number(initialBatchSize) || 60));
  let purged = 0;
  for (;;) {
    const snap = await db.ref("tradeHistory").orderByKey().limitToFirst(batchSize).get();
    if (!snap.exists()) break;
    const val = snap.val();
    const keys = val && typeof val === "object" ? Object.keys(val) : [];
    if (keys.length === 0) break;
    const updates = {};
    for (const k of keys) {
      updates[`tradeHistory/${k}`] = null;
    }
    try {
      await db.ref().update(updates);
    } catch (e) {
      const msg = String(e?.message || e || "");
      if (msg.includes("WRITE_TOO_BIG") && batchSize > 5) {
        batchSize = Math.max(5, Math.floor(batchSize / 2));
        continue;
      }
      if (msg.includes("WRITE_TOO_BIG") && keys.length > 1) {
        batchSize = 1;
        continue;
      }
      if (msg.includes("WRITE_TOO_BIG") && keys.length === 1) {
        await db.ref(`tradeHistory/${keys[0]}`).remove();
        purged += 1;
        continue;
      }
      throw e;
    }
    purged += keys.length;
    if (keys.length < batchSize) break;
  }
  return purged;
}

/** 관리자 전용: tradeHistory(유저 활동로그) 전체 삭제 */
exports.adminPurgeUserActivityLogs = onCall(
  { cors: true, timeoutSeconds: 300, memory: "512MiB" },
  async (request) => {
    if (!isAdminAuth(request.auth)) {
      throw new HttpsError("permission-denied", "Admin only.");
    }
    const db = admin.database();
    const purged = await purgeTradeHistoryBatched(db);
    const ts = Date.now();
    try {
      await db.ref(`adminActivityLogs/userActivityPurge/${ts}`).set({
        type: "userActivityPurge",
        adminEmail: String(request.auth?.token?.email || ADMIN_EMAIL),
        createdAt: ts,
        via: "adminPurgeUserActivityLogs",
        purged,
      });
    } catch (e) {
      console.warn("[adminPurgeUserActivityLogs] adminActivityLogs:", e?.message || e);
    }
    return { ok: true, purged, at: ts };
  }
);

/** 관리자 전용: 자산 지원 신청 Grant (대액 지급 포함) */
exports.adminGrantAssetRequest = onCall(
  { cors: true, timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    if (!isAdminAuth(request.auth)) {
      throw new HttpsError("permission-denied", "Admin only.");
    }
    const reqId = String(request.data?.reqId || "").trim();
    const targetUid = String(request.data?.targetUid || "").trim();
    const amtRaw = Number(request.data?.amount);
    const amount = Math.floor(amtRaw);
    if (!reqId) throw new HttpsError("invalid-argument", "reqId required.");
    if (!targetUid) throw new HttpsError("invalid-argument", "targetUid required.");
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new HttpsError("invalid-argument", "amount must be a positive integer.");
    }
    // JS 안전 정수 범위 내에서만 처리
    if (!Number.isSafeInteger(amount) || amount > 9_000_000_000_000_000) {
      throw new HttpsError("invalid-argument", "amount is out of safe range.");
    }

    const db = admin.database();
    const reqRef = db.ref(`assetRequests/${reqId}`);
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists()) {
      throw new HttpsError("not-found", "request not found.");
    }
    const reqVal = reqSnap.val() || {};
    if (String(reqVal.status || "").trim() !== "pending") {
      throw new HttpsError("failed-precondition", "already processed.");
    }
    const reqUid = String(reqVal.uid || "");
    if (reqUid && reqUid !== targetUid) {
      throw new HttpsError("failed-precondition", "target uid mismatch.");
    }

    const userRef = db.ref(`users/${targetUid}`);
    await userRef.transaction((cur) => {
      const base = cur && typeof cur === "object" ? cur : { cash: 1000000, stocks: {}, coins: {} };
      const cash = Math.floor(Number(base.cash) || 1000000);
      return { ...base, cash: cash + amount };
    });

    const logRef = db.ref("adminLogs/grants").push();
    const now = Date.now();
    await db.ref().update({
      [`assetRequests/${reqId}/status`]: "completed",
      [`assetRequests/${reqId}/completedAt`]: now,
      [`assetRequests/${reqId}/grantedAmount`]: amount,
      [`assetRequests/${reqId}/grantedBy`]: String(request.auth?.token?.email || ADMIN_EMAIL),
      [`adminLogs/grants/${logRef.key}`]: {
        adminEmail: String(request.auth?.token?.email || ADMIN_EMAIL),
        targetUid,
        amount,
        requestId: reqId,
        via: "adminGrantAssetRequest",
        timestamp: admin.database.ServerValue.TIMESTAMP,
      },
    });

    return { ok: true, reqId, targetUid, amount };
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
 * - tradeHistory / adminActivityLogs 는 open에서 `.write: false`(클라이언트 전부 금지)인 경우가 많은데,
 *   장 마감(closed) 중에도 관리자 화면에서 일일 루틴(활동로그 삭제 등)이 동작하도록 예외적으로 관리자 쓰기 허용
 */
function buildClosedRulesObjectFromOpen(openRulesParsed) {
  const adminWrite =
    "auth != null && auth.token.email != null && auth.token.email.matches(/^skftodwocks2@gmail\\.com$/i)";
  const clone = JSON.parse(JSON.stringify(openRulesParsed));

  function walk(n, pathParts) {
    if (!n || typeof n !== "object") return;
    for (const k of Object.keys(n)) {
      if (k === ".write") {
        if (n[k] === false) {
          if (
            pathParts.length === 1 &&
            (pathParts[0] === "tradeHistory" ||
              pathParts[0] === "adminActivityLogs")
          ) {
            n[k] = adminWrite;
          }
          continue;
        }
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

/**
 * 주가/코인 시가총액 랭킹과 동일 기준(byPrice) 순위를 marketRank 에 기록.
 * 비용 절감: 15분마다만 실행, KST 기준 장 마감 시 stocks/coins 전체 읽기 생략.
 */
exports.refreshMarketPriceRanks = onSchedule(
  {
    schedule: "every 15 minutes",
    region: "asia-northeast3",
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async () => {
    const db = admin.database();
    try {
      const mhSnap = await db.ref("siteConfig/marketHours").get();
      const mh = mhSnap.exists() ? mhSnap.val() : null;
      const kst = nowKstDate();
      if (mh && mh.enabled && !isMarketOpenServer(mh, kst)) {
        console.log("[refreshMarketPriceRanks] skip: market closed (KST)");
        return;
      }

      const [stocksSnap, coinsSnap] = await Promise.all([
        db.ref("stocks").get(),
        db.ref("coins").get(),
      ]);
      const stocksVal = stocksSnap.exists() ? stocksSnap.val() : {};
      const coinsVal = coinsSnap.exists() ? coinsSnap.val() : {};
      const stockRank = buildPriceRankByIdFromMarketSnapshot(stocksVal);
      const coinRank = buildPriceRankByIdFromMarketSnapshot(coinsVal);
      const stockVolTop5 = buildVolumeTop5FromMarketSnapshot(stocksVal);
      const coinVolTop5 = buildVolumeTop5FromMarketSnapshot(coinsVal);
      const updatedAt = Date.now();
      await db.ref().update({
        "marketRank/stocks/byPrice": stockRank,
        "marketRank/coins/byPrice": coinRank,
        "marketRank/stocks/byVolumeTop5": stockVolTop5,
        "marketRank/coins/byVolumeTop5": coinVolTop5,
        "marketRank/meta/updatedAt": updatedAt,
        "marketRank/meta/sortKey": `byPrice_v${MARKET_RANK_SORT_VERSION}`,
      });
      console.log(
        `[refreshMarketPriceRanks] ok stocks=${Object.keys(stockRank).length} coins=${Object.keys(coinRank).length} volTop5 stock=${stockVolTop5.length} coin=${coinVolTop5.length}`
      );
    } catch (e) {
      console.error("[refreshMarketPriceRanks]", e?.message || e);
      throw e;
    }
  }
);

