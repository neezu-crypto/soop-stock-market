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
// 신청하면 닉네임과 신청 시각만 즉시 관리자에게 전달되고, 관리자가 별도로
// 신원을 확인한 뒤 승인/거절한다. 이미 다른 uid로 인증된 닉네임을 또 다른
// 기기에서 신청하면(=계정 전환 요청) 카카오/구글처럼 즉시 토큰을 내주지
// 않고, 매번 관리자 확인을 다시 거치게 한다 — 그렇지 않으면 남의 방송에
// 나온 스트리머 닉네임을 아무나 입력해 그 계정을 그대로 탈취할 수 있기 때문.
// ══════════════════════════════════════════════════════════

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
    return { ok: true, action: "pending", nickname: latest.nickname, isSwitch: !!latest.isSwitch };
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

  // 같은 닉네임으로 다른 uid가 이미 대기 중인 신청을 넣어뒀으면 막는다 —
  // 안 막으면 실제 스트리머의 신청이 검토되기 전에 다른 사람이 같은 닉네임으로
  // 먼저(또는 동시에) 신청해둘 수 있고, 관리자가 실수로 그 신청을 승인하면
  // 같은 닉네임이 서로 다른 uid 두 개에 영구히 매핑되는 상태가 된다.
  const duplicatePending = Object.values(allReq).some((r) => r.nickname === nickname && r.status === "pending" && r.uid !== uid);
  if (duplicatePending) {
    throw new HttpsError(
      "already-exists",
      "이미 같은 닉네임으로 인증 검토를 기다리는 신청이 있습니다. 해당 신청이 처리된 후 다시 시도해주세요."
    );
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

  const ref = db.ref("streamerVerificationRequests").push();
  await ref.set({
    uid,
    nickname,
    status:      "pending",
    requestedAt: now,
    isSwitch,
    existingUid,
  });

  return { ok: true, action: "pending", nickname, isSwitch };
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

async function actionListVerifiedStreamers(db) {
  const snap = await db.ref("streamerVerifications").get();
  const data = snap.val() || {};
  const streamers = Object.entries(data)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => (b.verifiedAt || 0) - (a.verifiedAt || 0));
  return { ok: true, streamers };
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

// 배팅시장의 인증 해제(revokeVerification)는 soopId 기준으로 공유 streamerVerifications를
// 찾는데, 이 앱에서 최초 인증된 레코드는 soopId 필드 자체가 없어 그 함수로는 못 지운다.
// 그래서 이 앱 자체의 인증 상태(users/{uid}/streamerVerified)를 uid 기준으로 직접
// 해제하고, 공유 노드에 아직 레코드가 남아있으면 그것도 같이 지운다.
async function actionRevokeStreamerVerification(db, { uid }) {
  if (!uid) throw new HttpsError("invalid-argument", "uid가 필요합니다.");

  const verifiedSnap = await db.ref("streamerVerifications").orderByChild("uid").equalTo(uid).limitToFirst(1).get();
  const updates = { [`users/${uid}/streamerVerified`]: false };
  if (verifiedSnap.exists()) {
    const key = Object.keys(verifiedSnap.val())[0];
    updates[`streamerVerifications/${key}`] = null;
  }
  await db.ref().update(updates);
  return { ok: true };
}

module.exports = {
  requestStreamerVerification,
  actionListStreamerVerificationRequests,
  actionListVerifiedStreamers,
  actionApproveStreamerVerification,
  actionRejectStreamerVerification,
  actionRevokeStreamerVerification,
};
