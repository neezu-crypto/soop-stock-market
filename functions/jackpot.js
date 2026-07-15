const admin = require("firebase-admin");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const {
  JACKPOT_PRIZE_AMOUNT,
  JACKPOT_PER_ACCOUNT_CAP,
  JACKPOT_TARGET_MIN,
  JACKPOT_TARGET_RATIO,
  JACKPOT_TARGET_VARIANCE,
  JACKPOT_AUTO_TICK_RATIO,
  JACKPOT_AUTO_TICK_CAP_RATIO,
  todayKeyKST,
  creditUserCash,
  grantAchievement,
} = require("./common");

// ══════════════════════════════════════════════════════════
// 잭팟 종목 — 매일(또는 당첨될 때까지) 랜덤 종목 1개를 지정해, 전체 유저의
// 누적 매매량(매수+매도 합산)이 목표치에 도달하는 순간 그 매매를 실행한
// 유저가 상금을 받는다. trade.js가 매매 성공 시마다 이 파일의 함수들을
// best-effort로 호출한다(실패해도 매매 자체는 정상 처리됨).
//
// 목표치 = max(JACKPOT_TARGET_MIN, 전일 최고 매매량 델타 × 비율 × 랜덤변동)
// "전일 최고 매매량 델타"는 매 거래마다 그 종목이 그날 처음 거래될 때
// (updateStockDailySnapshot) 스냅샷되는 lastDayVolumeDelta들 중 최댓값을
// jackpotDailyMaxDelta에 실시간으로 반영해두는 방식이라, 별도 스케줄
// 작업이나 전체 종목 스캔 없이 저렴하게 유지된다.
// ══════════════════════════════════════════════════════════

/** 종목별 "전일 매매량 델타" 스냅샷 — 그 종목이 오늘 처음 거래될 때만 갱신(best-effort). */
async function updateStockDailySnapshot(db, stockId, currentVolume) {
  const today = todayKeyKST();
  const ref = db.ref(`stocks/${stockId}`);
  const snap = await ref.get();
  const stock = snap.val();
  if (!stock || stock.snapshotDate === today) return; // 오늘 이미 스냅샷됨

  const delta = Math.max(0, currentVolume - (stock.volumeAtSnapshot ?? currentVolume));
  await ref.update({
    lastDayVolumeDelta: delta,
    volumeAtSnapshot: currentVolume,
    snapshotDate: today,
  });

  if (delta > 0) {
    await db.ref("jackpotDailyMaxDelta").transaction((current) => {
      if (!current || current.date !== today) return { date: today, value: delta };
      return { date: today, value: Math.max(current.value, delta) };
    });
  }
}

/** 새 잭팟 종목/목표치를 랜덤으로 선정해 사이클을 시작한다. */
async function pickNewJackpot(db) {
  const stocksSnap = await db.ref("stocks").get();
  const stocksData = stocksSnap.val() || {};
  const ids = Object.keys(stocksData);
  if (ids.length === 0) return;

  const pickedId    = ids[Math.floor(Math.random() * ids.length)];
  const pickedStock = stocksData[pickedId];

  const deltaSnap     = await db.ref("jackpotDailyMaxDelta").get();
  const dailyMaxDelta = deltaSnap.val()?.value || 0;
  const randomFactor  = (1 - JACKPOT_TARGET_VARIANCE) + Math.random() * (JACKPOT_TARGET_VARIANCE * 2);
  const target = Math.max(
    JACKPOT_TARGET_MIN,
    Math.round(dailyMaxDelta * JACKPOT_TARGET_RATIO * randomFactor)
  );

  await db.ref().update({
    "jackpot/state": {
      stockId:   pickedId,
      stockName: pickedStock.name || pickedId,
      target,
      progress:  0,
      startedAt: Date.now(),
      wonAt:     null,
      winnerUid: null,
    },
    jackpotContributions: null, // 이전 사이클 계정별 기여 기록 초기화
  });
}

