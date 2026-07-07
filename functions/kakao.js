const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { KAKAO_LINK_BONUS, creditUserCash } = require("./common");

// ══════════════════════════════════════════════════════════
// 카카오 로그인 연동 — 익명 계정 자산을 유지한 채 카카오 ID로 보호
// ══════════════════════════════════════════════════════════

/**
 * 현재 로그인된(대개 익명) uid에 카카오 계정을 연결한다.
 * - 이 카카오 계정이 처음 연동되는 것이면, 지금 쓰던 uid에 카카오 ID를 매핑해
 *   기존 자산·보유 종목을 그대로 유지한 채 "보호된 계정"으로 승격시킨다.
 * - 이미 다른 uid에 연동된 적 있는 카카오 계정이면(다른 기기 등), 그 uid로
 *   전환할 수 있도록 커스텀 토큰을 발급해 돌려준다 — 클라이언트가
 *   signInWithCustomToken으로 전환한다.
 */
const linkKakaoAccount = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const kakaoAccessToken = String(request.data?.kakaoAccessToken || "").trim();
  if (!kakaoAccessToken) throw new HttpsError("invalid-argument", "카카오 access token이 필요합니다.");

  let kakaoUser;
  try {
    const kakaoRes = await fetch("https://kapi.kakao.com/v2/user/me", {
      headers: { Authorization: `Bearer ${kakaoAccessToken}` },
    });
    if (!kakaoRes.ok) throw new Error(`kakao api status ${kakaoRes.status}`);
    kakaoUser = await kakaoRes.json();
  } catch (e) {
    throw new HttpsError("unauthenticated", "카카오 인증에 실패했습니다.");
  }

  const kakaoId = String(kakaoUser?.id || "").trim();
  if (!kakaoId) throw new HttpsError("internal", "카카오 계정 정보를 확인할 수 없습니다.");

  const db      = admin.database();
  const linkRef = db.ref(`kakaoLinks/${kakaoId}`);
  const existingUid = (await linkRef.get()).val();

  if (!existingUid) {
    // 처음 연동 — 지금 uid에 매핑하고, 기존 자산은 유지한 채 보너스만 추가 지급한다.
    await linkRef.set(auth.uid);
    await db.ref(`users/${auth.uid}/kakaoLinked`).set(true);
    await creditUserCash(db, auth.uid, KAKAO_LINK_BONUS);
    return { ok: true, action: "linked", bonus: KAKAO_LINK_BONUS };
  }

  if (existingUid === auth.uid) {
    return { ok: true, action: "already-linked" };
  }

  // 이미 다른 uid에 연동된 카카오 계정 — 그 계정으로 전환할 커스텀 토큰 발급
  const customToken = await admin.auth().createCustomToken(existingUid);
  return { ok: true, action: "switch", customToken };
});

module.exports = { linkKakaoAccount };
