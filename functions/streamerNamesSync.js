const { onValueWritten } = require("firebase-functions/v2/database");
const { getDatabase } = require("firebase-admin/database");

// 스트리머 이름 정적 파일(streamer-gallery, streamer-life-game이 각자 갖고 있던
// streamer-names.json) 방식을 RTDB 파생 노드 방식으로 전환하면서 추가(2026-09).
//
// /stocks는 가격·거래량이 실시간으로 계속 바뀌는 무거운 노드라 클라이언트가
// 직접 구독하면 안 된다(거래 한 번마다 전체 재전송) — 그래서 이름만 뽑은
// 가벼운 파생 노드 streamerNames를 따로 두고, 이 트리거가 /stocks 변경을
// 감시하며 "이름이 실제로 바뀐 경우"에만 그 파생 노드를 갱신한다.
// 가격/거래량만 바뀌는 대다수의 쓰기는 아래 가드에서 그냥 무시된다 — 안 그러면
// 거래마다 이 함수가 불필요하게 실행되고 streamerNames에 쓸모없는 쓰기가 쌓인다.
const syncStreamerNameOnStockChange = onValueWritten("/stocks/{stockId}", async (event) => {
  const stockId = event.params.stockId;
  const beforeName = event.data.before.exists() ? event.data.before.child("name").val() : null;
  const afterName = event.data.after.exists() ? event.data.after.child("name").val() : null;

  if (beforeName === afterName) return; // 이름 변화 없음(가격/거래량만 바뀜) — 아무것도 안 함

  const db = getDatabase();
  if (afterName == null) {
    // 종목 삭제(상장폐지 등) — 파생 노드에서도 같이 제거해 stale 데이터가 안 남게 한다.
    await db.ref(`streamerNames/${stockId}`).remove();
  } else {
    await db.ref(`streamerNames/${stockId}`).set(afterName);
  }
  await db.ref("streamerNamesMeta/updatedAt").set(Date.now());
});

module.exports = { syncStreamerNameOnStockChange };
