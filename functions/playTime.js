const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  ADMIN_EMAIL,
  ANON_DAILY_SECONDS,
  KAKAO_DAILY_SECONDS,
  PLAYTIME_BASE_RATE,
  PLAYTIME_SURCHARGE_STEP,
  PLAYTIME_SURCHARGE_MAX,
  MAX_PLAYTIME_BUY_HOURS,
  MAX_HEARTBEAT_GAP_SECONDS,
  chargeUserCash,
} = require("./common");

// ══════════════════════════════════════════════════════════
// 플레이타임 제한 — 서버 이용 비용 절감을 위해 하루 무료 이용 시간을 두고,
// 초과분은 게임머니로 직접 충전(자기서비스, 관리자 검수 불필요)한다.
//   - 익명 유저: 하루 15분 / 카카오 연동 유저: 하루 60분 / 관리자: 무제한
//   - 충전 단가 = 총자산(현금+보유주식 평가금액) × 10% (기준, 1시간)
//   - 당일 n번째 추가 구매마다 할증 +10%p, 최대 +50%에서 상한
//   - 자정(KST) 지나면 사용시간·구매횟수 모두 초기화
// ══════════════════════════════════════════════════════════

function todayKeyKST() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  return kst.toISOString().split("T")[0];
}

/** 보유 현금 + 보유 주식 평가금액(현재가 기준)을 합산한 총자산을 계산한다. */
async function computeTotalAssets(db, user) {
  const holdings = Object.entries(user?.stocks || {}).filter(([, s]) => (s?.qty || 0) > 0);
  if (holdings.length === 0) return user?.cash || 0;

  const priceSnaps = await Promise.all(
    holdings.map(([stockId]) => db.ref(`stocks/${stockId}/price`).get())
  );
  const stockValue = holdings.reduce((sum, [, s], i) => {
    const price = priceSnaps[i].val() || 0;
    return sum + price * (s.qty || 0);
  }, 0);

  return (user?.cash || 0) + stockValue;
}

/** 유저의 현재 일일 이용 한도/사용량/남은 시간을 계산한다 (하트비트 갱신 없이 조회만). */
async function getQuotaState(db, uid, auth) {
  if (auth.token?.email === ADMIN_EMAIL) return { unlimited: true };

  const user = (await db.ref(`users/${uid}`).get()).val() || {};
  const today = todayKeyKST();
  const isNewDay = user.playQuotaDate !== today;

  const baseLimitSeconds = user.kakaoLinked ? KAKAO_DAILY_SECONDS : ANON_DAILY_SECONDS;
  const usedSeconds      = isNewDay ? 0 : (user.playSecondsUsedToday || 0);
  const bonusSeconds     = isNewDay ? 0 : (user.bonusSecondsToday || 0);
  const remainingSeconds = Math.max(0, baseLimitSeconds + bonusSeconds - usedSeconds);

  return { unlimited: false, today, isNewDay, baseLimitSeconds, usedSeconds, bonusSeconds, remainingSeconds };
}

/** trade() 등 실제 자산 변경 액션에서 재사용하는 quota 체크 — 소진 시 예외를 던진다. */
async function checkPlayQuota(db, uid, auth) {
  const state = await getQuotaState(db, uid, auth);
  if (state.unlimited) return;
  if (state.remainingSeconds <= 0) {
    throw new HttpsError(
      "resource-exhausted",
      "오늘 이용 시간이 모두 소진됐습니다. 시간을 충전하거나 내일 다시 이용해주세요."
    );
  }
}

/**
 * 클라이언트가 주기적으로(예: 20~30초 간격) 호출하는 하트비트.
 * 경과 시간은 클라이언트가 주장하는 값이 아니라 서버에 저장된
 * lastHeartbeatAt과의 실제 시간차로 계산한다 — 절전/네트워크 단절 등으로
 * 간격이 비정상적으로 벌어져도 MAX_HEARTBEAT_GAP_SECONDS로 상한을 둬
 * 불공평하게 큰 차감이 발생하지 않도록 한다.
 */
