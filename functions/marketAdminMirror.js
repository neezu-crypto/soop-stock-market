const { onValueWritten } = require("firebase-functions/v2/database");
const { stockDb } = require("./marketDatabases");

const MARKET_ADMIN_MIRROR_ROOT = "stockMarketAdminUids";

/**
 * 전용 RTDB 규칙은 공유 기본 DB의 adminCenter/adminUids를 참조할 수 없다.
 * 공유 관리자 원장이 바뀔 때 최소 권한 미러만 동기화한다. 이 값은 브라우저가
 * 쓰지 못하며, callable은 계속 공유 DB에서 requireAdmin을 다시 검사한다.
 */
async function syncStockMarketAdminUid(event, { getStockDatabase = stockDb } = {}) {
  const uid = String(event?.params?.uid || "");
  if (!uid) throw new Error("관리자 UID가 필요합니다.");
  const isAdmin = event.data.after.exists() && event.data.after.val() === true;
  const ref = getStockDatabase().ref(`${MARKET_ADMIN_MIRROR_ROOT}/${uid}`);
  if (isAdmin) {
    await ref.set(true);
    return { uid, mirrored: true };
  }
  await ref.remove();
  return { uid, mirrored: false };
}

const syncStockMarketAdminUidMirror = onValueWritten(
  "/adminCenter/adminUids/{uid}",
  async (event) => syncStockMarketAdminUid(event),
);

module.exports = {
  MARKET_ADMIN_MIRROR_ROOT,
  syncStockMarketAdminUid,
  syncStockMarketAdminUidMirror,
};
