const { onCall } = require("firebase-functions/v2/https");
const { HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { isAdmin } = require("./common");

// 09번/13번 — 클라이언트가 로컬에서 이메일 문자열을 직접 비교하던 관리자
// UI 판별을 서버 확인으로 옮기기 위한 가벼운 전용 함수. adminCenter/adminUids는
// .read:false라 클라이언트가 직접 읽을 수 없으므로, 판별 결과만 반환한다.
// 이름을 stockWhoAmI로 지은 이유 — StreamBet-Market도 같은 default codebase에
// whoAmI라는 이름으로 동일한 목적의 함수를 배포했다. 같은 프로젝트를 공유하는
// 두 저장소가 codebase 격리 없이 같은 이름을 쓰면 나중에 배포한 쪽이 앞선 쪽을
// 조용히 덮어쓴다 - 이번에 실제로 겪을 뻔한 문제라 이름을 구분해서 피한다.
const stockWhoAmI = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const db = admin.database();
  return { isAdmin: await isAdmin(db, auth.uid, auth.token?.email) };
});

module.exports = { stockWhoAmI };
