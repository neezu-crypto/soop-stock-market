const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  STREAMER_VERIFICATION_NICKNAME_MAX_LENGTH,
  STREAMER_VERIFICATION_COOLDOWN_MS,
  STREAMER_ID_RE,
  requireNotInMaintenance,
  grantAchievement,
  assertNotBanned
} = require("./common");
const { logAdminAction } = require("./adminAuditLog");

// streamerVerifications는 스트리머 배팅시장과 공유하는 노드다. 그쪽 앱은 SOOP
// 아이디를 정체성의 기준(canonical key)으로 삼는데, 이 앱은 원래 닉네임으로만
// 매칭했다 — 그래서 같은 사람이 두 앱에서 각각 인증받으면 서로 다른 uid로
// 매핑된 레코드가 두 개 생기는 사고가 실제로 있었다(SOOP 아이디 우선, 닉네임은
// 폴백으로 찾아야 두 앱 중 어느 쪽에서 먼저 인증됐어도 같은 레코드로 합쳐진다).
async function findExistingStreamerRecord(db, nickname, soopId) {
  if (soopId) {
    const bySoopId = await db.ref("streamerVerifications").orderByChild("soopId").equalTo(soopId).limitToFirst(1).get();
    if (bySoopId.exists()) return bySoopId;
  }
  return db.ref("streamerVerifications").orderByChild("nickname").equalTo(nickname).limitToFirst(1).get();
}

