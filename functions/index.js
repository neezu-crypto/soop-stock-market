const crypto = require("crypto");
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

/**
 * KST 시·분 (Cloud Functions VM 타임존과 무관).
 * 기존 `new Date(toLocaleString(...))` 는 파싱이 로컬에 의존해 장중 판정·스케줄 스킵이 틀어질 수 있음.
 */
function getKstHourMinute() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return {
    h: Number.isFinite(hour) ? hour : 0,
    m: Number.isFinite(minute) ? minute : 0,
  };
}

/** KST 기준 YYYY-MM-DD (스케줄·일일 락용) */
function kstYmdString(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const mo = parts.find((p) => p.type === "month")?.value ?? "01";
  const da = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${mo}-${da}`;
}

/** KST 당일 `ymd` + 시·분 → UTC epoch ms (한국 DST 없음, `+09:00` 고정). */
function kstLocalDateTimeToUtcMs(ymd, hour, minute) {
  const [y, mo, d] = String(ymd || "")
    .trim()
    .split("-")
    .map((x) => parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return NaN;
  const hh = String(Math.min(23, Math.max(0, hour))).padStart(2, "0");
  const mm = String(Math.min(59, Math.max(0, minute))).padStart(2, "0");
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${hh}:${mm}:00+09:00`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

/** getHours/getMinutes 만 쓰는 기존 코드와 호환 (실제 Date 아님) */
function nowKstDate() {
  const { h, m } = getKstHourMinute();
  return {
    getHours: () => h,
    getMinutes: () => m,
  };
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
const MARKET_TOP_RANK_LIMIT = 100;
const MARKET_RANK_LIVE_REFRESH_MIN_GAP_MS = 3000;

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

/** 실시간 Top 랭킹 페이지용 경량 payload (id,name,price,change,volume,rank) */
function buildTopPriceRowsFromMarketSnapshot(val, { limit = MARKET_TOP_RANK_LIMIT, isCoin = false } = {}) {
  if (!val || typeof val !== "object") return [];
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
  const decimalPlaces = isCoin ? 4 : 2;
  return filtered.slice(0, limit).map((s, i) =>
    stripUndefinedShallow({
      rank: i + 1,
      id: s.id,
      name: String(s.name || "").trim() || s.id,
      price: Math.max(0, Math.floor(Number(s.price) || 0)),
      change: Number.isFinite(Number(s.change)) ? Number(s.change).toFixed(decimalPlaces) : (0).toFixed(decimalPlaces),
      volume: Math.max(0, Math.floor(Number(s.volume) || 0)),
    })
  );
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

/** 쿨다운: session/lastTradeTime 우선, 레거시 users/.../lastTradeTime 폴백 */
function effectiveLastTradeTimeMs(preUser) {
  if (!preUser || typeof preUser !== "object") return 0;
  const s = preUser.session && typeof preUser.session === "object" ? preUser.session.lastTradeTime : undefined;
  const legacy = preUser.lastTradeTime;
  const a = Number(s);
  const b = Number(legacy);
  const ma = Number.isFinite(a) && a > 0 ? a : 0;
  const mb = Number.isFinite(b) && b > 0 ? b : 0;
  return Math.max(ma, mb);
}

function computeUserSummaryForRtdb(u) {
  const cash = Math.floor(Number(u?.cash ?? 1000000));
  const stocks = u?.stocks && typeof u.stocks === "object" ? u.stocks : {};
  const coins = u?.coins && typeof u.coins === "object" ? u.coins : {};
  const stockCount = Object.values(stocks).filter((row) => Math.floor(Number(row?.qty || 0)) !== 0).length;
  const coinCount = Object.values(coins).filter((row) => Math.floor(Number(row?.qty || 0)) !== 0).length;
  const c = Number.isFinite(cash) && cash >= 0 ? cash : 1000000;
  return {
    cash: c,
    stockCount,
    coinCount,
    updatedAt: Date.now(),
  };
}

/** 거래·강제 매도 후 session·summary·레거시 lastTradeTime 정리 */
async function persistUserDerivedState(db, uid, userVal, opts) {
  const touchCooldown = Boolean(opts?.touchLastTradeTime);
  const summary = computeUserSummaryForRtdb(userVal);
  const tasks = [db.ref(`users/${uid}/summary`).set(summary)];
  if (touchCooldown) {
    tasks.push(
      db.ref(`users/${uid}/session/lastTradeTime`).set(admin.database.ServerValue.TIMESTAMP),
      db.ref(`users/${uid}/lastTradeTime`).remove()
    );
  }
  await Promise.all(tasks);
}

/**
 * 클라이언트 조작 불가 — session/lastTradeTime(서버) · 레거시 lastTradeTime 폴백.
 * Admin 은 쿨다운 면제.
 */
function assertServerTradeCooldownAllowed(auth, siteConfig, preUser) {
  if (isAdminAuth(auth)) return;
  const mh = siteConfig.marketHours || {};
  const now = Date.now();
  const dateKst = nowKstDate();
  const cooldownMs = getTradeCooldownMsFromConfig(mh, dateKst);
  if (cooldownMs <= 0) return;
  const lt = effectiveLastTradeTimeMs(preUser);
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

/** 인버스 모드 거래 시 `siteConfig/sellConfig.inverseFee` (미설정·비유효 시 일반 fee) */
function resolveTradeFee(standardFee, sellConfig, inverseModeReq) {
  if (!inverseModeReq) return standardFee;
  const inv = sellConfig?.inverseFee;
  if (inv === undefined || inv === null || inv === "") return standardFee;
  const n = Number(inv);
  if (!Number.isFinite(n) || n < 0 || n > 1) return standardFee;
  return n;
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

/** 인버스 모드 체결가용 스프레드 — 미설정 시 기존 spread / coinSpread */
function resolveSpreadForTrade(sellConfig, isCoin, invertPrice, stockSpread, coinSpread) {
  if (!invertPrice) return isCoin ? coinSpread : stockSpread;
  const invS = sellConfig?.inverseSpread;
  const invC = sellConfig?.inverseCoinSpread;
  if (isCoin) {
    if (invC !== undefined && invC !== null && invC !== "") {
      const n = Number(invC);
      if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
    }
    if (invS !== undefined && invS !== null && invS !== "") {
      const n = Number(invS);
      if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
    }
    return coinSpread;
  }
  if (invS !== undefined && invS !== null && invS !== "") {
    const n = Number(invS);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  return stockSpread;
}

const INVERSE_DROP_IMPACT_MULT_DEFAULT = 1.28;
const INVERSE_RISE_IMPACT_MULT_DEFAULT = 0.78;

function pickInverseImpactMult(val, def) {
  if (val === undefined || val === null || val === "") return def;
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** 메인 앱 `window.trade`와 동일한 가격·임팩트 계산 — prevPrice는 트랜잭션 내 현재가 */
function computeTradePrices(side, prevPrice, qty, sellConfig, marketParams, isCoin, invertPrice) {
  const priceSide = invertPrice ? (side === "buy" ? "sell" : "buy") : side;
  const basePrice = Math.max(1, finiteOr(sellConfig.basePrice, 10000));
  const scalePrice = Math.max(1, finiteOr(sellConfig.scalePrice, 90000));
  const impactCoef = finiteOr(sellConfig.impact, 0.0005);
  const stockSpread = finiteOr(sellConfig.spread, 0.001);
  const coinSpread = finiteOr(sellConfig.coinSpread, stockSpread);
  const spread = resolveSpreadForTrade(sellConfig, isCoin, invertPrice, stockSpread, coinSpread);
  const impactRefPriceWon = Math.max(1, finiteOr(marketParams?.impactRefPrice, 100000));
  const stockSellImpactMultiplier = Math.max(1, finiteOr(marketParams?.stockSellImpactMultiplier, 1.2));
  const coinSellImpactMultiplier = Math.max(1, finiteOr(marketParams?.coinSellImpactMultiplier, 1.2));
  const dampingFactor = isCoin ? 1 : Math.min(1, impactRefPriceWon / Math.max(1, prevPrice));
  const effectiveImpactCoef = impactCoef * dampingFactor;
  let sellPressure = 1;
  if (priceSide === "sell" && !isCoin) {
    sellPressure = 1 + (Math.max(0, prevPrice - basePrice) / scalePrice);
  }
  let impact = effectiveImpactCoef * Math.log2(1 + qty) * sellPressure;
  if (isCoin) {
    const coinMul = finiteOr(marketParams?.coinImpactMultiplier, 1.85);
    impact *= coinMul > 0 ? coinMul : 1.85;
  }
  if (priceSide === "sell") {
    impact *= isCoin ? coinSellImpactMultiplier : stockSellImpactMultiplier;
  }
  if (invertPrice) {
    if (priceSide === "sell") {
      impact *= pickInverseImpactMult(sellConfig?.inverseDropImpactMultiplier, INVERSE_DROP_IMPACT_MULT_DEFAULT);
    } else {
      impact *= pickInverseImpactMult(sellConfig?.inverseRiseImpactMultiplier, INVERSE_RISE_IMPACT_MULT_DEFAULT);
    }
  }
  if (!Number.isFinite(impact) || impact < 0) impact = 0;
  let rawNewPrice;
  if (priceSide === "buy") {
    rawNewPrice = prevPrice * (1 + impact);
  } else {
    rawNewPrice = prevPrice * (1 - impact);
  }
  if (!Number.isFinite(rawNewPrice) || rawNewPrice <= 0) rawNewPrice = prevPrice;
  const newPrice = Math.max(1, Math.round(rawNewPrice));
  const tradePrice =
    priceSide === "buy"
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
const CB_FREEZE_MS = 60 * 1000;
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
    const frozenRef = db.ref(`siteConfig/frozenStocks/${stockId}`);
    const verifySnap = await frozenRef.get();
    if (verifySnap.exists()) {
      const v = Number(verifySnap.val());
      if (Number.isFinite(v) && v > now) return;
      if (Number.isFinite(v) && v === frozenUntilMs) return;
    }
    await frozenRef.set(frozenUntilMs);
    await db.ref(`siteConfig/circuitBreakerLastTrigger/${stockId}`).set(now);
    console.warn("[trade] stock volatility circuit breaker", stockId, variation.toFixed(2));
  } catch (e) {
    console.error("[trade] maybeApplyStockVolatilityCircuitBreaker", stockId, e?.message || e);
  }
}

/** 검색 카드 시세: 여러 종목을 한 번의 HTTPS 왕복으로, 클라이언트 RTDB N회 get 대체 */
exports.fetchSearchQuotes = onCall(
  { cors: true, timeoutSeconds: 30, memory: "256MiB" },
  async (req) => {
    if (!req.auth?.uid) {
      throw new HttpsError("unauthenticated", "Login required.");
    }
    const market = String(req.data?.market || "stock").trim().toLowerCase();
    const isCoin = market === "coin";
    const ids = Array.isArray(req.data?.ids)
      ? req.data.ids.map((x) => String(x ?? "").trim()).filter(Boolean)
      : [];
    const unique = [...new Set(ids)].slice(0, 40);
    if (unique.length === 0) return { quotes: {} };

    const db = admin.database();
    const base = isCoin ? "coins" : "stocks";
    const quotes = {};

    await Promise.all(
      unique.map(async (id) => {
        try {
          const snap = await db.ref(`${base}/${id}`).get();
          if (!snap.exists()) return;
          const v = snap.val();
          if (!v || typeof v !== "object") return;
          quotes[id] = {
            id,
            name: v.name != null ? String(v.name) : "",
            price: Number(v.price) || 0,
            change: v.change,
            volume: Number(v.volume) || 0,
            buyVol: Number(v.buyVol) || 0,
            sellVol: Number(v.sellVol) || 0,
          };
        } catch (_) {
          /* noop */
        }
      })
    );

    return { quotes };
  }
);

/** 검색용 stockSearchIndex·coinSearchIndex 재구축 — 클라이언트 RTDB 쓰기 규칙과 무관하게 Admin SDK로 처리 */
exports.adminRebuildSearchIndexes = onCall(
  { cors: true, timeoutSeconds: 300, memory: "512MiB" },
  async (request) => {
    if (!isAdminAuth(request.auth)) {
      throw new HttpsError("permission-denied", "Admin only.");
    }

    const db = admin.database();
    const [sSnap, cSnap, stockIdxSnap, coinIdxSnap] = await Promise.all([
      db.ref("stocks").once("value"),
      db.ref("coins").once("value"),
      db.ref("stockSearchIndex").once("value"),
      db.ref("coinSearchIndex").once("value"),
    ]);

    const stocksData = sSnap.val() || {};
    const coinsData = cSnap.val() || {};
    const prevStockIdx = stockIdxSnap.val() || {};
    const prevCoinIdx = coinIdxSnap.val() || {};

    const updates = {};
    const stockIds = new Set(Object.keys(stocksData));

    Object.entries(stocksData).forEach(([id, row]) => {
      const n = row && typeof row === "object" ? row.name : "";
      if (typeof n === "string" && n.length > 0 && n.length <= 200) {
        updates[`stockSearchIndex/${id}/name`] = n;
      } else if (prevStockIdx[id]) {
        updates[`stockSearchIndex/${id}`] = null;
      }
    });
    Object.keys(prevStockIdx).forEach((id) => {
      if (!stockIds.has(id)) updates[`stockSearchIndex/${id}`] = null;
    });

    const coinIds = new Set(Object.keys(coinsData));
    Object.entries(coinsData).forEach(([id, row]) => {
      const n = row && typeof row === "object" ? row.name : "";
      if (typeof n === "string" && n.length > 0 && n.length <= 200) {
        updates[`coinSearchIndex/${id}/name`] = n;
      } else if (prevCoinIdx[id]) {
        updates[`coinSearchIndex/${id}`] = null;
      }
    });
    Object.keys(prevCoinIdx).forEach((id) => {
      if (!coinIds.has(id)) updates[`coinSearchIndex/${id}`] = null;
    });

    const ts = Date.now();
    updates["siteConfig/stockNameIndexVersion"] = ts;
    updates["siteConfig/coinNameIndexVersion"] = ts;
    updates["siteConfig/stockCacheVersion"] = ts;

    const parts = chunkObject(updates, 400);
    for (const part of parts) {
      await db.ref().update(part);
    }

    return {
      ok: true,
      pathCount: Object.keys(updates).length,
      stockCount: stockIds.size,
      coinCount: coinIds.size,
    };
  }
);

/** 관리자 상장 세션: 닉네임 목록으로 stocks 신규 생성 + stockSearchIndex 갱신 */
exports.adminBulkListStocks = onCall(
  { cors: true, timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    if (!isAdminAuth(request.auth)) {
      throw new HttpsError("permission-denied", "Admin only.");
    }
    const rawNames = Array.isArray(request.data?.names) ? request.data.names : [];
    const names = [...new Set(rawNames.map((v) => String(v || "").trim()).filter(Boolean))].slice(0, 300);
    if (!names.length) {
      throw new HttpsError("invalid-argument", "names is required.");
    }

    const db = admin.database();
    const now = Date.now();
    const stocksSnap = await db.ref("stocks").get();
    const stocks = stocksSnap.exists() ? stocksSnap.val() || {} : {};
    const existingNameSet = new Set(
      Object.values(stocks)
        .map((row) => String(row?.name || "").trim())
        .filter(Boolean)
    );

    const toCreate = names.filter((n) => !existingNameSet.has(n));
    const skipped = names.filter((n) => existingNameSet.has(n));
    if (!toCreate.length) return { ok: true, created: 0, skipped };

    const updates = {};
    toCreate.forEach((name, i) => {
      const id = `id_${now}_${i}`;
      updates[`stocks/${id}`] = {
        name,
        price: 10000,
        volume: 0,
        totalShares: 1000000,
        status: "active",
        createdAt: now,
        lastUpdate: now,
        impactCoef: 0.0005,
        history: [10000, 10000],
        change: 0,
        buyVol: 0,
        sellVol: 0,
      };
      updates[`stockSearchIndex/${id}/name`] = name;
    });
    updates["siteConfig/stockNameIndexVersion"] = now;
    updates["siteConfig/stockCacheVersion"] = now;
    await db.ref().update(updates);
    return { ok: true, created: toCreate.length, skipped };
  }
);

/** 관리자 삭제 세션: 닉네임 목록으로 stocks/coins + 검색 인덱스 삭제 */
exports.adminBulkDeleteStocks = onCall(
  { cors: true, timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    if (!isAdminAuth(request.auth)) {
      throw new HttpsError("permission-denied", "Admin only.");
    }
    const rawNames = Array.isArray(request.data?.names) ? request.data.names : [];
    const names = [...new Set(rawNames.map((v) => String(v || "").trim()).filter(Boolean))].slice(0, 300);
    if (!names.length) {
      throw new HttpsError("invalid-argument", "names is required.");
    }

    const db = admin.database();
    const now = Date.now();
    const stocksSnap = await db.ref("stocks").get();
    const stocks = stocksSnap.exists() ? stocksSnap.val() || {} : {};

    const targetIds = [];
    Object.entries(stocks).forEach(([id, row]) => {
      const name = String(row?.name || "").trim();
      if (name && names.includes(name)) targetIds.push(id);
    });
    if (!targetIds.length) return { ok: true, deleted: 0, notFound: names };

    const updates = {};
    targetIds.forEach((id) => {
      updates[`stocks/${id}`] = null;
      updates[`coins/${id}`] = null;
      updates[`stockSearchIndex/${id}`] = null;
      updates[`coinSearchIndex/${id}`] = null;
    });
    updates["siteConfig/stockNameIndexVersion"] = now;
    updates["siteConfig/coinNameIndexVersion"] = now;
    updates["siteConfig/stockCacheVersion"] = now;
    await db.ref().update(updates);

    const deletedNameSet = new Set(
      targetIds
        .map((id) => String(stocks[id]?.name || "").trim())
        .filter(Boolean)
    );
    const notFound = names.filter((n) => !deletedNameSet.has(n));
    return { ok: true, deleted: targetIds.length, notFound };
  }
);

/**
 * 관리자 단일 종목 상장폐지/시가 재상장
 * - delist: market 에 따라 stocks·stockSearchIndex·유저 stocks 보유 만 / coins·coinSearchIndex·유저 coins 보유 만 삭제 (stock|coin). 생략 시 both(기존 동작).
 * - relist: market 에 따라 주식만(1만원)·코인만(1억)·둘 다 시가로 신규/덮어쓰기. 생략 시 both.
 */
exports.adminRebuildSingleInstrument = onCall(
  { cors: true, timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    if (!isAdminAuth(request.auth)) {
      throw new HttpsError("permission-denied", "Admin only.");
    }
    const action = String(request.data?.action || "").trim().toLowerCase();
    const id = String(request.data?.id || "").trim();
    const rawName = String(request.data?.name || "").trim();
    const now = Date.now();
    const batchSizeRaw = Number(request.data?.batchSize);
    const batchSize = Number.isFinite(batchSizeRaw)
      ? Math.min(1000, Math.max(50, Math.floor(batchSizeRaw)))
      : 300;

    if (!id) throw new HttpsError("invalid-argument", "id is required.");
    if (action !== "delist" && action !== "relist") {
      throw new HttpsError("invalid-argument", "action must be delist|relist.");
    }

    const db = admin.database();

    if (action === "delist") {
      const hasMarket =
        request.data && Object.prototype.hasOwnProperty.call(request.data, "market");
      let market = "both";
      if (hasMarket) {
        const mr = String(request.data.market || "").trim().toLowerCase();
        if (mr === "stock" || mr === "coin" || mr === "both") market = mr;
        else {
          throw new HttpsError("invalid-argument", "market must be stock|coin|both.");
        }
      }

      const usersSnap = await db.ref("users").get();
      const users = usersSnap.exists() ? usersSnap.val() || {} : {};
      const holdingUpdates = {};
      let removedHoldingPaths = 0;
      Object.entries(users).forEach(([uid, u]) => {
        if (market === "stock" || market === "both") {
          if (u?.stocks && typeof u.stocks === "object" && Object.prototype.hasOwnProperty.call(u.stocks, id)) {
            holdingUpdates[`users/${uid}/stocks/${id}`] = null;
            removedHoldingPaths += 1;
          }
        }
        if (market === "coin" || market === "both") {
          if (u?.coins && typeof u.coins === "object" && Object.prototype.hasOwnProperty.call(u.coins, id)) {
            holdingUpdates[`users/${uid}/coins/${id}`] = null;
            removedHoldingPaths += 1;
          }
        }
      });
      const chunks = chunkObject(holdingUpdates, batchSize);
      for (const chunk of chunks) {
        await db.ref().update(chunk);
      }

      const rootUpd = {};
      if (market === "stock" || market === "both") {
        rootUpd[`stocks/${id}`] = null;
        rootUpd[`stockSearchIndex/${id}`] = null;
        rootUpd["siteConfig/stockNameIndexVersion"] = now;
        rootUpd["siteConfig/stockCacheVersion"] = now;
      }
      if (market === "coin" || market === "both") {
        rootUpd[`coins/${id}`] = null;
        rootUpd[`coinSearchIndex/${id}`] = null;
        rootUpd["siteConfig/coinNameIndexVersion"] = now;
      }
      await db.ref().update(rootUpd);

      return {
        ok: true,
        action,
        id,
        market,
        removedHoldingPaths,
        holdingChunks: chunks.length,
        batchSize,
        at: now,
      };
    }

    const hasMarket =
      request.data && Object.prototype.hasOwnProperty.call(request.data, "market");
    let market = "both";
    if (hasMarket) {
      const mr = String(request.data.market || "").trim().toLowerCase();
      if (mr === "stock" || mr === "coin" || mr === "both") market = mr;
      else {
        throw new HttpsError("invalid-argument", "market must be stock|coin|both.");
      }
    }

    const stockSnap = await db.ref(`stocks/${id}`).get();
    const coinSnap = await db.ref(`coins/${id}`).get();
    let derivedName = rawName;
    if (!derivedName) {
      if (market === "stock" || market === "both") {
        derivedName = String(stockSnap.exists() ? stockSnap.val()?.name || "" : "").trim();
      }
      if (!derivedName && (market === "coin" || market === "both")) {
        derivedName = String(coinSnap.exists() ? coinSnap.val()?.name || "" : "").trim();
      }
    }
    if (!derivedName) derivedName = id;

    const upd = {};
    if (market === "stock" || market === "both") {
      upd[`stocks/${id}`] = {
        name: derivedName,
        price: 10000,
        volume: 0,
        totalShares: 1000000,
        status: "active",
        createdAt: now,
        lastUpdate: now,
        impactCoef: 0.0005,
        history: [10000, 10000],
        change: 0,
        buyVol: 0,
        sellVol: 0,
      };
      upd[`stockSearchIndex/${id}/name`] = derivedName;
      upd["siteConfig/stockNameIndexVersion"] = now;
      upd["siteConfig/stockCacheVersion"] = now;
    }
    if (market === "coin" || market === "both") {
      upd[`coins/${id}`] = {
        name: derivedName,
        price: 100000000,
        volume: 0,
        buyVol: 0,
        sellVol: 0,
        change: "0.00",
      };
      upd[`coinSearchIndex/${id}/name`] = derivedName;
      upd["siteConfig/coinNameIndexVersion"] = now;
    }
    await db.ref().update(upd);

    return { ok: true, action, id, name: derivedName, market, at: now };
  }
);

function toPositiveInt(v, fallback = 0, max = 9_999_999) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, n);
}

function getPricingPoints(siteConfig = {}) {
  const pricing = siteConfig && typeof siteConfig === "object" ? siteConfig.pricing || {} : {};
  const titleCfg = siteConfig && typeof siteConfig === "object" ? siteConfig.titleSponsorConfig || {} : {};
  return {
    assetRanking: toPositiveInt(pricing.assetRankingBalloons, 30, 999_999),
    liveRankingTop100: toPositiveInt(pricing.liveRankingTop100Balloons, 30, 999_999),
    liveRankingTop100DurationDays: toPositiveInt(pricing.liveRankingTop100DurationDays, 7, 365),
    relayRegularPerHour: toPositiveInt(pricing.relayRegularPerHour, 15, 999_999),
    relayOffPeakPerHour: toPositiveInt(pricing.relayOffPeakPerHour, 10, 999_999),
    broadcastBannerPerDay: toPositiveInt(pricing.broadcastBannerPerDay, 20, 999_999),
    chartBannerPerDay: toPositiveInt(pricing.chartBannerPerDay, 80, 999_999),
    titleSponsorUnitCost: toPositiveInt(titleCfg.unitCost, 50, 999_999),
  };
}

function nowMs() {
  return Date.now();
}

function isValidHttpUrl(url, maxLen = 800) {
  if (!url || typeof url !== "string") return false;
  const s = url.trim();
  if (s.length < 8 || s.length > maxLen) return false;
  return /^https?:\/\//i.test(s);
}

function kstYmdFromNow(addDays = 0) {
  const ms = nowMs() + (Math.max(0, Math.floor(Number(addDays) || 0)) * 86400000);
  const d = new Date(ms);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d); // YYYY-MM-DD
}

function toLogSafeValue(v, maxLen = 200) {
  if (v == null) return v;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

function logCallableFailure(functionName, request, err, extra = {}) {
  const payload = {
    functionName,
    uid: String(request?.auth?.uid || ""),
    email: String(request?.auth?.token?.email || ""),
    code: String(err?.code || err?.status || err?.name || "unknown"),
    message: String(err?.message || err || ""),
    extra,
  };
  console.error(`[callable:${functionName}] failure`, payload);
}

async function deductPointsOrThrow(db, uid, pointCost) {
  const walletRef = db.ref(`users/${uid}/wallet`);
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const beforeSnap = await walletRef.get();
    const beforeVal = beforeSnap.exists() ? (beforeSnap.val() || {}) : {};
    const beforeValForTx = beforeVal;
    const beforeRaw = beforeVal.points;
    const beforeParsed =
      typeof beforeRaw === "number"
        ? beforeRaw
        : Number(String(beforeRaw ?? "0").replace(/[^0-9.-]/g, ""));
    const beforePoints = Math.max(0, Math.floor(Number.isFinite(beforeParsed) ? beforeParsed : 0));

    if (beforePoints < pointCost) {
      const err = new HttpsError("failed-precondition", "insufficient points.");
      err.details = {
        reason: "INSUFFICIENT_POINTS",
        beforeRaw: toLogSafeValue(beforeRaw),
        beforePoints,
        pointCost,
      };
      throw err;
    }

    let evalLogged = false;
    const tx = await walletRef.transaction((cur) => {
      // RTDB transaction callback이 `cur=null`로 들어오는 케이스가 있어(경합/일시적 뷰),
      // 이 함수 앞단에서 이미 읽은 wallet 값을 fallback으로 사용합니다.
      const base =
        cur && typeof cur === "object"
          ? cur
          : (beforeValForTx && typeof beforeValForTx === "object" ? beforeValForTx : {});
      const raw = base.points;
      const parsed =
        typeof raw === "number"
          ? raw
          : Number(String(raw ?? "0").replace(/[^0-9.-]/g, ""));
      const points = Math.max(0, Math.floor(Number.isFinite(parsed) ? parsed : 0));

      if (!evalLogged) {
        evalLogged = true;
        console.error("[wallet] deduct transaction eval", {
          uid,
          pointCost,
          attempt,
          curExists: cur != null,
          raw: toLogSafeValue(raw),
          parsed: toLogSafeValue(parsed),
          points,
        });
      }

      if (points < pointCost) return;
      return { ...base, points: points - pointCost, updatedAt: nowMs() };
    });

    if (tx.committed) {
      return Math.max(0, Math.floor(Number(tx.snapshot.val()?.points || 0)));
    }

    const afterSnap = await walletRef.get();
    const afterVal = afterSnap.exists() ? (afterSnap.val() || {}) : {};
    const afterRaw = afterVal.points;
    const afterParsed =
      typeof afterRaw === "number"
        ? afterRaw
        : Number(String(afterRaw ?? "0").replace(/[^0-9.-]/g, ""));
    const afterPoints = Math.max(0, Math.floor(Number.isFinite(afterParsed) ? afterParsed : 0));

    console.error("[wallet] deduct transaction aborted", {
      uid,
      pointCost,
      attempt,
      beforeRaw: toLogSafeValue(beforeRaw),
      beforePoints,
      afterRaw: toLogSafeValue(afterRaw),
      afterPoints,
      txSnapshotRaw: toLogSafeValue(tx.snapshot?.val()?.points),
    });

    if (afterPoints < pointCost) {
      const err = new HttpsError("failed-precondition", "insufficient points.");
      err.details = {
        reason: "INSUFFICIENT_POINTS_AFTER_RECHECK",
        beforeRaw: toLogSafeValue(beforeRaw),
        beforePoints,
        afterRaw: toLogSafeValue(afterRaw),
        afterPoints,
        pointCost,
      };
      throw err;
    }

    // 잔액이 충분한데도 commit이 안 된 케이스: transient abort/경합으로 보고 재시도
    if (attempt < MAX_ATTEMPTS) {
      continue;
    }

    const err = new HttpsError("failed-precondition", "wallet transaction aborted.");
    err.details = {
      reason: "WALLET_TRANSACTION_ABORTED",
      beforeRaw: toLogSafeValue(beforeRaw),
      beforePoints,
      afterRaw: toLogSafeValue(afterRaw),
      afterPoints,
      pointCost,
    };
    throw err;
  }

  // 논리상 여기에 도달하면 안 됨
  throw new HttpsError("aborted", "deductPointsOrThrow failed unexpectedly.");
}

async function appendPointLedger(db, uid, row) {
  const refPush = db.ref(`pointLedger/${uid}`).push();
  const payload = {
    uid,
    type: String(row?.type || ""),
    amount: Math.floor(Number(row?.amount) || 0),
    balanceAfter: Math.floor(Number(row?.balanceAfter) || 0),
    requestType: String(row?.requestType || ""),
    requestId: String(row?.requestId || ""),
    requestPath: String(row?.requestPath || ""),
    note: String(row?.note || ""),
    createdAt: nowMs(),
    createdBy: String(row?.createdBy || "system"),
  };
  await refPush.set(payload);
  return refPush.key;
}

exports.createPointChargeRequest = onCall(
  { cors: true, timeoutSeconds: 60, memory: "256MiB" },
  async (request) => {
    if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Login required.");
    const uid = request.auth.uid;
    const nickname = String(request.data?.nickname || "").trim();
    const soopId = String(request.data?.soopId || "").trim();
    if (!nickname) throw new HttpsError("invalid-argument", "nickname required.");
    if (!soopId) throw new HttpsError("invalid-argument", "soopId required.");
    if (!/^[a-zA-Z0-9_]+$/.test(soopId)) throw new HttpsError("invalid-argument", "invalid soopId.");

    const db = admin.database();
    const reqId = `charge_${uid}_${nowMs()}`;
    const row = {
      uid,
      nickname,
      soopId,
      // 사용자 입력(후원갯수)을 받지 않는 정책.
      // 실제 적립 수량은 admin 승인 단계에서 pointsToGrant로 확정/적립됩니다.
      balloons: 0,
      points: 0,
      status: "pending",
      createdAt: nowMs(),
    };
    await db.ref(`pointChargeRequests/${reqId}`).set(row);
    return { ok: true, reqId };
  }
);

exports.adminApprovePointCharge = onCall(
  { cors: true, timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    if (!isAdminAuth(request.auth)) throw new HttpsError("permission-denied", "Admin only.");
    const reqId = String(request.data?.reqId || "").trim();
    if (!reqId) throw new HttpsError("invalid-argument", "reqId required.");
    const db = admin.database();
    const reqRef = db.ref(`pointChargeRequests/${reqId}`);
    const snap = await reqRef.get();
    if (!snap.exists()) throw new HttpsError("not-found", "request not found.");
    const row = snap.val() || {};
    if (String(row.status || "") !== "pending") {
      throw new HttpsError("failed-precondition", "already resolved.");
    }
    const uid = String(row.uid || "");
    const pointsToGrant = toPositiveInt(request.data?.pointsToGrant, 0, 999_999);
    const pointsFromRow = toPositiveInt(row.points ?? row.balloons, 0, 999_999);
    const points = pointsToGrant > 0 ? pointsToGrant : pointsFromRow;
    if (!uid || points <= 0) throw new HttpsError("failed-precondition", "invalid request payload (points).");
    const walletRef = db.ref(`users/${uid}/wallet`);
    const tx = await walletRef.transaction((cur) => {
      const base = cur && typeof cur === "object" ? cur : {};
      const current = Math.max(0, Math.floor(Number(base.points || 0)));
      return {
        ...base,
        points: current + points,
        updatedAt: nowMs(),
      };
    });
    if (!tx.committed) throw new HttpsError("aborted", "wallet update failed.");
    const after = Math.max(0, Math.floor(Number(tx.snapshot.val()?.points || 0)));
    const txnId = await appendPointLedger(db, uid, {
      type: "charge",
      amount: points,
      balanceAfter: after,
      requestType: "pointChargeRequests",
      requestId: reqId,
      requestPath: `pointChargeRequests/${reqId}`,
      note: "admin approve charge",
      createdBy: String(request.auth?.token?.email || ADMIN_EMAIL),
    });
    await reqRef.update({
      status: "approved",
      approvedAt: nowMs(),
      approvedBy: String(request.auth?.token?.email || ADMIN_EMAIL),
      // admin 승인 확정값 저장 (기존 스키마 호환용 balloons/points 포함)
      balloons: points,
      points,
      pointsGranted: points,
      ledgerTxnId: txnId,
    });
    return { ok: true, reqId, uid, pointsGranted: points, balanceAfter: after };
  }
);

exports.adminRejectPointCharge = onCall(
  { cors: true, timeoutSeconds: 60, memory: "256MiB" },
  async (request) => {
    if (!isAdminAuth(request.auth)) throw new HttpsError("permission-denied", "Admin only.");
    const reqId = String(request.data?.reqId || "").trim();
    if (!reqId) throw new HttpsError("invalid-argument", "reqId required.");
    const db = admin.database();
    const reqRef = db.ref(`pointChargeRequests/${reqId}`);
    const snap = await reqRef.get();
    if (!snap.exists()) throw new HttpsError("not-found", "request not found.");
    const row = snap.val() || {};
    if (String(row.status || "") !== "pending") throw new HttpsError("failed-precondition", "already resolved.");
    await reqRef.update({
      status: "rejected",
      rejectedAt: nowMs(),
      rejectedBy: String(request.auth?.token?.email || ADMIN_EMAIL),
    });
    return { ok: true, reqId };
  }
);

exports.purchaseAndPublishPromoBanner = onCall(
  { cors: true, timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    const functionName = "purchaseAndPublishPromoBanner";
    try {
      if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Login required.");
      const uid = request.auth.uid;
      const nickname = String(request.data?.nickname || "").trim();
      const soopId = String(request.data?.soopId || "").trim();
      const days = toPositiveInt(request.data?.days, 0, 30);
      const imgUrl = String(request.data?.imgUrl || "").trim();
      const link = String(request.data?.link || "").trim();
      const clientRequestId = String(request.data?.clientRequestId || "").trim();

      if (!nickname || nickname.length > 50) throw new HttpsError("invalid-argument", "invalid nickname.");
      if (!soopId || soopId.length > 80 || !/^[a-zA-Z0-9_]+$/.test(soopId)) throw new HttpsError("invalid-argument", "invalid soopId.");
      if (days < 1 || days > 30) throw new HttpsError("invalid-argument", "days must be 1~30.");
      if (!isValidHttpUrl(imgUrl, 800)) throw new HttpsError("invalid-argument", "invalid imgUrl.");
      if (!isValidHttpUrl(link, 800)) throw new HttpsError("invalid-argument", "invalid link.");
      if (!clientRequestId || !/^[A-Za-z0-9_-]{8,80}$/.test(clientRequestId)) throw new HttpsError("invalid-argument", "invalid clientRequestId.");

      const db = admin.database();
      const cfgSnap = await db.ref("siteConfig").get();
      const pricing = getPricingPoints(cfgSnap.exists() ? cfgSnap.val() : {});
      const pointCost = Math.max(1, days * pricing.broadcastBannerPerDay);

      const opRef = db.ref(`pointOps/${uid}/promoBanner/${clientRequestId}`);
      const opSnap = await opRef.get();
      const st = String(opSnap.val()?.status || "");
      if (opSnap.exists() && st === "done") return { ok: true, ...opSnap.val() };
      if (opSnap.exists() && st === "processing") throw new HttpsError("failed-precondition", "already processing.");
      await opRef.set({ status: "processing", uid, soopId, days, pointCost, createdAt: nowMs() });

      const balanceAfter = await deductPointsOrThrow(db, uid, pointCost);
      const ledgerTxnId = await appendPointLedger(db, uid, {
        type: "purchase_promo_banner",
        amount: -pointCost,
        balanceAfter,
        requestType: "promoBanner",
        requestId: clientRequestId,
        requestPath: `pointOps/${uid}/promoBanner/${clientRequestId}`,
        note: `publish promo banner ${soopId} ${days}d`,
        createdBy: "user",
      });

      const endDate = kstYmdFromNow(days - 1);
      await db.ref(`stocksBanner/${soopId}`).update({
        name: nickname,
        bannerImg: imgUrl,
        link,
        bannerIsPaid: true,
        bannerEndDate: endDate,
        updatedAt: nowMs(),
        updatedByUid: uid,
      });
      await db.ref("siteConfig/bannerCacheVersion").set(nowMs());

      const payload = {
        ok: true,
        status: "done",
        clientRequestId,
        uid,
        soopId,
        days,
        pointCost,
        balanceAfter,
        endDate,
        ledgerTxnId,
        doneAt: nowMs(),
      };
      await opRef.set(payload);
      return payload;
    } catch (err) {
      logCallableFailure(functionName, request, err, {
        soopId: toLogSafeValue(request.data?.soopId),
        days: request.data?.days,
        imgUrl: toLogSafeValue(request.data?.imgUrl),
        clientRequestId: toLogSafeValue(request.data?.clientRequestId),
      });
      throw err;
    }
  }
);

exports.purchaseAndPublishChartBanner = onCall(
  { cors: true, timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    const functionName = "purchaseAndPublishChartBanner";
    try {
      if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Login required.");
      const uid = request.auth.uid;
      const nickname = String(request.data?.nickname || "").trim();
      const days = toPositiveInt(request.data?.days, 0, 99);
      const imgUrl = String(request.data?.imgUrl || "").trim();
      const link = String(request.data?.link || "").trim();
      const clientRequestId = String(request.data?.clientRequestId || "").trim();

      if (!nickname || nickname.length > 50) throw new HttpsError("invalid-argument", "invalid nickname.");
      if (days < 1 || days > 99) throw new HttpsError("invalid-argument", "days must be 1~99.");
      if (!isValidHttpUrl(imgUrl, 800)) throw new HttpsError("invalid-argument", "invalid imgUrl.");
      if (!isValidHttpUrl(link, 800)) throw new HttpsError("invalid-argument", "invalid link.");
      if (!clientRequestId || !/^[A-Za-z0-9_-]{8,80}$/.test(clientRequestId)) throw new HttpsError("invalid-argument", "invalid clientRequestId.");

      const db = admin.database();
      const cfgSnap = await db.ref("siteConfig").get();
      const pricing = getPricingPoints(cfgSnap.exists() ? cfgSnap.val() : {});
      const pointCost = Math.max(1, days * pricing.chartBannerPerDay);

      const opRef = db.ref(`pointOps/${uid}/chartBanner/${clientRequestId}`);
      const opSnap = await opRef.get();
      const st = String(opSnap.val()?.status || "");
      if (opSnap.exists() && st === "done") return { ok: true, ...opSnap.val() };
      if (opSnap.exists() && st === "processing") throw new HttpsError("failed-precondition", "already processing.");
      await opRef.set({ status: "processing", uid, days, pointCost, createdAt: nowMs() });

      const balanceAfter = await deductPointsOrThrow(db, uid, pointCost);
      const ledgerTxnId = await appendPointLedger(db, uid, {
        type: "purchase_chart_banner",
        amount: -pointCost,
        balanceAfter,
        requestType: "chartBanner",
        requestId: clientRequestId,
        requestPath: `pointOps/${uid}/chartBanner/${clientRequestId}`,
        note: `publish chart banner ${days}d`,
        createdBy: "user",
      });

      const endDate = kstYmdFromNow(days - 1);
      await db.ref("chartBanner").set({
        img: imgUrl,
        link,
        endDate,
        sponsorName: nickname,
        updatedAt: nowMs(),
        updatedByUid: uid,
      });

      const payload = {
        ok: true,
        status: "done",
        clientRequestId,
        uid,
        days,
        pointCost,
        balanceAfter,
        endDate,
        ledgerTxnId,
        doneAt: nowMs(),
      };
      await opRef.set(payload);
      return payload;
    } catch (err) {
      logCallableFailure(functionName, request, err, {
        days: request.data?.days,
        imgUrl: toLogSafeValue(request.data?.imgUrl),
        link: toLogSafeValue(request.data?.link),
        clientRequestId: toLogSafeValue(request.data?.clientRequestId),
      });
      throw err;
    }
  }
);

exports.purchaseAndPublishRelay = onCall(
  { cors: true, timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    const functionName = "purchaseAndPublishRelay";
    try {
      if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Login required.");
      const uid = request.auth.uid;
      const nickname = String(request.data?.nickname || "").trim();
      const soopId = String(request.data?.soopId || "").trim();
      const hours = toPositiveInt(request.data?.hours, 0, 24);
      const regularHours = Math.max(0, Number(request.data?.regularHours || 0));
      const offPeakHours = Math.max(0, Number(request.data?.offPeakHours || 0));
      const clientRequestId = String(request.data?.clientRequestId || "").trim();

      if (!nickname || nickname.length > 80) throw new HttpsError("invalid-argument", "invalid nickname.");
      if (!soopId || soopId.length > 80 || !/^[a-zA-Z0-9_]+$/.test(soopId)) throw new HttpsError("invalid-argument", "invalid soopId.");
      if (hours < 1 || hours > 24) throw new HttpsError("invalid-argument", "hours must be 1~24.");
      if (!clientRequestId || !/^[A-Za-z0-9_-]{8,80}$/.test(clientRequestId)) throw new HttpsError("invalid-argument", "invalid clientRequestId.");

      const db = admin.database();
      const cfgSnap = await db.ref("siteConfig").get();
      const pricing = getPricingPoints(cfgSnap.exists() ? cfgSnap.val() : {});
      const reg = Math.max(0, Math.min(hours, regularHours));
      const off = Math.max(0, Math.min(hours, offPeakHours));
      const pointCost = Math.max(1, Math.floor((off * pricing.relayOffPeakPerHour) + (reg * pricing.relayRegularPerHour)));

      const opRef = db.ref(`pointOps/${uid}/relay/${clientRequestId}`);
      const opSnap = await opRef.get();
      const st = String(opSnap.val()?.status || "");
      if (opSnap.exists() && st === "done") return { ok: true, ...opSnap.val() };
      if (opSnap.exists() && st === "processing") throw new HttpsError("failed-precondition", "already processing.");
      await opRef.set({ status: "processing", uid, soopId, hours, pointCost, createdAt: nowMs() });

      const allSnap = await db.ref("relayRequests").get();
      const now = nowMs();
      const allData = allSnap.exists() ? (allSnap.val() || {}) : {};
      const activeCount = Object.values(allData).filter((v) => v && v.status === "approved" && Number(v.expireAt || 0) > now).length;
      if (activeCount >= 3) {
        await opRef.update({ status: "failed", failedAt: nowMs(), error: "SLOT_FULL" });
        throw new HttpsError("failed-precondition", "relay slots full.");
      }

      const balanceAfter = await deductPointsOrThrow(db, uid, pointCost);
      const ledgerTxnId = await appendPointLedger(db, uid, {
        type: "purchase_relay",
        amount: -pointCost,
        balanceAfter,
        requestType: "relay",
        requestId: clientRequestId,
        requestPath: `pointOps/${uid}/relay/${clientRequestId}`,
        note: `publish relay ${soopId} ${hours}h`,
        createdBy: "user",
      });

      const approvedAt = nowMs();
      const expireAt = approvedAt + (hours * 3600000);
      const reqId = `relay_${uid}_${approvedAt}`;
      await db.ref(`relayRequests/${reqId}`).set({
        nickname,
        soopId,
        hours,
        uid,
        status: "approved",
        createdAt: approvedAt,
        approvedAt,
        expireAt,
        cost: pointCost,
        pointCost,
        paymentStatus: "paid",
        pointTxnId: String(ledgerTxnId || ""),
        regularHours: reg,
        offPeakHours: off,
      });

      const payload = {
        ok: true,
        status: "done",
        clientRequestId,
        uid,
        soopId,
        hours,
        pointCost,
        balanceAfter,
        relayRequestId: reqId,
        approvedAt,
        expireAt,
        ledgerTxnId,
        doneAt: nowMs(),
      };
      await opRef.set(payload);
      return payload;
    } catch (err) {
      logCallableFailure(functionName, request, err, {
        soopId: toLogSafeValue(request.data?.soopId),
        hours: request.data?.hours,
        regularHours: request.data?.regularHours,
        offPeakHours: request.data?.offPeakHours,
        clientRequestId: toLogSafeValue(request.data?.clientRequestId),
      });
      throw err;
    }
  }
);

exports.purchaseAndPublishTitleSponsor = onCall(
  { cors: true, timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    const functionName = "purchaseAndPublishTitleSponsor";
    try {
      // index.html과 동일 규칙에 최대한 가깝게 서버에서도 검증합니다.
      function sanitizeTitleName(raw) {
        return String(raw || "").trim().replace(/\s+/g, " ").slice(0, 16);
      }
      function isTitleNameTooSpammy(name) {
        if (/(.)\1{3,}/.test(name)) return true; // 동일 문자 반복(과도)
        const only = name.replace(/\s+/g, "");
        if (only.length >= 6 && /^(.{1,2})\1+$/.test(only)) return true; // 1~2글자 패턴 반복
        return false;
      }
      function normalizeTitleThemeId(theme) {
        const t = String(theme || "").trim().toLowerCase();
        if (t === "preset2") return "preset2";
        if (t === "preset3") return "preset3";
        return "preset1";
      }

      if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Login required.");
      const uid = request.auth.uid;

      const stockId = String(request.data?.stockId || "").trim();
      const stockName = String(request.data?.stockName || "").trim();
      const titleRaw = request.data?.title;
      const title = sanitizeTitleName(titleRaw);
      const themeRaw = String(request.data?.theme || "preset1").trim();
      const theme = normalizeTitleThemeId(themeRaw);

      const clientRequestId = String(request.data?.clientRequestId || "").trim();

      if (!stockId || stockId.length > 80 || /\s/.test(stockId)) throw new HttpsError("invalid-argument", "invalid stockId.");
      if (!title || title.length < 2 || title.length > 16) throw new HttpsError("invalid-argument", "invalid title.");
      if (isTitleNameTooSpammy(title)) throw new HttpsError("invalid-argument", "title is too spammy.");
      if (!["preset1", "preset2", "preset3"].includes(theme)) throw new HttpsError("invalid-argument", "invalid theme.");
      if (!clientRequestId || !/^[A-Za-z0-9_-]{8,80}$/.test(clientRequestId))
        throw new HttpsError("invalid-argument", "invalid clientRequestId.");

      const db = admin.database();
      const cfgSnap = await db.ref("siteConfig").get();
      const pricing = getPricingPoints(cfgSnap.exists() ? cfgSnap.val() : {});
      const pointCost = pricing.titleSponsorUnitCost;
      const durationMs = 5 * 24 * 60 * 60 * 1000; // default: 5 days

      // 종목당 활성 1개 — 현재 만료가 지나지 않은 "approved+active"면 구매를 막습니다.
      const stockSnap = await db.ref(`stockTitles/${stockId}`).get();
      if (stockSnap.exists()) {
        const cur = stockSnap.val() || {};
        const active = cur.active !== false;
        const approved = String(cur.status || "").toLowerCase() === "approved";
        const expiresAt = Number(cur.expiresAt || 0);
        if (active && approved && expiresAt > nowMs()) {
          throw new HttpsError("failed-precondition", "title already active.");
        }
      }

      const opRef = db.ref(`pointOps/${uid}/titleSponsor/${clientRequestId}`);
      const opSnap = await opRef.get();
      const st = String(opSnap.val()?.status || "");
      if (opSnap.exists() && st === "done") return { ok: true, ...opSnap.val() };
      if (opSnap.exists() && st === "processing") throw new HttpsError("failed-precondition", "already processing.");

      await opRef.set({
        status: "processing",
        uid,
        stockId,
        title,
        theme,
        pointCost,
        createdAt: nowMs(),
      });

      const balanceAfter = await deductPointsOrThrow(db, uid, pointCost);
      const ledgerTxnId = await appendPointLedger(db, uid, {
        type: "purchase_title_sponsor",
        amount: -pointCost,
        balanceAfter,
        requestType: "titleSponsor",
        requestId: clientRequestId,
        requestPath: `pointOps/${uid}/titleSponsor/${clientRequestId}`,
        note: `publish title sponsor ${stockId}`,
        createdBy: "user",
      });

      const now = nowMs();
      const expiresAt = now + durationMs;
      await db.ref(`stockTitles/${stockId}`).set({
        title,
        theme,
        status: "approved",
        active: true,
        uid,
        stockId,
        stockName: stockName || stockId,
        approvedAt: now,
        startedAt: now,
        expiresAt,
        durationMs,
        requestId: clientRequestId,
        updatedAt: now,
        updatedByUid: uid,
      });

      const payload = {
        ok: true,
        status: "done",
        clientRequestId,
        uid,
        stockId,
        stockName: stockName || stockId,
        title,
        theme,
        pointCost,
        balanceAfter,
        expiresAt,
        durationMs,
        ledgerTxnId,
        doneAt: now,
      };

      await opRef.set(payload);
      return payload;
    } catch (err) {
      logCallableFailure(functionName, request, err, {
        stockId: toLogSafeValue(request.data?.stockId),
        clientRequestId: toLogSafeValue(request.data?.clientRequestId),
      });
      throw err;
    }
  }
);

exports.purchaseAndPublishAssetRanking = onCall(
  { cors: true, timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    const functionName = "purchaseAndPublishAssetRanking";
    try {
      if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Login required.");
      const uid = request.auth.uid;

      const nicknameRaw = String(request.data?.nickname || "").trim();
      const soopIdRaw = String(request.data?.soopId || "").trim();
      const soopId = soopIdRaw;
      const clientRequestId = String(request.data?.clientRequestId || "").trim();

      if (!nicknameRaw || nicknameRaw.length > 80) throw new HttpsError("invalid-argument", "invalid nickname.");
      if (!soopId || soopId.length > 50 || !/^[a-zA-Z0-9_]+$/.test(soopId)) throw new HttpsError("invalid-argument", "invalid soopId.");
      if (!clientRequestId || !/^[A-Za-z0-9_-]{8,80}$/.test(clientRequestId)) throw new HttpsError("invalid-argument", "invalid clientRequestId.");

      const db = admin.database();
      const cfgSnap = await db.ref("siteConfig").get();
      const pricing = getPricingPoints(cfgSnap.exists() ? cfgSnap.val() : {});
      const pointCost = Math.max(1, Math.floor(Number(pricing.assetRanking || 0)));

      const RANKING_ACCESS_DURATION_MS = 12 * 60 * 60 * 1000;
      const now = nowMs();
      const accessExpiresAt = now + RANKING_ACCESS_DURATION_MS;

      const opRef = db.ref(`pointOps/${uid}/assetRanking/${clientRequestId}`);
      const opSnap = await opRef.get();
      if (opSnap.exists() && String(opSnap.val()?.status || "").toLowerCase() === "done") {
        return { ok: true, status: "done", ...opSnap.val() };
      }

      const reqRef = db.ref(`assetRankingRequests/${uid}`);
      const reqSnap = await reqRef.get();
      const curReq = reqSnap.exists() ? (reqSnap.val() || {}) : {};
      const curStatus = String(curReq.status || "").toLowerCase();
      const curAccessExpiresAt = Number(curReq.accessExpiresAt || 0);
      const curApprovedAt = Number(curReq.approvedAt || 0);

      // 이미 승인된 기간 내면 중복결제 방지: 승인 상태만 유지
      if (curStatus === "approved") {
        const exp = Number.isFinite(curAccessExpiresAt) && curAccessExpiresAt > 0 ? curAccessExpiresAt : curApprovedAt + RANKING_ACCESS_DURATION_MS;
        if (exp > Date.now()) {
          const walletSnap = await db.ref(`users/${uid}/wallet`).get();
          const balanceAfter = Math.max(0, Math.floor(Number(walletSnap.val()?.points || 0)));
          return {
            ok: true,
            status: "done",
            alreadyActive: true,
            pointCost: 0,
            balanceAfter,
            assetRankingRequest: curReq,
          };
        }
      }

      // 레거시 pending(기존 consumePointsForProduct 경로)라면 포인트는 이미 차감되었을 가능성이 높으므로,
      // 재차감 없이 승인/만료 시각만 승격합니다.
      if (curStatus === "pending") {
        const walletSnap = await db.ref(`users/${uid}/wallet`).get();
        const balanceAfter = Math.max(0, Math.floor(Number(walletSnap.val()?.points || 0)));
        await reqRef.update({
          status: "approved",
          approvedAt: now,
          accessExpiresAt,
          // UI 호환 필드 유지
          cost: curReq.cost ?? pointCost,
          pointCost: curReq.pointCost ?? pointCost,
          paymentStatus: curReq.paymentStatus ?? "paid",
          updatedAt: now,
        });
        await opRef.set({ status: "done", uid, clientRequestId, pointCost: 0, updatedAt: now });
        return {
          ok: true,
          status: "done",
          activatedFromPending: true,
          accessExpiresAt,
          pointCost: 0,
          balanceAfter,
        };
      }

      // 승인/거절/만료 등 다른 상태라면, 새로 포인트 차감 후 승인 publish
      const balanceAfter = await deductPointsOrThrow(db, uid, pointCost);

      const ledgerTxnId = await appendPointLedger(db, uid, {
        type: "purchase_asset_ranking",
        amount: -pointCost,
        balanceAfter,
        requestType: "assetRanking",
        requestId: clientRequestId,
        requestPath: `pointOps/${uid}/assetRanking/${clientRequestId}`,
        note: `publish asset ranking access`,
        createdBy: "user",
      });

      await reqRef.set({
        uid,
        nickname: nicknameRaw,
        soopId,
        status: "approved",
        approvedAt: now,
        accessExpiresAt,
        createdAt: curReq.createdAt ?? now,
        updatedAt: now,
        cost: pointCost,
        pointCost,
        paymentStatus: "paid",
        pointTxnId: String(ledgerTxnId || ""),
      });

      await opRef.set({
        status: "done",
        uid,
        clientRequestId,
        nickname: nicknameRaw,
        soopId,
        pointCost,
        balanceAfter,
        accessExpiresAt,
        assetRankingRequestPath: `assetRankingRequests/${uid}`,
        ledgerTxnId,
        doneAt: nowMs(),
      });

      return { ok: true, status: "done", clientRequestId, uid, pointCost, balanceAfter, accessExpiresAt, ledgerTxnId };
    } catch (err) {
      logCallableFailure(functionName, request, err, {
        nickname: toLogSafeValue(request.data?.nickname),
        soopId: toLogSafeValue(request.data?.soopId),
        clientRequestId: toLogSafeValue(request.data?.clientRequestId),
      });
      throw err;
    }
  }
);

exports.purchaseAndPublishLiveRankingTop100 = onCall(
  { cors: true, timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    const functionName = "purchaseAndPublishLiveRankingTop100";
    try {
      if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Login required.");
      const uid = request.auth.uid;

      const nicknameRaw = String(request.data?.nickname || "").trim();
      const soopIdRaw = String(request.data?.soopId || "").trim();
      const soopId = soopIdRaw;
      const clientRequestId = String(request.data?.clientRequestId || "").trim();

      if (!nicknameRaw || nicknameRaw.length > 80) throw new HttpsError("invalid-argument", "invalid nickname.");
      if (!soopId || soopId.length > 50 || !/^[a-zA-Z0-9_]+$/.test(soopId)) throw new HttpsError("invalid-argument", "invalid soopId.");
      if (!clientRequestId || !/^[A-Za-z0-9_-]{8,80}$/.test(clientRequestId)) throw new HttpsError("invalid-argument", "invalid clientRequestId.");

      const db = admin.database();
      const cfgSnap = await db.ref("siteConfig").get();
      const pricing = getPricingPoints(cfgSnap.exists() ? cfgSnap.val() : {});
      const pointCost = Math.max(1, Math.floor(Number(pricing.liveRankingTop100 || 0)));
      const durationDays = Math.max(1, Math.floor(Number(pricing.liveRankingTop100DurationDays || 7)));

      const now = nowMs();
      const accessExpiresAt = now + durationDays * 24 * 60 * 60 * 1000;

      const opRef = db.ref(`pointOps/${uid}/liveRankingTop100/${clientRequestId}`);
      const opSnap = await opRef.get();
      if (opSnap.exists() && String(opSnap.val()?.status || "").toLowerCase() === "done") {
        return { ok: true, status: "done", ...opSnap.val() };
      }

      const reqRef = db.ref(`liveRankingTop100Requests/${uid}`);
      const reqSnap = await reqRef.get();
      const curReq = reqSnap.exists() ? (reqSnap.val() || {}) : {};
      const curStatus = String(curReq.status || "").toLowerCase();
      const curAccessExpiresAt = Number(curReq.accessExpiresAt || 0);

      // 이미 승인·유효 기간이면 중복 결제 없이 그대로 사용
      if (curStatus === "approved" && Number.isFinite(curAccessExpiresAt) && curAccessExpiresAt > now) {
        const walletSnap = await db.ref(`users/${uid}/wallet`).get();
        const balanceAfter = Math.max(0, Math.floor(Number(walletSnap.val()?.points || 0)));
        return {
          ok: true,
          status: "done",
          alreadyActive: true,
          pointCost: 0,
          balanceAfter,
          liveRankingTop100Request: curReq,
        };
      }

      // 레거시 pending 요청이 있으면, 추가 차감 없이 승인·entitlements만 승격
      if (curStatus === "pending") {
        const walletSnap = await db.ref(`users/${uid}/wallet`).get();
        const balanceAfter = Math.max(0, Math.floor(Number(walletSnap.val()?.points || 0)));
        await db.ref().update({
          [`liveRankingTop100Requests/${uid}/status`]: "approved",
          [`liveRankingTop100Requests/${uid}/approvedAt`]: now,
          [`liveRankingTop100Requests/${uid}/accessExpiresAt`]: accessExpiresAt,
          [`liveRankingTop100Requests/${uid}/durationDays`]: durationDays,
          [`liveRankingTop100Requests/${uid}/cost`]: curReq.cost ?? pointCost,
          [`liveRankingTop100Requests/${uid}/pointCost`]: curReq.pointCost ?? pointCost,
          [`liveRankingTop100Requests/${uid}/paymentStatus`]: curReq.paymentStatus ?? "paid",
          [`liveRankingTop100Requests/${uid}/updatedAt`]: now,
          [`users/${uid}/entitlements/liveRankingTop100ExpiresAt`]: accessExpiresAt,
        });
        await opRef.set({
          status: "done",
          uid,
          clientRequestId,
          pointCost: 0,
          balanceAfter,
          accessExpiresAt,
          activatedFromPending: true,
          updatedAt: now,
        });
        return {
          ok: true,
          status: "done",
          activatedFromPending: true,
          accessExpiresAt,
          pointCost: 0,
          balanceAfter,
          durationDays,
        };
      }

      // 새로 포인트 차감 후 열람권 부여
      const balanceAfter = await deductPointsOrThrow(db, uid, pointCost);
      const ledgerTxnId = await appendPointLedger(db, uid, {
        type: "purchase_live_ranking_top100",
        amount: -pointCost,
        balanceAfter,
        requestType: "liveRankingTop100",
        requestId: clientRequestId,
        requestPath: `pointOps/${uid}/liveRankingTop100/${clientRequestId}`,
        note: "purchase live ranking top100 access",
        createdBy: "user",
      });

      await db.ref().update({
        [`liveRankingTop100Requests/${uid}`]: {
          uid,
          nickname: nicknameRaw,
          soopId,
          status: "approved",
          approvedAt: now,
          accessExpiresAt,
          durationDays,
          createdAt: curReq.createdAt ?? now,
          updatedAt: now,
          cost: pointCost,
          pointCost,
          paymentStatus: "paid",
          pointTxnId: String(ledgerTxnId || ""),
        },
        [`users/${uid}/entitlements/liveRankingTop100ExpiresAt`]: accessExpiresAt,
      });

      const payload = {
        ok: true,
        status: "done",
        clientRequestId,
        uid,
        nickname: nicknameRaw,
        soopId,
        pointCost,
        balanceAfter,
        accessExpiresAt,
        durationDays,
        ledgerTxnId,
        doneAt: now,
      };

      await opRef.set(payload);
      return payload;
    } catch (err) {
      logCallableFailure(functionName, request, err, {
        nickname: toLogSafeValue(request.data?.nickname),
        soopId: toLogSafeValue(request.data?.soopId),
        clientRequestId: toLogSafeValue(request.data?.clientRequestId),
      });
      throw err;
    }
  }
);

exports.transferStarPointsGift = onCall(
  { cors: true, timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Login required.");
    const fromUid = request.auth.uid;
    const toUidRaw = String(request.data?.toUid || "").trim();
    const toGiftCode = String(request.data?.toGiftCode || "").trim();
    const points = toPositiveInt(request.data?.points, 0, 999_999_999);
    const clientRequestId = String(request.data?.clientRequestId || "").trim();
    if (!toUidRaw && !toGiftCode) throw new HttpsError("invalid-argument", "toUid or toGiftCode required.");
    if (!Number.isFinite(points) || points <= 0) throw new HttpsError("invalid-argument", "points must be > 0.");
    if (!clientRequestId) throw new HttpsError("invalid-argument", "clientRequestId required.");
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(clientRequestId)) throw new HttpsError("invalid-argument", "invalid clientRequestId.");

    const db = admin.database();
    let toUid = "";
    let resolvedGiftCode = "";
    if (toGiftCode) {
      if (!/^\d{4}$/.test(toGiftCode)) throw new HttpsError("invalid-argument", "invalid toGiftCode.");
      const mapSnap = await db.ref(`pointGiftCodeMap/${toGiftCode}`).get();
      const mappedUid = String(mapSnap.exists() ? mapSnap.val() : "").trim();
      if (!mappedUid) throw new HttpsError("not-found", "receiver gift code not found.");
      toUid = mappedUid;
      resolvedGiftCode = toGiftCode;
    } else {
      if (!/^[A-Za-z0-9_-]{10,128}$/.test(toUidRaw)) throw new HttpsError("invalid-argument", "invalid toUid.");
      toUid = toUidRaw;
      const codeSnap = await db.ref(`users/${toUid}/pointGiftCode`).get();
      const codeVal = String(codeSnap.exists() ? codeSnap.val() : "").trim();
      if (/^\d{4}$/.test(codeVal)) resolvedGiftCode = codeVal;
    }
    if (toUid === fromUid) throw new HttpsError("invalid-argument", "cannot gift to self.");

    const giftRef = db.ref(`pointGiftRequests/${fromUid}/${clientRequestId}`);
    const giftSnap = await giftRef.get();
    const giftRow = giftSnap.exists() ? (giftSnap.val() || {}) : {};
    if (String(giftRow.status || "").toLowerCase() === "done") {
      return { ok: true, clientRequestId, ...giftRow };
    }
    if (String(giftRow.status || "").toLowerCase() === "processing") {
      throw new HttpsError("failed-precondition", "gift transfer already processing.");
    }

    // 수신자 존재 확인 (없으면 유효하지 않은 요청)
    const toUserSnap = await db.ref(`users/${toUid}`).get();
    if (!toUserSnap.exists()) throw new HttpsError("not-found", "receiver user not found.");

    // processing record
    await giftRef.set({
      fromUid,
      toUid,
      toGiftCode: resolvedGiftCode || null,
      points,
      status: "processing",
      createdAt: nowMs(),
    });

    let fromAfter = 0;
    let toAfter = 0;
    let deducted = false;
    let credited = false;
    let outTxnId = null;
    let inTxnId = null;
    try {
      const fromWalletRef = db.ref(`users/${fromUid}/wallet`);
      const txOut = await fromWalletRef.transaction((cur) => {
        const base = cur && typeof cur === "object" ? cur : {};
        const current = Math.max(0, Math.floor(Number(base.points || 0)));
        if (current < points) throw new Error("INSUFFICIENT_POINTS");
        return {
          ...base,
          points: current - points,
          updatedAt: nowMs(),
        };
      });
      if (!txOut.committed) throw new Error("WALLET_DEDUCT_ABORTED");
      fromAfter = Math.max(0, Math.floor(Number(txOut.snapshot.val()?.points || 0)));
      deducted = true;

      const toWalletRef = db.ref(`users/${toUid}/wallet`);
      const txIn = await toWalletRef.transaction((cur) => {
        const base = cur && typeof cur === "object" ? cur : {};
        const current = Math.max(0, Math.floor(Number(base.points || 0)));
        const next = current + points;
        if (next > 999_999_999) throw new Error("RECIPIENT_POINTS_OVERFLOW");
        return {
          ...base,
          points: next,
          updatedAt: nowMs(),
        };
      });
      if (!txIn.committed) throw new Error("WALLET_CREDIT_ABORTED");
      credited = true;

      toAfter = Math.max(0, Math.floor(Number(txIn.snapshot.val()?.points || 0)));

      outTxnId = await appendPointLedger(db, fromUid, {
        type: "gift_out",
        amount: -points,
        balanceAfter: fromAfter,
        requestType: "pointGiftRequests",
        requestId: clientRequestId,
        requestPath: `pointGiftRequests/${fromUid}/${clientRequestId}`,
        note: "star points gift",
        createdBy: "user",
      });
      inTxnId = await appendPointLedger(db, toUid, {
        type: "gift_in",
        amount: points,
        balanceAfter: toAfter,
        requestType: "pointGiftRequests",
        requestId: clientRequestId,
        requestPath: `pointGiftRequests/${fromUid}/${clientRequestId}`,
        note: "star points received",
        createdBy: "user",
      });

      await giftRef.update({
        status: "done",
        doneAt: nowMs(),
        toGiftCode: resolvedGiftCode || null,
        outTxnId,
        inTxnId,
        fromAfter,
        toAfter,
      });

      return { ok: true, clientRequestId, outTxnId, inTxnId, fromAfter, toAfter, toGiftCode: resolvedGiftCode || null };
    } catch (e) {
      const msg = String(e?.message || e || "");
      // ledger 기록(out/in)이 하나도 없을 때만 롤백을 시도합니다.
      // ledger까지 들어간 상태를 되돌리면 원장과 지갑이 불일치할 수 있어서 방지합니다.
      if (deducted && credited && !outTxnId && !inTxnId) {
        try {
          // 수신자 포인트 차감(= 롤백)
          await db.ref(`users/${toUid}/wallet`).transaction((cur) => {
            const base = cur && typeof cur === "object" ? cur : {};
            const current = Math.max(0, Math.floor(Number(base.points || 0)));
            if (current < points) throw new Error("ROLLBACK_RECIPIENT_UNDERFLOW");
            return { ...base, points: current - points, updatedAt: nowMs() };
          });
          // 송신자 포인트 복구
          await db.ref(`users/${fromUid}/wallet`).transaction((cur) => {
            const base = cur && typeof cur === "object" ? cur : {};
            const current = Math.max(0, Math.floor(Number(base.points || 0)));
            return { ...base, points: current + points, updatedAt: nowMs() };
          });
        } catch (_) { /* noop */ }
      }

      await giftRef.update({
        status: "failed",
        failedAt: nowMs(),
        error: msg.slice(0, 200),
      });

      if (/INSUFFICIENT_POINTS/i.test(msg)) throw new HttpsError("failed-precondition", "insufficient points.");
      throw new HttpsError("aborted", msg || "gift failed.");
    }
  }
);

exports.getMyPointGiftCode = onCall(
  { cors: true, timeoutSeconds: 60, memory: "256MiB" },
  async (request) => {
    if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Login required.");
    const uid = request.auth.uid;
    const db = admin.database();

    const existingSnap = await db.ref(`users/${uid}/pointGiftCode`).get();
    const existingCode = String(existingSnap.exists() ? existingSnap.val() : "").trim();
    if (/^\d{4}$/.test(existingCode)) {
      const mapRef = db.ref(`pointGiftCodeMap/${existingCode}`);
      const tx = await mapRef.transaction((cur) => {
        if (!cur) return uid;
        if (String(cur) === uid) return cur;
        return;
      });
      if (tx.committed || String(tx.snapshot?.val() || "") === uid) {
        return { ok: true, giftCode: existingCode };
      }
    }

    for (let i = 0; i < 40; i++) {
      const code = String(1000 + crypto.randomInt(9000));
      const mapRef = db.ref(`pointGiftCodeMap/${code}`);
      const tx = await mapRef.transaction((cur) => (cur ? undefined : uid));
      if (!tx.committed) continue;
      await db.ref(`users/${uid}/pointGiftCode`).set(code);
      return { ok: true, giftCode: code };
    }
    throw new HttpsError("resource-exhausted", "no available gift code.");
  }
);

exports.consumePointsForProduct = onCall(
  { cors: true, timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Login required.");
    const uid = request.auth.uid;
    const productType = String(request.data?.productType || "").trim();
    const payload = request.data?.payload && typeof request.data.payload === "object" ? request.data.payload : {};
    const now = nowMs();
    const db = admin.database();
    const cfgSnap = await db.ref("siteConfig").get();
    const pricing = getPricingPoints(cfgSnap.exists() ? cfgSnap.val() : {});

    let requestPath = "";
    let writePayload = null;
    let pointCost = 0;

    if (productType === "liveRankingTop100") {
      const nickname = String(payload.nickname || "").trim();
      const soopId = String(payload.soopId || "").trim();
      if (!nickname || !soopId) throw new HttpsError("invalid-argument", "nickname/soopId required.");
      pointCost = pricing.liveRankingTop100;
      const durationDays = pricing.liveRankingTop100DurationDays;
      requestPath = `liveRankingTop100Requests/${uid}`;
      writePayload = {
        nickname,
        soopId,
        uid,
        status: "pending",
        createdAt: now,
        cost: pointCost,
        pointCost,
        paymentStatus: "paid",
        pointTxnId: "",
        durationDays,
      };
    } else if (productType === "assetRanking") {
      const nickname = String(payload.nickname || "").trim();
      const soopId = String(payload.soopId || "").trim();
      if (!nickname || !soopId) throw new HttpsError("invalid-argument", "nickname/soopId required.");
      pointCost = pricing.assetRanking;
      requestPath = `assetRankingRequests/${uid}`;
      writePayload = {
        nickname,
        soopId,
        uid,
        status: "pending",
        createdAt: now,
        cost: pointCost,
        pointCost,
        paymentStatus: "paid",
        pointTxnId: "",
      };
    } else if (productType === "relay") {
      const nickname = String(payload.nickname || "").trim();
      const soopId = String(payload.soopId || "").trim();
      const hours = toPositiveInt(payload.hours, 0, 24);
      if (!nickname || !soopId || hours < 1 || hours > 24) throw new HttpsError("invalid-argument", "invalid relay payload.");
      const offPeak = Number(payload.offPeakHours || 0);
      const regular = Number(payload.regularHours || 0);
      pointCost = Math.max(1, Math.floor((offPeak * pricing.relayOffPeakPerHour) + (regular * pricing.relayRegularPerHour)));
      const reqId = `relay_${uid}_${now}`;
      requestPath = `relayRequests/${reqId}`;
      writePayload = {
        nickname,
        soopId,
        hours,
        uid,
        status: "pending",
        createdAt: now,
        cost: pointCost,
        pointCost,
        paymentStatus: "paid",
        pointTxnId: "",
      };
    } else if (productType === "promoBanner") {
      const nickname = String(payload.nickname || "").trim();
      const soopId = String(payload.soopId || "").trim();
      const days = toPositiveInt(payload.days, 0, 30);
      if (!nickname || !soopId || days < 1 || days > 30) throw new HttpsError("invalid-argument", "invalid promo payload.");
      pointCost = days * pricing.broadcastBannerPerDay;
      const reqId = `${soopId}_${now}`;
      requestPath = `adRequests/${reqId}`;
      writePayload = {
        nickname,
        soopId,
        days,
        imgUrl: String(payload.imgUrl || ""),
        link: String(payload.link || ""),
        uid,
        status: "pending",
        createdAt: now,
        cost: pointCost,
        pointCost,
        paymentStatus: "paid",
        pointTxnId: "",
      };
    } else if (productType === "chartBanner") {
      const nickname = String(payload.nickname || "").trim();
      const imgUrl = String(payload.imgUrl || "").trim();
      const link = String(payload.link || "").trim();
      const days = toPositiveInt(payload.days, 0, 99);
      if (!nickname || !imgUrl || !link || days < 1 || days > 99) throw new HttpsError("invalid-argument", "invalid chart payload.");
      pointCost = days * pricing.chartBannerPerDay;
      const reqId = `chart_${uid}_${now}`;
      requestPath = `chartAdRequests/${reqId}`;
      writePayload = {
        nickname,
        imgUrl,
        link,
        days,
        uid,
        status: "pending",
        createdAt: now,
        cost: pointCost,
        pointCost,
        paymentStatus: "paid",
        pointTxnId: "",
      };
    } else if (productType === "titleSponsor") {
      const stockId = String(payload.stockId || "").trim();
      const stockName = String(payload.stockName || "").trim();
      const market = String(payload.market || "stock").trim();
      const title = String(payload.title || "").trim();
      const theme = String(payload.theme || "preset1").trim();
      if (!stockId || !title) throw new HttpsError("invalid-argument", "invalid title payload.");
      pointCost = pricing.titleSponsorUnitCost;
      const reqId = `title_${uid}_${now}`;
      requestPath = `titleRequests/${reqId}`;
      writePayload = {
        uid,
        stockId,
        stockName,
        market,
        title,
        theme,
        status: "pending",
        cost: pointCost,
        pointCost,
        paymentStatus: "paid",
        pointTxnId: "",
        durationMs: Number(payload.durationMs || 5 * 24 * 60 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
      };
    } else {
      throw new HttpsError("invalid-argument", "unsupported productType.");
    }

    const reqRef = db.ref(requestPath);
    const reqSnap = await reqRef.get();
    if (reqSnap.exists()) {
      const st = String(reqSnap.val()?.status || "");
      if (st === "pending" || st === "approved") {
        throw new HttpsError("failed-precondition", "already requested.");
      }
    }

    const walletRef = db.ref(`users/${uid}/wallet`);
    const tx = await walletRef.transaction((cur) => {
      const base = cur && typeof cur === "object" ? cur : {};
      const points = Math.max(0, Math.floor(Number(base.points || 0)));
      if (points < pointCost) return;
      return {
        ...base,
        points: points - pointCost,
        updatedAt: nowMs(),
      };
    });
    if (!tx.committed) throw new HttpsError("failed-precondition", "insufficient-points");
    const after = Math.max(0, Math.floor(Number(tx.snapshot.val()?.points || 0)));
    const txnId = await appendPointLedger(db, uid, {
      type: "consume",
      amount: -pointCost,
      balanceAfter: after,
      requestType: productType,
      requestId: requestPath.split("/").pop() || "",
      requestPath,
      note: "consume points for paid product",
      createdBy: uid,
    });
    writePayload.pointTxnId = txnId;
    writePayload.pointDebitedAt = now;
    await reqRef.set(writePayload);
    return { ok: true, productType, pointCost, balanceAfter: after, requestPath, txnId };
  }
);

exports.adminRejectPaidRequestWithRefund = onCall(
  { cors: true, timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    if (!isAdminAuth(request.auth)) throw new HttpsError("permission-denied", "Admin only.");
    const requestPath = String(request.data?.requestPath || "").trim();
    const rejectStatus = String(request.data?.status || "rejected").trim();
    if (!requestPath || !requestPath.includes("/")) throw new HttpsError("invalid-argument", "requestPath required.");
    const db = admin.database();
    const reqRef = db.ref(requestPath);
    const snap = await reqRef.get();
    if (!snap.exists()) throw new HttpsError("not-found", "request not found.");
    const row = snap.val() || {};
    const uid = String(row.uid || "");
    if (!uid) throw new HttpsError("failed-precondition", "uid missing.");
    const prevStatus = String(row.status || "");
    if (prevStatus !== "pending") throw new HttpsError("failed-precondition", "not pending.");
    const pointCost = Math.max(0, Math.floor(Number((row.pointCost ?? row.cost) || 0)));
    const paymentStatus = String(row.paymentStatus || "");

    let refunded = 0;
    let balanceAfter = null;
    if (pointCost > 0 && paymentStatus === "paid") {
      const walletRef = db.ref(`users/${uid}/wallet`);
      const tx = await walletRef.transaction((cur) => {
        const base = cur && typeof cur === "object" ? cur : {};
        const points = Math.max(0, Math.floor(Number(base.points || 0)));
        return {
          ...base,
          points: points + pointCost,
          updatedAt: nowMs(),
        };
      });
      if (!tx.committed) throw new HttpsError("aborted", "wallet refund failed.");
      balanceAfter = Math.max(0, Math.floor(Number(tx.snapshot.val()?.points || 0)));
      refunded = pointCost;
      await appendPointLedger(db, uid, {
        type: "refund",
        amount: pointCost,
        balanceAfter,
        requestType: requestPath.split("/")[0],
        requestId: requestPath.split("/")[1] || "",
        requestPath,
        note: "admin reject refund",
        createdBy: String(request.auth?.token?.email || ADMIN_EMAIL),
      });
    }
    await reqRef.update({
      status: rejectStatus,
      rejectedAt: nowMs(),
      rejectedBy: String(request.auth?.token?.email || ADMIN_EMAIL),
      paymentStatus: refunded > 0 ? "refunded" : paymentStatus || "none",
      refundedPoints: refunded,
      refundedAt: refunded > 0 ? nowMs() : null,
    });
    return { ok: true, requestPath, refundedPoints: refunded, balanceAfter };
  }
);

/** 관리자: stocks 기준으로 coins 미존재 종목 생성(시가 1억원) */
exports.adminSyncCoinsFromStocks = onCall(
  { cors: true, timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    if (!isAdminAuth(request.auth)) {
      throw new HttpsError("permission-denied", "Admin only.");
    }
    const db = admin.database();
    const now = Date.now();
    const [stocksSnap, coinsSnap] = await Promise.all([
      db.ref("stocks").get(),
      db.ref("coins").get(),
    ]);
    const stocks = stocksSnap.exists() ? stocksSnap.val() || {} : {};
    const coins = coinsSnap.exists() ? coinsSnap.val() || {} : {};
    const INITIAL = 100000000;
    const updates = {};
    let created = 0;

    Object.entries(stocks).forEach(([id, row]) => {
      if (coins[id]) return;
      const name = String(row?.name || "");
      updates[`coins/${id}`] = {
        name,
        price: INITIAL,
        volume: 0,
        buyVol: 0,
        sellVol: 0,
        change: "0.00",
      };
      if (name) updates[`coinSearchIndex/${id}/name`] = name;
      created++;
    });

    if (!created) return { ok: true, created: 0 };
    updates["siteConfig/coinNameIndexVersion"] = now;
    updates["siteConfig/stockCacheVersion"] = now;
    await db.ref().update(updates);
    return { ok: true, created };
  }
);

const CHALLENGE_STOCK_OPEN_WON = 10000;
const CHALLENGE_COIN_OPEN_WON = 100000000;
const CHALLENGE_DAILY_CASH_WON = 10000000;

/** 관리자: 메인 stocks/coins 기준으로 챌린지 시장 노드만 동기화(유저 청산 없음). 최초 배포·수동 동기화용 */
exports.adminSyncChallengeMarketsFromMain = onCall(
  { cors: true, timeoutSeconds: 300, memory: "512MiB" },
  async (request) => {
    if (!isAdminAuth(request.auth)) {
      throw new HttpsError("permission-denied", "Admin only.");
    }
    const db = admin.database();
    const [stocksSnap, coinsSnap, chStockSnap, chCoinSnap] = await Promise.all([
      db.ref("stocks").get(),
      db.ref("coins").get(),
      db.ref("challengeStocks").get(),
      db.ref("challengeCoins").get(),
    ]);
    const stocks = stocksSnap.exists() ? stocksSnap.val() || {} : {};
    const coins = coinsSnap.exists() ? coinsSnap.val() || {} : {};
    const chStocks = chStockSnap.exists() ? chStockSnap.val() || {} : {};
    const chCoins = chCoinSnap.exists() ? chCoinSnap.val() || {} : {};
    const chSUp = {};
    Object.entries(stocks).forEach(([id, row]) => {
      const name = String(row?.name || "");
      const cur = chStocks[id] ? normalizeStockRow(chStocks[id]) : null;
      const p = Math.max(1, Math.floor(Number(cur?.price || 0)) || CHALLENGE_STOCK_OPEN_WON);
      chSUp[`challengeStocks/${id}`] = {
        name,
        price: p,
        volume: Number(cur?.volume || 0) || 0,
        buyVol: Number(cur?.buyVol || 0) || 0,
        sellVol: Number(cur?.sellVol || 0) || 0,
        change: cur?.change != null ? String(cur.change) : "0.00",
        history: Array.isArray(cur?.history) && cur.history.length ? cur.history : [p],
      };
    });
    Object.keys(chStocks).forEach((id) => {
      if (!stocks[id]) chSUp[`challengeStocks/${id}`] = null;
    });
    const chCUp = {};
    Object.entries(coins).forEach(([id, row]) => {
      const name = String(row?.name || "");
      const cur = chCoins[id] ? normalizeStockRow(chCoins[id]) : null;
      const p = Math.max(1, Math.floor(Number(cur?.price || 0)) || CHALLENGE_COIN_OPEN_WON);
      chCUp[`challengeCoins/${id}`] = {
        name,
        price: p,
        volume: Number(cur?.volume || 0) || 0,
        buyVol: Number(cur?.buyVol || 0) || 0,
        sellVol: Number(cur?.sellVol || 0) || 0,
        change: cur?.change != null ? String(cur.change) : "0.0000",
        history: Array.isArray(cur?.history) && cur.history.length ? cur.history : [p],
      };
    });
    Object.keys(chCoins).forEach((id) => {
      if (!coins[id]) chCUp[`challengeCoins/${id}`] = null;
    });
    const CHUNK = 400;
    const allKeys = [...Object.keys(chSUp), ...Object.keys(chCUp)];
    for (let i = 0; i < allKeys.length; i += CHUNK) {
      const patch = {};
      allKeys.slice(i, i + CHUNK).forEach((k) => {
        patch[k] = chSUp[k] !== undefined ? chSUp[k] : chCUp[k];
      });
      await db.ref().update(patch);
    }
    const rankR = await runMarketRankChallengeAggregation(db, { skipIfMarketClosed: false });
    return { ok: true, stockIds: Object.keys(stocks).length, coinIds: Object.keys(coins).length, rank: rankR };
  }
);

exports.submitChallengeSupporterVerify = onCall(
  { cors: true, timeoutSeconds: 30, memory: "256MiB" },
  async (request) => {
    const auth = request.auth;
    if (!auth?.uid) throw new HttpsError("unauthenticated", "Login required.");
    if (String(auth.token?.firebase?.sign_in_provider || "") !== "google.com") {
      throw new HttpsError("failed-precondition", "Google 로그인 계정만 신청할 수 있습니다.");
    }
    const nickname = String(request.data?.nickname || "").trim();
    const soopId = String(request.data?.soopId || "").trim();
    if (!nickname || nickname.length > 80) {
      throw new HttpsError("invalid-argument", "닉네임을 입력해 주세요. (최대 80자)");
    }
    if (!soopId || soopId.length > 80) {
      throw new HttpsError("invalid-argument", "SOOP 아이디를 입력해 주세요. (최대 80자)");
    }
    const db = admin.database();
    const pendingSnap = await db
      .ref("challengeSupporterRequests")
      .orderByChild("uid")
      .equalTo(auth.uid)
      .limitToFirst(20)
      .get();
    if (pendingSnap.exists()) {
      const rows = pendingSnap.val() || {};
      for (const v of Object.values(rows)) {
        if (v && v.status === "pending") {
          throw new HttpsError("failed-precondition", "이미 검수 대기 중인 신청이 있습니다.");
        }
      }
    }
    const key = db.ref("challengeSupporterRequests").push().key;
    if (!key) throw new HttpsError("internal", "push key failed");
    await db.ref(`challengeSupporterRequests/${key}`).set({
      uid: auth.uid,
      email: String(auth.token?.email || ""),
      nickname,
      soopId,
      status: "pending",
      createdAt: Date.now(),
    });
    return { ok: true, requestId: key };
  }
);

exports.adminRunChallengeDailyReset = onCall(
  { cors: true, timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    if (!isAdminAuth(request.auth)) {
      throw new HttpsError("permission-denied", "Admin only.");
    }
    const db = admin.database();
    return await runDailyChallengeResetServer(db);
  }
);

exports.adminReviewChallengeSupporterRequest = onCall(
  { cors: true, timeoutSeconds: 60, memory: "256MiB" },
  async (request) => {
    if (!isAdminAuth(request.auth)) {
      throw new HttpsError("permission-denied", "Admin only.");
    }
    const reqId = String(request.data?.requestId || "").trim();
    const approve = request.data?.approve === true;
    if (!reqId) throw new HttpsError("invalid-argument", "requestId required.");
    const db = admin.database();
    const rref = db.ref(`challengeSupporterRequests/${reqId}`);
    const snap = await rref.get();
    if (!snap.exists()) throw new HttpsError("not-found", "요청을 찾을 수 없습니다.");
    const row = snap.val() || {};
    if (row.status !== "pending") {
      throw new HttpsError("failed-precondition", "이미 처리된 요청입니다.");
    }
    const targetUid = String(row.uid || "");
    if (!targetUid) throw new HttpsError("failed-precondition", "uid 없음");
    const now = Date.now();
    if (approve) {
      await db.ref().update({
        [`challengeSupporterRequests/${reqId}/status`]: "approved",
        [`challengeSupporterRequests/${reqId}/reviewedAt`]: now,
        [`challengeSupporterRequests/${reqId}/reviewedBy`]: String(request.auth?.token?.email || ""),
        [`users/${targetUid}/entitlements/challengeSupporterVerified`]: true,
      });
      return { ok: true, approved: true, uid: targetUid };
    }
    await rref.update({
      status: "rejected",
      reviewedAt: now,
      reviewedBy: String(request.auth?.token?.email || ""),
    });
    return { ok: true, approved: false, uid: targetUid };
  }
);

/** 챌린지 모드 거래 시 users 노드에 메인·챌린지 포트폴리오를 동시에 유지 */
function packUserTradeResult(u, challengeModeReq, isCoin, cashOut, stockBookOut, coinBookOut) {
  const base = { ...u, lastTradeTime: null };
  if (!challengeModeReq) {
    base.cash = cashOut;
    base.stocks = stockBookOut;
    base.coins = coinBookOut;
    return base;
  }
  base.challengeCash = cashOut;
  base.stocks = u.stocks && typeof u.stocks === "object" ? u.stocks : {};
  base.coins = u.coins && typeof u.coins === "object" ? u.coins : {};
  base.challengeStocks = stockBookOut;
  base.challengeCoins = coinBookOut;
  return base;
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
  const inverseModeReq = Boolean(req.data?.inverseMode);
  const challengeModeReq = Boolean(req.data?.challengeMode);

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

  if (!isCoin && !challengeModeReq) {
    const frozenMap = siteConfig.frozenStocks || {};
    const frozenUntil = Number(frozenMap?.[stockId] || 0);
    if (frozenUntil > Date.now() && !isAdminAuth(auth)) {
      throw new HttpsError("failed-precondition", "Circuit breaker active.");
    }
  }

  const sellConfig = siteConfig.sellConfig || {};
  const marketParams = siteConfig.marketParams || {};
  const standardFee = Number(sellConfig.fee ?? 0.003);
  const fee = resolveTradeFee(standardFee, sellConfig, inverseModeReq);

  const preUser = preUserSnap.exists() ? preUserSnap.val() : { cash: 1000000, stocks: {}, coins: {} };
  assertUserTradeRestrictionAllowed(auth, preUser);
  assertServerTradeCooldownAllowed(auth, siteConfig, preUser);
  if (challengeModeReq && !isAdminAuth(auth)) {
    const provider = String(auth.token?.firebase?.sign_in_provider || "");
    if (provider !== "google.com") {
      throw new HttpsError("failed-precondition", "챌린지 모드는 Google 로그인이 필요합니다.");
    }
    if (preUser?.entitlements?.challengeSupporterVerified !== true) {
      throw new HttpsError(
        "permission-denied",
        "챌린지 모드는 후원자 인증(별풍선 100개 이상) 승인 후 이용할 수 있습니다."
      );
    }
  }
  if (challengeModeReq && isCoin) {
    throw new HttpsError("failed-precondition", "챌린지 모드는 주식시장만 지원합니다.");
  }
  /** RTDB 트랜잭션 콜백에서 cur가 null로만 오는 경우 대비 */
  const userSeedForTx = JSON.parse(JSON.stringify(preUser));
  const preCash = Number(challengeModeReq ? preUser.challengeCash ?? CHALLENGE_DAILY_CASH_WON : preUser.cash ?? 1000000);
  const preStocksMap = challengeModeReq
    ? preUser.challengeStocks && typeof preUser.challengeStocks === "object"
      ? preUser.challengeStocks
      : {}
    : preUser.stocks && typeof preUser.stocks === "object"
      ? preUser.stocks
      : {};
  const preCoinsMap = challengeModeReq
    ? preUser.challengeCoins && typeof preUser.challengeCoins === "object"
      ? preUser.challengeCoins
      : {}
    : preUser.coins && typeof preUser.coins === "object"
      ? preUser.coins
      : {};
  const preBookPos = isCoin ? preCoinsMap[stockId] || { qty: 0, avg: 0 } : preStocksMap[stockId] || { qty: 0, avg: 0 };
  const preHaveQty = Math.floor(Number(preBookPos.qty || 0));
  const invertPrice = inverseModeReq;

  const stockPath = challengeModeReq ? (isCoin ? "challengeCoins" : "challengeStocks") : isCoin ? "coins" : "stocks";
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
    isCoin,
    invertPrice
  );

  if (!isAdminAuth(auth)) {
    if (side === "buy") {
      const bookForLimit = isCoin ? preCoinsMap : preStocksMap;
      if (preHaveQty === 0) {
        const ownedCount = Object.values(bookForLimit).filter((s) => Math.floor(Number(s?.qty || 0)) !== 0).length;
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
      if (preHaveQty > 0 && preHaveQty < qty) {
        throw new HttpsError("failed-precondition", "보유 수량이 부족합니다.");
      }
      if (preHaveQty < 0 && preHaveQty > -qty) {
        throw new HttpsError("failed-precondition", "보유 수량이 부족합니다.");
      }
      if (preHaveQty === 0) {
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
          isCoin,
          invertPrice
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
    const u = effectiveCur != null ? effectiveCur : { cash: 1000000, challengeCash: CHALLENGE_DAILY_CASH_WON, stocks: {}, coins: {} };
    const cash = Number(challengeModeReq ? u.challengeCash ?? CHALLENGE_DAILY_CASH_WON : u.cash ?? 1000000);
    const mainStocks = u.stocks && typeof u.stocks === "object" ? u.stocks : {};
    const mainCoins = u.coins && typeof u.coins === "object" ? u.coins : {};
    const chStocks = u.challengeStocks && typeof u.challengeStocks === "object" ? u.challengeStocks : {};
    const chCoins = u.challengeCoins && typeof u.challengeCoins === "object" ? u.challengeCoins : {};
    const stocks = challengeModeReq ? chStocks : mainStocks;
    const coins = challengeModeReq ? chCoins : mainCoins;
    const finish = (cashOut, stockBookOut, coinBookOut) =>
      packUserTradeResult(u, challengeModeReq, isCoin, cashOut, stockBookOut, coinBookOut);

    if (isCoin) {
      const us = coins[stockId] || { qty: 0, avg: 0 };
      const haveQty = Math.floor(Number(us.qty || 0));
      const haveAvg = Math.round(Number(us.avg || 0));

      if (side === "buy") {
        const total = lastTradePrice * qty;
        if (cash < total && !isAdminAuth(auth)) return undefined;
        if (!isAdminAuth(auth) && haveQty === 0) {
          const ownedCount = Object.values(coins).filter((s) => Math.floor(Number(s?.qty || 0)) !== 0).length;
          if (ownedCount >= 10) return undefined;
        }
        if (inverseModeReq) {
          const newQty = haveQty - qty;
          const nextCoins = { ...coins };
          if (newQty === 0) {
            nextCoins[stockId] = null;
          } else if (haveQty > 0 && newQty > 0) {
            // 롱 유지 구간: 기존 평균단가 유지
            nextCoins[stockId] = { qty: newQty, avg: haveAvg };
          } else if (newQty < 0) {
            // 숏 진입/확대 구간: 신규 숏 체결가를 기준으로 평균단가 갱신
            if (haveQty < 0) {
              const absOld = Math.abs(haveQty);
              const absNew = Math.abs(newQty);
              const weighted = absOld * haveAvg + lastTradePrice * qty;
              nextCoins[stockId] = { qty: newQty, avg: Math.round(weighted / absNew) };
            } else {
              nextCoins[stockId] = { qty: newQty, avg: Math.round(lastTradePrice) };
            }
          } else {
            nextCoins[stockId] = { qty: newQty, avg: haveAvg };
          }
          return finish(cash - total, stocks, nextCoins);
        }
        if (haveQty < 0) {
          const newQty = haveQty + qty;
          const nextCoins = { ...coins };
          if (newQty === 0) {
            nextCoins[stockId] = null;
          } else if (newQty < 0) {
            // 숏 유지 구간: 기존 평균단가 유지
            nextCoins[stockId] = { qty: newQty, avg: haveAvg };
          } else {
            // 롱 전환 구간: 남은 롱 수량의 기준단가는 전환 시점 체결가
            nextCoins[stockId] = { qty: newQty, avg: Math.round(lastTradePrice) };
          }
          return finish(cash - total, stocks, nextCoins);
        }
        if (haveQty > 0) {
          const totalCost = haveQty * haveAvg + total;
          const newQty = haveQty + qty;
          return finish(cash - total, stocks, {
            ...coins,
            [stockId]: { qty: newQty, avg: Math.round(totalCost / newQty) },
          });
        }
        if (haveQty === 0) {
          if (inverseModeReq) {
            return finish(cash - total, stocks, {
              ...coins,
              [stockId]: { qty: -qty, avg: Math.round(lastTradePrice) },
            });
          }
          return finish(cash - total, stocks, {
            ...coins,
            [stockId]: { qty: qty, avg: Math.round(lastTradePrice) },
          });
        }
        return finish(cash - total, stocks, {
          ...coins,
          [stockId]: { qty: qty, avg: Math.round(lastTradePrice) },
        });
      }

      if (haveQty > 0) {
        if (haveQty < qty && !isAdminAuth(auth)) return undefined;
        const receive = Math.round(lastTradePrice * qty * (1 - fee));
        const newQty = haveQty - qty;
        const nextCoins = { ...coins };
        if (newQty <= 0) {
          nextCoins[stockId] = null;
        } else {
          nextCoins[stockId] = { qty: newQty, avg: haveAvg };
        }
        return finish(cash + receive, stocks, nextCoins);
      }
      if (haveQty < 0) {
        if (haveQty > -qty && !isAdminAuth(auth)) return undefined;
        const receive = Math.round(lastTradePrice * qty * (1 - fee));
        const newQty = haveQty + qty;
        const nextCoins = { ...coins };
        if (newQty === 0) {
          nextCoins[stockId] = null;
        } else {
          nextCoins[stockId] = { qty: newQty, avg: haveAvg };
        }
        return finish(cash + receive, stocks, nextCoins);
      }
      return undefined;
    }

    const us = stocks[stockId] || { qty: 0, avg: 0 };
    const haveQty = Math.floor(Number(us.qty || 0));
    const haveAvg = Math.round(Number(us.avg || 0));

    if (side === "buy") {
      const total = lastTradePrice * qty;
      if (cash < total && !isAdminAuth(auth)) return undefined;
      if (!isAdminAuth(auth) && haveQty === 0) {
        const ownedCount = Object.values(stocks).filter((s) => Math.floor(Number(s?.qty || 0)) !== 0).length;
        if (ownedCount >= 10) return undefined;
      }
      if (inverseModeReq) {
        const newQty = haveQty - qty;
        const nextStocks = { ...stocks };
        if (newQty === 0) {
          nextStocks[stockId] = null;
        } else if (haveQty > 0 && newQty > 0) {
          // 롱 유지 구간: 기존 평균단가 유지
          nextStocks[stockId] = { qty: newQty, avg: haveAvg };
        } else if (newQty < 0) {
          // 숏 진입/확대 구간: 신규 숏 체결가를 기준으로 평균단가 갱신
          if (haveQty < 0) {
            const absOld = Math.abs(haveQty);
            const absNew = Math.abs(newQty);
            const weighted = absOld * haveAvg + lastTradePrice * qty;
            nextStocks[stockId] = { qty: newQty, avg: Math.round(weighted / absNew) };
          } else {
            nextStocks[stockId] = { qty: newQty, avg: Math.round(lastTradePrice) };
          }
        } else {
          nextStocks[stockId] = { qty: newQty, avg: haveAvg };
        }
        return finish(cash - total, nextStocks, coins);
      }
      if (haveQty < 0) {
        const newQty = haveQty + qty;
        const nextStocks = { ...stocks };
        if (newQty === 0) {
          nextStocks[stockId] = null;
        } else if (newQty < 0) {
          // 숏 유지 구간: 기존 평균단가 유지
          nextStocks[stockId] = { qty: newQty, avg: haveAvg };
        } else {
          // 롱 전환 구간: 남은 롱 수량의 기준단가는 전환 시점 체결가
          nextStocks[stockId] = { qty: newQty, avg: Math.round(lastTradePrice) };
        }
        return finish(cash - total, nextStocks, coins);
      }
      if (haveQty > 0) {
        const totalCost = haveQty * haveAvg + total;
        const newQty = haveQty + qty;
        return finish(cash - total, { ...stocks, [stockId]: { qty: newQty, avg: Math.round(totalCost / newQty) } }, coins);
      }
      if (haveQty === 0) {
        if (inverseModeReq) {
          return finish(cash - total, { ...stocks, [stockId]: { qty: -qty, avg: Math.round(lastTradePrice) } }, coins);
        }
        return finish(cash - total, { ...stocks, [stockId]: { qty: qty, avg: Math.round(lastTradePrice) } }, coins);
      }
      return finish(cash - total, { ...stocks, [stockId]: { qty: qty, avg: Math.round(lastTradePrice) } }, coins);
    }

    if (haveQty > 0) {
      if (haveQty < qty && !isAdminAuth(auth)) return undefined;
      const receive = Math.round(lastTradePrice * qty * (1 - fee));
      const newQty = haveQty - qty;
      const nextStocks = { ...stocks };
      if (newQty <= 0) {
        nextStocks[stockId] = null;
      } else {
        nextStocks[stockId] = { qty: newQty, avg: haveAvg };
      }
      return finish(cash + receive, nextStocks, coins);
    }
    if (haveQty < 0) {
      if (haveQty > -qty && !isAdminAuth(auth)) return undefined;
      const receive = Math.round(lastTradePrice * qty * (1 - fee));
      const newQty = haveQty + qty;
      const nextStocks = { ...stocks };
      if (newQty === 0) {
        nextStocks[stockId] = null;
      } else {
        nextStocks[stockId] = { qty: newQty, avg: haveAvg };
      }
      return finish(cash + receive, nextStocks, coins);
    }
    return undefined;
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

  if (userTx.snapshot.exists()) {
    try {
      await persistUserDerivedState(db, uid, userTx.snapshot.val(), { touchLastTradeTime: true });
    } catch (e) {
      console.error("[trade] persistUserDerivedState", uid, e?.message || e);
    }
  }

  if (!challengeModeReq) {
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
  }

  if (!isCoin && !challengeModeReq) {
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
      challengeMode: challengeModeReq ? true : null,
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
    tradeId: tradeId || null,
    challengeMode: challengeModeReq || false
  };
});

/**
 * 관리자: 유저 잔고 없이 종목/코인 시세만 `computeTradePrices` + RTDB 반영 (trade 와 동일한 시세 트랜잭션·캔들).
 * dryRun 시에는 DB 미갱신, prevPrice만으로 또는 stockId 조회로 시뮬레이션.
 */
exports.adminInstrumentImpact = onCall({ cors: true, timeoutSeconds: 60, memory: "512MiB" }, async (req) => {
  const auth = req.auth;
  if (!auth?.uid || !isAdminAuth(auth)) {
    throw new HttpsError("permission-denied", "Admin only.");
  }

  const stockIdRaw = String(req.data?.stockId || "").trim();
  const side = String(req.data?.side || "")
    .trim()
    .toLowerCase();
  const qty = clampInt(req.data?.qty, 1, 100);
  const market = String(req.data?.market || "stock").trim().toLowerCase();
  const isCoin = market === "coin";
  const inverseModeReq = Boolean(req.data?.inverseMode);
  const dryRun = Boolean(req.data?.dryRun);
  const invertPrice = inverseModeReq;

  if (side !== "buy" && side !== "sell") {
    throw new HttpsError("invalid-argument", "side must be buy|sell.");
  }
  if (!qty) {
    throw new HttpsError("invalid-argument", "qty must be 1..100.");
  }
  if (market !== "stock" && market !== "coin") {
    throw new HttpsError("invalid-argument", "market must be stock|coin.");
  }

  const db = admin.database();
  const cfgSnap = await db.ref("siteConfig").get();
  const siteConfig = cfgSnap.exists() ? cfgSnap.val() : {};
  const sellConfig = siteConfig.sellConfig || {};
  const marketParams = siteConfig.marketParams || {};

  if (dryRun) {
    const prevOverride = req.data?.prevPrice;
    let prevPrice;
    if (prevOverride != null && prevOverride !== "") {
      const p = Number(prevOverride);
      if (!Number.isFinite(p) || p <= 0) {
        throw new HttpsError("invalid-argument", "prevPrice must be a positive number.");
      }
      prevPrice = p;
    } else {
      if (!stockIdRaw) {
        throw new HttpsError("invalid-argument", "dryRun requires prevPrice or stockId.");
      }
      const stockPath = isCoin ? "coins" : "stocks";
      const snap = await db.ref(`${stockPath}/${stockIdRaw}`).get();
      if (!snap.exists()) {
        throw new HttpsError("not-found", "종목을 찾을 수 없습니다.");
      }
      const row = normalizeStockRow(snap.val());
      if (!row) {
        throw new HttpsError("failed-precondition", "종목 데이터 형식이 올바르지 않습니다.");
      }
      prevPrice = Number(row.price);
      if (!Number.isFinite(prevPrice) || prevPrice <= 0) prevPrice = isCoin ? 100000000 : 10000;
    }
    const out = computeTradePrices(side, prevPrice, qty, sellConfig, marketParams, isCoin, invertPrice);
    const liqRaw = Number(sellConfig.liquidationImpactMultiplier);
    const liqMult = Number.isFinite(liqRaw) && liqRaw >= 0 ? liqRaw : 1;
    const impactLiq = out.impact * liqMult;
    const newPriceLiquidation = Math.max(1, Math.round(prevPrice * (1 - impactLiq)));
    const basePrice = Math.max(1, finiteOr(sellConfig.basePrice, 10000));
    const scalePrice = Math.max(1, finiteOr(sellConfig.scalePrice, 90000));
    const impactCoef = finiteOr(sellConfig.impact, 0.0005);
    const impactRefPriceWon = Math.max(1, finiteOr(marketParams?.impactRefPrice, 100000));
    const sellPressure =
      side === "sell" && !isCoin ? 1 + Math.max(0, prevPrice - basePrice) / scalePrice : 1;
    const dampingFactor = isCoin ? 1 : Math.min(1, impactRefPriceWon / Math.max(1, prevPrice));
    const effectiveImpactCoef = impactCoef * dampingFactor;
    return {
      ok: true,
      dryRun: true,
      prevPrice,
      newPrice: out.newPrice,
      tradePrice: out.tradePrice,
      rawNewPrice: out.rawNewPrice,
      impact: out.impact,
      changeStr: out.changeStr,
      liquidationImpactMultiplier: liqMult,
      newPriceLiquidation,
      impactLiquidation: impactLiq,
      sellPressure,
      dampingFactor,
      effectiveImpactCoef
    };
  }

  const stockId = stockIdRaw;
  if (!stockId) {
    throw new HttpsError("invalid-argument", "stockId required.");
  }

  const stockPath = isCoin ? "coins" : "stocks";
  const candleRoot = isCoin ? "coinCandles" : "candlesticks";
  const instrumentRef = db.ref(`${stockPath}/${stockId}`);

  const preStockSnap = await instrumentRef.get();
  if (!preStockSnap.exists()) {
    throw new HttpsError("not-found", "종목을 찾을 수 없습니다.");
  }
  const rawPreVal = preStockSnap.val();
  const preRowForHint = normalizeStockRow(rawPreVal);
  if (!preRowForHint) {
    throw new HttpsError("failed-precondition", "종목 데이터 형식이 올바르지 않습니다.");
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
          effectiveCur = rawPreVal;
        }

        const row = normalizeStockRow(effectiveCur);
        if (!row) {
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
          isCoin,
          invertPrice
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
          return undefined;
        }
        return out;
      } catch (e) {
        console.error("[adminInstrumentImpact] instrumentTx", stockId, e?.message || e);
        return undefined;
      }
    });
    if (stockTx.committed) break;
    await new Promise((r) => setTimeout(r, 35 * (attempt + 1)));
  }

  if (!stockTx.committed) {
    throw new HttpsError(
      "failed-precondition",
      isCoin ? "코인 시세 갱신에 실패했습니다." : "종목 시세 갱신에 실패했습니다."
    );
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

  return {
    ok: true,
    stockId,
    side,
    qty,
    market: isCoin ? "coin" : "stock",
    tradePrice: lastTradePrice,
    newPrice: lastNewPrice,
    impact: lastImpact,
    prevPrice: lastPrevPrice
  };
});

exports.liquidateAll = onCall({ cors: true, timeoutSeconds: 540, memory: "1GiB" }, async (req) => {
  const auth = req.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "Login required.");

  const uid = auth.uid;
  const stockId = String(req.data?.stockId || "").trim();
  const market = String(req.data?.market || "stock").trim().toLowerCase(); // stock | coin
  const fractionRaw = req.data?.fraction;
  let fraction = 1;
  if (fractionRaw != null && fractionRaw !== "") {
    const f = Number(fractionRaw);
    if (!Number.isFinite(f) || f <= 0 || f > 1) {
      throw new HttpsError("invalid-argument", "fraction must be a number in (0, 1].");
    }
    fraction = f;
  }
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
  const haveQty = Math.floor(Number(bookSnap.val()?.qty || 0));
  if (!Number.isFinite(haveQty) || haveQty <= 0) {
    throw new HttpsError("failed-precondition", "No holdings.");
  }
  let qty;
  if (fraction >= 1 - 1e-9) {
    qty = haveQty;
  } else {
    qty = Math.max(1, Math.floor(haveQty * fraction));
    if (qty > haveQty) qty = haveQty;
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
  const liqMulRaw = Number(sellConfig.liquidationImpactMultiplier);
  const liquidationImpactMultiplier =
    Number.isFinite(liqMulRaw) && liqMulRaw >= 0 ? liqMulRaw : 1;
  const liqSpreadMulRaw = Number(sellConfig.liquidationSpreadMultiplier);
  const liquidationSpreadMultiplier =
    Number.isFinite(liqSpreadMulRaw) && liqSpreadMulRaw >= 0 ? liqSpreadMulRaw : 1;
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
    impact *= liquidationImpactMultiplier;
    nextPrice = Math.max(1, Math.round(prevPrice * (1 - impact)));
    const liquidationSpread = Math.max(0, spread * liquidationSpreadMultiplier);
    tradePrice = Math.max(1, Math.round(nextPrice * (1 - liquidationSpread)));
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
      lastTradeTime: null,
    };
  });
  if (!userTx.committed) throw new HttpsError("aborted", "Holdings changed during liquidation.");

  if (userTx.snapshot.exists()) {
    try {
      await persistUserDerivedState(db, uid, userTx.snapshot.val(), { touchLastTradeTime: true });
    } catch (e) {
      console.error("[liquidateAll] persistUserDerivedState", uid, e?.message || e);
    }
  }

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
 * 액면분할: Admin SDK로 stocks + 전 users 스캔·갱신 (callable·일일 스케줄 공용)
 * kind: "threshold" | "top100"
 * @param {{ kind: string, ratioN: number, thresholdWon: number }} params
 */
async function executeAdminStockSplitCore(db, { kind, ratioN, thresholdWon }) {
  const splitTs = Date.now();
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

    return {
      ok: true,
      skipped: false,
      kind,
      stocksUpdated: splittable.length,
      userHoldingPathsUpdated: Object.keys(holdingUpdates).length,
      events,
    };
  } catch (e) {
    throw e;
  }
}

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
    try {
      return await executeAdminStockSplitCore(db, { kind, ratioN, thresholdWon });
    } catch (e) {
      console.error("[adminStockSplit]", e);
      throw new HttpsError("internal", e?.message || String(e));
    }
  }
);

