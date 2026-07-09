const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  PROFIT_RANKING_CHECK_COST,
  PROFIT_RANKING_TOP_N,
  requireLinkedUser,
  requireNotInMaintenance,
  chargeUserCash,
} = require("./common");

// ══════════════════════════════════════════════════════════
// 순수 매매 손익 랭킹
// 보너스/후원 당첨금/신청 환불 등 매매 외 현금흐름은 전혀 반영하지 않는다 —
// trade()가 매도 시점마다 평단가 기준으로 누적해 둔 user.realizedPL(실현손익)
// "만" 반영한다. 미실현(보유 중 종목의 평가손익)은 의도적으로 제외한다 —
// 현재가는 본인이 직전에 소량 매수만으로도 순간적으로 밀어올릴 수 있는
// 값이라, 대량 보유 물량에 그 가격을 그대로 곱해 마킹하면 팔지 않고도
// (매도 시 자기 물량이 가격을 도로 끌어내리는 자기교정 없이) 가짜 이익을
// 순위표에 영구히 박아둘 수 있는 구멍이 있었다. 실현손익만 반영하면 실제로
// 판 수량에 대해서만, 그것도 본인 매도가 가격을 끌어내리는 만큼만 인정되어
// 이 트릭이 통하지 않는다.
// 익명 계정 도배를 막기 위해 카카오 연동 유저만 확인/갱신 가능하고,
// 확인할 때마다 게임자산을 차감해 상시 폴링을 억제한다(그 대가로 스케줄
// 재계산 없이 "확인하는 사람만" 서버가 계산하는 저비용 구조가 된다).
// 표시 이름은 실제 닉네임이 없으므로 uid 기반 익명 ID를 고정 사용한다.
// ══════════════════════════════════════════════════════════

function anonIdFor(uid) {
  return `트레이더-${uid.slice(-6).toUpperCase()}`;
}

const checkProfitRanking = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const uid = auth.uid;
  const db  = admin.database();

  await requireLinkedUser(db, uid, auth);
  await requireNotInMaintenance(db, auth);

  const userSnap = await db.ref(`users/${uid}`).get();
  const user     = userSnap.val() || {};
  const totalPL  = Math.round(user.realizedPL || 0);

  // 1) 확인 비용 차감 (실패 시 여기서 예외 — 아래 랭킹 갱신은 진행되지 않는다)
  await chargeUserCash(db, uid, PROFIT_RANKING_CHECK_COST);

  // 2) 내 순위표 항목 갱신
  const anonId = anonIdFor(uid);
  await db.ref(`rankings/profitEntries/${uid}`).set({
    anonId,
    value: totalPL,
    updatedAt: Date.now(),
  });

  // 3) 상위 N명 조회
  const topSnap = await db.ref("rankings/profitEntries")
    .orderByChild("value")
    .limitToLast(PROFIT_RANKING_TOP_N)
    .get();
  const topRaw = [];
  topSnap.forEach((child) => { topRaw.push(child.val()); });
  topRaw.sort((a, b) => b.value - a.value);

  // 4) 내 순위 계산 (나보다 값이 큰 사람 수 + 1)
  const higherSnap = await db.ref("rankings/profitEntries")
    .orderByChild("value")
    .startAt(totalPL + 1)
    .get();
  const myRank = (higherSnap.numChildren ? higherSnap.numChildren() : 0) + 1;

  return {
    ok: true,
    myProfit: totalPL,
    myRank,
    myAnonId: anonId,
    top: topRaw,
  };
});

module.exports = { checkProfitRanking };
