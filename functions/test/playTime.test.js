const test = require("node:test");
const assert = require("node:assert/strict");
const { getQuotaState, touchHeartbeat, checkPlayQuota } = require("../playTime");
const { todayKeyKST } = require("../common");

function snapshot(value) {
  return {
    val: () => structuredClone(value ?? null),
    exists: () => value !== null && value !== undefined,
  };
}

class MemoryDatabase {
  constructor(initial = {}) {
    this.values = structuredClone(initial);
    this.reads = [];
    this.writes = [];
  }

  ref(path = "") {
    const db = this;
    const getAt = () => path.split("/").filter(Boolean).reduce((value, key) => value?.[key], db.values);
    const putAt = (value) => {
      if (!path) { db.values = value; return; }
      const keys = path.split("/").filter(Boolean);
      let parent = db.values;
      for (const key of keys.slice(0, -1)) parent = parent[key] ||= {};
      parent[keys.at(-1)] = value;
    };
    return {
      async get() { db.reads.push(path); return snapshot(getAt()); },
      async transaction(callback) {
        const next = callback(structuredClone(getAt() ?? null));
        if (next === undefined) return { committed: false, snapshot: snapshot(getAt()) };
        putAt(structuredClone(next));
        db.writes.push(path);
        return { committed: true, snapshot: snapshot(next) };
      },
      async update(updates) {
        Object.entries(updates).forEach(([relativePath, value]) => {
          const fullPath = [path, relativePath].filter(Boolean).join("/");
          db.ref(fullPath); // keeps the implementation intentionally simple for this test helper
          const keys = fullPath.split("/").filter(Boolean);
          let parent = db.values;
          for (const key of keys.slice(0, -1)) parent = parent[key] ||= {};
          parent[keys.at(-1)] = structuredClone(value);
        });
        db.writes.push(path);
      },
    };
  }
}

function marketContext(db) {
  return {
    db,
    accountPath: (uid) => `stockMarket/accounts/${uid}`,
    accountRef: (uid) => db.ref(`stockMarket/accounts/${uid}`),
  };
}

test("quota reads protection from shared identity and usage from dedicated market account", async () => {
  const shared = new MemoryDatabase({
    adminCenter: { adminUids: { user: false } },
    users: { user: { nickname: "identity only" } },
  });
  const stock = new MemoryDatabase({
    stockMarket: { accounts: { user: {
      playQuotaDate: todayKeyKST(), playSecondsUsedToday: 30, bonusSecondsToday: 10,
    } } },
  });

  const state = await getQuotaState(shared, "user", { token: {} }, marketContext(stock));
  assert.equal(state.unlimited, false);
  assert.equal(state.usedSeconds, 30);
  assert.equal(state.bonusSeconds, 10);
  assert.equal(state.remainingSeconds, 880);
  assert.ok(stock.reads.includes("stockMarket/accounts/user"));
  assert.equal(shared.reads.includes("stockMarket/accounts/user"), false);
});

test("linked shared identity remains unlimited without reading a dedicated market account", async () => {
  const shared = new MemoryDatabase({
    adminCenter: { adminUids: { user: false } },
    users: { user: { googleLinked: true } },
  });
  const stock = new MemoryDatabase({ stockMarket: { accounts: { user: { playSecondsUsedToday: 999 } } } });

  const state = await getQuotaState(shared, "user", { token: {} }, marketContext(stock));
  assert.deepEqual(state, { unlimited: true });
  assert.equal(stock.reads.length, 0);
});

test("heartbeat writes quota state and asset snapshot under the selected market account path", async () => {
  const stock = new MemoryDatabase({
    stockMarket: { accounts: { user: {
      cash: 100,
      stocks: {},
      playQuotaDate: todayKeyKST(),
      playSecondsUsedToday: 10,
      bonusSecondsToday: 0,
      lastHeartbeatAt: Date.now() - 4_000,
    } } },
  });

  const tx = await touchHeartbeat(stock, "user", { accountPath: "stockMarket/accounts/user" });
  assert.equal(tx.committed, true);
  assert.ok(stock.writes.includes("stockMarket/accounts/user"));
  assert.ok(stock.values.stockMarket.accounts.user.playSecondsUsedToday >= 13);
  assert.equal(stock.values.users, undefined);
});

test("play quota check does not charge heartbeat usage for protected shared identities", async () => {
  const shared = new MemoryDatabase({
    adminCenter: { adminUids: { user: false } },
    users: { user: { streamerVerified: true } },
  });
  const stock = new MemoryDatabase({ stockMarket: { accounts: { user: { playSecondsUsedToday: 20 } } } });

  await checkPlayQuota(shared, "user", { token: {} }, marketContext(stock));
  assert.equal(stock.writes.length, 0);
});
