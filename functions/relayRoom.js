const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  STREAMER_ID_RE,
  MAX_RELAY_ROOM_HOURS,
  RELAY_ROOM_COST_PER_HOUR,
  MAX_RELAY_ROOMS,
  chargeUserCash,
  creditUserCash,
} = require("./common");

// ══════════════════════════════════════════════════════════
// 중계방 홍보 — 현재 스트리머 주식시장을 플레이 중인 스트리머를 소개하는
// 별도 홍보 슬롯. 우측 랭킹 배너와 달리 재신청 시 "연장"하지 않고,
// 이미 진행 중이면 신청 자체를 거부한다(단순 중복 방지).
// ══════════════════════════════════════════════════════════

function buildRelayPreview(streamerId) {
  const prefix = streamerId.slice(0, 2);
  return {
    previewImg:  `https://stimg.sooplive.com/LOGO/${prefix}/${streamerId}/${streamerId}.jpg`,
    stationLink: `https://www.sooplive.com/station/${streamerId}`,
  };
}

/**
 * 중계방 홍보 신청 접수. 로그인(익명 포함)한 누구나 호출 가능 — 실제
 * 반영은 관리자 승인(actionApproveRelayRoomRequest) 후에만 이뤄진다.
 */
const submitRelayRoomRequest = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const nickname   = String(request.data?.nickname || "").trim();
  const streamerId = String(request.data?.streamerId || "").trim().toLowerCase();
  const hours      = parseInt(request.data?.hours, 10);

  if (!nickname) throw new HttpsError("invalid-argument", "닉네임을 입력해주세요.");
  if (!STREAMER_ID_RE.test(streamerId)) {
    throw new HttpsError("invalid-argument", "아이디는 영문 소문자/숫자 2~20자여야 합니다.");
  }
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_RELAY_ROOM_HOURS) {
    throw new HttpsError("invalid-argument", `홍보 시간은 1~${MAX_RELAY_ROOM_HOURS}시간 사이로 입력해주세요.`);
  }

  const db  = admin.database();
  const now = Date.now();

  // 이미 진행 중인 중계방이면 신청 자체를 막는다 (연장 없이 단순 거부).
  const activeSnap = await db.ref(`relayRooms/${streamerId}`).get();
  if (activeSnap.exists() && activeSnap.val().endAt > now) {
    throw new HttpsError("already-exists", "이미 진행 중인 중계방입니다. 종료된 뒤 다시 신청해주세요.");
  }

  // 같은 아이디로 검토 대기 중인 신청이 이미 있으면 중복 접수를 막는다.
  const allReqSnap = await db.ref("relayRoomRequests").get();
  const allReqs = allReqSnap.val() || {};
  const hasPending = Object.values(allReqs).some((r) => r.streamerId === streamerId && r.status === "pending");
  if (hasPending) {
    throw new HttpsError("already-exists", "이미 검토 대기 중인 신청이 있습니다.");
  }

  const cost = hours * RELAY_ROOM_COST_PER_HOUR;

  // 신청 시점에 게임자산을 바로 차감한다 (거절되면 actionRejectRelayRoomRequest에서 환불).
  await chargeUserCash(db, auth.uid, cost);

  const ref = db.ref("relayRoomRequests").push();
  const { previewImg, stationLink } = buildRelayPreview(streamerId);

  await ref.set({
    nickname,
    streamerId,
    previewImg,
    stationLink,
    hours,
    chargedAmount: cost,
    status:        "pending",
    requestedAt:   now,
    requesterUid:  auth.uid,
  });

  return { ok: true, id: ref.key, chargedAmount: cost };
});

async function actionListRelayRoomRequests(db) {
  const snap = await db.ref("relayRoomRequests").get();
  const data = snap.val() || {};
  const requests = Object.entries(data)
    .map(([id, r]) => ({ id, ...r }))
    .filter((r) => r.status === "pending")
    .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));
  return { ok: true, requests };
}

/** 현재 진행 중인(만료 전) 중계방 목록 — 관리자 페이지의 현황 표시용. */
async function actionListActiveRelayRooms(db) {
  const snap = await db.ref("relayRooms").get();
  const data = snap.val() || {};
  const now  = Date.now();
  const rooms = Object.entries(data)
    .filter(([, r]) => r.endAt > now)
    .map(([streamerId, r]) => ({ streamerId, ...r }))
    .sort((a, b) => a.endAt - b.endAt);
  return { ok: true, rooms, maxRooms: MAX_RELAY_ROOMS };
}

async function actionApproveRelayRoomRequest(db, { requestId, hours, nickname }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");
  const hoursNum = parseInt(hours, 10);
  if (!Number.isFinite(hoursNum) || hoursNum < 1) {
    throw new HttpsError("invalid-argument", "홍보 시간을 올바르게 입력해주세요.");
  }

  const reqSnap = await db.ref(`relayRoomRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();

  const finalNickname = String(nickname || "").trim() || reqData.nickname;
  const streamerId = reqData.streamerId;

  const now = Date.now();
  // 승인 시점에도 다시 확인 — 그 사이 다른 신청이 먼저 승인됐을 수 있다.
  const activeSnap = await db.ref(`relayRooms/${streamerId}`).get();
  if (activeSnap.exists() && activeSnap.val().endAt > now) {
    throw new HttpsError("already-exists", "이미 진행 중인 중계방입니다. 먼저 종료하거나 만료를 기다려주세요.");
  }

  // 최대 등록 인원(3명) 확인 — 이 아이디가 새로 슬롯을 차지하는 경우에만 검사.
  const allRoomsSnap = await db.ref("relayRooms").get();
  const allRooms = allRoomsSnap.val() || {};
  const activeCount = Object.values(allRooms).filter((r) => r.endAt > now).length;
  if (activeCount >= MAX_RELAY_ROOMS) {
    throw new HttpsError(
      "resource-exhausted",
      `중계방은 최대 ${MAX_RELAY_ROOMS}명까지만 등록할 수 있습니다. 기존 중계방이 종료된 뒤 승인해주세요.`
    );
  }

  const endAt = now + hoursNum * 3600000;

  await db.ref().update({
    [`relayRooms/${streamerId}`]: {
      nickname:    finalNickname,
      previewImg:  reqData.previewImg,
      stationLink: reqData.stationLink,
      startAt:     now,
      endAt,
    },
    [`relayRoomRequests/${requestId}/nickname`]:   finalNickname,
    [`relayRoomRequests/${requestId}/status`]:     "approved",
    [`relayRoomRequests/${requestId}/reviewedAt`]: Date.now(),
  });

  return { ok: true, endAt };
}

async function actionRejectRelayRoomRequest(db, { requestId }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");

  const reqSnap = await db.ref(`relayRoomRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();

  if (reqData.status === "pending") {
    await creditUserCash(db, reqData.requesterUid, reqData.chargedAmount);
  }

  await db.ref(`relayRoomRequests/${requestId}`).update({
    status:     "rejected",
    reviewedAt: Date.now(),
  });
  return { ok: true };
}

/** 관리자가 중계방을 만료 전에 직접 종료한다. */
async function actionDeleteRelayRoom(db, { streamerId }) {
  if (!streamerId) throw new HttpsError("invalid-argument", "streamerId가 필요합니다.");
  await db.ref(`relayRooms/${streamerId}`).remove();
  return { ok: true };
}

module.exports = {
  submitRelayRoomRequest,
  actionListRelayRoomRequests,
  actionListActiveRelayRooms,
  actionApproveRelayRoomRequest,
  actionRejectRelayRoomRequest,
  actionDeleteRelayRoom,
};
