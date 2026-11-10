const { createHash } = require("node:crypto");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { assertNotBanned } = require("./common");
const {
  claimMarketOperation,
  completeMarketOperation,
  failMarketOperation,
  writeMarketAudit,
} = require("./marketOperations");

const WALLET_ROOT = "gameSeriesWallet";
const PAYMENT_METHOD = "integrated-cash";
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const APPROVAL_LEASE_MS = 60 * 1000;

const PRODUCTS = Object.freeze({
  chartBanner: { price: 20, unit: "일", label: "차트 공통 배너" },
  cardBanner: { price: 1, unit: "일", label: "종목 카드 배너" },
  pin: { price: 1, unit: "시간", label: "최상단 고정" },
  relayRoom: { price: 1, unit: "시간", label: "중계방 홍보" },
});

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function fingerprint(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function requireRequestId(value) {
  const id = String(value || "");
  if (!REQUEST_ID_RE.test(id)) throw new HttpsError("invalid-argument", "신청 식별자가 올바르지 않습니다. 새로고침 후 다시 시도해주세요.");
  return id;
}

function isCashPromotionRequest(requestData) {
  return requestData?.paymentMethod === PAYMENT_METHOD;
}

function isRequestActionable(requestData, now = Date.now()) {
  if (requestData?.status === "pending") return true;
  if (!isCashPromotionRequest(requestData)) return false;
  return (requestData.status === "approving" && Number(requestData.approvalLeaseUntil) <= now) ||
    (requestData.status === "rejecting" && Number(requestData.rejectionLeaseUntil) <= now);
}

async function getPromotionCashStatus(db, uid) {
  const account = (await db.ref(`${WALLET_ROOT}/accounts/${uid}`).get()).val() || {};
  return {
    balanceCash: nonNegativeInteger(account.balanceCash),
    products: Object.fromEntries(Object.entries(PRODUCTS).map(([id, product]) => [id, { ...product }])),
  };
}

const getPromotionCashStatusCallable = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const db = admin.database();
  await assertNotBanned(db, request.auth);
  return { ok: true, ...(await getPromotionCashStatus(db, uid)) };
});

/**
 * 통합 캐시 원장은 공유 DB, 주식시장 홍보 신청은 시장 DB에 둔다.
 * 전환 전에는 두 인자가 같은 DB여도 동작해야 하므로 marketDatabase를 첫 번째
 * 인자로 유지하고 sharedDatabase만 선택 인자로 받는다.
 */
