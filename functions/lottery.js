const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  LOTTERY_TICKET_PRICE,
  LOTTERY_POOL_FLOOR,
  LOTTERY_PAYOUT_RATIO,
  LOTTERY_DIGIT_MIN,
  LOTTERY_DIGIT_MAX,
  requireLinkedUser,
  requireNotInMaintenance,
  chargeUserCash,
  creditUserCash,
  grantAchievement,
} = require("./common");

// ══════════════════════════════════════════════════════════
// 복권함 — 20만원짜리 복권을 사면 서버가 그 자리에서 세 자리 숫자(각 자리
// 1~7)를 확정한다. 777이면 그 순간 누적 모금액의 90%를 받고 모금액은
// 초기값(100만원)으로 리셋된다. 익명 계정 무한 생성 파밍을 막기 위해
// 계정 보호 유저만 구매 가능(출석 보상과 동일한 이유). 1인당 구매 개수
// 제한은 없다 — 티켓마다 실비용이 들어 많이 사는 게 파밍이 아니라 정상적인
// 복권 원리이기 때문이다. "긁기"는 클라이언트가 이 결과를 보여주는
// 연출일 뿐, 당첨 판정과 지급은 이 함수 안에서 이미 끝나 있다.
// ══════════════════════════════════════════════════════════

function rollDigit() {
  return LOTTERY_DIGIT_MIN + Math.floor(Math.random() * (LOTTERY_DIGIT_MAX - LOTTERY_DIGIT_MIN + 1));
}

const buyLotteryTicket = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const db  = admin.database();
  const uid = auth.uid;

  await requireLinkedUser(db, uid, auth);
  await requireNotInMaintenance(db, auth);

  await chargeUserCash(db, uid, LOTTERY_TICKET_PRICE);

  const digits = [rollDigit(), rollDigit(), rollDigit()];
  const digitsStr = digits.join("");
  const won = digits.every((d) => d === LOTTERY_DIGIT_MAX); // 7-7-7

  if (won) {
    // 이후 단계(모금액 트랜잭션·지급·업적)에서 예외가 나 함수가 중간에
    // 죽더라도 "777이 실제로 떴었다"는 사실 자체는 남기기 위해, 당첨 판정
    // 직후·다른 처리보다 먼저 별도 감사 로그에 기록한다. 이 로그 실패가
    // 실제 지급을 막아서는 안 되므로 실패해도 무시하고 계속 진행한다.
    try {
      await db.ref("lotteryTripleSevenLog").push({ uid, digits: digitsStr, at: Date.now() });
    } catch (e) {
      console.error("lotteryTripleSevenLog 기록 실패", e);
    }
  }

  const poolRef = db.ref("lottery/pool");
  let prizeAmount = 0;
  const poolTx = await poolRef.transaction((current) => {
    const poolBefore = current ?? LOTTERY_POOL_FLOOR;
    const poolAfterTicket = poolBefore + LOTTERY_TICKET_PRICE;
    if (won) {
      prizeAmount = Math.round(poolAfterTicket * LOTTERY_PAYOUT_RATIO);
      return LOTTERY_POOL_FLOOR;
    }
    return poolAfterTicket;
  });

  if (won) {
    await creditUserCash(db, uid, prizeAmount);
    await grantAchievement(db, uid, "lottery_winner");
    await db.ref("lotteryLastWin").set({
      prizeAmount,
      at: Date.now(),
    }); // 당첨자 개인정보는 담지 않는다 — 동결 해제·잭팟 공지와 동일한 원칙
  }

  await db.ref("lotteryPurchases").push({
    uid,
    digits: digitsStr,
    won,
    prizeAmount,
    chargedAmount: LOTTERY_TICKET_PRICE,
    purchasedAt: Date.now(),
  });

  return {
    ok: true,
    digits,
    won,
    prizeAmount,
    pool: poolTx.snapshot.val(),
  };
});

module.exports = { buyLotteryTicket };
