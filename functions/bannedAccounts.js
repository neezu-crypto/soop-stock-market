const { HttpsError } = require("firebase-functions/v2/https");

// 20번 2단계 — 정지계정 관리. 지금까지 이 저장소엔 "이 유저 하나를 막는" 개념
// 자체가 없었다. StreamBet-Market과 공유하는 uid 기준 원장(bannedAccounts/{uid})을
// 이 저장소 관점(stockMarket)에서 조회/조작한다 — 04번(인증 상태 미러 동기화
// 사고)에서 배운 대로 저장소마다 따로 정지 노드를 두지 않는다.
//
// "전체 게임 정지"는 여기서 다루지 않는다 — 그건 통합 관리 센터 전용
// banAccountAllGames/unbanAccountAllGames가 담당한다(신원 단위로 명백히
// 심각한 사안만 관리자가 명시적으로 격상시키는 구조, 07번 위임 권한
// 카탈로그처럼 기본은 좁게 두고 필요할 때만 넓히는 결).

async function actionListBannedAccounts(db) {
  const snap = await db.ref("bannedAccounts").get();
  const data = snap.val() || {};
  const entries = Object.keys(data)
    .map((uid) => {
      const ban = data[uid];
      if (ban.all) {
        return { uid, reason: ban.allReason || "", bannedAt: ban.allBannedAt || 0, bannedByName: ban.allBannedByName || "", all: true };
      }
      const scoped = ban.games && ban.games.stockMarket;
      if (scoped) {
        return { uid, reason: scoped.reason || "", bannedAt: scoped.bannedAt || 0, bannedByName: scoped.bannedByName || "", all: false };
      }
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => (b.bannedAt || 0) - (a.bannedAt || 0));
  return { ok: true, entries };
}

async function actionBanAccount(db, { uid, reason }, auth) {
  if (!uid) throw new HttpsError("invalid-argument", "대상 uid를 입력해주세요.");
  if (!reason || !reason.trim()) throw new HttpsError("invalid-argument", "정지 사유를 입력해주세요.");
  const adminName = (auth && auth.token && (auth.token.name || auth.token.email)) || (auth && auth.uid) || "";
  await db.ref(`bannedAccounts/${uid}/games/stockMarket`).set({
    reason: reason.trim(),
    bannedAt: Date.now(),
    bannedBy: (auth && auth.uid) || null,
    bannedByName: adminName,
  });
  return { ok: true };
}

async function actionUnbanAccount(db, { uid }) {
  if (!uid) throw new HttpsError("invalid-argument", "대상 uid를 입력해주세요.");
  await db.ref(`bannedAccounts/${uid}/games/stockMarket`).remove();
  return { ok: true };
}

module.exports = { actionListBannedAccounts, actionBanAccount, actionUnbanAccount };
