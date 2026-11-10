const test = require("node:test");
const assert = require("node:assert/strict");
const {
  reserveCashPromotion,
  rejectCashPromotionRequest,
} = require("../promotionCash");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function split(path) {
  return String(path || "").split("/").filter(Boolean);
}

function readAt(root, path) {
  let current = root;
  for (const part of split(path)) {
    if (current == null || typeof current !== "object") return null;
    current = current[part];
  }
  return current === undefined ? null : clone(current);
}

function writeAt(root, path, value) {
  const parts = split(path);
  if (!parts.length) {
    Object.keys(root).forEach((key) => delete root[key]);
    if (value && typeof value === "object") Object.assign(root, clone(value));
    return;
  }
  let parent = root;
  for (const part of parts.slice(0, -1)) parent = parent[part] ||= {};
  const key = parts.at(-1);
  if (value === null) delete parent[key];
  else parent[key] = clone(value);
}

function makeDb(initial = {}) {
  const state = clone(initial);
  return {
    state,
    ref(path = "") {
      return {
        get: async () => ({ val: () => readAt(state, path), exists: () => readAt(state, path) !== null }),
        set: async (value) => writeAt(state, path, value),
        remove: async () => writeAt(state, path, null),
        update: async (values) => {
          for (const [key, value] of Object.entries(values || {})) writeAt(state, [path, key].filter(Boolean).join("/"), value);
        },
        transaction: async (fn) => {
          const before = readAt(state, path);
          const next = fn(clone(before));
          if (next === undefined) return { committed: false, snapshot: { val: () => readAt(state, path), exists: () => readAt(state, path) !== null } };
          writeAt(state, path, next);
          return { committed: true, snapshot: { val: () => readAt(state, path), exists: () => readAt(state, path) !== null } };
        },
      };
    },
  };
}

test("promotion reservation debits the shared wallet once and keeps its request in the market DB", async () => {
  const shared = makeDb({ gameSeriesWallet: { accounts: { u1: { balanceCash: 100 } } } });
  const market = makeDb();
  const requestId = "promotion-request-0001";
  const args = {
    uid: "u1",
    product: "pin",
    units: 1,
    requestId,
    requestPath: "pinRequests",
    requestData: { stockName: "테스트", hours: 1 },
    sharedDatabase: shared,
    now: 1000,
  };

  const first = await reserveCashPromotion(market, args);
  assert.equal(first.remainingCash, 99);
  assert.equal(readAt(shared.state, "gameSeriesWallet/accounts/u1/balanceCash"), 99);
  assert.equal(readAt(market.state, `pinRequests/${requestId}/status`), "pending");
  assert.equal(readAt(market.state, `stockMarket/operations/${requestId}/state`), "complete");

  const replay = await reserveCashPromotion(market, args);
  assert.equal(replay.replayed, true);
  assert.equal(readAt(shared.state, "gameSeriesWallet/accounts/u1/balanceCash"), 99);

  const rejected = await rejectCashPromotionRequest(
    market,
    "pinRequests",
    requestId,
    readAt(market.state, `pinRequests/${requestId}`),
    2000,
    { sharedDatabase: shared },
  );
  assert.equal(rejected.refundCash, 1);
  assert.equal(readAt(shared.state, "gameSeriesWallet/accounts/u1/balanceCash"), 100);
  assert.equal(readAt(market.state, `pinRequests/${requestId}/status`), "rejected");
});
