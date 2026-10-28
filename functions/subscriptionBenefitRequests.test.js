const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function makeDatabase(seed) {
  const data = structuredClone(seed);
  let nextPushId = 0;
  const parts = (path) => path.split("/").filter(Boolean);
  const valueAt = (path) => parts(path).reduce((value, key) => value?.[key] ?? null, data);
  const writeAt = (path, value) => {
    const keys = parts(path);
    let parent = data;
    for (const key of keys.slice(0, -1)) {
      parent[key] ||= {};
      parent = parent[key];
    }
    if (!keys.length) throw new Error("root replacement is not supported in this test");
    if (value === null) delete parent[keys.at(-1)];
    else parent[keys.at(-1)] = structuredClone(value);
  };
  const snapshot = (value) => ({ val: () => value == null ? null : structuredClone(value), exists: () => value != null });
  const ref = (path = "") => ({
    child: (key) => ref([path, key].filter(Boolean).join("/")),
    push: () => ({ key: `push-request-${++nextPushId}-000000000000` }),
    get: async () => snapshot(valueAt(path)),
    set: async (value) => writeAt(path, value),
    update: async (value) => {
      for (const [key, item] of Object.entries(value)) writeAt(key.includes("/") ? [path, key].filter(Boolean).join("/") : path ? `${path}/${key}` : key, item);
    },
    remove: async () => writeAt(path, null),
    transaction: async (update) => {
      const current = valueAt(path);
      const next = update(current == null ? null : structuredClone(current));
      if (next === undefined) return { committed: false, snapshot: snapshot(current) };
      writeAt(path, next);
      return { committed: true, snapshot: snapshot(next) };
    },
  });
  return { ref, data };
}

let activeDb;
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const common = {
  STREAMER_ID_RE: /^[a-z0-9]{2,20}$/,
  URL_RE: /^https?:\/\/.+/i,
  MAX_BANNER_REQUEST_DAYS: 7,
  MAX_PIN_HOURS: 12,
  MAX_RELAY_ROOM_HOURS: 8,
  MAX_PINNED_SLOTS: 3,
  MAX_RELAY_ROOMS: 3,
  CARD_BANNER_MIN_HOLDING_QTY: 10,
  findStockIdByName: async (db, name) => {
    const stocks = (await db.ref("stocks").get()).val() || {};
    return Object.entries(stocks).find(([, stock]) => stock.name === name)?.[0] || null;
  },
  requireLinkedUser: async () => {},
  requireNotInMaintenance: async () => {},
  grantAchievement: async () => {},
  assertNotBanned: async () => {},
  isAdmin: async () => false,
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "firebase-functions/v2/https") return { onCall: (_options, handler) => handler, HttpsError };
  if (request === "firebase-admin") return { database: () => activeDb };
  if (request === "./common" && /\/functions\/(subscriptionBenefits|bannerRequests|cardBannerRequests|pinRequests|relayRoom)\.js$/.test(parent?.filename || "")) return common;
  return originalLoad.call(this, request, parent, isMain);
};
const banner = require("./bannerRequests");
const cardBanner = require("./cardBannerRequests");
const pin = require("./pinRequests");
const relay = require("./relayRoom");
Module._load = originalLoad;

const uid = "subscription-member";
const auth = { uid, token: { email: "member@example.com" } };
const activeExpiry = Date.now() + 30 * 86400000;
const requestId = (n) => `request-id-0000000${n}`;

function setup() {
  activeDb = makeDatabase({
    streamerFanPageViewerSubscriptions: { [uid]: { expiresAt: activeExpiry } },
    users: { [uid]: { googleLinked: true, stocks: { stock1: { qty: 10 } } } },
    stocks: { stock1: { name: "테스트 종목", price: 100000 } },
  });
  return activeDb;
}

