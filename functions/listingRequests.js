const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { requireLinkedUser, requireNotInMaintenance, findStockIdByName, grantAchievement } = require("./common");

// ══════════════════════════════════════════════════════════
// 종목 상장 신청 — 검색해도 없는 스트리머를 유저가 직접 상장 요청할 수
// 있게 한다. 무료지만(비용 차감 없음) 아무 이름이나 즉시 상장되면 도배성
// 종목이 난립할 수 있으므로, 다른 셀프 신청 기능과 동일하게 신청만 유저가
// 하고 실제 상장은 관리자 승인 후에 이뤄진다.
// ══════════════════════════════════════════════════════════

const MAX_STOCK_NAME_LENGTH        = 12;
const LISTING_REQUEST_COOLDOWN_MS  = 60 * 1000; // 매크로/도배 방지용 최소 재신청 간격

const submitListingRequest = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const db = admin.database();
  await requireLinkedUser(db, auth.uid, auth);
  await requireNotInMaintenance(db, auth);

  // 매크로/도배성 연속 신청을 막기 위한 쿨다운 — 트랜잭션으로 검사와 갱신을
  // 원자적으로 처리해 동시에 여러 번 호출해도 하나만 통과한다.
  const now = Date.now();
  let tooSoon = false;
  await db.ref(`users/${auth.uid}/lastListingRequestAt`).transaction((last) => {
    if (last && now - last < LISTING_REQUEST_COOLDOWN_MS) {
      tooSoon = true;
      return; // abort, 값 유지
    }
    return now;
  });
  if (tooSoon) {
    throw new HttpsError("resource-exhausted", "상장 신청이 너무 빠릅니다. 1분 후 다시 시도해주세요.");
  }

  const stockName = String(request.data?.stockName || "").trim();
  if (!stockName) throw new HttpsError("invalid-argument", "종목명을 입력해주세요.");
  if (stockName.length > MAX_STOCK_NAME_LENGTH) {
    throw new HttpsError("invalid-argument", `종목명은 ${MAX_STOCK_NAME_LENGTH}자 이하로 입력해주세요.`);
  }

  const existingId = await findStockIdByName(db, stockName);
  if (existingId) {
    throw new HttpsError("already-exists", "이미 상장된 종목명입니다.");
  }

  const snap = await db.ref("listingRequests").get();
  const data = snap.val() || {};
  const alreadyRequested = Object.values(data).some(
    (r) => r.status === "pending" && r.stockName === stockName
  );
  if (alreadyRequested) {
    throw new HttpsError("already-exists", "이미 동일한 이름으로 대기 중인 상장 신청이 있습니다.");
  }

  const ref = db.ref("listingRequests").push();
  await ref.set({
    stockName,
    status:       "pending",
    requestedAt:  Date.now(),
    requesterUid: auth.uid,
  });

  return { ok: true, id: ref.key };
});

async function actionListListingRequests(db) {
  const snap = await db.ref("listingRequests").get();
  const data = snap.val() || {};
  const requests = Object.entries(data)
    .map(([id, r]) => ({ id, ...r }))
    .filter((r) => r.status === "pending")
    .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));
  return { ok: true, requests };
}

/**
 * 관리자가 신청을 승인하면 그 순간 새 종목이 실제로 상장된다(가격 10,000원 시작,
 * 다른 셀프 상장 경로인 actionUploadStocks와 동일한 초깃값). 관리자가 오타 등을
 * 발견하면 승인 시 stockName을 고쳐서 넘길 수 있다.
 */
async function actionApproveListingRequest(db, { requestId, stockName }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");

  const reqSnap = await db.ref(`listingRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();

  const finalStockName = String(stockName || "").trim() || reqData.stockName;
  if (!finalStockName) throw new HttpsError("invalid-argument", "종목명을 입력해주세요.");

  // 신청 이후 같은 이름이 이미 상장됐을 수 있으므로 승인 시점에 다시 확인한다.
  const existingId = await findStockIdByName(db, finalStockName);
  if (existingId) {
    throw new HttpsError("already-exists", "이미 상장된 종목명입니다. 이름을 확인하거나 신청을 거절해주세요.");
  }

  const newStockId = `id_${Date.now()}_0`;
  await db.ref().update({
    [`stocks/${newStockId}`]:                     { name: finalStockName, price: 10000 },
    [`listingRequests/${requestId}/stockName`]:   finalStockName,
    [`listingRequests/${requestId}/status`]:      "approved",
    [`listingRequests/${requestId}/reviewedAt`]:  Date.now(),
    [`listingRequests/${requestId}/stockId`]:     newStockId,
  });
  if (reqData.requesterUid) await grantAchievement(db, reqData.requesterUid, "listing_approved");

  return { ok: true, stockId: newStockId };
}

async function actionRejectListingRequest(db, { requestId }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");

  const reqSnap = await db.ref(`listingRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");

  await db.ref(`listingRequests/${requestId}`).update({
    status:     "rejected",
    reviewedAt: Date.now(),
  });
  return { ok: true };
}

module.exports = {
  submitListingRequest,
  actionListListingRequests,
  actionApproveListingRequest,
  actionRejectListingRequest,
};
