const admin = require("firebase-admin");
const { getDatabase, getDatabaseWithUrl } = require("firebase-admin/database");

// 주식시장 전용 RTDB의 고정 URL이다. 기본 RTDB URL을 이 값으로 교체하지 않는다.
// 신원·인증·통합 캐시 등 공유 데이터는 항상 sharedDb()로만 읽고 쓴다.
const STOCK_MARKET_DATABASE_URL = "https://soop-stock-market-rtdb.firebaseio.com";
const STOCK_MARKET_MIGRATION_STATE_PATH = "adminCenter/stockMarketDatabaseMigration/state";
const STOCK_MARKET_PRIMARY_PHASE = "market-primary";

/**
 * 기존 공유 기본 RTDB를 명시적으로 반환한다.
 * @param {Function} databaseFactory 테스트용 Database factory
 * @returns {import("firebase-admin/database").Database}
 */
function sharedDb(databaseFactory = getDatabase) {
  return databaseFactory();
}

/**
 * 주식시장 전용 RTDB를 명시적으로 반환한다.
 * 경로 이름으로 DB를 자동 추론하는 helper는 의도적으로 제공하지 않는다.
 * @param {Function} databaseFactory 테스트용 Database factory
 * @param {import("firebase-admin/app").App} app 테스트용 Firebase App
 * @returns {import("firebase-admin/database").Database}
 */
// firebase-admin의 getDatabase(app, url)는 URL 인자를 받지 않아 기본 DB를 반환한다.
// 반드시 getDatabaseWithUrl(url, app)을 사용한다.
function stockDb(databaseFactory = getDatabaseWithUrl, app = admin.app()) {
  return databaseFactory(STOCK_MARKET_DATABASE_URL, app);
}

/**
 * 운영 전환은 이 정확한 phase가 서버 전용 경로에 기록된 뒤에만 허용한다.
 * null/오류/알 수 없는 상태는 모두 기본 DB 유지로 처리한다.
 */
function isStockMarketPrimary(migrationState) {
  return migrationState?.phase === STOCK_MARKET_PRIMARY_PHASE;
}

/**
 * 시장 데이터의 현재 소유 DB를 반환한다. 호출자가 migrationState를 공유 DB에서
 * 읽어 전달하므로, 이 helper 자체는 RTDB 읽기·쓰기를 발생시키지 않는다.
 */
function resolveMarketDatabase({ migrationState, sharedDatabase, stockDatabase }) {
  if (!sharedDatabase) throw new Error("sharedDatabase가 필요합니다.");
  if (isStockMarketPrimary(migrationState)) {
    if (!stockDatabase) throw new Error("시장 전환 상태에는 stockDatabase가 필요합니다.");
    return { db: stockDatabase, mode: "stock" };
  }
  return { db: sharedDatabase, mode: "shared" };
}

function marketAccountPath(mode, uid) {
  if (!uid) throw new Error("시장 계정 UID가 필요합니다.");
  return mode === "stock" ? `stockMarket/accounts/${uid}` : `users/${uid}`;
}

/**
 * 각 callable의 시작 지점에서 사용한다. migration state는 공유 기본 DB에만
 * 보관하므로, 전용 시장 DB가 비어 있거나 접근 오류가 나더라도 자동 전환되지 않는다.
 * @param {object} deps 테스트용 의존성 주입
 */
async function getMarketDatabaseContext({
  sharedDatabase = sharedDb(),
  getStockDatabase = stockDb,
} = {}) {
  const migrationState = (await sharedDatabase.ref(STOCK_MARKET_MIGRATION_STATE_PATH).get()).val() || null;
  const stockDatabase = isStockMarketPrimary(migrationState) ? getStockDatabase() : null;
  const selected = resolveMarketDatabase({ migrationState, sharedDatabase, stockDatabase });
  return {
    ...selected,
    sharedDb: sharedDatabase,
    migrationState,
    accountPath: (uid) => marketAccountPath(selected.mode, uid),
    accountRef: (uid) => selected.db.ref(marketAccountPath(selected.mode, uid)),
  };
}

async function getMarketUserContext({ uid, ...deps } = {}) {
  if (!uid) throw new Error("시장 사용자 UID가 필요합니다.");
  const market = await getMarketDatabaseContext(deps);
  const identitySnapshot = await market.sharedDb.ref(`users/${uid}`).get();
  return {
    ...market,
    identity: identitySnapshot.val() || {},
    account: await market.accountRef(uid).get().then((snapshot) => snapshot.val() || {}),
  };
}

module.exports = {
  STOCK_MARKET_DATABASE_URL,
  STOCK_MARKET_MIGRATION_STATE_PATH,
  STOCK_MARKET_PRIMARY_PHASE,
  sharedDb,
  stockDb,
  isStockMarketPrimary,
  resolveMarketDatabase,
  marketAccountPath,
  getMarketDatabaseContext,
  getMarketUserContext,
};
