const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp({
  databaseURL: "https://soop-stock-market-default-rtdb.firebaseio.com",
});

setGlobalOptions({
  // region: "asia-northeast3"
});

// 기능별로 나뉜 모듈에서 Cloud Function을 모아 최상위로 재노출한다.
// 각 파일의 역할:
//   trade.js          — 초기 자산 지급(initializeUser), 매매 체결(trade)
//   admin.js          — 관리자 페이지 전용 액션 디스패처(adminAction)
//   bannerRequests.js — 우측 랭킹 배너 + 차트 하단 배너 셀프 신청
//   cardBannerRequests.js — 종목 카드 프로필 배너 셀프 신청(대량 보유자 전용)
//   kakao.js          — 카카오 로그인 연동
//   google.js         — 구글 로그인 연동
//   cashCharge.js     — 라이브 방송 후원 자산 충전 신청
//   pinRequests.js    — 종목 리스트 최상단 고정 노출 셀프 신청
//   playTime.js       — 하루 무료 이용 시간 제한 + 게임머니 셀프 충전
//   relayRoom.js      — 현재 플레이 중인 스트리머 홍보(중계방) 셀프 신청
//   stockFreeze.js    — 종목 거래 동결(서킷브레이커) 해제 신청 + 상장폐지 스케줄러
//   listingRequests.js — 검색해도 없는 종목의 신규 상장 셀프 신청
//   profitRanking.js  — 순수 매매 손익 랭킹 확인/갱신
//   attendance.js     — 출석 보상(1~7일차 순환)
//   jackpot.js        — 잭팟 종목(커뮤니티 합산 매매량 마일스톤) + 90분마다 95%까지 진행률 자동 증가 스케줄러
//   lottery.js        — 복권함(계정당 구매, 즉시 판정 스크래치 복권)
//   treasureChest.js  — 보물상자(후원창 구매 신청 → 관리자 승인 → 직접 개봉해 랜덤 보상)
//   streamerVerification.js — 카카오/구글 대체 계정 보호(방송 검증 기반)
//   common.js         — 위 모듈들이 공유하는 상수/헬퍼 (Cloud Function 없음)
const { stockWhoAmI } = require("./whoami");
const { initializeUser, trade } = require("./trade");
const { triggerBotReaction } = require("./tradingBot");
const { adminAction, getOverviewStatsForMonitoring } = require("./admin");
const { submitBannerRequest, submitChartBannerRequest } = require("./bannerRequests");
const { submitCardBannerRequest } = require("./cardBannerRequests");
const { linkKakaoAccount } = require("./kakao");
const { linkGoogleAccount } = require("./google");
const { submitCashChargeRequest } = require("./cashCharge");
const { submitPinRequest } = require("./pinRequests");
const { heartbeat, buyPlayTime } = require("./playTime");
const { submitRelayRoomRequest } = require("./relayRoom");
const {
  unfreezeWithCash,
  submitUnfreezeDonationRequest,
  checkFrozenStockDelistings,
} = require("./stockFreeze");
const { submitListingRequest } = require("./listingRequests");
const { checkProfitRanking } = require("./profitRanking");
const { claimDailyAttendance } = require("./attendance");
const { autoTickJackpotProgress } = require("./jackpot");
const { buyLotteryTicket } = require("./lottery");
const { requestStreamerVerification } = require("./streamerVerification");
const { submitTreasureChestPurchaseRequest, openTreasureChest } = require("./treasureChest");
const { logStockMarketVisit } = require("./streamerVisitLog");

exports.initializeUser          = initializeUser;
exports.trade                   = trade;
exports.triggerBotReaction      = triggerBotReaction;
exports.adminAction             = adminAction;
exports.getOverviewStatsForMonitoring = getOverviewStatsForMonitoring;
exports.submitBannerRequest     = submitBannerRequest;
exports.submitChartBannerRequest = submitChartBannerRequest;
exports.submitCardBannerRequest = submitCardBannerRequest;
exports.linkKakaoAccount        = linkKakaoAccount;
exports.linkGoogleAccount       = linkGoogleAccount;
exports.submitCashChargeRequest = submitCashChargeRequest;
exports.submitPinRequest        = submitPinRequest;
exports.heartbeat               = heartbeat;
exports.buyPlayTime             = buyPlayTime;
exports.submitRelayRoomRequest  = submitRelayRoomRequest;
exports.unfreezeWithCash             = unfreezeWithCash;
exports.submitUnfreezeDonationRequest = submitUnfreezeDonationRequest;
exports.checkFrozenStockDelistings    = checkFrozenStockDelistings;
exports.submitListingRequest          = submitListingRequest;
exports.checkProfitRanking            = checkProfitRanking;
exports.claimDailyAttendance          = claimDailyAttendance;
exports.buyLotteryTicket              = buyLotteryTicket;
exports.requestStreamerVerification   = requestStreamerVerification;
exports.autoTickJackpotProgress       = autoTickJackpotProgress;
exports.submitTreasureChestPurchaseRequest = submitTreasureChestPurchaseRequest;
exports.openTreasureChest                  = openTreasureChest;
exports.stockWhoAmI                        = stockWhoAmI;
exports.logStockMarketVisit                = logStockMarketVisit;