/**
 * 액면병합(역분할): 주가 × ratioN, 보유량 ÷ ratioN(내림), 평단 × ratioN — 액면분할의 역연산(롱 양수 보유만).
 * kind: "threshold" | "top100" | "ids" — threshold/top100 는 adminStockSplit 과 동일 규칙, ids 는 stockIds 만.
 */
async function executeAdminStockReverseSplitCore(db, { kind, ratioN, thresholdWon, stockIds }) {
  const ts = Date.now();
  try {
    const stocksSnap = await db.ref("stocks").once("value");
    const stocksData = stocksSnap.val() || {};

    let targets = [];
    if (kind === "top100") {
      targets = Object.entries(stocksData)
        .sort(([, a], [, b]) => (Number(b?.price) || 0) - (Number(a?.price) || 0))
        .slice(0, 100)
        .map(([id]) => id);
    } else if (kind === "ids") {
      const seen = new Set();
      const raw = Array.isArray(stockIds) ? stockIds : [];
      for (const id of raw) {
        const sid = String(id == null ? "" : id).trim();
        if (!sid || sid.length > 200 || seen.has(sid)) continue;
        if (!stocksData[sid]) continue;
        seen.add(sid);
        targets.push(sid);
      }
    } else {
      Object.entries(stocksData).forEach(([id, s]) => {
        const price = Number(s?.price) || 0;
        if (price >= thresholdWon && price >= ratioN) targets.push(id);
      });
    }

    if (targets.length === 0) {
      return {
        ok: true,
        skipped: true,
        reason: "no_targets",
        kind,
        stocksUpdated: 0,
        userHoldingPathsUpdated: 0,
        events: [],
      };
    }

    const targetSet = new Set(targets);
    const events = [];

    const scalePriceUp = (oldPrice) => {
      const p = Math.floor(Number(oldPrice) || 0);
      const r = Math.floor(Number(ratioN) || 1);
      const x = p * r;
      if (!Number.isFinite(x)) return 1;
      return Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, x));
    };

    targets.forEach((id) => {
      const s = stocksData[id];
      const oldPrice = Number(s?.price) || 0;
      const newPrice = scalePriceUp(oldPrice);
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
    for (let i = 0; i < targets.length; i += PAR) {
      const slice = targets.slice(i, i + PAR);
      await Promise.all(
        slice.map((id) => {
          const s = stocksData[id];
          const oldPrice = Number(s?.price) || 0;
          const newPrice = scalePriceUp(oldPrice);
          const history = (s?.history || [s?.price]).map((p) =>
            scalePriceUp(Number(p) || 0)
          );
          return db.ref(`stocks/${id}`).update({
            price: newPrice,
            history,
            change: s?.change != null ? s.change : 0,
            lastReverseSplitTimestamp: ts,
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
        const path = `users/${uid}/stocks/${stockId}`;
        const newQty = Math.floor(q / ratioN);
        if (newQty < 1) {
          holdingUpdates[path] = null;
          return;
        }
        const oldAvg = Math.floor(Number(info.avg) || 0);
        const newAvg = Math.max(1, Math.floor((q * Math.max(1, oldAvg)) / newQty));
        holdingUpdates[path] = { qty: newQty, avg: newAvg };
      });
    });

    const chunks = chunkObject(holdingUpdates, 400);
    for (const chunk of chunks) {
      await db.ref().update(chunk);
    }

    try {
      await db.ref(`adminActivityLogs/adminStockReverseSplit/${Date.now()}`).set({
        type: "adminStockReverseSplit",
        adminEmail: ADMIN_EMAIL,
        kind,
        thresholdWon: kind === "threshold" ? thresholdWon : null,
        ratioN,
        events,
        userHoldingPathsUpdated: Object.keys(holdingUpdates).length,
        createdAt: ts,
        via: "adminStockReverseSplit",
      });
    } catch (logErr) {
      console.warn("[adminStockReverseSplit] adminActivityLogs:", logErr?.message || logErr);
    }

    return {
      ok: true,
      skipped: false,
      kind,
      stocksUpdated: targets.length,
      userHoldingPathsUpdated: Object.keys(holdingUpdates).length,
      events,
    };
  } catch (e) {
    throw e;
  }
}

exports.adminStockReverseSplit = onCall(
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

    let stockIds = null;
    if (kind === "ids") {
      const raw = request.data?.stockIds;
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new HttpsError(
          "invalid-argument",
          "stockIds (non-empty array) is required for kind=ids."
        );
      }
      if (raw.length > 300) {
        throw new HttpsError("invalid-argument", "stockIds must have at most 300 entries.");
      }
      stockIds = raw.map((x) => String(x == null ? "" : x).trim()).filter(Boolean);
    }

    const db = admin.database();
    try {
      return await executeAdminStockReverseSplitCore(db, {
        kind,
        ratioN,
        thresholdWon,
        stockIds,
      });
    } catch (e) {
      console.error("[adminStockReverseSplit]", e);
      throw new HttpsError("internal", e?.message || String(e));
    }
  }
);