/**
 * 매매 성공 후 best-effort로 호출 — 지금 거래된 종목이 잭팟 종목이면
 * 계정당 상한(JACKPOT_PER_ACCOUNT_CAP) 안에서 기여량을 반영하고, 목표치에
 * 도달하는 순간(동시성 상황에서도 정확히 한 명만) 그 유저에게 상금을
 * 지급한 뒤 다음 잭팟 사이클을 시작한다.
 *
 * isProtected(계정 보호 여부)를 넘겨받아 익명 유저는 아예 카운트에서
 * 제외한다 — 익명 계정은 무한정 새로 만들 수 있어, 계정당 상한만으로는
 * "여러 익명 계정을 파서 혼자 목표치를 채우고 마지막 트리거만 원하는
 * 계정으로 실행" 하는 셀프 파밍을 막지 못하기 때문(다른 현금 보상
 * 기능들과 동일한 이유로 로그인 유저만 대상으로 한정).
 */
async function contributeToJackpot(db, uid, stockId, qty, isProtected) {
  if (!isProtected) return;

  const stateSnap = await db.ref("jackpot/state").get();
  const state = stateSnap.val();
  if (!state || state.stockId !== stockId || state.wonAt) return;

  const contribRef  = db.ref(`jackpotContributions/${uid}`);
  const trueContrib = (await contribRef.get()).val() || 0;
  const contribTx = await contribRef.transaction((current) => {
    const c = current ?? trueContrib;
    return Math.min(JACKPOT_PER_ACCOUNT_CAP, c + qty);
  });
  if (!contribTx.committed) return;
  const delta = (contribTx.snapshot.val() || 0) - trueContrib;
  if (delta <= 0) return; // 이미 계정당 상한을 채움 — 더 매매해도 반영 안 됨

  const jackpotRef = db.ref("jackpot/state");
  const jackpotTx = await jackpotRef.transaction((current) => {
    if (!current || current.stockId !== stockId || current.wonAt) return current;
    const newProgress = (current.progress || 0) + delta;
    const crossed = newProgress >= current.target;
    return {
      ...current,
      progress:  newProgress,
      wonAt:     crossed ? Date.now() : null,
      winnerUid: crossed ? uid : null,
    };
  });
  if (!jackpotTx.committed) return;

  const finalState = jackpotTx.snapshot.val();
  const iWon = !!finalState.wonAt && finalState.winnerUid === uid;
  if (!iWon) return;

  await creditUserCash(db, uid, JACKPOT_PRIZE_AMOUNT);
  await grantAchievement(db, uid, "jackpot_winner");
  await db.ref("jackpotLastWin").set({
    stockName:   finalState.stockName,
    prizeAmount: JACKPOT_PRIZE_AMOUNT,
    at:          Date.now(),
  }); // 당첨자 개인정보(uid 등)는 담지 않는다 — 동결 해제 공지와 동일한 원칙
  await pickNewJackpot(db);
}

/**
 * 잭팟 진행률을 매매와 무관하게 1시간마다 자동으로 조금씩 채워, 실제 거래가
 * 뜸해도 진행 상황이 보이도록 하는 스케줄 함수. 다만 자동 증가만으로는
 * 당첨(target 도달)이 나지 않도록 목표치의 JACKPOT_AUTO_TICK_CAP_RATIO
 * (95%)까지만 올리고, 그 이후 마지막 구간은 반드시 실제 매매(contributeToJackpot)로
 * 채워야 당첨이 성립한다.
 */
const autoTickJackpotProgress = onSchedule("every 1 hours", async () => {
  const db = admin.database();
  const jackpotRef = db.ref("jackpot/state");
  await jackpotRef.transaction((current) => {
    if (!current || current.wonAt) return current;
    const target = current.target || 0;
    if (target <= 0) return current;
    const cap = Math.floor(target * JACKPOT_AUTO_TICK_CAP_RATIO);
    const progress = current.progress || 0;
    if (progress >= cap) return current;
    const tick = Math.max(1, Math.round(target * JACKPOT_AUTO_TICK_RATIO));
    return { ...current, progress: Math.min(cap, progress + tick) };
  });
});

module.exports = {
  updateStockDailySnapshot,
  contributeToJackpot,
  pickNewJackpot,
  autoTickJackpotProgress,
};
