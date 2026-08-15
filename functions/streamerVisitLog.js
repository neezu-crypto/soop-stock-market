const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

function todayKeyKST() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  return kst.toISOString().split("T")[0];
}

// 인증 스트리머가 주식시장에 접속하면 관리자 디스코드로 알림이 가게 한다.
// 실제 발송은 admin-center의 RTDB 트리거(24번 웹훅 인프라)가 담당하고, 이
// 함수는 verifiedStreamerVisits 큐에 항목 하나를 쌓는 역할만 한다. 같은
// 스트리머가 새로고침을 반복해도 매번 울리지 않도록 하루(KST)에 한 번만
// 기록되게 dedup 노드로 막는다 - market별로 따로 세서, 같은 사람이 주식시장과
// 배팅시장을 둘 다 들르면 각각 한 번씩은 알림이 간다.
const logStockMarketVisit = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const db = admin.database();
  const uid = auth.uid;

  const verifiedSnap = await db.ref(`users/${uid}/streamerVerified`).get();
  if (!verifiedSnap.val()) return { ok: true, logged: false };

  const dateKey = todayKeyKST();
  const dedupRef = db.ref(`verifiedStreamerVisitDedup/stock/${uid}/${dateKey}`);
  let alreadyLogged = false;
  await dedupRef.transaction((cur) => {
    if (cur) {
      alreadyLogged = true;
      return; // abort, 값 유지
    }
    return true;
  });
  if (alreadyLogged) return { ok: true, logged: false };

  const vSnap = await db.ref("streamerVerifications").orderByChild("uid").equalTo(uid).limitToFirst(1).get();
  const vEntry = vSnap.exists() ? Object.values(vSnap.val())[0] : null;

  await db.ref("verifiedStreamerVisits").push({
    uid,
    nickname: vEntry?.nickname || "",
    soopId: vEntry?.soopId || "",
    market: "stock",
    visitedAt: Date.now(),
  });
  return { ok: true, logged: true };
});

module.exports = { logStockMarketVisit };