// 로그인 세션은 공유되지만, 배팅시장의 프로필(bettingMarket/profiles/{uid})은
// 그쪽 앱의 approveVerification이 승인할 때만 채워진다 — 그래서 이 앱에서
// 인증됐을 뿐인 uid가 배팅시장에 처음 들어가면 프로필이 비어서 초기 상태(랜덤
// 닉네임 등)로 보이는 문제가 있었다. 여기서도 같이 채워준다(배팅시장의
// functions/src/lib/avatar.js avatarUrlFor와 동일한 규칙 — 별개 저장소라 상수
// 공유가 안 되므로 그쪽이 바뀌면 여기도 맞춰야 한다).
function avatarUrlForSoopId(soopId) {
  if (!soopId) return "";
  const folder = soopId.slice(0, 2);
  return "https://stimg.sooplive.com/LOGO/" + folder + "/" + soopId + "/" + soopId + ".jpg";
}
async function fillBettingMarketProfileIfEmpty(db, uid, nickname, soopId) {
  if (!uid) return;
  const profileRef = db.ref("bettingMarket/profiles/" + uid);
  const snap = await profileRef.get();
  const current = snap.val();
  if (current && current.nickname) return;
  await profileRef.update({ nickname, soopId: soopId || null, avatarUrl: avatarUrlForSoopId(soopId) });
}

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
  await assertNotBanned(db, auth);

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
  // SOOP 아이디 — 스트리머 배팅시장과 공유하는 정체성 기준 키. 형식은 그쪽 앱과
  // 동일(영문 소문자/숫자 2~20자, 이 저장소의 STREAMER_ID_RE와 동일한 패턴).
  const soopId = String(request.data?.soopId || "").trim();
  if (!STREAMER_ID_RE.test(soopId)) {
    throw new HttpsError("invalid-argument", "SOOP 아이디는 영문 소문자/숫자 2~20자로 입력해주세요.");
  }

  // 같은 닉네임 또는 같은 SOOP 아이디로 다른 uid가 이미 대기 중인 신청을 넣어뒀으면
  // 막는다 — 안 막으면 실제 스트리머의 신청이 검토되기 전에 다른 사람이 먼저(또는
  // 동시에) 신청해둘 수 있고, 관리자가 실수로 그 신청을 승인하면 같은 사람이 서로
  // 다른 uid 두 개에 영구히 매핑되는 상태가 된다.
  const duplicatePending = Object.values(allReq).some((r) =>
    r.status === "pending" && r.uid !== uid && (r.nickname === nickname || (soopId && r.soopId === soopId))
  );
  if (duplicatePending) {
    throw new HttpsError(
      "already-exists",
      "이미 같은 닉네임 또는 SOOP 아이디로 인증 검토를 기다리는 신청이 있습니다. 해당 신청이 처리된 후 다시 시도해주세요."
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

  // 이미 인증된 SOOP 아이디(우선) 또는 닉네임(폴백, SOOP 아이디 없는 레거시 레코드
  // 호환용)이면 "계정 전환" 신청으로 분류한다 — 그래도 방송 검증·관리자 승인
  // 절차는 최초 인증과 동일하게 거친다.
  const existingSnap = await findExistingStreamerRecord(db, nickname, soopId);
  const existingEntry = existingSnap.exists() ? Object.values(existingSnap.val())[0] : null;
  const isSwitch    = !!(existingEntry && existingEntry.uid !== uid);
  const existingUid = isSwitch ? existingEntry.uid : null;

  const ref = db.ref("streamerVerificationRequests").push();
  await ref.set({
    uid,
    nickname,
    soopId,
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

async function actionApproveStreamerVerification(db, { requestId }, auth) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");

  const reqSnap = await db.ref(`streamerVerificationRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();

  if (!reqData.isSwitch) {
    // 최초 인증 — 닉네임↔uid 매핑을 등록하고 계정 보호 플래그를 켠다. SOOP 아이디도
    // 같이 저장해야 배팅시장 쪽에서 이 레코드를 SOOP 아이디 기준으로 찾을 수 있다.
    const linkRef = db.ref("streamerVerifications").push();
    await db.ref().update({
      [`streamerVerifications/${linkRef.key}`]: {
        nickname: reqData.nickname, soopId: reqData.soopId || null, uid: reqData.uid, verifiedAt: Date.now(),
      },
      [`users/${reqData.uid}/streamerVerified`]: true,
      [`streamerVerificationRequests/${requestId}/status`]:     "approved",
      [`streamerVerificationRequests/${requestId}/reviewedAt`]: Date.now(),
    });
    await grantAchievement(db, reqData.uid, "account_protected");
    await fillBettingMarketProfileIfEmpty(db, reqData.uid, reqData.nickname, reqData.soopId);
  } else {
    // 계정 전환 — 기존 uid는 이미 인증돼 있으므로 신청 상태만 승인 처리한다.
    // 실제 커스텀 토큰 발급은 신청자가 requestStreamerVerification을 다시
    // 호출할 때 이뤄진다(위 함수의 approved+isSwitch 분기).
    // 기존 레코드가 SOOP 아이디 없이(레거시 또는 배팅시장에서) 만들어졌었다면
    // 이번 승인으로 같이 보완한다.
    const updates = {
      [`streamerVerificationRequests/${requestId}/status`]:     "approved",
      [`streamerVerificationRequests/${requestId}/reviewedAt`]: Date.now(),
    };
    if (reqData.soopId && reqData.existingUid) {
      const existingSnap = await db.ref("streamerVerifications").orderByChild("uid").equalTo(reqData.existingUid).limitToFirst(1).get();
      if (existingSnap.exists()) {
        const existingKey = Object.keys(existingSnap.val())[0];
        if (!existingSnap.val()[existingKey].soopId) {
          updates[`streamerVerifications/${existingKey}/soopId`] = reqData.soopId;
        }
      }
    }
    await db.ref().update(updates);
    // 전환 승인 후 실제로 로그인하게 되는 건 existingUid라, 배팅시장 프로필도
    // 그 uid 기준으로 채워야 한다(reqData.uid는 신청 당시의 임시 세션일 뿐).
    await fillBettingMarketProfileIfEmpty(db, reqData.existingUid, reqData.nickname, reqData.soopId);
  }

  await logAdminAction(
    db, auth,
    reqData.isSwitch ? "스트리머 인증 재신청 승인 (계정 전환)" : "스트리머 인증 승인",
    reqData.nickname + " (" + (reqData.soopId || "SOOP 아이디 미기재") + ")"
  );
  return { ok: true };
}

async function actionRejectStreamerVerification(db, { requestId }, auth) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");

  const reqSnap = await db.ref(`streamerVerificationRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();

  await db.ref(`streamerVerificationRequests/${requestId}`).update({
    status:     "rejected",
    reviewedAt: Date.now(),
  });
  await logAdminAction(db, auth, "스트리머 인증 반려", reqData.nickname + " (" + (reqData.soopId || "SOOP 아이디 미기재") + ")");
  return { ok: true };
}

// 배팅시장의 인증 해제(revokeVerification)는 soopId 기준으로 공유 streamerVerifications를
// 찾는데, 이 앱에서 최초 인증된 레코드는 soopId 필드 자체가 없어 그 함수로는 못 지운다.
// 그래서 이 앱 자체의 인증 상태(users/{uid}/streamerVerified)를 uid 기준으로 직접
// 해제하고, 공유 노드에 아직 레코드가 남아있으면 그것도 같이 지운다.
async function actionRevokeStreamerVerification(db, { uid }, auth) {
  if (!uid) throw new HttpsError("invalid-argument", "uid가 필요합니다.");

  const verifiedSnap = await db.ref("streamerVerifications").orderByChild("uid").equalTo(uid).limitToFirst(1).get();
  const updates = { [`users/${uid}/streamerVerified`]: false };
  let nickname = "";
  if (verifiedSnap.exists()) {
    const key = Object.keys(verifiedSnap.val())[0];
    nickname = verifiedSnap.val()[key].nickname || "";
    updates[`streamerVerifications/${key}`] = null;
  }
  await db.ref().update(updates);
  await logAdminAction(db, auth, "스트리머 인증 해제", (nickname ? nickname + " " : "") + "(uid: " + uid.slice(0, 10) + ")");
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
