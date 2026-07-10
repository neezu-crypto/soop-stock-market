const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { ACCOUNT_PROTECTION_BONUS, creditUserCash } = require("./common");

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
// (클라이언트가 링크 성공 여부를 속일 수 없도록), 보너스 지급 + googleLinked
// 마킹을 한다 — 카카오처럼 외부 API 검증이나 자체 ID 매핑이 필요 없다.
// 카카오와 마찬가지로 이메일·이름·프로필 사진은 전혀 저장하지 않는다.
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

  const db      = admin.database();
  const userRef = db.ref(`users/${auth.uid}`);
  const trueUser = (await userRef.get()).val() || {};

  // 카카오로 이미 보호돼있던 계정이거나, 전환(신규 연동이 아니라 기존에
  // 구글로 이미 보호돼있던 계정으로 signInWithCredential 전환한 경우 —
  // 이때도 googleLinked는 이미 true이므로 보너스는 자동으로 건너뛴다.
  const alreadyProtected = !!(trueUser.kakaoLinked || trueUser.googleLinked);
  await userRef.child("googleLinked").set(true);

  if (alreadyProtected) {
    return { ok: true, action: "linked", bonus: 0 };
  }

  await creditUserCash(db, auth.uid, ACCOUNT_PROTECTION_BONUS);
  return { ok: true, action: "linked", bonus: ACCOUNT_PROTECTION_BONUS };
});

module.exports = { linkGoogleAccount };
