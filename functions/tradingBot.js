/**
 * 트레이딩 봇은 2026-10-22부터 비활성화됐다.
 *
 * adminAction의 과거 getBotSessions 호출부와 호환되도록 빈 결과만 반환한다.
 * 봇 거래·배정·presence 갱신이나 RTDB 조회는 수행하지 않는다.
 */
async function actionGetBotSessions() {
  return {
    ok: true,
    totalCount: 0,
    onlineCount: 0,
    tradingCount: 0,
    sessions: [],
  };
}

module.exports = { actionGetBotSessions };
