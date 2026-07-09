const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  TEST_PERIOD_ACTIVE,
  ADMIN_EMAIL,
  ANON_DAILY_SECONDS,
  KAKAO_DAILY_SECONDS,
  PLAYTIME_BASE_RATE,
  PLAYTIME_SURCHARGE_STEP,
  PLAYTIME_SURCHARGE_MAX,
  MAX_PLAYTIME_BUY_HOURS,
  MAX_HEARTBEAT_GAP_SECONDS,
  chargeUserCash,
  requireNotInMaintenance,
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

/**
 * 이용시간 사용량을 실제 경과시간만큼 갱신하는 트랜잭션 — heartbeat()와
 * checkPlayQuota()가 공유한다. 예전엔 checkPlayQuota가 heartbeat가 미리
 * 쌓아둔 값만 "읽기"만 했는데, 이 경우 클라이언트가 heartbeat 호출을
 * 건너뛰고 trade 등을 직접 호출하면 사용량이 영원히 0으로 남아 하루
 * 이용시간 제한이 무력화되는 문제가 있었다. 이제는 trade() 등 실제
 * 활동을 유발하는 모든 액션이 이 함수를 직접 호출해 스스로 시계를
 * 진행시키므로, heartbeat를 아예 호출하지 않아도 우회할 수 없다.
 */
async function touchHeartbeat(db, uid) {
  const now      = Date.now();
  const userRef  = db.ref(`users/${uid}`);
  const trueUser = (await userRef.get()).val();

  return userRef.transaction((currentUser) => {
    const user = currentUser || trueUser;
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
}

/**
 * trade() 등 실제 자산 변경 액션에서 재사용하는 quota 체크. 단순 조회가
 * 아니라 touchHeartbeat()로 사용량을 먼저 실제 경과시간만큼 갱신한 뒤
 * 판정한다 — 그래야 heartbeat 호출 없이 이 함수만 반복 호출해도 우회가
 * 안 된다(트랜잭션 자체가 시계 역할을 겸함).
 */
async function checkPlayQuota(db, uid, auth) {
  if (auth.token?.email === ADMIN_EMAIL) return;

  const userTx = await touchHeartbeat(db, uid);
  if (!userTx.committed || !userTx.snapshot.exists()) return; // 아직 유저 데이터가 없는 극초반 — initializeUser가 곧 처리

  const updated = userTx.snapshot.val();
  const baseLimitSeconds = updated.kakaoLinked ? KAKAO_DAILY_SECONDS : ANON_DAILY_SECONDS;
  const remainingSeconds = Math.max(
    0,
    baseLimitSeconds + (updated.bonusSecondsToday || 0) - (updated.playSecondsUsedToday || 0)
  );
  if (remainingSeconds <= 0) {
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

  const userTx = await touchHeartbeat(db, auth.uid);

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

  // 테스트 기간 동안은 관리자를 제외한 모두의 플레이 시간 충전(유료)을 막는다.
  if (TEST_PERIOD_ACTIVE && auth.token?.email !== ADMIN_EMAIL) {
    throw new HttpsError("failed-precondition", "테스트 기간 중에는 플레이 시간 충전을 이용할 수 없습니다.");
  }

  const hours = parseInt(request.data?.hours, 10);
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_PLAYTIME_BUY_HOURS) {
    throw new HttpsError("invalid-argument", `충전 시간은 1~${MAX_PLAYTIME_BUY_HOURS}시간 사이로 입력해주세요.`);
  }

  const db   = admin.database();
  await requireNotInMaintenance(db, auth);
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

  // 플레이타임 충전은 총자산(현금+평가금액) 기준으로 단가가 매겨지므로,
  // 구매 시점의 현금 잔액이 그보다 적을 수 있다. 이 경우에도 구매를 막지 않고
  // 그대로 차감해 마이너스 자산(미수금)이 되도록 허용한다.
  const { resultingCash } = await chargeUserCash(db, uid, cost, { allowNegative: true });

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

  return {
    ok: true,
    chargedAmount: cost,
    addedSeconds,
    resultingCash: resultingCash,
    negativeCashWarning: resultingCash < 0,
  };
});

module.exports = { heartbeat, buyPlayTime, checkPlayQuota, getQuotaState };
