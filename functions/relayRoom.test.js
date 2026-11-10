const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

class HttpsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function loadRelayRoom({ reserveCashPromotion }) {
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "firebase-functions/v2/https") return { onCall: (_options, handler) => handler, HttpsError };
    if (request === "firebase-admin") return { database: () => ({}) };
    if (request === "./marketDatabases" && /relayRoom\.js$/.test(parent?.filename || "")) {
      return { getMarketDatabaseContext: async ({ sharedDatabase }) => ({ db: sharedDatabase }) };
    }
    if (request === "./common" && /relayRoom\.js$/.test(parent?.filename || "")) {
      return {
        STREAMER_ID_RE: /^[a-z0-9]{2,20}$/,
        MAX_RELAY_ROOM_HOURS: 8,
        MAX_RELAY_ROOMS: 3,
        requireLinkedUser: async () => {},
        requireNotInMaintenance: async () => {},
        grantAchievement: async () => {},
        assertNotBanned: async () => {},
      };
    }
    if (request === "./promotionCash" && /relayRoom\.js$/.test(parent?.filename || "")) {
      return {
        isCashPromotionRequest: () => true,
        reserveCashPromotion,
        rejectCashPromotionRequest: async () => ({}),
        isRequestActionable: () => true,
        commitCashPromotionApproval: async () => ({}),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const modulePath = require.resolve("./relayRoom");
  delete require.cache[modulePath];
  const relayRoom = require("./relayRoom");
  Module._load = originalLoad;
  return relayRoom;
}

test("중계방 신청은 종목명 없이 스트리머 아이디만으로 접수한다", async () => {
  let captured;
  const relayRoom = loadRelayRoom({
    reserveCashPromotion: async (_db, payload) => {
      captured = payload;
      return { ok: true, cashAmount: 1 };
    },
  });

  const result = await relayRoom.submitRelayRoomRequest({
    auth: { uid: "user-1" },
    data: { streamerId: "StreamEr1", hours: 1, requestId: "relay-request-0001" },
  });

  assert.equal(result.ok, true);
  assert.equal(captured.requestData.streamerId, "streamer1");
  assert.equal(captured.requestData.nickname, "streamer1");
  assert.equal(captured.requestData.previewImg, "https://stimg.sooplive.com/LOGO/st/streamer1/streamer1.jpg");
  assert.equal(captured.requestData.stationLink, "https://www.sooplive.com/station/streamer1");
  assert.equal(Object.hasOwn(captured.requestData, "stockName"), false);
});