/**
 * tradeHistory 하위를 한 번에 set(null) 하면 RTDB WRITE_TOO_BIG 에 걸릴 수 있어
 * 키 단위로 나눠 multi-path update 로 삭제한다.
 * maxPurged 가 있으면 그 개수만큼만 지우고 hasMore: true 로 남은 데이터가 있을 수 있음(데드라인 방지).
 */
async function purgeTradeHistoryBatched(db, opts = {}) {
  const initialBatchSize = opts.initialBatchSize != null ? opts.initialBatchSize : 60;
  const maxPurged =
    opts.maxPurged != null && Number.isFinite(Number(opts.maxPurged))
      ? Math.max(1, Math.floor(Number(opts.maxPurged)))
      : null;
  let batchSize = Math.max(5, Math.floor(Number(initialBatchSize) || 60));
  let purged = 0;
  for (;;) {
    const snap = await db.ref("tradeHistory").orderByKey().limitToFirst(batchSize).get();
    if (!snap.exists()) {
      return { purged, hasMore: false };
    }
    const val = snap.val();
    const keys = val && typeof val === "object" ? Object.keys(val) : [];
    if (keys.length === 0) {
      return { purged, hasMore: false };
    }
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
        if (maxPurged != null && purged >= maxPurged) {
          const rest = await db.ref("tradeHistory").orderByKey().limitToFirst(1).get();
          return { purged, hasMore: rest.exists() };
        }
        continue;
      }
      throw e;
    }
    purged += keys.length;
    if (maxPurged != null && purged >= maxPurged) {
      const rest = await db.ref("tradeHistory").orderByKey().limitToFirst(1).get();
      return { purged, hasMore: rest.exists() };
    }
    if (keys.length < batchSize) {
      return { purged, hasMore: false };
    }
  }
}