test("all five subscription promo request handlers reserve the requested monthly quota", async () => {
  const db = setup();
  const requests = [
    [banner.submitBannerRequest, { nickname: "테스트 종목", streamerId: "streamer1", days: 2 }, "bannerRequests", "bannerDaysUsed", 2],
    [banner.submitChartBannerRequest, { stockId: "stock1", nickname: "테스트 종목", streamerId: "streamer1", bannerImg: "https://example.com/banner.png", days: 3 }, "chartBannerRequests", "chartBannerDaysUsed", 3],
    [cardBanner.submitCardBannerRequest, { nickname: "테스트 종목", streamerId: "streamer1", days: 4 }, "cardBannerRequests", "cardBannerDaysUsed", 4],
    [pin.submitPinRequest, { stockName: "테스트 종목", hours: 5 }, "pinRequests", "pinHoursUsed", 5],
    [relay.submitRelayRoomRequest, { stockName: "테스트 종목", streamerId: "streamer1", hours: 6 }, "relayRoomRequests", "relayHoursUsed", 6],
  ];

  for (let i = 0; i < requests.length; i++) {
    const [handler, data, queue, usageField, expectedUnits] = requests[i];
    const result = await handler({ auth, data: { ...data, requestId: requestId(i + 1) } });
    const record = db.data[queue][requestId(i + 1)];
    assert.equal(result.ok, true);
    assert.equal(record.status, "pending");
    assert.equal(record.paymentMethod, "subscription-entitlement");
    assert.equal(record.benefitUnits, expectedUnits);
    assert.equal(record.starBalloons, 0);
    assert.equal(db.data.stockSubscriptionBenefits[uid][record.benefitMonth][usageField], expectedUnits);
  }

  const approvals = [
    [banner.actionApproveBannerRequest, requestId(1)],
    [banner.actionApproveChartBannerRequest, requestId(2)],
    [cardBanner.actionApproveCardBannerRequest, requestId(3)],
    [pin.actionApprovePinRequest, requestId(4)],
    [relay.actionApproveRelayRoomRequest, requestId(5)],
  ];
  for (const [approve, id] of approvals) await approve(db, { requestId: id });
  requests.forEach(([, , queue], index) => assert.equal(db.data[queue][requestId(index + 1)].status, "approved"));
});

test("approval applies the reserved duration and rejects a pending request after subscription expiry", async () => {
  const db = setup();
  await banner.submitBannerRequest({ auth, data: { nickname: "테스트 종목", streamerId: "streamer1", days: 2, requestId: requestId(1) } });
  await banner.actionApproveBannerRequest(db, { requestId: requestId(1) });
  assert.equal(db.data.bannerRequests[requestId(1)].status, "approved");
  assert.ok(db.data.bannerRequests[requestId(1)].approvedEndDate);

  await pin.submitPinRequest({ auth, data: { stockName: "테스트 종목", hours: 3, requestId: requestId(2) } });
  db.data.streamerFanPageViewerSubscriptions[uid].expiresAt = Date.now() - 1;
  await assert.rejects(
    pin.actionApprovePinRequest(db, { requestId: requestId(2) }),
    (error) => error.code === "failed-precondition",
  );
  assert.equal(db.data.pinRequests[requestId(2)].status, "rejected");
  assert.equal(db.data.pinRequests[requestId(2)].refundStatus, "returned");
  assert.equal(db.data.stockSubscriptionBenefits[uid][db.data.pinRequests[requestId(2)].benefitMonth].pinHoursUsed, 0);
});

test("concurrent approval of one request applies the entitlement only once", async () => {
  const db = setup();
  await banner.submitBannerRequest({ auth, data: { nickname: "테스트 종목", streamerId: "streamer1", days: 2, requestId: requestId(4) } });

  const results = await Promise.allSettled([
    banner.actionApproveBannerRequest(db, { requestId: requestId(4) }),
    banner.actionApproveBannerRequest(db, { requestId: requestId(4) }),
  ]);

  assert.equal(db.data.bannerRequests[requestId(4)].status, "approved");
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "aborted").length, 1);
  assert.ok(db.data.stocks.stock1.bannerEndDate);
  const retry = await banner.actionApproveBannerRequest(db, { requestId: requestId(4) });
  assert.equal(retry.alreadyProcessed, true);
});

test("pin approval rechecks live slots before applying a subscription request", async () => {
  const db = setup();
  db.data.stocks.stock2 = { name: "다른 종목 1", pinnedUntil: Date.now() + 3600000 };
  db.data.stocks.stock3 = { name: "다른 종목 2", pinnedUntil: Date.now() + 3600000 };
  db.data.stocks.stock4 = { name: "다른 종목 3", pinnedUntil: Date.now() + 3600000 };
  await pin.submitPinRequest({ auth, data: { stockName: "테스트 종목", hours: 3, requestId: requestId(3) } });

  await assert.rejects(
    pin.actionApprovePinRequest(db, { requestId: requestId(3) }),
    (error) => error.code === "resource-exhausted",
  );
  assert.equal(db.data.pinRequests[requestId(3)].status, "pending");
  db.data.stocks.stock4.pinnedUntil = Date.now() - 1;
  await pin.actionApprovePinRequest(db, { requestId: requestId(3) });
  assert.equal(db.data.pinRequests[requestId(3)].status, "approved");
});
