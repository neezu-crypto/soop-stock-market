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
  todayKeyKST,
  isAdmin,
  grantAchievement,
  assertNotBanned
} = require("./common");

// ══════════════════════════════════════════════════════════
// 무료 구독자 티켓은 KST 하루 1장, 무료분을 쓴 뒤에는 기존처럼 유료 구매한다.
// 요청·차감·모금액 정산·당첨 지급은 ticketId 기준으로 멱등 처리해 재시도해도
// 복권이나 게임머니가 중복 지급되지 않도록 한다.
// ══════════════════════════════════════════════════════════

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const SETTLEMENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

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
  await assertNotBanned(db, auth);

  const user = (await db.ref(`users/${uid}`).get()).val();
  const adminUser = await isAdmin(db, uid, auth.token?.email);
  const kstDay = todayKeyKST();
  const freeClaimRef = db.ref(`lotteryFreeClaims/${uid}/${kstDay}`);
  const activeSubscription = adminUser || Number((await db.ref(`streamerFanPageViewerSubscriptions/${uid}/expiresAt`).get()).val()) > Date.now();

  if (request.data?.action === "status") {
    const freeClaim = (await freeClaimRef.get()).val();
    const freeRequest = freeClaim?.requestId
      ? (await db.ref(`lotteryTicketRequests/${uid}/${freeClaim.requestId}`).get()).val()
      : null;
    const requestedRecoveryId = String(request.data?.requestId || "");
    const recoveryRequest = REQUEST_ID_RE.test(requestedRecoveryId)
      ? (await db.ref(`lotteryTicketRequests/${uid}/${requestedRecoveryId}`).get()).val()
      : null;
    return {
      ok: true,
      freeAvailable: !!activeSubscription && !freeClaim,
      freeUsed: !!freeClaim,
      freeRequestId: freeClaim?.status === "complete" ? "" : (freeClaim?.requestId || ""),
      freePending: !!freeRequest && freeRequest.status !== "complete",
      requestStatus: recoveryRequest?.status || "",
      requestSource: recoveryRequest?.source || "",
      eligible: !!activeSubscription,
      day: kstDay,
    };
  }

  const requestId = String(request.data?.requestId || "");
  if (!REQUEST_ID_RE.test(requestId)) {
    throw new HttpsError("invalid-argument", "복권 요청 정보가 올바르지 않습니다. 다시 시도해 주세요.");
  }

  const requestRef = db.ref(`lotteryTicketRequests/${uid}/${requestId}`);
  const proposedTicketId = db.ref("lotteryPurchases").push().key;
  const proposedDigits = [rollDigit(), rollDigit(), rollDigit()];
  const proposed = {
    uid, requestId, ticketId: proposedTicketId,
    digits: proposedDigits.join(""),
    won: proposedDigits.every((d) => d === LOTTERY_DIGIT_MAX),
    requestedDay: kstDay,
    subscriptionEligibleAtStart: !!activeSubscription,
    status: "pending", createdAt: Date.now(),
  };
  await requestRef.transaction((current) => current || proposed);
  let ticket = (await requestRef.get()).val();
  const ticketFreeClaimPath = `lotteryFreeClaims/${uid}/${ticket?.requestedDay || kstDay}`;
  const ticketFreeClaimRef = db.ref(ticketFreeClaimPath);
  if (!ticket?.ticketId) throw new HttpsError("aborted", "복권 요청을 준비하지 못했습니다. 다시 시도해 주세요.");
  if (ticket.status === "complete") {
    if (ticket.source === "subscription-free") {
      await ticketFreeClaimRef.update({ status: "complete", result: ticket.result, completedAt: ticket.completedAt || Date.now() });
    }
    return ticket.result;
  }

  if (!ticket.source) {
    let free = false;
    let claim = (await ticketFreeClaimRef.get()).val();
    if (claim?.ticketId === ticket.ticketId) free = true;
    else if (ticket.subscriptionEligibleAtStart) {
      const claimTx = await ticketFreeClaimRef.transaction((current) => current || {
        ticketId: ticket.ticketId,
        requestId,
        claimedAt: Date.now(),
      });
      claim = claimTx.snapshot.val();
      free = claim?.ticketId === ticket.ticketId;
    }
    await requestRef.child("source").transaction((current) => current || (free ? "subscription-free" : "paid"));
    ticket = (await requestRef.get()).val();
  }

  const source = ticket.source;
  const chargedAmount = source === "subscription-free" ? 0 : LOTTERY_TICKET_PRICE;
  if (chargedAmount > 0) {
    const userRef = db.ref(`users/${uid}`);
    let insufficient = false;
    const chargeTx = await userRef.transaction((current) => {
      const currentUser = current || user;
      if (!currentUser) return current;
      const charges = currentUser.lotteryTicketCharges || {};
      if (charges[ticket.ticketId]) return currentUser;
      const balance = Number(currentUser.cash) || 0;
      if (balance < chargedAmount) { insufficient = true; return; }
      return {
        ...currentUser,
        cash: balance - chargedAmount,
        lotteryTicketCharges: { ...charges, [ticket.ticketId]: { amount: chargedAmount, at: Date.now() } },
      };
    });
    if (insufficient) throw new HttpsError("failed-precondition", `게임자산이 부족합니다! (필요 금액: ${chargedAmount.toLocaleString()}원)`);
    if (!chargeTx.committed) throw new HttpsError("aborted", "복권 구매를 처리하지 못했습니다. 다시 시도해 주세요.");
  }

  const lotteryRef = db.ref("lottery");
  const settlementTx = await lotteryRef.transaction((current) => {
    const lottery = current || {};
    const settlements = lottery.settlements || {};
    if (settlements[ticket.ticketId]) return;
    const parsedPool = Number(lottery.pool);
    const poolBefore = lottery.pool == null || !Number.isFinite(parsedPool) ? LOTTERY_POOL_FLOOR : parsedPool;
    const poolAfterTicket = poolBefore + chargedAmount;
    const prizeAmount = ticket.won ? Math.round(poolAfterTicket * LOTTERY_PAYOUT_RATIO) : 0;
    const now = Date.now();
    for (const [id, entry] of Object.entries(settlements)) {
      if ((entry?.settledAt || 0) < now - SETTLEMENT_RETENTION_MS) delete settlements[id];
    }
    return {
      ...lottery,
      pool: ticket.won ? LOTTERY_POOL_FLOOR : poolAfterTicket,
      settlements: {
        ...settlements,
        [ticket.ticketId]: { ticketId: ticket.ticketId, uid, source, won: !!ticket.won, digits: ticket.digits, chargedAmount, prizeAmount, poolAfter: ticket.won ? LOTTERY_POOL_FLOOR : poolAfterTicket, settledAt: now },
      },
    };
  });
  const settlement = settlementTx.snapshot.child(`settlements/${ticket.ticketId}`).val()
    || (await db.ref(`lottery/settlements/${ticket.ticketId}`).get()).val();
  if (!settlement) throw new HttpsError("aborted", "복권 결과를 정산하지 못했습니다. 다시 시도해 주세요.");

  if (settlement.won) {
    const userRef = db.ref(`users/${uid}`);
    const trueUser = (await userRef.get()).val();
    await userRef.transaction((current) => {
      const currentUser = current || trueUser;
      if (!currentUser) return current;
      const payouts = currentUser.lotteryTicketPayouts || {};
      if (payouts[ticket.ticketId]) return currentUser;
      return {
        ...currentUser,
        cash: (Number(currentUser.cash) || 0) + settlement.prizeAmount,
        lotteryTicketPayouts: { ...payouts, [ticket.ticketId]: { amount: settlement.prizeAmount, at: settlement.settledAt } },
      };
    });
    await db.ref(`lotteryTripleSevenLog/${ticket.ticketId}`).set({ uid, digits: ticket.digits, at: settlement.settledAt });
    await grantAchievement(db, uid, "lottery_winner");
    if (settlementTx.committed) await db.ref("lotteryLastWin").set({ prizeAmount: settlement.prizeAmount, at: settlement.settledAt });
  }

  const result = {
    ok: true,
    digits: ticket.digits.split("").map(Number),
    won: !!ticket.won,
    prizeAmount: settlement.prizeAmount || 0,
    pool: settlement.poolAfter,
    free: source === "subscription-free",
    chargedAmount,
    freeAvailable: false,
  };
  const completedAt = Date.now();
  const completionUpdates = {
    [`lotteryPurchases/${ticket.ticketId}`]: { uid, digits: ticket.digits, won: !!ticket.won, prizeAmount: settlement.prizeAmount || 0, chargedAmount, source, purchasedAt: settlement.settledAt },
    [`lotteryTicketRequests/${uid}/${requestId}/status`]: "complete",
    [`lotteryTicketRequests/${uid}/${requestId}/result`]: result,
    [`lotteryTicketRequests/${uid}/${requestId}/completedAt`]: completedAt,
    [`users/${uid}/lotteryTicketCharges/${ticket.ticketId}`]: null,
    [`users/${uid}/lotteryTicketPayouts/${ticket.ticketId}`]: null,
  };
  if (source === "subscription-free") {
    completionUpdates[`${ticketFreeClaimPath}/status`] = "complete";
    completionUpdates[`${ticketFreeClaimPath}/result`] = result;
    completionUpdates[`${ticketFreeClaimPath}/completedAt`] = completedAt;
  }
  await db.ref().update(completionUpdates);
  return result;
});

module.exports = { buyLotteryTicket };
