const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { grantAchievement } = require("./common");

// ══════════════════════════════════════════════════════════
// 구글 로그인 연동 — 익명 계정 자산을 유지한 채 구글 계정으로 보호
//
// 카카오와 달리 구글은 Firebase가 기본 지원하는 제공자라, 실제 계정 연결은
// 전부 클라이언트에서 Firebase SDK로 처리된다:
//   - 처음 연동: linkWithPopup(auth.currentUser, googleProvider) — 지금 쓰던
//     익명 uid에 구글 자격증명을 그대로 이어붙인다(별도 매핑 테이블 불필요).
//   - 이미 다른 uid에 연동된 구글 계정이면: linkWithPopup이
//     auth/credential-already-in-use로 실패 → 클라이언트가 그 에러의
//     credential로 signInWithCredential을 호출해 기존 계정으로 전환한다
//     (카카오의 커스텀 토큰 발급과 동일한 효과를 Firebase가 네이티브로 제공).
//
// 이 함수는 그 이후 "정말 구글이 연동된 세션인지"만 서버에서 재확인하고
// (클라이언트가 링크 성공 여부를 속일 수 없도록) googleLinked 마킹을 한다 —
// 카카오처럼 외부 API 검증이나 자체 ID 매핑이 필요 없다. 익명/로그인 초기
// 자산이 동일해진 뒤로는 연동 자체에 현금 보너스가 없다(진행상황 보존 +
// 잭팟/복권/출석 같은 로그인 전용 콘텐츠 이용권이 연동의 가치). 카카오와
// 마찬가지로 이메일·이름·프로필 사진은 전혀 저장하지 않는다.
// ══════════════════════════════════════════════════════════
const linkGoogleAccount = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  // ID 토큰의 firebase.identities에 google.com이 있어야 실제로 구글이 연동된
  // 세션이다 — Firebase가 서명한 토큰이라 클라이언트가 위조할 수 없다.
  const hasGoogleIdentity = !!(auth.token?.firebase?.identities?.["google.com"]?.length);
  if (!hasGoogleIdentity) {
    throw new HttpsError("failed-precondition", "구글 계정 연동이 확인되지 않았습니다.");
  }

  const db = admin.database();
  await db.ref(`users/${auth.uid}/googleLinked`).set(true);
  await grantAchievement(db, auth.uid, "account_protected");

  return { ok: true, action: "linked" };
});

module.exports = { linkGoogleAccount };
