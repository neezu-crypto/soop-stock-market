const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  STREAMER_VERIFICATION_NICKNAME_MAX_LENGTH,
  STREAMER_VERIFICATION_COOLDOWN_MS,
  requireNotInMaintenance,
  grantAchievement,
} = require("./common");

// ══════════════════════════════════════════════════════════
// 스트리머 인증 — 카카오/구글 연동을 꺼리는 유저를 위한 대체 계정 보호 경로.
//
// 닉네임은 아무 텍스트나 입력 가능해 그 자체로는 소유권 증명이 안 된다.
// 그래서 신청 시 서버가 4자리 코드를 발급하고, 신청자는 본인 방송에서 그
// 코드를 언급해 소유권을 증명한다 — 관리자가 다시보기에서 코드 일치를
// 확인한 뒤에만 승인한다. 이미 다른 uid로 인증된 닉네임을 또 다른 기기에서
// 신청하면(=계정 전환 요청) 카카오/구글처럼 즉시 토큰을 내주지 않고, 매번
// 새 코드로 다시 방송 검증을 거치게 한다 — 그렇지 않으면 남의 방송에 나온
// 스트리머 닉네임을 아무나 입력해 그 계정을 그대로 탈취할 수 있기 때문.
// ══════════════════════════════════════════════════════════

function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000)); // 1000~9999
}

/**
 * 신청/재확인을 겸하는 단일 엔드포인트. 호출할 때마다 이 uid의 현재 상태를
 * 보고 다음 중 하나로 분기한다:
 *   - 이미 이 uid 자체가 스트리머 인증됨            → already-verified
 *   - 대기 중인 신청이 있음                          → 기존 코드를 그대로 반환(pending)
 *   - 승인된 "계정 전환" 신청이 있음                 → 커스텀 토큰 발급(switch)
 *   - 그 외(신규 신청)                                → 새 신청 생성, 코드 발급(pending)
 */
const requestStreamerVerification = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const db  = admin.database();
  const uid = auth.uid;
  await requireNotInMaintenance(db, auth);

  const userSnap = await db.ref(`users/${uid}`).get();
  const user = userSnap.val() || {};
  if (user.streamerVerified) {
    return { ok: true, action: "already-verified" };
  }

  const allReqSnap = await db.ref("streamerVerificationRequests").get();
  const allReq = allReqSnap.val() || {};
  const myRequests = Object.entries(allReq)
    .map(([id, r]) => ({ id, ...r }))
    .filter((r) => r.uid === uid)
    .sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0));
  const latest = myRequests[0];

  if (latest?.status === "pending") {
    return { ok: true, action: "pending", code: latest.code, nickname: latest.nickname, isSwitch: !!latest.isSwitch };
  }

  if (latest?.status === "approved" && latest.isSwitch && latest.existingUid) {
    const customToken = await admin.auth().createCustomToken(latest.existingUid);
    await db.ref(`streamerVerificationRequests/${latest.id}/status`).set("switched");
    return { ok: true, action: "switch", customToken };
  }

  // 신규 신청 (또는 이전 신청이 거절/이미 전환 완료된 상태) — 새로 접수한다.
  const nickname = String(request.data?.nickname || "").trim();
  if (!nickname) throw new HttpsError("invalid-argument", "닉네임을 입력해주세요.");
  if (nickname.length > STREAMER_VERIFICATION_NICKNAME_MAX_LENGTH) {
    throw new HttpsError("invalid-argument", `닉네임은 ${STREAMER_VERIFICATION_NICKNAME_MAX_LENGTH}자 이하로 입력해주세요.`);
  }

  const now = Date.now();
  let tooSoon = false;
  await db.ref(`users/${uid}/lastStreamerVerificationRequestAt`).transaction((last) => {
    if (last && now - last < STREAMER_VERIFICATION_COOLDOWN_MS) {
      tooSoon = true;
      return; // abort, 값 유지
    }
    return now;
  });
  if (tooSoon) {
    throw new HttpsError("resource-exhausted", "신청이 너무 빠릅니다. 잠시 후 다시 시도해주세요.");
  }

  // 이미 다른 uid로 인증된 닉네임이면 "계정 전환" 신청으로 분류한다 — 그래도
  // 코드 발급·방송 검증·관리자 승인 절차는 최초 인증과 동일하게 거친다.
  const verifiedSnap = await db.ref("streamerVerifications").get();
  const verifiedData = verifiedSnap.val() || {};
  const existingEntry = Object.values(verifiedData).find((v) => v.nickname === nickname);
  const isSwitch    = !!(existingEntry && existingEntry.uid !== uid);
  const existingUid = isSwitch ? existingEntry.uid : null;

  const code = generateCode();
  const ref  = db.ref("streamerVerificationRequests").push();
  await ref.set({
    uid,
    nickname,
    code,
    status:      "pending",
    requestedAt: now,
    isSwitch,
    existingUid,
  });

  return { ok: true, action: "pending", code, nickname, isSwitch };
});

async function actionListStreamerVerificationRequests(db) {
  const snap = await db.ref("streamerVerificationRequests").get();
  const data = snap.val() || {};
  const requests = Object.entries(data)
    .map(([id, r]) => ({ id, ...r }))
    .filter((r) => r.status === "pending")
    .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));
  return { ok: true, requests };
}

async function actionApproveStreamerVerification(db, { requestId }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");

  const reqSnap = await db.ref(`streamerVerificationRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();

  if (!reqData.isSwitch) {
    // 최초 인증 — 닉네임↔uid 매핑을 등록하고 계정 보호 플래그를 켠다.
    const linkRef = db.ref("streamerVerifications").push();
    await db.ref().update({
      [`streamerVerifications/${linkRef.key}`]: { nickname: reqData.nickname, uid: reqData.uid, verifiedAt: Date.now() },
      [`users/${reqData.uid}/streamerVerified`]: true,
      [`streamerVerificationRequests/${requestId}/status`]:     "approved",
      [`streamerVerificationRequests/${requestId}/reviewedAt`]: Date.now(),
    });
    await grantAchievement(db, reqData.uid, "account_protected");
  } else {
    // 계정 전환 — 기존 uid는 이미 인증돼 있으므로 신청 상태만 승인 처리한다.
    // 실제 커스텀 토큰 발급은 신청자가 requestStreamerVerification을 다시
    // 호출할 때 이뤄진다(위 함수의 approved+isSwitch 분기).
    await db.ref(`streamerVerificationRequests/${requestId}`).update({
      status:     "approved",
      reviewedAt: Date.now(),
    });
  }

  return { ok: true };
}

async function actionRejectStreamerVerification(db, { requestId }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");

  const reqSnap = await db.ref(`streamerVerificationRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");

  await db.ref(`streamerVerificationRequests/${requestId}`).update({
    status:     "rejected",
    reviewedAt: Date.now(),
  });
  return { ok: true };
}

module.exports = {
  requestStreamerVerification,
  actionListStreamerVerificationRequests,
  actionApproveStreamerVerification,
  actionRejectStreamerVerification,
};
