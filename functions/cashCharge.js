const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { STREAMER_ID_RE, creditUserCash } = require("./common");

// ══════════════════════════════════════════════════════════
// 자산 충전 신청 — 라이브 방송 후원 확인 후 관리자가 지급액을 직접 입력해 승인
// ══════════════════════════════════════════════════════════

/**
 * 자산 충전 신청 접수. 실제 후원은 라이브 방송에서 별도로 이뤄지고, 이
 * 함수는 "후원했다"는 신청만 접수한다 — 차감/지급 없이 pending 기록만
 * 남기고, 실제 지급은 관리자가 방송에서 후원을 직접 확인한 뒤
 * actionApproveCashChargeRequest에서 지급액을 입력해 처리한다.
 */
const submitCashChargeRequest = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const nickname = String(request.data?.nickname || "").trim();
  const soopId    = String(request.data?.soopId || "").trim().toLowerCase();

  if (!nickname) throw new HttpsError("invalid-argument", "닉네임을 입력해주세요.");
  if (!STREAMER_ID_RE.test(soopId)) {
    throw new HttpsError("invalid-argument", "아이디는 영문 소문자/숫자 2~20자여야 합니다.");
  }

  const db  = admin.database();
  const ref = db.ref("cashChargeRequests").push();

  await ref.set({
    nickname,
    soopId,
    status:       "pending",
    requestedAt:  Date.now(),
    requesterUid: auth.uid,
  });

  return { ok: true, id: ref.key };
});

async function actionListCashChargeRequests(db) {
  const snap = await db.ref("cashChargeRequests").get();
  const data = snap.val() || {};
  const requests = Object.entries(data)
    .map(([id, r]) => ({ id, ...r }))
    .filter((r) => r.status === "pending")
    .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));
  return { ok: true, requests };
}

async function actionApproveCashChargeRequest(db, { requestId, amount }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");
  const amountNum = parseInt(amount, 10);
  if (!Number.isFinite(amountNum) || amountNum < 1) {
    throw new HttpsError("invalid-argument", "지급액을 올바르게 입력해주세요.");
  }

  const reqSnap = await db.ref(`cashChargeRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();
  if (reqData.status !== "pending") {
    throw new HttpsError("failed-precondition", "이미 처리된 신청입니다.");
  }

  await creditUserCash(db, reqData.requesterUid, amountNum);

  await db.ref(`cashChargeRequests/${requestId}`).update({
    status:        "approved",
    grantedAmount: amountNum,
    reviewedAt:    Date.now(),
  });

  return { ok: true, amount: amountNum };
}

async function actionRejectCashChargeRequest(db, { requestId }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");
  const reqSnap = await db.ref(`cashChargeRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  if (reqSnap.val().status !== "pending") {
    throw new HttpsError("failed-precondition", "이미 처리된 신청입니다.");
  }

  await db.ref(`cashChargeRequests/${requestId}`).update({
    status:     "rejected",
    reviewedAt: Date.now(),
  });
  return { ok: true };
}

module.exports = {
  submitCashChargeRequest,
  actionListCashChargeRequests,
  actionApproveCashChargeRequest,
  actionRejectCashChargeRequest,
};
