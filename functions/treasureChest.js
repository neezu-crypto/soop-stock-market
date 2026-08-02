const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  STREAMER_ID_RE,
  TREASURE_CHEST_BALLOON_PRICE,
  TREASURE_CHEST_MAX_BUY_COUNT,
  TREASURE_CHEST_BULK_BONUS_THRESHOLD,
  TREASURE_CHEST_BULK_BONUS_RATE,
  TREASURE_CHEST_OPEN_BIG_RATE,
  TREASURE_CHEST_REWARD_SMALL,
  TREASURE_CHEST_REWARD_BIG,
  requireLinkedUser,
  requireNotInMaintenance,
  creditUserCash,
  assertNotBanned
} = require("./common");

// ══════════════════════════════════════════════════════════
// 보물상자 구매 신청 — cashCharge.js와 동일한 패턴(후원창에서 실제 후원 →
// 신청서 제출 → 관리자가 후원 내역 확인 후 승인)이지만, 임의 금액이 아니라
// 상자 개수(별풍선 33개/개)로 정찰제다. 10개 이상 한 번에 신청하면 상자
// 개수 기준 10% 보너스가 붙는다. 신청 시점엔 아무것도 지급하지 않고,
// 실제 상자 지급은 actionApproveTreasureChestRequest에서만 이뤄진다.
// ══════════════════════════════════════════════════════════

function computeChestPurchase(chestCount) {
  const bonusChestCount = chestCount >= TREASURE_CHEST_BULK_BONUS_THRESHOLD
    ? Math.floor(chestCount * TREASURE_CHEST_BULK_BONUS_RATE)
    : 0;
  return {
    chestCount,
    bonusChestCount,
    totalChestCount: chestCount + bonusChestCount,
    starBalloons: chestCount * TREASURE_CHEST_BALLOON_PRICE,
  };
}

const submitTreasureChestPurchaseRequest = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const db = admin.database();
  await requireLinkedUser(db, auth.uid, auth);
  await requireNotInMaintenance(db, auth);
  await assertNotBanned(db, auth);

  const nickname   = String(request.data?.nickname || "").trim();
  const soopId     = String(request.data?.soopId || "").trim().toLowerCase();
  const chestCount = parseInt(request.data?.chestCount, 10);

  if (!nickname) throw new HttpsError("invalid-argument", "닉네임을 입력해주세요.");
  if (!STREAMER_ID_RE.test(soopId)) {
    throw new HttpsError("invalid-argument", "아이디는 영문 소문자/숫자 2~20자여야 합니다.");
  }
  if (!Number.isInteger(chestCount) || chestCount < 1 || chestCount > TREASURE_CHEST_MAX_BUY_COUNT) {
    throw new HttpsError("invalid-argument", `구매 개수는 1~${TREASURE_CHEST_MAX_BUY_COUNT}개 사이로 입력해주세요.`);
  }

  const purchase = computeChestPurchase(chestCount);
  const ref = db.ref("treasureChestRequests").push();

  await ref.set({
    nickname,
    soopId,
    ...purchase,
    status:       "pending",
    requestedAt:  Date.now(),
    requesterUid: auth.uid,
  });

  return { ok: true, id: ref.key, ...purchase };
});

/**
 * 보물상자 개봉 — 소지 개수를 트랜잭션으로 1개 차감(0개면 abort)한 뒤
 * 95% 확률로 50만원, 5% 확률로 500만원을 즉시 지급한다.
 */
const openTreasureChest = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const db  = admin.database();
  const uid = auth.uid;
  await requireNotInMaintenance(db, auth);
  await assertNotBanned(db, auth);

  // transaction()의 updateFunction은 재시도 과정에서 실제 서버 값을 확인하기
  // 전에 한 번 더(때로는 null로) 불릴 수 있다 — 그 시점에 바로 return
  // undefined로 중단시키면 재시도 없이 잘못 실패 처리될 수 있어, 대신 매
  // 호출마다 판정 결과를 클로저 변수에 남기고 최종 커밋된 값으로 판단한다.
  const chestRef = db.ref(`users/${uid}/treasureChests`);
  let hadChest = false;
  const tx = await chestRef.transaction((current) => {
    const count = current || 0;
    if (count < 1) {
      hadChest = false;
      return count; // 변화 없음(그대로 유지)
    }
    hadChest = true;
    return count - 1;
  });

  if (!tx.committed || !hadChest) {
    console.error("openTreasureChest 실패", { uid, committed: tx.committed, snapshotVal: tx.snapshot.val() });
    throw new HttpsError("failed-precondition", "보유한 보물상자가 없습니다.");
  }

  const isBig = Math.random() < TREASURE_CHEST_OPEN_BIG_RATE;
  const reward = isBig ? TREASURE_CHEST_REWARD_BIG : TREASURE_CHEST_REWARD_SMALL;

  await creditUserCash(db, uid, reward);
  await db.ref("treasureChestOpens").push({ uid, reward, isBig, openedAt: Date.now() });

  return { ok: true, reward, isBig, remaining: tx.snapshot.val() || 0 };
});

async function actionListTreasureChestRequests(db) {
  const snap = await db.ref("treasureChestRequests").get();
  const data = snap.val() || {};
  const requests = Object.entries(data)
    .map(([id, r]) => ({ id, ...r }))
    .filter((r) => r.status === "pending")
    .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));
  return { ok: true, requests };
}

async function actionApproveTreasureChestRequest(db, { requestId }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");

  const reqSnap = await db.ref(`treasureChestRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();
  if (reqData.status !== "pending") {
    throw new HttpsError("failed-precondition", "이미 처리된 신청입니다.");
  }

  const chestRef = db.ref(`users/${reqData.requesterUid}/treasureChests`);
  await chestRef.transaction((current) => (current || 0) + (reqData.totalChestCount || 0));

  await db.ref(`treasureChestRequests/${requestId}`).update({
    status:     "approved",
    reviewedAt: Date.now(),
  });

  return { ok: true, totalChestCount: reqData.totalChestCount || 0 };
}

async function actionRejectTreasureChestRequest(db, { requestId }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");
  const reqSnap = await db.ref(`treasureChestRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  if (reqSnap.val().status !== "pending") {
    throw new HttpsError("failed-precondition", "이미 처리된 신청입니다.");
  }

  await db.ref(`treasureChestRequests/${requestId}`).update({
    status:     "rejected",
    reviewedAt: Date.now(),
  });
  return { ok: true };
}

module.exports = {
  submitTreasureChestPurchaseRequest,
  openTreasureChest,
  actionListTreasureChestRequests,
  actionApproveTreasureChestRequest,
  actionRejectTreasureChestRequest,
};
