const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function makeDatabase(seed) {
  const data = structuredClone(seed);
  let nextTicket = 0;
  const parts = (path) => path.split("/").filter(Boolean);
  const valueAt = (path) => parts(path).reduce((value, key) => value?.[key] ?? null, data);
  const writeAt = (path, value) => {
    const keys = parts(path);
    let parent = data;
    for (const key of keys.slice(0, -1)) parent = parent[key] ||= {};
    if (value === null) delete parent[keys.at(-1)];
    else parent[keys.at(-1)] = structuredClone(value);
  };
  const snap = (value) => ({
    val: () => value == null ? null : structuredClone(value),
    child: (path) => snap(path.split("/").filter(Boolean).reduce((item, key) => item?.[key] ?? null, value)),
  });
  const ref = (path = "") => ({
    child: (key) => ref([path, key].filter(Boolean).join("/")),
    push: () => ({ key: `ticket_${++nextTicket}` }),
    get: async () => snap(valueAt(path)),
    set: async (value) => writeAt(path, value),
    update: async (value) => {
      if (Object.keys(value).some((key) => key.includes("/"))) {
        for (const [key, item] of Object.entries(value)) writeAt([path, key].filter(Boolean).join("/"), item);
      } else {
        writeAt(path, { ...(valueAt(path) || {}), ...value });
      }
    },
    transaction: async (update) => {
      const current = valueAt(path);
      const next = update(current == null ? null : structuredClone(current));
      if (next === undefined) return { committed: false, snapshot: snap(current) };
      writeAt(path, next);
      return { committed: true, snapshot: snap(next) };
    },
  });
  return { ref, data };
}

let activeDb;
let adminEnabled = false;
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const todayKeyKST = (offsetDays = 0) => {
  const date = new Date(Date.UTC(2026, 9, 29 + offsetDays));
  return date.toISOString().slice(0, 10);
};
const common = {
  LOTTERY_TICKET_PRICE: 200000,
  LOTTERY_POOL_FLOOR: 1000000,
  LOTTERY_PAYOUT_RATIO: 0.9,
  LOTTERY_DIGIT_MIN: 1,
  LOTTERY_DIGIT_MAX: 7,
  requireLinkedUser: async () => {},
  requireNotInMaintenance: async () => {},
  assertNotBanned: async () => {},
  todayKeyKST,
  isAdmin: async () => adminEnabled,
  DAILY_ATTENDANCE_REWARDS: [30000, 50000, 70000, 100000, 130000, 160000, 300000],
  creditUserCash: async (_db, uid, amount) => { activeDb.data.users[uid].cash += amount; },
  grantAchievement: async () => {},
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "firebase-functions/v2/https") return { onCall: (_options, handler) => handler, HttpsError };
  if (request === "firebase-admin") return { database: () => activeDb };
  if (request === "./common" && /\/functions\/(lottery|attendance)\.js$/.test(parent?.filename || "")) return common;
  return originalLoad.call(this, request, parent, isMain);
};
const { buyLotteryTicket } = require("./lottery");
const { claimDailyAttendance } = require("./attendance");
Module._load = originalLoad;

test("free ticket is first, adds no cash to the pool, then paid purchases charge once across retries", async () => {
  const uid = "protected-user";
  activeDb = makeDatabase({
    users: { [uid]: { kakaoLinked: true, cash: 0 } },
    streamerFanPageViewerSubscriptions: { [uid]: { expiresAt: Date.now() + 60000 } },
    lottery: { pool: 1000000 },
  });
  const oldRandom = Math.random;
  Math.random = () => 0; // deterministic non-winning 1-1-1 tickets
  try {
    const auth = { uid, token: { email: "user@example.com" } };
    const before = await buyLotteryTicket({ auth, data: { action: "status" } });
    assert.equal(before.freeAvailable, true);
    const freeRequest = { auth, data: { requestId: "free-ticket-request-0001" } };
    const free = await buyLotteryTicket(freeRequest);
    const freeRetry = await buyLotteryTicket(freeRequest);
    assert.equal(free.free, true);
    assert.equal(free.chargedAmount, 0);
    assert.deepEqual(free, freeRetry);
    assert.equal(activeDb.data.users[uid].cash, 0);
    assert.equal(activeDb.data.lottery.pool, 1000000);
    const after = await buyLotteryTicket({ auth, data: { action: "status" } });
    assert.equal(after.freeAvailable, false);
    assert.equal(after.freeUsed, true);

    const paidRequest = { auth, data: { requestId: "paid-ticket-request-0001" } };
    await assert.rejects(buyLotteryTicket(paidRequest), (error) => error.code === "failed-precondition");
    activeDb.data.users[uid].cash = 200000;
    const [paid, paidRetry] = await Promise.all([buyLotteryTicket(paidRequest), buyLotteryTicket(paidRequest)]);
    assert.equal(paid.free, false);
    assert.equal(paid.chargedAmount, 200000);
    assert.deepEqual(paid, paidRetry);
    assert.equal(activeDb.data.users[uid].cash, 0);
    assert.equal(activeDb.data.lottery.pool, 1200000);
    assert.equal(activeDb.data.lotteryFreeClaims[uid]["2026-10-29"].status, "complete");
    assert.equal(Object.keys(activeDb.data.lotteryPurchases).length, 2);
    assert.equal(Object.keys(activeDb.data.users[uid].lotteryTicketCharges || {}).length, 0);
    assert.equal(Object.keys(activeDb.data.users[uid].lotteryTicketPayouts || {}).length, 0);
  } finally {
    Math.random = oldRandom;
  }
});

