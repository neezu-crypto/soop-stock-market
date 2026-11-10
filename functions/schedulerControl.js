"use strict";

// 통합 관리 센터(서비스 일시정지 세션)에서 켜고 끄는 주식시장 백그라운드(스케줄) 작업 플래그.
// 스케줄러 자체는 계속 호출되지만, 꺼진 작업은 각 함수가 맨 앞에서 이 플래그 하나만 읽고
// 바로 끝낸다. 플래그가 없으면 켜진 것으로 보므로 기존 동작은 그대로다.
// 플래그를 쓰는 쪽은 admin-center의 stockMarketScheduler이며(꺼짐/켜짐, 재개 시 동결 마감 연장),
// 저장 위치는 시장 전용 DB의 stockMarket/adminSchedulerControl/{jobId}다. 시장 전용 규칙은
// 루트 기본 거부라 클라이언트는 읽고 쓸 수 없다. 이 파일은 읽기 가드와 실행 기록만 맡는다.

const ROOT = "stockMarket/adminSchedulerControl";
const STOCK_DELIST_JOB = "checkFrozenStockDelistings";
const CREW_SYNC_JOB = "syncCrewRosterFromSheet";

// 플래그가 없거나 true면 켜짐. 명시적으로 false일 때만 꺼짐.
async function isSchedulerEnabled(db, jobId) {
  const value = (await db.ref(`${ROOT}/${jobId}/enabled`).get()).val();
  return value !== false;
}

// 실행했을 때만 남기는 가벼운 기록. 관리자 화면의 "마지막 실행"에 쓴다.
async function recordSchedulerRun(db, jobId, extra = {}) {
  await db.ref(`${ROOT}/${jobId}`).update({ lastRunAt: Date.now(), ...extra });
}

module.exports = { ROOT, STOCK_DELIST_JOB, CREW_SYNC_JOB, isSchedulerEnabled, recordSchedulerRun };