async function reserveCashPromotion(marketDatabase, {
  uid,
  product,
  units,
  requestId,
  requestPath,
  requestData,
  sharedDatabase = marketDatabase,
  now = Date.now(),
}) {
  const definition = PRODUCTS[product];
  if (!definition) throw new HttpsError("invalid-argument", "홍보 상품 종류가 올바르지 않습니다.");
  if (!Number.isInteger(units) || units < 1) throw new HttpsError("invalid-argument", "신청 수량이 올바르지 않습니다.");
  const id = requireRequestId(requestId || marketDatabase.ref(requestPath).push().key);
  const cashAmount = definition.price * units;
  const payloadFingerprint = fingerprint({ product, units, requestPath, requestData });
  const operation = await claimMarketOperation(marketDatabase, {
    operationId: id,
    uid,
    kind: "stock-promotion-reservation",
    request: { product, units, requestPath, requestData, cashAmount },
    now,
  });
  if (operation.action === "conflict") {
    throw new HttpsError("already-exists", "같은 신청 번호가 다른 내용에 사용됐습니다. 다시 신청해주세요.");
  }
  if (operation.action === "in-progress") {
    throw new HttpsError("aborted", "신청 처리 중입니다. 잠시 후 다시 시도해주세요.");
  }
  if (operation.action === "replay") {
    const request = (await marketDatabase.ref(`${requestPath}/${id}`).get()).val();
    const status = await getPromotionCashStatus(sharedDatabase, uid);
    return {
      ok: true,
      id,
      cashAmount,
      cashUnitPrice: definition.price,
      remainingCash: status.balanceCash,
      unit: definition.unit,
      replayed: true,
      requestStatus: request?.status || null,
    };
  }

  const accountRef = sharedDatabase.ref(`${WALLET_ROOT}/accounts/${uid}`);
  const before = (await accountRef.get()).val() || {};
  let insufficient = false;
  let conflict = false;
  let alreadyCharged = false;
  const debit = await accountRef.transaction((current) => {
    const account = current || before || {};
    const payments = account.stockPromotionPurchases && typeof account.stockPromotionPurchases === "object" ? account.stockPromotionPurchases : {};
    const previous = payments[id];
    if (previous && previous.status !== "refunded") {
      conflict = previous.fingerprint !== payloadFingerprint;
      alreadyCharged = !conflict && previous.status === "charged";
      return account;
    }
    const balance = nonNegativeInteger(account.balanceCash);
    if (balance < cashAmount) { insufficient = true; return; }
    return {
      ...account,
      balanceCash: balance - cashAmount,
      stockPromotionPurchases: {
        ...payments,
        [id]: { requestId: id, requestPath, product, units, cashAmount, fingerprint: payloadFingerprint, status: "charged", chargedAt: now },
      },
    };
  }, undefined, false);
  if (conflict) {
    await failMarketOperation(operation.ref, { requestHash: operation.requestHash, error: "같은 신청 번호가 다른 내용에 사용됨", now });
    throw new HttpsError("already-exists", "같은 신청 번호가 다른 내용에 사용됐습니다. 다시 신청해주세요.");
  }
  if (insufficient) {
    await failMarketOperation(operation.ref, { requestHash: operation.requestHash, error: "통합 캐시 부족", now });
    throw new HttpsError("failed-precondition", `통합 캐시가 부족합니다. 필요 ${cashAmount}캐시입니다.`);
  }
  if (!debit.committed && !alreadyCharged) {
    await failMarketOperation(operation.ref, { requestHash: operation.requestHash, error: "통합 캐시 차감 실패", now });
    throw new HttpsError("aborted", "통합 캐시 차감에 실패했습니다. 다시 시도해주세요.");
  }

  const stored = { ...requestData, status: "pending", requestedAt: now, requesterUid: uid, paymentMethod: PAYMENT_METHOD, product, units, cashUnitPrice: definition.price, cashAmount, paymentRequestId: id, refundStatus: "pending" };
  const requestRef = marketDatabase.ref(`${requestPath}/${id}`);
  let requestConflict = false;
  const requestTx = await requestRef.transaction((current) => {
    if (!current) return stored;
    requestConflict = current.requesterUid !== uid || current.paymentMethod !== PAYMENT_METHOD || current.paymentRequestId !== id || Number(current.cashAmount) !== cashAmount;
    return current;
  });
  if (requestConflict || !requestTx.snapshot.val()) {
    await refundCashPromotion(marketDatabase, id, stored, now, "접수 실패 환불", { sharedDatabase });
    await failMarketOperation(operation.ref, { requestHash: operation.requestHash, error: "신청 저장 실패", now });
    throw new HttpsError("already-exists", "신청을 저장하지 못해 통합 캐시를 환불했습니다. 다시 신청해주세요.");
  }
  const status = await getPromotionCashStatus(sharedDatabase, uid);
  await completeMarketOperation(operation.ref, {
    requestHash: operation.requestHash,
    result: { requestPath, requestId: id, cashAmount, status: requestTx.snapshot.val()?.status || "pending" },
    now,
  });
  // 감사 기록 실패가 이미 확정된 지갑 차감·신청 접수를 실패 응답으로 바꾸면
  // 사용자가 재시도했을 때 혼란만 생긴다. 원장은 complete 상태로 남으므로
  // 감사 쓰기는 best-effort로 분리한다.
  try {
    await writeMarketAudit(marketDatabase, id, {
      kind: "stock-promotion-reservation",
      uid,
      requestPath,
      cashAmount,
      state: "complete",
    });
  } catch (error) {
    console.error("stock promotion audit write failed", { requestId: id, error: String(error?.message || error) });
  }
  return { ok: true, id, cashAmount, cashUnitPrice: definition.price, remainingCash: status.balanceCash, unit: definition.unit };
}