/** 관리자 전용: tradeHistory(유저 활동로그) 삭제 — 기본적으로 한 번에 maxPerInvocation 건만(클라이언트가 hasMore 동안 반복) */
exports.adminPurgeUserActivityLogs = onCall(
  { cors: true, timeoutSeconds: 540, memory: "512MiB" },
  async (request) => {
    if (!isAdminAuth(request.auth)) {
      throw new HttpsError("permission-denied", "Admin only.");
    }
    const rawMax = Number(request.data?.maxPerInvocation);
    const maxPerInvocation = Number.isFinite(rawMax)
      ? Math.min(100000, Math.max(500, Math.floor(rawMax)))
      : 20000;
    const db = admin.database();
    const { purged, hasMore } = await purgeTradeHistoryBatched(db, { maxPurged: maxPerInvocation });
    const ts = Date.now();
    return { ok: true, purged, hasMore, maxPerInvocation, at: ts };
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
    const grantTx = await userRef.transaction((cur) => {
      const base = cur && typeof cur === "object" ? cur : { cash: 1000000, stocks: {}, coins: {} };
      const cash = Math.floor(Number(base.cash) || 1000000);
      return { ...base, cash: cash + amount };
    });
    if (!grantTx.committed) {
      throw new HttpsError("aborted", "User cash update did not commit.");
    }
    if (grantTx.snapshot.exists()) {
      try {
        await persistUserDerivedState(db, targetUid, grantTx.snapshot.val(), { touchLastTradeTime: false });
      } catch (e) {
        console.warn("[adminGrantAssetRequest] persistUserDerivedState", targetUid, e?.message || e);
      }
    }

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

/** 로그인 유저: 자산 지원 신청 (클라이언트 직접 assetRequests 쓰기 금지 — 서버에서 잔고·중복 검증) */
exports.submitAssetSupportRequest = onCall(
  { cors: true, timeoutSeconds: 60, memory: "256MiB" },
  async (request) => {
    if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Login required.");
    const uid = request.auth.uid;
    const nicknameRaw = String(request.data?.nickname || "").trim();
    const requestReasonRaw = String(request.data?.requestReason || "").trim();
    if (!nicknameRaw || nicknameRaw.length > 80) {
      throw new HttpsError("invalid-argument", "nickname required (1~80 chars).");
    }
    if (requestReasonRaw.length > 2000) {
      throw new HttpsError("invalid-argument", "requestReason too long.");
    }

    const db = admin.database();

    const pendingSnap = await db.ref("assetRequests").orderByChild("uid").equalTo(uid).once("value");
    const pendingVal = pendingSnap.exists() ? pendingSnap.val() || {} : {};
    for (const v of Object.values(pendingVal)) {
      if (v && typeof v === "object" && String(v.status || "").trim() === "pending") {
        throw new HttpsError("failed-precondition", "pending asset request exists.");
      }
    }

    const cashSnap = await db.ref(`users/${uid}/cash`).once("value");
    let currentBalance = 1000000;
    if (cashSnap.exists() && Number.isFinite(Number(cashSnap.val()))) {
      currentBalance = Math.floor(Number(cashSnap.val()));
    } else {
      const sumSnap = await db.ref(`users/${uid}/summary/cash`).once("value");
      if (sumSnap.exists() && Number.isFinite(Number(sumSnap.val()))) {
        currentBalance = Math.floor(Number(sumSnap.val()));
      }
    }
    if (!Number.isFinite(currentBalance) || currentBalance < 0) currentBalance = 0;

    const newRef = db.ref("assetRequests").push();
    const now = Date.now();
    await newRef.set({
      uid,
      nickname: nicknameRaw,
      currentBalance,
      requestReason: requestReasonRaw,
      requestAmount: 0,
      status: "pending",
      timestamp: admin.database.ServerValue.TIMESTAMP,
      createdAtMs: now,
    });

    return { ok: true, requestId: newRef.key };
  }
);

/** 관리자: assetRequests 전체 삭제 (일일 루틴·관리자 도구와 동일 로직) */
exports.adminClearAssetRequests = onCall(
  { cors: true, timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    if (!isAdminAuth(request.auth)) {
      throw new HttpsError("permission-denied", "Admin only.");
    }
    const db = admin.database();
    const n = await clearRtdbChildrenServer(db, "assetRequests");
    return { ok: true, deleted: n };
  }
);

/** 관리자: 기본 현금·무(0)보유 주식 유저 일괄 삭제 (클라이언트 users/ 직접 갱신 제거) */
exports.adminDeleteInactiveUsers = onCall(
  { cors: true, timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    if (!isAdminAuth(request.auth)) {
      throw new HttpsError("permission-denied", "Admin only.");
    }
    const db = admin.database();
    const snap = await db.ref("users").once("value");
    const data = snap.exists() ? snap.val() || {} : {};
    const inactive = [];
    Object.entries(data).forEach(([u, user]) => {
      const isDefaultCash = (user?.cash ?? 1000000) === 1000000;
      const hasNoStocks = !user?.stocks || Object.keys(user.stocks).length === 0;
      const hasZeroStocks =
        user?.stocks && Object.values(user.stocks).every((s) => (s?.qty || 0) === 0);
      if (isDefaultCash && (hasNoStocks || hasZeroStocks)) inactive.push(u);
    });
    if (inactive.length === 0) return { ok: true, deleted: 0 };

    const BATCH = 500;
    let deleted = 0;
    for (let i = 0; i < inactive.length; i += BATCH) {
      const batch = inactive.slice(i, i + BATCH);
      const updates = {};
      batch.forEach((u) => {
        updates[`users/${u}`] = null;
      });
      await db.ref().update(updates);
      deleted += batch.length;
    }
    return { ok: true, deleted };
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

/**
 * 서킷 동결 시 RTDB 대역 외 푸시(선택): SOOP_CIRCUIT_FCM_TOPIC 이 설정된 경우에만 FCM topic 전송.
 * 앱에서 해당 토픽을 구독하면 알림을 RTDB 리스너 없이 받을 수 있음.
 */
exports.onFrozenStockFcmBroadcast = onValueWritten(
  "/siteConfig/frozenStocks/{stockId}",
  async (event) => {
    const topic = process.env.SOOP_CIRCUIT_FCM_TOPIC;
    if (!topic || typeof topic !== "string" || !String(topic).trim()) return;

    const after = event.data.after.exists() ? event.data.after.val() : null;
    if (after == null) return;

    const untilMs = Number(after);
    if (!Number.isFinite(untilMs) || untilMs <= Date.now()) return;

    const stockId = String(event.params.stockId || "").trim();
    if (!stockId) return;

    try {
      await admin.messaging().send({
        topic: String(topic).trim(),
        data: {
          type: "circuitFreeze",
          stockId,
          frozenUntil: String(untilMs),
        },
      });
    } catch (e) {
      console.warn("[onFrozenStockFcmBroadcast]", e?.code || e?.message || e);
    }
  }
);

// ── RTDB 보안규칙: 장 운영 시간에 따라 open(기존 규칙) / closed(쓰기 전부 관리자만) 전환 ──
const RULES_OPEN_PATH = path.join(__dirname, "rules/open.json");
/** 장 마감 전용: open.json 은 건드리지 않고, closed 규칙에만 병합되는 덮어쓰기(예: marketRank 읽기) */
const RULES_CLOSED_OVERRIDES_PATH = path.join(
  __dirname,
  "rules/closed-overrides.json"
);

let cachedOpenRulesStr = null;

function loadOpenRulesString() {
  if (!cachedOpenRulesStr) {
    cachedOpenRulesStr = fs.readFileSync(RULES_OPEN_PATH, "utf8");
  }
  return cachedOpenRulesStr;
}

/** Firebase RTDB rules 트리에 소스 브랜치를 병합(장 마감 closed-overrides 전용) */
function deepMergeRuleTree(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  if (!target || typeof target !== "object") return;
  for (const k of Object.keys(source)) {
    const sv = source[k];
    if (sv && typeof sv === "object" && !Array.isArray(sv)) {
      if (!target[k] || typeof target[k] !== "object" || Array.isArray(target[k])) {
        target[k] = JSON.parse(JSON.stringify(sv));
      } else {
        deepMergeRuleTree(target[k], sv);
      }
    } else {
      target[k] = sv;
    }
  }
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
  const open = JSON.parse(loadOpenRulesString());
  const closedObj = buildClosedRulesObjectFromOpen(open);
  if (fs.existsSync(RULES_CLOSED_OVERRIDES_PATH)) {
    try {
      const raw = fs.readFileSync(RULES_CLOSED_OVERRIDES_PATH, "utf8");
      const over = JSON.parse(raw);
      if (over.rules && typeof over.rules === "object") {
        deepMergeRuleTree(closedObj.rules, over.rules);
      }
    } catch (e) {
      console.error(
        "[getClosedRulesString] closed-overrides.json",
        e?.message || e
      );
    }
  }
  return JSON.stringify(closedObj);
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

  const rulesStr =
    mode === "closed" ? getClosedRulesString() : loadOpenRulesString().trim();
  const rulesHash = crypto.createHash("sha256").update(rulesStr).digest("hex");

  const stateRef = db.ref("siteConfig/_functions/lastMarketRulesMode");
  const hashRef = db.ref("siteConfig/_functions/lastAppliedRulesHash");
  const [stSnap, hSnap] = await Promise.all([stateRef.get(), hashRef.get()]);
  const prevMode = stSnap.exists() ? String(stSnap.val()) : null;
  const prevHash = hSnap.exists() ? String(hSnap.val()) : null;

  // 모드가 같아도(예: 계속 closed) 규칙 JSON이 바뀌면 재적용 — 마감 중 closed-overrides.json 만 배포한 경우
  if (prevMode === mode && prevHash === rulesHash) {
    return { skipped: true, mode };
  }

  await admin.database().setRules(rulesStr);
  await stateRef.set(mode);
  await hashRef.set(rulesHash);
  console.log(
    `[syncDatabaseRulesFromMarketHours] applied mode=${mode} hash=${rulesHash.slice(0, 12)}…`
  );
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
 * marketRank 갱신 — 스케줄/실시간 트리거에서 공용 사용.
 * @returns {Promise<{skipped?:boolean,reason?:string,updatedAt?:number,stockRankCount?:number,coinRankCount?:number,stockVolTop5?:number,coinVolTop5?:number,stockTop100?:number,coinTop100?:number}>}
 */
async function runMarketRankAggregation(db, { skipIfMarketClosed }) {
  const mhSnap = await db.ref("siteConfig/marketHours").get();
  const mh = mhSnap.exists() ? mhSnap.val() : null;
  const kst = nowKstDate();
  if (skipIfMarketClosed && mh && mh.enabled && !isMarketOpenServer(mh, kst)) {
    console.log("[runMarketRankAggregation] skip: market closed (KST)");
    return { skipped: true, reason: "market_closed" };
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
  const stockTop100 = buildTopPriceRowsFromMarketSnapshot(stocksVal, {
    limit: MARKET_TOP_RANK_LIMIT,
    isCoin: false,
  });
  const coinTop100 = buildTopPriceRowsFromMarketSnapshot(coinsVal, {
    limit: MARKET_TOP_RANK_LIMIT,
    isCoin: true,
  });
  const updatedAt = Date.now();
  await db.ref().update({
    "marketRank/stocks/byPrice": stockRank,
    "marketRank/coins/byPrice": coinRank,
    "marketRank/stocks/byVolumeTop5": stockVolTop5,
    "marketRank/coins/byVolumeTop5": coinVolTop5,
    "marketRank/top100/stocks": stockTop100,
    "marketRank/top100/coins": coinTop100,
    "marketRank/meta/updatedAt": updatedAt,
    "marketRank/meta/sortKey": `byPrice_v${MARKET_RANK_SORT_VERSION}`,
    "marketRank/meta/topLimit": MARKET_TOP_RANK_LIMIT,
  });
  const out = {
    skipped: false,
    updatedAt,
    stockRankCount: Object.keys(stockRank).length,
    coinRankCount: Object.keys(coinRank).length,
    stockVolTop5: stockVolTop5.length,
    coinVolTop5: coinVolTop5.length,
    stockTop100: stockTop100.length,
    coinTop100: coinTop100.length,
  };
  console.log(
    `[runMarketRankAggregation] ok stocks=${out.stockRankCount} coins=${out.coinRankCount} top100 stock=${out.stockTop100} coin=${out.coinTop100} volTop5 stock=${out.stockVolTop5} coin=${out.coinVolTop5}`
  );
  return out;
}

/**
 * 잦은 종목 가격 변경에서 전체 재집계를 직접 매번 수행하면 오히려 낭비가 커져,
 * 최소 간격 락(기본 3초)으로 실시간 업데이트 빈도를 제한한다.
 */
async function tryAcquireMarketRankRefreshLock(db, nowMs, holdMs = MARKET_RANK_LIVE_REFRESH_MIN_GAP_MS) {
  const ref = db.ref("marketRank/meta/liveRefreshLockUntil");
  const tx = await ref.transaction((cur) => {
    const curUntil = Number(cur || 0);
    if (Number.isFinite(curUntil) && curUntil > nowMs) return;
    return nowMs + holdMs;
  });
  return Boolean(tx?.committed);
}

async function maybeRunMarketRankLiveRefresh(sourceTag) {
  const db = admin.database();
  const now = Date.now();
  try {
    const locked = await tryAcquireMarketRankRefreshLock(db, now);
    if (!locked) return;
    const r = await runMarketRankAggregation(db, { skipIfMarketClosed: true });
    if (r.skipped) return;
    await db.ref("marketRank/meta/liveUpdatedAt").set(Date.now());
  } catch (e) {
    console.error(`[maybeRunMarketRankLiveRefresh:${sourceTag}]`, e?.message || e);
  }
}

/** 관리자만 — marketRank 즉시 재집계 (장 마감 중에도 실행 가능) */
exports.adminRefreshMarketRanks = onCall(
  {
    cors: true,
    timeoutSeconds: 300,
    memory: "512MiB",
    region: "asia-northeast3",
  },
  async (request) => {
    if (!isAdminAuth(request.auth)) {
      throw new HttpsError("permission-denied", "Admin only.");
    }
    const db = admin.database();
    const r = await runMarketRankAggregation(db, { skipIfMarketClosed: false });
    return { ok: true, ...r };
  }
);

exports.adminRunAssetRanking = onCall(
  { cors: true, timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    if (!isAdminAuth(request.auth)) {
      throw new HttpsError("permission-denied", "Admin only.");
    }
    const db = admin.database();
    return await runDailyAssetRankingServer(db);
  }
);

exports.adminRunStockHolderTop3 = onCall(
  { cors: true, timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    if (!isAdminAuth(request.auth)) {
      throw new HttpsError("permission-denied", "Admin only.");
    }
    const db = admin.database();
    return await runDailyStockHolderTop3Server(db);
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
      const r = await runMarketRankAggregation(db, { skipIfMarketClosed: true });
      if (r.skipped) return;
    } catch (e) {
      console.error("[refreshMarketPriceRanks]", e?.message || e);
      throw e;
    }
  }
);

/**
 * 실시간 체감용: 가격 변경 이벤트에서 marketRank/top100 갱신.
 * 전체 집계를 3초 최소 간격으로 제한해 쓰기 폭주를 방지한다.
 */
exports.refreshMarketRanksOnStockPriceWrite = onValueWritten(
  "/stocks/{stockId}/price",
  async () => {
    await maybeRunMarketRankLiveRefresh("stock_price_write");
  }
);

exports.refreshMarketRanksOnCoinPriceWrite = onValueWritten(
  "/coins/{stockId}/price",
  async () => {
    await maybeRunMarketRankLiveRefresh("coin_price_write");
  }
);

exports.refreshMarketRanksOnChallengeStockPriceWrite = onValueWritten(
  "/challengeStocks/{stockId}/price",
  async () => {
    await maybeRunMarketRankChallengeLiveRefresh("challenge_stock_price_write");
  }
);

exports.refreshMarketRanksOnChallengeCoinPriceWrite = onValueWritten(
  "/challengeCoins/{stockId}/price",
  async () => {
    await maybeRunMarketRankChallengeLiveRefresh("challenge_coin_price_write");
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// siteConfig/dailyAuto — Cloud Scheduler 서버 실행 (관리자 페이지 미오픈)
// 관리자 UI와 동일 루틴 타입·KST 시각(hour/minute) 기준
// ═══════════════════════════════════════════════════════════════════════════

function clampInt(v, lo, hi, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function clampDailyRoutineTimeStrServer(raw, fallback) {
  const fb = String(fallback || "20:00").trim();
  const s = String(raw || "").trim();
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(s);
  if (!m) return fb;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (!Number.isFinite(h) || h < 0 || h > 23) return fb;
  if (!Number.isFinite(mi) || mi < 0 || mi > 59) return fb;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

function clampDailyAutoSplitThresholdManwonServer(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return 100;
  return Math.max(0, n);
}

function clampDailyAutoSplitRatioNServer(v) {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n <= 1) return 10;
  return Math.min(100, Math.max(2, n));
}

function normalizeDailyRoutineItemServer(raw) {
  const type = String(raw?.type || "").trim();
  if (type === "autoSplit") {
    return {
      type: "autoSplit",
      thresholdManwon: clampDailyAutoSplitThresholdManwonServer(raw?.thresholdManwon),
      ratioN: clampDailyAutoSplitRatioNServer(raw?.ratioN),
    };
  }
  if (type === "ranking") return { type: "ranking" };
  if (type === "candlePrune") return { type: "candlePrune" };
  if (type === "stockHolders") return { type: "stockHolders" };
  if (type === "userActivityPurge") return { type: "userActivityPurge" };
  if (type === "rankingVolumeReset") return { type: "rankingVolumeReset" };
  if (type === "clearAssetRequests") return { type: "clearAssetRequests" };
  if (type === "clearAdRequests") return { type: "clearAdRequests" };
  if (type === "regularHoursSet") {
    let ro = clampDailyRoutineTimeStrServer(raw?.regularOpen, "20:00");
    let rc = clampDailyRoutineTimeStrServer(raw?.regularClose, "00:00");
    if (ro === rc) {
      rc = "00:01";
      if (ro === rc) rc = "23:59";
    }
    return { type: "regularHoursSet", regularOpen: ro, regularClose: rc };
  }
  if (type === "maintenanceMode") {
    return { type: "maintenanceMode", maintenanceOn: raw?.maintenanceOn === true };
  }
  if (type === "circuitBreakerClear") return { type: "circuitBreakerClear" };
  if (type === "marketRankRefresh") return { type: "marketRankRefresh" };
  if (type === "challengePriceReset") return { type: "challengePriceReset" };
  return null;
}

async function tryClaimDailyAutoDayRun(db, ymd) {
  const ref = db.ref(`siteConfig/_functions/dailyAutoRunner/claims/${ymd}`);
  const tx = await ref.transaction((cur) => {
    if (cur && cur.completed === true) return undefined;
    if (cur && cur.running === true) {
      const st = Number(cur.startedAt || 0);
      if (Date.now() - st < 50 * 60 * 1000) return undefined;
    }
    return {
      running: true,
      completed: false,
      startedAt: Date.now(),
      source: "dailyAutoRunner",
    };
  });
  return Boolean(tx?.committed);
}

async function finalizeDailyAutoDayClaim(db, ymd, patch) {
  await db
    .ref(`siteConfig/_functions/dailyAutoRunner/claims/${ymd}`)
    .update({
      running: false,
      finishedAt: Date.now(),
      ...patch,
    })
    .catch(() => {});
}

async function runDailyAssetRankingServer(db) {
  const usersSnap = await db.ref("users").once("value");
  if (!usersSnap.exists()) {
    return { ok: true, skipped: true, reason: "no_users" };
  }
  const users = usersSnap.val() || {};
  const [stocksSnap, coinsSnap] = await Promise.all([
    db.ref("stocks").once("value"),
    db.ref("coins").once("value"),
  ]);
  const stocks = stocksSnap.exists() ? stocksSnap.val() || {} : {};
  const coins = coinsSnap.exists() ? coinsSnap.val() || {} : {};

  const assetList = Object.entries(users).map(([uid, u]) => {
    let cashRaw = Number(u?.cash);
    if (
      (!Number.isFinite(cashRaw) || cashRaw < 0) &&
      u?.summary &&
      typeof u.summary === "object"
    ) {
      cashRaw = Number(u.summary.cash);
    }
    let total = Math.floor(Number.isFinite(cashRaw) && cashRaw >= 0 ? cashRaw : 0);
    if (u.stocks && typeof u.stocks === "object") {
      Object.entries(u.stocks).forEach(([stockId, s]) => {
        const qty = Number(s?.qty);
        if (!Number.isFinite(qty) || qty <= 0) return;
        const price = Number(stocks[stockId]?.price);
        const p = Number.isFinite(price) && price >= 0 ? price : 0;
        const add = Math.floor(p * qty);
        if (Number.isFinite(add)) total += add;
      });
    }
    if (u.coins && typeof u.coins === "object") {
      Object.entries(u.coins).forEach(([coinId, s]) => {
        const qty = Number(s?.qty);
        if (!Number.isFinite(qty) || qty <= 0) return;
        const price = Number(coins[coinId]?.price);
        const p = Number.isFinite(price) && price >= 0 ? price : 0;
        const add = Math.floor(p * qty);
        if (Number.isFinite(add)) total += add;
      });
    }
    return { uid, totalAsset: total };
  });

  assetList.sort((a, b) => b.totalAsset - a.totalAsset);
  const top100 = assetList.slice(0, 100).map((item, i) => ({
    rank: i + 1,
    totalAsset: item.totalAsset,
  }));
  const now = Date.now();
  await db.ref("assetRanking").set({
    updatedAt: now,
    totalUsers: assetList.length,
    items: top100,
  });
  return { ok: true, totalUsers: assetList.length, top: top100.length };
}

async function runDailyStockHolderTop3Server(db) {
  const [usersSnap, stocksSnap, coinsSnap] = await Promise.all([
    db.ref("users").once("value"),
    db.ref("stocks").once("value"),
    db.ref("coins").once("value"),
  ]);
  if (!usersSnap.exists()) {
    return { ok: true, skipped: true, reason: "no_users" };
  }
  const users = usersSnap.val() || {};
  const stocks = stocksSnap.exists() ? stocksSnap.val() || {} : {};
  const coins = coinsSnap.exists() ? coinsSnap.val() || {} : {};
  const stockIds = Object.keys(stocks);
  const coinIds = Object.keys(coins);

  const byStock = {};
  stockIds.forEach((id) => {
    byStock[id] = [];
  });
  const byCoin = {};
  coinIds.forEach((id) => {
    byCoin[id] = [];
  });

  Object.values(users).forEach((u) => {
    if (u?.stocks && typeof u.stocks === "object") {
      Object.entries(u.stocks).forEach(([stockId, s]) => {
        const qty = Math.floor(Number(s?.qty) || 0);
        if (qty <= 0) return;
        if (!byStock[stockId]) byStock[stockId] = [];
        byStock[stockId].push(qty);
      });
    }
    if (u?.coins && typeof u.coins === "object") {
      Object.entries(u.coins).forEach(([coinId, s]) => {
        const qty = Math.floor(Number(s?.qty) || 0);
        if (qty <= 0) return;
        if (!byCoin[coinId]) byCoin[coinId] = [];
        byCoin[coinId].push(qty);
      });
    }
  });

  const now = Date.now();
  const CHUNK = 150;

  const stockKeys = Object.keys(byStock);
  for (let i = 0; i < stockKeys.length; i += CHUNK) {
    const slice = stockKeys.slice(i, i + CHUNK);
    const updates = {};
    for (const stockId of slice) {
      const arr = (byStock[stockId] || []).sort((a, b) => b - a).slice(0, 3);
      const holders = arr.map((qty, idx) => ({ rank: idx + 1, qty }));
      updates[`stockHolderRanking/${stockId}/updatedAt`] = now;
      updates[`stockHolderRanking/${stockId}/holders`] = holders;
    }
    await db.ref().update(updates);
  }

  const coinKeys = Object.keys(byCoin);
  for (let i = 0; i < coinKeys.length; i += CHUNK) {
    const slice = coinKeys.slice(i, i + CHUNK);
    const updates = {};
    for (const coinId of slice) {
      const arr = (byCoin[coinId] || []).sort((a, b) => b - a).slice(0, 3);
      const holders = arr.map((qty, idx) => ({ rank: idx + 1, qty }));
      updates[`coinHolderRanking/${coinId}/updatedAt`] = now;
      updates[`coinHolderRanking/${coinId}/holders`] = holders;
    }
    await db.ref().update(updates);
  }

  return { ok: true, stockKeys: stockKeys.length, coinKeys: coinKeys.length };
}

async function pruneCandleBranchServer(db, baseName) {
  const snap = await db.ref(baseName).once("value");
  if (!snap.exists()) {
    return { baseName, deleted: 0, instruments: 0 };
  }
  const allRows = snap.val() || {};
  const cutoff = (Math.floor(Date.now() / 60000) - 360) * 60;
  let totalDeleted = 0;
  let stockCount = 0;
  for (const stockId of Object.keys(allRows)) {
    const candles = allRows[stockId];
    if (!candles || typeof candles !== "object") continue;
    const toDelete = Object.keys(candles).filter((ts) => parseInt(ts, 10) < cutoff);
    if (toDelete.length === 0) continue;
    for (let i = 0; i < toDelete.length; i += 400) {
      const slice = toDelete.slice(i, i + 400);
      const updates = {};
      for (const ts of slice) {
        updates[`${baseName}/${stockId}/${ts}`] = null;
      }
      await db.ref().update(updates);
      totalDeleted += slice.length;
    }
    stockCount += 1;
  }
  return { baseName, deleted: totalDeleted, instruments: stockCount };
}

async function runDailyPruneOldCandlesServer(db) {
  const a = await pruneCandleBranchServer(db, "candlesticks");
  const b = await pruneCandleBranchServer(db, "coinCandles");
  return { ok: true, a, b, deleted: (a.deleted || 0) + (b.deleted || 0) };
}

async function runDailyPurgeUserTradeHistoryServer(db) {
  let total = 0;
  let rounds = 0;
  const maxRounds = 250;
  for (;;) {
    rounds += 1;
    if (rounds > maxRounds) {
      return { ok: true, totalPurged: total, hasMore: true, rounds };
    }
    const { purged, hasMore } = await purgeTradeHistoryBatched(db, { maxPurged: 20000 });
    total += purged;
    if (!hasMore) break;
  }
  return { ok: true, totalPurged: total, hasMore: false, rounds };
}

async function runDailyResetRankingVolumesServer(db) {
  const [sSnap, cSnap] = await Promise.all([
    db.ref("stocks").once("value"),
    db.ref("coins").once("value"),
  ]);
  const sData = sSnap.exists() ? sSnap.val() : null;
  const cData = cSnap.exists() ? cSnap.val() : null;
  const sUpdates = {};
  const cUpdates = {};
  if (sData) {
    Object.keys(sData).forEach((id) => {
      sUpdates[`${id}/volume`] = 0;
      sUpdates[`${id}/buyVol`] = 0;
      sUpdates[`${id}/sellVol`] = 0;
    });
  }
  if (cData) {
    Object.keys(cData).forEach((id) => {
      cUpdates[`${id}/volume`] = 0;
      cUpdates[`${id}/buyVol`] = 0;
      cUpdates[`${id}/sellVol`] = 0;
    });
  }
  if (Object.keys(sUpdates).length === 0 && Object.keys(cUpdates).length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (Object.keys(sUpdates).length) await db.ref("stocks").update(sUpdates);
  if (Object.keys(cUpdates).length) await db.ref("coins").update(cUpdates);
  const ns = sData ? Object.keys(sData).length : 0;
  const nc = cData ? Object.keys(cData).length : 0;
  return { ok: true, ns, nc };
}

async function clearRtdbChildrenServer(db, rootKey) {
  const snap = await db.ref(rootKey).once("value");
  if (!snap.exists()) return 0;
  const val = snap.val();
  const keys = val && typeof val === "object" && !Array.isArray(val) ? Object.keys(val) : [];
  if (keys.length === 0) return 0;
  const updates = {};
  keys.forEach((k) => {
    updates[`${rootKey}/${k}`] = null;
  });
  await db.ref().update(updates);
  return keys.length;
}

async function runDailyClearCircuitFreezesServer(db) {
  const n = await clearRtdbChildrenServer(db, "siteConfig/frozenStocks");
  return { ok: true, cleared: n };
}

async function runDailyRegularHoursSetServer(db, ro, rc) {
  const snap = await db.ref("siteConfig/marketHours").once("value");
  const current = snap.exists() ? snap.val() || {} : {};
  await db.ref("siteConfig/marketHours").set({
    ...current,
    regularOpen: ro,
    regularClose: rc,
  });
  return { ok: true, regularOpen: ro, regularClose: rc };
}

async function runDailyChallengeResetServer(db) {
  const [stocksSnap, coinsSnap, usersSnap, chStockSnap, chCoinSnap] = await Promise.all([
    db.ref("stocks").get(),
    db.ref("coins").get(),
    db.ref("users").get(),
    db.ref("challengeStocks").get(),
    db.ref("challengeCoins").get(),
  ]);
  const stocks = stocksSnap.exists() ? stocksSnap.val() || {} : {};
  const coins = coinsSnap.exists() ? coinsSnap.val() || {} : {};
  const users = usersSnap.exists() ? usersSnap.val() || {} : {};
  const chStocks = chStockSnap.exists() ? chStockSnap.val() || {} : {};
  const chCoins = chCoinSnap.exists() ? chCoinSnap.val() || {} : {};

  const updates = {};
  let liquidatedUsers = 0;

  for (const [uid, u] of Object.entries(users)) {
    if (!u || typeof u !== "object") continue;
    const bkS = u.challengeStocks && typeof u.challengeStocks === "object" ? u.challengeStocks : {};
    const bkC = u.challengeCoins && typeof u.challengeCoins === "object" ? u.challengeCoins : {};
    let touched = false;

    for (const [sid, row] of Object.entries(bkS)) {
      const qty = Math.floor(Number(row?.qty || 0));
      if (!qty) continue;
      touched = true;
    }
    for (const [cid, row] of Object.entries(bkC)) {
      const qty = Math.floor(Number(row?.qty || 0));
      if (!qty) continue;
      touched = true;
    }

    updates[`users/${uid}/challengeCash`] = CHALLENGE_DAILY_CASH_WON;
    updates[`users/${uid}/challengeStocks`] = null;
    updates[`users/${uid}/challengeCoins`] = null;
    if (touched) liquidatedUsers += 1;
  }

  const CHUNK = 400;
  const keys = Object.keys(updates);
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    const patch = {};
    slice.forEach((k) => {
      patch[k] = updates[k];
    });
    await db.ref().update(patch);
  }

  const chSUp = {};
  Object.entries(stocks).forEach(([id, row]) => {
    const name = String(row?.name || "");
    chSUp[`challengeStocks/${id}`] = {
      name,
      price: CHALLENGE_STOCK_OPEN_WON,
      volume: 0,
      buyVol: 0,
      sellVol: 0,
      change: "0.00",
      history: [CHALLENGE_STOCK_OPEN_WON],
    };
  });
  Object.keys(chStocks).forEach((id) => {
    if (!stocks[id]) chSUp[`challengeStocks/${id}`] = null;
  });

  const chCUp = {};
  Object.entries(coins).forEach(([id, row]) => {
    const name = String(row?.name || "");
    chCUp[`challengeCoins/${id}`] = {
      name,
      price: CHALLENGE_COIN_OPEN_WON,
      volume: 0,
      buyVol: 0,
      sellVol: 0,
      change: "0.0000",
      history: [CHALLENGE_COIN_OPEN_WON],
    };
  });
  Object.keys(chCoins).forEach((id) => {
    if (!coins[id]) chCUp[`challengeCoins/${id}`] = null;
  });

  const instKeys = [...Object.keys(chSUp), ...Object.keys(chCUp)];
  for (let i = 0; i < instKeys.length; i += CHUNK) {
    const patch = {};
    instKeys.slice(i, i + CHUNK).forEach((k) => {
      const v = chSUp[k] !== undefined ? chSUp[k] : chCUp[k];
      patch[k] = v;
    });
    await db.ref().update(patch);
  }

  const rankR = await runMarketRankChallengeAggregation(db, { skipIfMarketClosed: false });
  return {
    ok: true,
    liquidatedUsers,
    challengeCashReset: CHALLENGE_DAILY_CASH_WON,
    challengeStocks: Object.keys(stocks).length,
    challengeCoins: Object.keys(coins).length,
    rank: rankR,
  };
}

async function runMarketRankChallengeAggregation(db, { skipIfMarketClosed }) {
  const mhSnap = await db.ref("siteConfig/marketHours").get();
  const mh = mhSnap.exists() ? mhSnap.val() : null;
  const kst = nowKstDate();
  if (skipIfMarketClosed && mh && mh.enabled && !isMarketOpenServer(mh, kst)) {
    return { skipped: true, reason: "market_closed" };
  }
  const [stocksSnap, coinsSnap] = await Promise.all([
    db.ref("challengeStocks").get(),
    db.ref("challengeCoins").get(),
  ]);
  const stocksVal = stocksSnap.exists() ? stocksSnap.val() || {} : {};
  const coinsVal = coinsSnap.exists() ? coinsSnap.val() || {} : {};
  const stockTop100 = buildTopPriceRowsFromMarketSnapshot(stocksVal, {
    limit: MARKET_TOP_RANK_LIMIT,
    isCoin: false,
  });
  const coinTop100 = buildTopPriceRowsFromMarketSnapshot(coinsVal, {
    limit: MARKET_TOP_RANK_LIMIT,
    isCoin: true,
  });
  const updatedAt = Date.now();
  await db.ref().update({
    "marketRank/challenge/top100/stocks": stockTop100,
    "marketRank/challenge/top100/coins": coinTop100,
    "marketRank/challenge/meta/updatedAt": updatedAt,
  });
  return {
    skipped: false,
    updatedAt,
    stockTop100: stockTop100.length,
    coinTop100: coinTop100.length,
  };
}

async function tryAcquireMarketRankChallengeRefreshLock(db, nowMs, holdMs = MARKET_RANK_LIVE_REFRESH_MIN_GAP_MS) {
  const ref = db.ref("marketRank/challenge/meta/liveRefreshLockUntil");
  const tx = await ref.transaction((cur) => {
    const curUntil = Number(cur || 0);
    if (Number.isFinite(curUntil) && curUntil > nowMs) return;
    return nowMs + holdMs;
  });
  return Boolean(tx?.committed);
}

async function maybeRunMarketRankChallengeLiveRefresh(sourceTag) {
  const db = admin.database();
  const now = Date.now();
  try {
    const locked = await tryAcquireMarketRankChallengeRefreshLock(db, now);
    if (!locked) return;
    const r = await runMarketRankChallengeAggregation(db, { skipIfMarketClosed: true });
    if (r.skipped) return;
    await db.ref("marketRank/challenge/meta/liveUpdatedAt").set(Date.now());
  } catch (e) {
    console.error(`[maybeRunMarketRankChallengeLiveRefresh:${sourceTag}]`, e?.message || e);
  }
}

async function runDailyOneRoutine(db, it) {
  const t = it?.type;
  if (t === "ranking") return { type: t, result: await runDailyAssetRankingServer(db) };
  if (t === "stockHolders") return { type: t, result: await runDailyStockHolderTop3Server(db) };
  if (t === "candlePrune") return { type: t, result: await runDailyPruneOldCandlesServer(db) };
  if (t === "userActivityPurge") {
    return { type: t, result: await runDailyPurgeUserTradeHistoryServer(db) };
  }
  if (t === "rankingVolumeReset") {
    return { type: t, result: await runDailyResetRankingVolumesServer(db) };
  }
  if (t === "clearAssetRequests") {
    const n = await clearRtdbChildrenServer(db, "assetRequests");
    return { type: t, result: { ok: true, deleted: n } };
  }
  if (t === "clearAdRequests") {
    const n = await clearRtdbChildrenServer(db, "adRequests");
    return { type: t, result: { ok: true, deleted: n } };
  }
  if (t === "circuitBreakerClear") {
    return { type: t, result: await runDailyClearCircuitFreezesServer(db) };
  }
  if (t === "marketRankRefresh") {
    const r = await runMarketRankAggregation(db, { skipIfMarketClosed: false });
    return { type: t, result: r };
  }
  if (t === "regularHoursSet") {
    const ro = clampDailyRoutineTimeStrServer(it.regularOpen, "20:00");
    const rc = clampDailyRoutineTimeStrServer(it.regularClose, "00:00");
    if (ro === rc) throw new Error("regularHoursSet: open equals close");
    return { type: t, result: await runDailyRegularHoursSetServer(db, ro, rc) };
  }
  if (t === "maintenanceMode") {
    const on = it.maintenanceOn === true;
    await db.ref("siteConfig/maintenance").set(on);
    return { type: t, result: { ok: true, maintenance: on } };
  }
  if (t === "autoSplit") {
    const splitThresholdManwon = clampDailyAutoSplitThresholdManwonServer(it.thresholdManwon);
    const splitRatioN = clampDailyAutoSplitRatioNServer(it.ratioN);
    const thresholdWon = splitThresholdManwon * 10000;
    if (!Number.isInteger(splitRatioN) || splitRatioN <= 1 || thresholdWon <= 0) {
      return { type: t, result: { ok: false, reason: "bad_params" } };
    }
    const r = await executeAdminStockSplitCore(db, {
      kind: "threshold",
      ratioN: splitRatioN,
      thresholdWon,
    });
    return { type: t, result: r };
  }
  if (t === "challengePriceReset") {
    return { type: t, result: await runDailyChallengeResetServer(db) };
  }
  return { type: t || "unknown", result: { ok: false, reason: "unknown_type" } };
}

/**
 * 매시 정각(KST): siteConfig/dailyAuto.enabled 이고 "오늘 예정 시각"이 지났을 때 1회 루틴 실행.
 * (매분 폴링 대역비 절감 — 예: 04:37 예정이면 05:00 첫 틱에서 실행될 수 있음, 최대 약 1시간 지연)
 * 중복 방지: siteConfig/_functions/dailyAutoRunner/claims/{KST날짜}
 */
exports.dailyAutoRunner = onSchedule(
  {
    schedule: "0 * * * *",
    timeZone: "Asia/Seoul",
    region: "asia-northeast3",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async () => {
    const db = admin.database();
    const ymd = kstYmdString();
    const { h, m } = getKstHourMinute();
    const nowMs = Date.now();
    try {
      const cfgSnap = await db.ref("siteConfig/dailyAuto").once("value");
      if (!cfgSnap.exists()) return;
      const cfg = cfgSnap.val() || {};
      if (!cfg.enabled) return;

      const hour = clampInt(cfg.hour, 0, 23, 0);
      const minute = clampInt(cfg.minute, 0, 59, 0);
      const scheduledMs = kstLocalDateTimeToUtcMs(ymd, hour, minute);
      if (!Number.isFinite(scheduledMs) || nowMs < scheduledMs) return;

      const routinesRaw = Array.isArray(cfg.routines) ? cfg.routines : [];
      const routines = routinesRaw.map(normalizeDailyRoutineItemServer).filter(Boolean);
      if (routines.length === 0) {
        console.log("[dailyAutoRunner] skip: no routines", { ymd, hour, minute });
        return;
      }

      const claimed = await tryClaimDailyAutoDayRun(db, ymd);
      if (!claimed) {
        console.log("[dailyAutoRunner] skip: claim not acquired", { ymd });
        return;
      }

      const runStarted = Date.now();
      const itemResults = [];
      let abortedError = null;

      try {
        for (let i = 0; i < routines.length; i++) {
          const it = routines[i];
          try {
            const one = await runDailyOneRoutine(db, it);
            itemResults.push({ index: i, ok: true, ...one });
          } catch (stepErr) {
            itemResults.push({
              index: i,
              ok: false,
              type: it?.type,
              error: String(stepErr?.message || stepErr),
            });
            abortedError = stepErr;
            break;
          }
        }

        const doneMs = Date.now();
        const fullSuccess = !abortedError;
        await db.ref("siteConfig/dailyAuto").update({
          lastRunAt: doneMs,
          updatedAt: doneMs,
          lastServerRunAt: doneMs,
          lastServerRunYmd: ymd,
        });

        const logPayload = {
          type: "dailyAutoRun",
          ymd,
          scheduledHour: hour,
          scheduledMinute: minute,
          kstHour: h,
          kstMinute: m,
          startedAt: runStarted,
          finishedAt: doneMs,
          success: fullSuccess,
          routines: routines.map((r) => r.type),
          itemResults,
          error: abortedError ? String(abortedError.message || abortedError) : null,
        };
        await db.ref(`adminActivityLogs/dailyAutoRuns/${doneMs}`).set(logPayload);

        await finalizeDailyAutoDayClaim(db, ymd, {
          // 실패해도 completed 로 막음 → 다음 정각에 액면분할 등 이중 실행 방지(수동으로 claim 삭제 시 재시도)
          completed: true,
          success: fullSuccess,
          itemCount: routines.length,
          lastError: abortedError ? String(abortedError.message || abortedError).slice(0, 2000) : null,
        });
      } catch (e) {
        console.error("[dailyAutoRunner]", e?.message || e);
        await finalizeDailyAutoDayClaim(db, ymd, {
          completed: true,
          success: false,
          lastError: String(e?.message || e).slice(0, 2000),
        });
        try {
          await db.ref(`adminActivityLogs/dailyAutoRuns/${Date.now()}`).set({
            type: "dailyAutoRun",
            ymd,
            success: false,
            error: String(e?.message || e),
            finishedAt: Date.now(),
          });
        } catch (_) {
          /* noop */
        }
      }
    } catch (outer) {
      console.error("[dailyAutoRunner] outer", outer?.message || outer);
    }
  }
);