const heartbeat = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const db = admin.database();

  if (auth.token?.email === ADMIN_EMAIL) {
    return { ok: true, unlimited: true, allowed: true };
  }

  const now      = Date.now();
  const userRef  = db.ref(`users/${auth.uid}`);
  const trueUser = (await userRef.get()).val();

  const userTx = await userRef.transaction((currentUser) => {
    const user  = currentUser || trueUser;
    if (!user) return currentUser;

    const today   = todayKeyKST();
    const isNewDay = user.playQuotaDate !== today;
    const lastHeartbeatAt = isNewDay ? now : (user.lastHeartbeatAt || now);
    const elapsedMs = Math.max(0, Math.min(now - lastHeartbeatAt, MAX_HEARTBEAT_GAP_SECONDS * 1000));

    return {
      ...user,
      playQuotaDate:        today,
      playSecondsUsedToday: (isNewDay ? 0 : (user.playSecondsUsedToday || 0)) + Math.floor(elapsedMs / 1000),
      bonusSecondsToday:    isNewDay ? 0 : (user.bonusSecondsToday || 0),
      lastHeartbeatAt:      now,
    };
  });

  if (!userTx.committed || !userTx.snapshot.exists()) {
    return { ok: true, unlimited: false, allowed: true, remainingSeconds: ANON_DAILY_SECONDS };
  }

  const updated = userTx.snapshot.val();
  const baseLimitSeconds = updated.kakaoLinked ? KAKAO_DAILY_SECONDS : ANON_DAILY_SECONDS;
  const remainingSeconds = Math.max(
    0,
    baseLimitSeconds + (updated.bonusSecondsToday || 0) - (updated.playSecondsUsedToday || 0)
  );

  return {
    ok: true,
    unlimited: false,
    allowed: remainingSeconds > 0,
    remainingSeconds,
    baseLimitSeconds,
  };
});

/**
 * 시간 부족분을 게임머니로 자기서비스 충전한다 (관리자 검수 불필요, 즉시 반영).
 * 단가는 총자산 기준이라 매 구매마다 새로 계산하고, 같은 날 이미 구매한
 * 횟수만큼 할증률이 누적된다.
 */
const buyPlayTime = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const hours = parseInt(request.data?.hours, 10);
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_PLAYTIME_BUY_HOURS) {
    throw new HttpsError("invalid-argument", `충전 시간은 1~${MAX_PLAYTIME_BUY_HOURS}시간 사이로 입력해주세요.`);
  }

  const db   = admin.database();
  const uid  = auth.uid;
  const user = (await db.ref(`users/${uid}`).get()).val() || { cash: 0, stocks: {} };

  const today = todayKeyKST();
  const isNewDay = user.playQuotaDate !== today;
  const purchasedTodayBefore = isNewDay ? 0 : (user.purchasedHoursToday || 0);

  const totalAssets = await computeTotalAssets(db, user);
  const basePrice   = totalAssets * PLAYTIME_BASE_RATE;

  // 오늘 이미 구매한 시간 수(purchasedTodayBefore) 다음부터 hours개만큼 순서대로 할증 적용
  let cost = 0;
  for (let i = 1; i <= hours; i++) {
    const n = purchasedTodayBefore + i;
    const surcharge = Math.min(PLAYTIME_SURCHARGE_MAX, PLAYTIME_SURCHARGE_STEP * n);
    cost += Math.round(basePrice * (1 + surcharge));
  }

  await chargeUserCash(db, uid, cost);

  const userRef  = db.ref(`users/${uid}`);
  const trueUser = (await userRef.get()).val();
  const addedSeconds = hours * 3600;

  await userRef.transaction((currentUser) => {
    const u = currentUser || trueUser;
    if (!u) return currentUser;
    const isNewDay2 = u.playQuotaDate !== today;
    return {
      ...u,
      playQuotaDate:         today,
      playSecondsUsedToday:  isNewDay2 ? 0 : (u.playSecondsUsedToday || 0),
      bonusSecondsToday:     (isNewDay2 ? 0 : (u.bonusSecondsToday || 0)) + addedSeconds,
      purchasedHoursToday:   (isNewDay2 ? 0 : (u.purchasedHoursToday || 0)) + hours,
    };
  });

  return { ok: true, chargedAmount: cost, addedSeconds };
});

module.exports = { heartbeat, buyPlayTime, checkPlayQuota, getQuotaState };
