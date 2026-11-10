const { onValueWritten } = require("firebase-functions/v2/database");
const { getDatabase } = require("firebase-admin/database");
const { stockDb } = require("./marketDatabases");

const DEDICATED_STOCK_DATABASE_INSTANCE = "soop-stock-market-rtdb";
const SHARED_STOCK_DATABASE_INSTANCE = "soop-stock-market-default-rtdb";

function publicStockFrom(stock) {
  if (!stock || typeof stock !== "object") return null;
  const publicStock = { ...stock };
  // 보유자 UID·동결 유발 UID는 공개 시세 뷰에 포함하지 않는다.
  delete publicStock.cardBannerHolderUid;
  delete publicStock.freezeTriggerUid;
  delete publicStock.triggerUid;
  return publicStock;
}

/**
 * stocks 원본을 공개 시세와 공유 이름 인덱스로 투영한다. 기본 DB 트리거와
 * 전용 DB 트리거가 같은 로직을 사용하므로, 전환 뒤 공개 카드가 멈추지 않는다.
 */
async function syncStockPublicProjection(event, {
  getMarketDatabase = getDatabase,
  getSharedDatabase = getDatabase,
} = {}) {
  const stockId = String(event?.params?.stockId || "");
  if (!stockId) throw new Error("stockId가 필요합니다.");
  const beforeName = event.data.before.exists() ? event.data.before.child("name").val() : null;
  const afterName = event.data.after.exists() ? event.data.after.child("name").val() : null;
  const marketDatabase = getMarketDatabase();
  const sharedDatabase = getSharedDatabase();
  const publicStock = event.data.after.exists() ? publicStockFrom(event.data.after.val()) : null;

  if (publicStock) await marketDatabase.ref(`stocksPublic/${stockId}`).set(publicStock);
  else await marketDatabase.ref(`stocksPublic/${stockId}`).remove();

  if (beforeName === afterName) return { stockId, nameChanged: false };
  if (afterName == null) await sharedDatabase.ref(`streamerNames/${stockId}`).remove();
  else await sharedDatabase.ref(`streamerNames/${stockId}`).set(afterName);
  await sharedDatabase.ref("streamerNamesMeta/updatedAt").set(Date.now());
  return { stockId, nameChanged: true };
}

// 기존 공유 기본 DB에서의 투영을 유지한다. instance를 지정하지 않으면 '*'로 배포되어
// 전용 DB의 변경도 이 함수가 받아 기본 DB의 stocksPublic을 다시 쓰므로 인스턴스를 고정한다.
const syncStreamerNameOnStockChange = onValueWritten(
  { ref: "/stocks/{stockId}", instance: SHARED_STOCK_DATABASE_INSTANCE },
  async (event) => syncStockPublicProjection(event),
);

// 전환 후 전용 DB의 변경도 공개 시세 뷰를 갱신한다. instance는 URL이 아니라
// Firebase RTDB 인스턴스 이름이다.
const syncDedicatedStockPublicOnStockChange = onValueWritten(
  { ref: "/stocks/{stockId}", instance: DEDICATED_STOCK_DATABASE_INSTANCE },
  async (event) => syncStockPublicProjection(event, {
    getMarketDatabase: stockDb,
    getSharedDatabase: getDatabase,
  }),
);

module.exports = {
  DEDICATED_STOCK_DATABASE_INSTANCE,
  SHARED_STOCK_DATABASE_INSTANCE,
  publicStockFrom,
  syncStockPublicProjection,
  syncStreamerNameOnStockChange,
  syncDedicatedStockPublicOnStockChange,
};
