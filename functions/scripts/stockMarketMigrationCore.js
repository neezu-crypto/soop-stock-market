const crypto = require("node:crypto");

// 사용자 신원·로그인·인증·통합 캐시를 제외하고 시장 계정으로 옮길 필드다.
// 새 필드가 생기면 실제 writer를 먼저 대조한 뒤 이 목록에 추가한다.
const MARKET_ACCOUNT_FIELDS = Object.freeze([
  "cash",
  "stocks",
  "lastTradeTime",
  "tradeCount",
  "realizedPL",
  "lastAttendanceDate",
  "attendanceStreak",
  "achievements",
  "assetHistory",
  "lastAssetSnapshotDate",
  "playQuotaDate",
  "playSecondsUsedToday",
  "bonusSecondsToday",
  "lastHeartbeatAt",
  "purchasedHoursToday",
  "playTimeExpiresAt",
  "anonTopUpAppliedAt",
  "lastListingRequestAt",
  "lotteryTicketCharges",
  "lotteryTicketPayouts",
  "treasureChests",
]);

// 기본 DB에서 전용 주식시장 DB로 원형 복사할 최상위 경로 후보다.
// 실제 --apply 전에는 각 경로의 writer·다른 서비스 사용 여부를 재대조해야 한다.
const TRANSFER_ROOTS = Object.freeze([
  "stocks",
  "stocksPublic",
  "candlesticks",
  "sparklines",
  "rankings",
  "pinnedStocks",
  "lastUnfreezeEvent",
  "delistedStocksLog",
  "stockMarket",
  "lottery",
  "lotteryLastWin",
  "lotteryDailyTicketPool",
  "lotteryFreeClaims",
  "lotteryPurchases",
  "lotteryTicketRequests",
  "lotteryTripleSevenLog",
  "listingRequests",
  "bannerRequests",
  "chartBanner",
  "chartBannerRequests",
  "cardBannerRequests",
  "pinRequests",
  "relayRoomRequests",
  "relayRooms",
  "unfreezeDonationRequests",
  "frozenStockRequests",
  "treasureChestRequests",
  "treasureChestOpens",
  "playTimePurchases",
  "stockSimSessions",
  "adminCashAdjustments",
]);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value ?? null))).digest("hex");
}

function countEntries(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : 0;
}

function extractMarketAccounts(users) {
  const accounts = {};
  for (const [uid, user] of Object.entries(users || {})) {
    if (!user || typeof user !== "object") continue;
    const account = {};
    for (const field of MARKET_ACCOUNT_FIELDS) {
      if (Object.hasOwn(user, field)) account[field] = clone(user[field]);
    }
    if (Object.keys(account).length) accounts[uid] = account;
  }
  return accounts;
}

function buildTransferBundle(source = {}) {
  const bundle = {};
  for (const root of TRANSFER_ROOTS) bundle[root] = clone(source[root] ?? null);

  const sourceStockMarket = bundle.stockMarket && typeof bundle.stockMarket === "object"
    ? bundle.stockMarket
    : {};
  bundle.stockMarket = {
    ...sourceStockMarket,
    accounts: extractMarketAccounts(source.users),
  };
  // 전용 DB 규칙에서 관리자 읽기 권한을 판별하는 최소 미러다. 공유 adminCenter
  // 전체를 옮기지 않으며, 이후 변경은 syncStockMarketAdminUidMirror가 갱신한다.
  bundle.stockMarketAdminUids = clone(source.adminCenter?.adminUids ?? null);
  return bundle;
}

function summarizeBundle(bundle) {
  return Object.fromEntries(Object.entries(bundle).map(([path, value]) => [path, {
    hash: hash(value),
    entries: countEntries(value),
    bytes: Buffer.byteLength(JSON.stringify(value ?? null)),
  }]));
}

function compareBundles(expected, actual) {
  const paths = [...new Set([...Object.keys(expected || {}), ...Object.keys(actual || {})])].sort();
  return paths.map((path) => ({
    path,
    expectedHash: hash(expected?.[path]),
    actualHash: hash(actual?.[path]),
    expectedEntries: countEntries(expected?.[path]),
    actualEntries: countEntries(actual?.[path]),
    matches: hash(expected?.[path]) === hash(actual?.[path]),
  }));
}

module.exports = {
  MARKET_ACCOUNT_FIELDS,
  TRANSFER_ROOTS,
  canonicalize,
  hash,
  countEntries,
  extractMarketAccounts,
  buildTransferBundle,
  summarizeBundle,
  compareBundles,
};