async function refundCashPromotion(marketDatabase, requestId, requestData, now = Date.now(), note = "관리자 거절 환불", { sharedDatabase = marketDatabase } = {}) {
  if (!isCashPromotionRequest(requestData)) return { status: "not-applicable", cashAmount: 0 };
  const uid = String(requestData.requesterUid || "");
  const amount = nonNegativeInteger(requestData.cashAmount);
  if (!uid || !REQUEST_ID_RE.test(String(requestId || "")) || !amount) throw new HttpsError("failed-precondition", "환불 정보를 확인할 수 없습니다.");
  const accountRef = sharedDatabase.ref(`${WALLET_ROOT}/accounts/${uid}`);
  const before = (await accountRef.get()).val() || {};
  let result = null;
  const tx = await accountRef.transaction((current) => {
    const account = current || before || {};
    const purchases = account.stockPromotionPurchases && typeof account.stockPromotionPurchases === "object" ? account.stockPromotionPurchases : {};
    const purchase = purchases[requestId];
    if (!purchase) return;
    if (purchase.status === "refunded") { result = { status: "refunded", cashAmount: amount, alreadyProcessed: true }; return account; }
    result = { status: "refunded", cashAmount: amount, alreadyProcessed: false };
    return { ...account, balanceCash: nonNegativeInteger(account.balanceCash) + amount, stockPromotionPurchases: { ...purchases, [requestId]: { ...purchase, status: "refunded", refundedAt: now, refundNote: note } } };
  }, undefined, false);
  if (!result && !tx.committed) throw new HttpsError("aborted", "통합 캐시 환불을 완료하지 못했습니다.");
  return result || { status: "refunded", cashAmount: amount, alreadyProcessed: true };
}

async function rejectCashPromotionRequest(marketDatabase, requestPath, requestId, requestData, now = Date.now(), { sharedDatabase = marketDatabase } = {}) {
  if (!isCashPromotionRequest(requestData)) {
    if (requestData.status === "approved") throw new HttpsError("failed-precondition", "이미 승인된 신청은 거절할 수 없습니다.");
    await marketDatabase.ref(`${requestPath}/${requestId}`).update({ status: "rejected", reviewedAt: now, refundStatus: "not-applicable" });
    return { ok: true, refundStatus: "not-applicable", refundCash: 0 };
  }
  const requestRef = marketDatabase.ref(`${requestPath}/${requestId}`);
  const lock = await requestRef.transaction((current) => {
    if (!current || current.status === "approved" || current.status === "rejected") return;
    if (current.status === "approving" && Number(current.approvalLeaseUntil) > now) return;
    if (current.status === "rejecting" && Number(current.rejectionLeaseUntil) > now) return;
    return { ...current, status: "rejecting", approvalLeaseUntil: null, rejectionLeaseUntil: now + APPROVAL_LEASE_MS };
  });
  const locked = lock.snapshot.val();
  if (locked?.status === "rejected") return { ok: true, alreadyProcessed: true, refundStatus: locked.refundStatus, refundCash: locked.refundCash || 0 };
  if (!lock.committed || locked?.status !== "rejecting") throw new HttpsError("aborted", "신청 처리 중입니다. 잠시 후 다시 시도해주세요.");
  const refund = await refundCashPromotion(marketDatabase, requestId, locked, now, "관리자 거절 환불", { sharedDatabase });
  await requestRef.update({ status: "rejected", reviewedAt: now, rejectionLeaseUntil: null, refundStatus: refund.status, refundCash: refund.cashAmount, refundNote: "통합 캐시 전액 환불" });
  return { ok: true, refundStatus: refund.status, refundCash: refund.cashAmount };
}

async function commitCashPromotionApproval(db, requestPath, requestId, requestData, updates, now = Date.now()) {
  if (!isCashPromotionRequest(requestData)) { await db.ref().update(updates); return { alreadyProcessed: false }; }
  const requestRef = db.ref(`${requestPath}/${requestId}`);
  const lock = await requestRef.transaction((current) => {
    if (!current) return;
    if (current.status === "pending" || (current.status === "approving" && Number(current.approvalLeaseUntil) <= now)) return { ...current, status: "approving", approvalLeaseUntil: now + APPROVAL_LEASE_MS, rejectionLeaseUntil: null };
    return;
  });
  const locked = lock.snapshot.val();
  if (!lock.committed) {
    if (locked?.status === "approved") return { alreadyProcessed: true, request: locked };
    throw new HttpsError("failed-precondition", "이미 거절됐거나 처리할 수 없는 신청입니다.");
  }
  try {
    await db.ref().update({ ...updates, [`${requestPath}/${requestId}/approvalLeaseUntil`]: null });
    return { alreadyProcessed: false };
  } catch (error) {
    await requestRef.transaction((current) => current?.status === "approving" ? { ...current, status: "pending", approvalLeaseUntil: null } : undefined);
    throw error;
  }
}

module.exports = { PRODUCTS, PAYMENT_METHOD, getPromotionCashStatus, getPromotionCashStatusCallable, reserveCashPromotion, isCashPromotionRequest, isRequestActionable, rejectCashPromotionRequest, commitCashPromotionApproval };