test("expired subscribers can still buy paid tickets but cannot claim a free ticket", async () => {
  const uid = "expired-user";
  activeDb = makeDatabase({
    users: { [uid]: { googleLinked: true, cash: 400000 } },
    streamerFanPageViewerSubscriptions: { [uid]: { expiresAt: Date.now() - 1 } },
    lottery: { pool: 1000000 },
  });
  adminEnabled = false;
  const result = await buyLotteryTicket({ auth: { uid, token: { email: "user@example.com" } }, data: { requestId: "expired-paid-ticket-0001" } });
  assert.equal(result.free, false);
  assert.equal(result.chargedAmount, 200000);
  assert.equal(activeDb.data.lotteryFreeClaims, undefined);
  assert.equal(activeDb.data.users[uid].cash, 200000);
});

test("administrators can use a daily free ticket without a subscription record", async () => {
  const uid = "admin-lottery-user";
  activeDb = makeDatabase({
    users: { [uid]: { cash: 0 } },
    lottery: { pool: 1000000 },
  });
  adminEnabled = true;
  const auth = { uid, token: { email: "admin@example.com" } };
  const oldRandom = Math.random;
  Math.random = () => 0;
  try {
    const status = await buyLotteryTicket({ auth, data: { action: "status" } });
    assert.equal(status.eligible, true);
    assert.equal(status.freeAvailable, true);
    const result = await buyLotteryTicket({ auth, data: { requestId: "admin-free-ticket-request-01" } });
    assert.equal(result.free, true);
    assert.equal(activeDb.data.users[uid].cash, 0);
    assert.equal(activeDb.data.lottery.pool, 1000000);
  } finally {
    Math.random = oldRandom;
    adminEnabled = false;
  }
});

test("a winning free ticket pays 90 percent once and resets the pool", async () => {
  const uid = "winning-subscriber";
  activeDb = makeDatabase({
    users: { [uid]: { googleLinked: true, cash: 50000 } },
    streamerFanPageViewerSubscriptions: { [uid]: { expiresAt: Date.now() + 60000 } },
    lottery: { pool: 2000000 },
  });
  const auth = { uid, token: { email: "user@example.com" } };
  const request = { auth, data: { requestId: "winning-free-ticket-request-01" } };
  const oldRandom = Math.random;
  Math.random = () => 0.999999;
  try {
    const [result, retry] = await Promise.all([buyLotteryTicket(request), buyLotteryTicket(request)]);
    assert.deepEqual(result, retry);
    assert.equal(result.won, true);
    assert.equal(result.prizeAmount, 1800000);
    assert.equal(activeDb.data.users[uid].cash, 1850000);
    assert.equal(activeDb.data.lottery.pool, 1000000);
    assert.equal(Object.keys(activeDb.data.lotteryTripleSevenLog).length, 1);
    assert.equal(activeDb.data.lotteryLastWin.prizeAmount, 1800000);
  } finally {
    Math.random = oldRandom;
  }
});

test("administrators receive the same automatic double attendance benefit", async () => {
  const uid = "admin-user";
  activeDb = makeDatabase({
    users: { [uid]: { cash: 1000, lastAttendanceDate: todayKeyKST(-1), attendanceStreak: 1 } },
  });
  adminEnabled = true;
  const result = await claimDailyAttendance({ auth: { uid, token: { email: "admin@example.com" } }, data: {} });
  assert.equal(result.doubled, true);
  assert.equal(result.reward, 100000);
  assert.equal(activeDb.data.users[uid].cash, 101000);
  adminEnabled = false;
});
