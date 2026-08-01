// 관리자 처리 내역 감사 로그 — 이 앱엔 원래 이런 로그가 전혀 없었다(admin.js의
// 다른 관리 액션들도 마찬가지). 통합 관리 센터에서 배팅시장의 기존 bettingMarket/
// auditLog와 합쳐서 보여주기 위해, 우선 스트리머 인증 관련 액션부터 기록을
// 남기기 시작한다(다른 관리 액션 전체로 넓히는 건 별도 작업).
const CAP = 200; // 배팅시장 AUDIT_LOG_CAP과 동일한 값 — push만 하고 지우는 로직이
                  // 없으면 무한히 쌓이므로 기록할 때마다 최근 CAP개로 잘라낸다.

async function trimToLast(ref, cap) {
  const snap = await ref.orderByKey().get();
  const keys = Object.keys(snap.val() || {});
  if (keys.length <= cap) return;
  const updates = {};
  keys.slice(0, keys.length - cap).forEach((key) => { updates[key] = null; });
  await ref.update(updates);
}

async function logAdminAction(db, auth, action, detail) {
  const logsRef = db.ref("adminAuditLog");
  const ref = logsRef.push();
  await ref.set({
    actorUid:  auth?.uid || "",
    actorName: (auth?.token && (auth.token.name || auth.token.email)) || auth?.uid || "",
    action,
    detail: detail || "",
    at: Date.now(),
  });
  await trimToLast(logsRef, CAP);
}

module.exports = { logAdminAction };
