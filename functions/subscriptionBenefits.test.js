const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function makeDatabase(seed = {}) {
  const data = structuredClone(seed);
  const parts = (path) => path.split("/").filter(Boolean);
  const valueAt = (path) => parts(path).reduce((value, key) => value?.[key] ?? null, data);
  const writeAt = (path, value) => {
    const keys = parts(path);
    let parent = data;
    for (const key of keys.slice(0, -1)) {
      parent[key] ||= {};
      parent = parent[key];
    }
    if (value === null) delete parent[keys.at(-1)];
    else parent[keys.at(-1)] = structuredClone(value);
  };
  const snapshot = (value) => ({
    val: () => value == null ? null : structuredClone(value),
    exists: () => value != null,
  });
  const ref = (path = "") => ({
    child: (key) => ref([path, key].filter(Boolean).join("/")),
    push: () => ({ key: "generated-request-id-00001" }),
    get: async () => snapshot(valueAt(path)),
    set: async (value) => writeAt(path, value),
    update: async (value) => writeAt(path, { ...(valueAt(path) || {}), ...value }),
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
const HttpsError = class extends Error {
  constructor(code, message) { super(message); this.code = code; }
};
const common = {
  isAdmin: async () => false,
  assertNotBanned: async () => {},
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "firebase-functions/v2/https") return { onCall: (_options, handler) => handler, HttpsError };
  if (request === "firebase-admin") return { database: () => activeDb };
  if (request === "./common" && /\/functions\/subscriptionBenefits\.js$/.test(parent?.filename || "")) return common;
  return originalLoad.call(this, request, parent, isMain);
};
const benefits = require("./subscriptionBenefits");
Module._load = originalLoad;

const NOW = Date.UTC(2026, 9, 29, 3, 0, 0);
const ACTIVE_SUBSCRIPTION = { expiresAt: NOW + 30 * 86400000 };
const REQUEST_ID = "request-id-00000001";
const auth = { uid: "member-1", token: { email: "member@example.com" } };

function baseDatabase() {
  return makeDatabase({
    streamerFanPageViewerSubscriptions: { [auth.uid]: ACTIVE_SUBSCRIPTION },
    users: { [auth.uid]: { kakaoLinked: true, treasureChests: 0 } },
  });
}

function requestData() {
  return { nickname: "테스트 스트리머", stockId: "stock-1", streamerId: "streamer1", days: 7 };
}

test("monthly entitlement is idempotent for a request and enforces the monthly quota", async () => {
  activeDb = baseDatabase();
  const first = await benefits.reserveMonthlyBenefit(activeDb, {
    uid: auth.uid, product: "banner", units: 7, requestId: REQUEST_ID,
    requestData: requestData(), auth, now: NOW,
  });
  const retry = await benefits.reserveMonthlyBenefit(activeDb, {
    uid: auth.uid, product: "banner", units: 7, requestId: REQUEST_ID,
    requestData: requestData(), auth, now: NOW + 1000,
  });

  assert.equal(first.remaining, 0);
  assert.equal(retry.remaining, 0);
  assert.equal(activeDb.data.stockSubscriptionBenefits[auth.uid]["2026-10"].bannerDaysUsed, 7);
  assert.equal(Object.keys(activeDb.data.bannerRequests).length, 1);
  await assert.rejects(
    benefits.reserveMonthlyBenefit(activeDb, {
      uid: auth.uid, product: "banner", units: 1, requestId: "request-id-00000002",
      requestData: requestData(), auth, now: NOW,
    }),
    (error) => error.code === "resource-exhausted",
  );
});

test("inactive subscribers cannot reserve promo use or claim a monthly chest", async () => {
  activeDb = baseDatabase();
  activeDb.data.streamerFanPageViewerSubscriptions[auth.uid].expiresAt = NOW;

  await assert.rejects(
    benefits.reserveMonthlyBenefit(activeDb, {
      uid: auth.uid, product: "banner", units: 1, requestId: REQUEST_ID,
      requestData: requestData(), auth, now: NOW,
    }),
    (error) => error.code === "failed-precondition",
  );
  await assert.rejects(
    benefits.claimMonthlyFreeTreasureChest(activeDb, auth.uid, NOW, auth),
    (error) => error.code === "failed-precondition",
  );
  assert.equal(activeDb.data.users[auth.uid].treasureChests, 0);
  const account = activeDb.data.stockSubscriptionBenefits?.[auth.uid]?.[benefits.kstMonthKey(NOW)] || {};
  assert.equal(account.bannerDaysUsed, undefined);
  assert.equal(account.treasureChestClaim, undefined);
});

test("rejected requests refund once in the same KST month", async () => {
  activeDb = baseDatabase();
  await benefits.reserveMonthlyBenefit(activeDb, {
    uid: auth.uid, product: "pin", units: 5, requestId: REQUEST_ID,
    requestData: { stockName: "테스트" , hours: 5 }, auth, now: NOW,
  });
  const queuedRequest = activeDb.data.pinRequests[REQUEST_ID];
  const first = await benefits.rejectSubscriptionRequest(activeDb, "pinRequests", REQUEST_ID, queuedRequest, NOW + 1000);
  const second = await benefits.rejectSubscriptionRequest(activeDb, "pinRequests", REQUEST_ID, queuedRequest, NOW + 2000);

  assert.equal(first.refundStatus, "returned");
  assert.equal(second.refundUnits, 5);
  assert.equal(activeDb.data.stockSubscriptionBenefits[auth.uid]["2026-10"].pinHoursUsed, 0);
});

test("unused entitlement from an earlier month expires without a rollover refund", async () => {
  activeDb = baseDatabase();
  await benefits.reserveMonthlyBenefit(activeDb, {
    uid: auth.uid, product: "relayRoom", units: 3, requestId: REQUEST_ID,
    requestData: { nickname: "테스트", streamerId: "streamer1", hours: 3 }, auth, now: NOW,
  });
  const queuedRequest = activeDb.data.relayRoomRequests[REQUEST_ID];
  const november = Date.UTC(2026, 10, 1, 0, 0, 0);
  const result = await benefits.rejectSubscriptionRequest(activeDb, "relayRoomRequests", REQUEST_ID, queuedRequest, november);

  assert.equal(result.refundStatus, "expired");
  assert.equal(result.refundUnits, 0);
  assert.equal(activeDb.data.stockSubscriptionBenefits[auth.uid]["2026-10"].relayHoursUsed, 3);
});

test("a refunded entitlement cannot be approved after the queue status update fails", async () => {
  activeDb = baseDatabase();
  await benefits.reserveMonthlyBenefit(activeDb, {
    uid: auth.uid, product: "banner", units: 2, requestId: REQUEST_ID,
    requestData: requestData(), auth, now: NOW,
  });
  const queuedRequest = activeDb.data.bannerRequests[REQUEST_ID];
  await benefits.returnMonthlyBenefit(activeDb, REQUEST_ID, queuedRequest, NOW + 1000);

  await assert.rejects(
    benefits.commitSubscriptionApproval(activeDb, "bannerRequests", REQUEST_ID, queuedRequest, {
      [`stocks/stock-1/bannerEndDate`]: "2026-11-01",
      [`bannerRequests/${REQUEST_ID}/status`]: "approved",
    }, NOW + 2000),
    (error) => error.code === "failed-precondition",
  );
  assert.equal(activeDb.data.bannerRequests[REQUEST_ID].status, "rejected");
  assert.equal(activeDb.data.stocks, undefined);
});

test("monthly free treasure chest can only be granted once", async () => {
  activeDb = baseDatabase();
  const first = await benefits.claimMonthlyFreeTreasureChest(activeDb, auth.uid, NOW, auth);
  const retry = await benefits.claimMonthlyFreeTreasureChest(activeDb, auth.uid, NOW + 1000, auth);

  assert.equal(first.alreadyClaimed, false);
  assert.equal(retry.alreadyClaimed, true);
  assert.equal(activeDb.data.users[auth.uid].treasureChests, 1);
  assert.equal(activeDb.data.stockSubscriptionBenefits[auth.uid]["2026-10"].treasureChestClaim.status, "granted");
});

test("a stale chest claim reservation can be recovered without granting twice", async () => {
  activeDb = baseDatabase();
  const month = benefits.kstMonthKey(NOW);
  activeDb.data.stockSubscriptionBenefits = {
    [auth.uid]: { [month]: { treasureChestClaim: { status: "reserved", claimId: `free-chest-${month}`, leaseUntil: NOW + 30_000 } } },
  };
  await assert.rejects(
    benefits.claimMonthlyFreeTreasureChest(activeDb, auth.uid, NOW, auth),
    (error) => error.code === "aborted",
  );

  const recovered = await benefits.claimMonthlyFreeTreasureChest(activeDb, auth.uid, NOW + 60_001, auth);
  assert.equal(recovered.alreadyClaimed, false);
  assert.equal(activeDb.data.users[auth.uid].treasureChests, 1);
});

test("KST monthly boundaries reset at midnight on the first day", () => {
  assert.equal(benefits.kstMonthKey(Date.UTC(2026, 9, 31, 14, 59, 59)), "2026-10");
  assert.equal(benefits.kstMonthKey(Date.UTC(2026, 9, 31, 15, 0, 0)), "2026-11");
  assert.equal(benefits.nextKstMonthStart(Date.UTC(2026, 9, 31, 14, 59, 59)), Date.UTC(2026, 9, 31, 15, 0, 0));
});
