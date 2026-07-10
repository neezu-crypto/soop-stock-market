const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  DAILY_ATTENDANCE_REWARDS,
  todayKeyKST,
  creditUserCash,
  requireLinkedUser,
  requireNotInMaintenance,
  grantAchievement,
} = require("./common");

// ══════════════════════════════════════════════════════════
// 출석 보상 — 1~7일차 순으로 지급되는 "출석부" 방식(연속 스트릭이 아니라
// 하루라도 놓치면 1일차로 되돌아가는 주간 캘린더). 카카오/구글로 계정을
// 보호한 유저만 대상이다 — 익명 계정은 브라우저 데이터만 지우면 무한정
// 새로 만들 수 있어, 익명 계정까지 대상에 넣으면 1일차 보상만 반복
// 파밍하는 어뷰징이 바로 생긴다.
// ══════════════════════════════════════════════════════════

const claimDailyAttendance = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const db  = admin.database();
  const uid = auth.uid;

  await requireLinkedUser(db, uid, auth);
  await requireNotInMaintenance(db, auth);

  const today     = todayKeyKST();
  const yesterday = todayKeyKST(-1);

  const userRef  = db.ref(`users/${uid}`);
  const trueUser = (await userRef.get()).val();

  // 체크와 갱신을 트랜잭션 하나로 묶어, 동시에 두 번 눌러도(더블클릭 등)
  // 한 번만 인정되도록 한다 — 두 번째 시도는 트랜잭션 콜백 안에서
  // lastAttendanceDate가 이미 오늘로 바뀐 걸 보고 스스로 중단(abort)한다.
  let claimed = null; // { streak, reward } — 이번 호출에서 실제로 지급이 확정된 경우만 채워짐
  const userTx = await userRef.transaction((currentUser) => {
    const user = currentUser || trueUser;
    if (!user) return currentUser; // 아직 유저 데이터가 없는 극초반 — 그대로 둠
    if (user.lastAttendanceDate === today) {
      claimed = null;
      return; // 이미 오늘 받음 — 중단
    }

    const streak = user.lastAttendanceDate === yesterday
      ? ((user.attendanceStreak || 0) % DAILY_ATTENDANCE_REWARDS.length) + 1
      : 1;
    claimed = { streak, reward: DAILY_ATTENDANCE_REWARDS[streak - 1] };

    return {
      ...user,
      lastAttendanceDate: today,
      attendanceStreak:   streak,
    };
  });

  if (!userTx.committed || !claimed) {
    throw new HttpsError("already-exists", "오늘 출석 보상은 이미 받았습니다.");
  }

  await creditUserCash(db, uid, claimed.reward);
  if (claimed.streak === DAILY_ATTENDANCE_REWARDS.length) {
    await grantAchievement(db, uid, "attendance_streak");
  }
  return { ok: true, streak: claimed.streak, reward: claimed.reward };
});

module.exports = { claimDailyAttendance };
