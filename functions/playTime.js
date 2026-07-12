const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  TEST_PERIOD_ACTIVE,
  ADMIN_EMAIL,
  ANON_DAILY_SECONDS,
  PLAYTIME_BASE_RATE,
  PLAYTIME_SURCHARGE_STEP,
  PLAYTIME_SURCHARGE_MAX,
  MAX_PLAYTIME_BUY_HOURS,
  MAX_HEARTBEAT_GAP_SECONDS,
  chargeUserCash,
  requireNotInMaintenance,
  todayKeyKST,
  computeTotalAssets,
  recordDailyAssetSnapshot,
  isUserProtected,
} = require("./common");

// ══════════════════════════════════════════════════════════
// 플레이타임 제한 — 서버 이용 비용 절감을 위해 하루 무료 이용 시간을 두고,
// 초과분은 게임머니로 직접 충전(자기서비스, 관리자 검수 불필요)한다.
//   - 익명 유저: 하루 15분 / 계정 보호(카카오·구글·스트리머 인증) 유저: 무제한 / 관리자: 무제한
//   - 충전 단가 = 총자산(현금+보유주식 평가금액) × 10% (기준, 1시간) — 익명 유저 전용
//   - 당일 n번째 추가 구매마다 할증 +10%p, 최대 +50%에서 상한
//   - 자정(KST) 지나면 사용시간·구매횟수 모두 초기화
//
// 2026-07-13: 계정 보호 유저는 무제한으로 전환했다 — 일일 한도는 무한정 새로
// 만들 수 있는 익명 계정의 실시간 연결 남용(=서버비)을 막는 게 목적인데,
// 계정 보호는 외부 인증이나 관리자 수동 검수를 거쳐야 해서 대량 생성이
// 어려우니 그쪽까지 제한할 이유가 없다고 판단했다.
// ══════════════════════════════════════════════════════════

/** 유저의 현재 일일 이용 한도/사용량/남은 시간을 계산한다 (하트비트 갱신 없이 조회만). */
async function getQuotaState(db, uid, auth) {
  if (auth.token?.email === ADMIN_EMAIL) return { unlimited: true };

  const user = (await db.ref(`users/${uid}`).get()).val() || {};
  if (isUserProtected(user)) return { unlimited: true };

  const today = todayKeyKST();
  const isNewDay = user.playQuotaDate !== today;

  const baseLimitSeconds = ANON_DAILY_SECONDS;
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

  const userTx = await userRef.transaction((currentUser) => {
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

  // 최근 7일 자산 변동 스냅샷 (best-effort — 실패해도 하트비트 자체는 정상 처리됨).
  // recordDailyAssetSnapshot 내부에서 오늘 이미 기록했으면 즉시 반환하므로,
  // 매 하트비트(20초 간격)마다 무거운 계산이 반복되지 않는다.
  if (userTx.committed && userTx.snapshot.exists()) {
    try {
      await recordDailyAssetSnapshot(db, uid, userTx.snapshot.val());
    } catch (e) {
      // 다음 하트비트 때 재시도됨
    }
  }

  return userTx;
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
  if (isUserProtected(updated)) return; // 계정 보호 유저는 이용시간 무제한

  const remainingSeconds = Math.max(
    0,
    ANON_DAILY_SECONDS + (updated.bonusSecondsToday || 0) - (updated.playSecondsUsedToday || 0)
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
    // 관리자는 이용시간 무제한이라 touchHeartbeat를 타지 않지만, 자산 변동
    // 그래프 기능은 관리자 계정으로도 확인해볼 수 있게 스냅샷만 별도로 남긴다.
    try {
      const adminUser = (await db.ref(`users/${auth.uid}`).get()).val();
      if (adminUser) await recordDailyAssetSnapshot(db, auth.uid, adminUser);
    } catch (e) {
      // best-effort
    }
    return { ok: true, unlimited: true, allowed: true };
  }

  const userTx = await touchHeartbeat(db, auth.uid);

  if (!userTx.committed || !userTx.snapshot.exists()) {
    return { ok: true, unlimited: false, allowed: true, remainingSeconds: ANON_DAILY_SECONDS };
  }

  const updated = userTx.snapshot.val();
  if (isUserProtected(updated)) {
    return { ok: true, unlimited: true, allowed: true };
  }

  const baseLimitSeconds = ANON_DAILY_SECONDS;
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

  const db   = admin.database();
  await requireNotInMaintenance(db, auth);
  const uid  = auth.uid;
  const isAdmin = auth.token?.email === ADMIN_EMAIL;
  const today = todayKeyKST();
  const user = (await db.ref(`users/${uid}`).get()).val() || { cash: 0, stocks: {} };
  const isProtected = isUserProtected(user);

  // 계정 보호(카카오·구글·스트리머 인증) 유저는 이용시간이 이미 무제한이라
  // 충전이 아무 효과가 없다 — 모르고 결제해 게임자산만 낭비하는 일을 막는다.
  if (isProtected && !isAdmin) {
    throw new HttpsError("failed-precondition", "계정 보호 유저는 이용시간이 무제한이라 충전이 필요 없습니다.");
  }

  let hours = parseInt(request.data?.hours, 10);

  // 테스트 기간 동안은 플레이 시간 충전(유료)을 원칙적으로 막았다(현재는
  // TEST_PERIOD_ACTIVE=false라 미적용) — 켜져도 이 시점엔 이미 위에서
  // 계정 보호 유저를 걸러냈으므로, 이 블록은 익명 유저 전면 차단으로만 동작한다.
  if (TEST_PERIOD_ACTIVE && !isAdmin) {
    throw new HttpsError("failed-precondition", "테스트 기간 중에는 플레이 시간 충전을 이용할 수 없습니다.");
  }

  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_PLAYTIME_BUY_HOURS) {
    throw new HttpsError("invalid-argument", `충전 시간은 1~${MAX_PLAYTIME_BUY_HOURS}시간 사이로 입력해주세요.`);
  }

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

  // 관리자 "구매 현황" 조회용 기록 — 지금까지는 플레이타임 구매만 어디에도
  // 남지 않아 관리자가 이력을 확인할 방법이 없었다.
  await db.ref("playTimePurchases").push({
    uid,
    hours,
    chargedAmount: cost,
    purchasedAt:   Date.now(),
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
