const assert = require("node:assert/strict");
const Module = require("node:module");

let tree = {};
let nextPushKey = 0;

function parts(path) { return String(path || "").split("/").filter(Boolean); }
function readPath(path) {
  let current = tree;
  for (const key of parts(path)) {
    if (!current || typeof current !== "object") return null;
    current = current[key];
  }
  return current == null ? null : structuredClone(current);
}
function writePath(path, value) {
  const keys = parts(path);
  if (!keys.length) { tree = value == null ? {} : structuredClone(value); return; }
  let current = tree;
  for (const key of keys.slice(0, -1)) {
    if (!current[key] || typeof current[key] !== "object") current[key] = {};
    current = current[key];
  }
  if (value == null) delete current[keys.at(-1)];
  else current[keys.at(-1)] = structuredClone(value);
}

class Snapshot {
  constructor(value) { this.value = value == null ? null : structuredClone(value); }
  val() { return this.value == null ? null : structuredClone(this.value); }
  exists() { return this.value != null; }
}
class Reference {
  constructor(path = "") { this.path = path; }
  child(path) { return new Reference([this.path, path].filter(Boolean).join("/")); }
  async get() { return new Snapshot(readPath(this.path)); }
  async set(value) { writePath(this.path, value); }
  async update(value) { writePath(this.path, { ...(readPath(this.path) || {}), ...structuredClone(value) }); }
  push() { return this.child(`push_${++nextPushKey}`); }
  async transaction(update) {
    const initial = update(null);
    if (initial === undefined) return { committed: false, snapshot: new Snapshot(readPath(this.path)) };
    const remote = readPath(this.path);
    if (remote !== null) {
      const latest = update(remote);
      if (latest === undefined) return { committed: false, snapshot: new Snapshot(remote) };
      writePath(this.path, latest);
    } else {
      writePath(this.path, initial);
    }
    return { committed: true, snapshot: new Snapshot(readPath(this.path)) };
  }
}

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const database = { ref: (path = "") => new Reference(path) };
const admin = { database: () => database };
const common = {
  TREASURE_CHEST_MAX_BUY_COUNT: 200,
  TREASURE_CHEST_BULK_BONUS_THRESHOLD: 10,
  TREASURE_CHEST_OPEN_BIG_RATE: 0,
  TREASURE_CHEST_REWARD_SMALL: 500000,
  TREASURE_CHEST_REWARD_BIG: 5000000,
  requireNotInMaintenance: async () => {},
  creditUserCash: async (_db, uid, amount) => {
    const user = readPath(`users/${uid}`) || {};
    writePath(`users/${uid}`, { ...user, cash: (Number(user.cash) || 0) + amount });
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "firebase-functions/v2/https") return { HttpsError, onCall: (_options, handler) => handler };
  if (request === "firebase-admin") return admin;
  if (request === "./common" && parent?.filename?.endsWith("/functions/treasureChest.js")) return common;
  return originalLoad.call(this, request, parent, isMain);
};
const chest = require("../treasureChest.js");
Module._load = originalLoad;

const adminUser = { auth: { uid: "chest-admin" }, data: {} };
const regularUser = { auth: { uid: "regular-user" }, data: {} };
const call = (name, user, data = {}) => chest[name]({ auth: user.auth, data });
async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof HttpsError && error.code === code);
}

async function main() {
  tree = {
    adminCenter: { adminUids: { "chest-admin": true } },
    gameSeriesWallet: { accounts: { "chest-admin": { balanceCash: 2000 } } },
    users: { "chest-admin": { treasureChests: 2, cash: 0 } },
  };

  await expectCode(call("getAdminTreasureChestState", regularUser), "permission-denied");
  await expectCode(call("purchaseTreasureChestsWithCash", regularUser, { requestId: "regular-chest-1", chestCount: 1 }), "permission-denied");
  await expectCode(call("openTreasureChest", regularUser), "permission-denied");
  await expectCode(call("submitTreasureChestPurchaseRequest", regularUser, { chestCount: 1 }), "failed-precondition");
  await expectCode(call("claimMonthlyFreeTreasureChest", regularUser), "failed-precondition");

  const firstPurchase = await call("purchaseTreasureChestsWithCash", adminUser, { requestId: "chest-order-19", chestCount: 19 });
  assert.equal(firstPurchase.cashAmount, 627);
  assert.equal(firstPurchase.bonusChestCount, 1);
  assert.equal(firstPurchase.totalChestCount, 20);
  assert.equal(firstPurchase.remainingCash, 1373);
  assert.equal(firstPurchase.totalOwnedChestCount, 22);
  await call("purchaseTreasureChestsWithCash", adminUser, { requestId: "chest-order-19", chestCount: 19 });
  assert.equal(readPath("gameSeriesWallet/accounts/chest-admin/balanceCash"), 1373, "중복 구매 재시도는 캐시를 다시 차감하지 않아야 함");

  const firstOpen = await call("openTreasureChest", adminUser);
  assert.equal(firstOpen.data?.source || firstOpen.source, "legacy");
  assert.equal(readPath("users/chest-admin/treasureChests"), 1, "기존 보유 상자를 신규 구매 상자보다 먼저 열어야 함");
  const secondOpen = await call("openTreasureChest", adminUser);
  assert.equal(secondOpen.source, "legacy");
  const thirdOpen = await call("openTreasureChest", adminUser);
  assert.equal(thirdOpen.source, "cash");
  assert.equal(readPath("stockMarket/treasureChestInventory/chest-admin/purchases/chest-order-19/bundleGroups/0/openedCount"), 1);
  await expectCode(call("cancelTreasureChestCashPurchase", adminUser, {
    purchaseId: "chest-order-19", cancellationId: "chest-order-19_bundle_0", itemType: "bundle", itemIndex: 0,
  }), "failed-precondition");

  const cashBeforeSingleCancel = readPath("gameSeriesWallet/accounts/chest-admin/balanceCash");
  const singleCancel = {
    purchaseId: "chest-order-19", cancellationId: "chest-order-19_single_1", itemType: "single", itemIndex: 1,
  };
  const cancelResult = await call("cancelTreasureChestCashPurchase", adminUser, singleCancel);
  assert.equal(cancelResult.cashAmount, 33);
  assert.equal(readPath("gameSeriesWallet/accounts/chest-admin/balanceCash"), cashBeforeSingleCancel + 33);
  await call("cancelTreasureChestCashPurchase", adminUser, singleCancel);
  assert.equal(readPath("gameSeriesWallet/accounts/chest-admin/balanceCash"), cashBeforeSingleCancel + 33, "중복 취소 재시도는 캐시를 다시 지급하지 않아야 함");

  await call("purchaseTreasureChestsWithCash", adminUser, { requestId: "chest-bundle-10", chestCount: 10 });
  const bundleCancel = {
    purchaseId: "chest-bundle-10", cancellationId: "chest-bundle-10_bundle_0", itemType: "bundle", itemIndex: 0,
  };
  const beforeBundleCancel = readPath("gameSeriesWallet/accounts/chest-admin/balanceCash");
  const bundleResult = await call("cancelTreasureChestCashPurchase", adminUser, bundleCancel);
  assert.equal(bundleResult.chestCount, 11);
  assert.equal(bundleResult.cashAmount, 330);
  assert.equal(readPath("gameSeriesWallet/accounts/chest-admin/balanceCash"), beforeBundleCancel + 330);

  await call("purchaseTreasureChestsWithCash", adminUser, { requestId: "chest-expired", chestCount: 1 });
  const expiredPath = "stockMarket/treasureChestInventory/chest-admin/purchases/chest-expired";
  writePath(expiredPath, { ...readPath(expiredPath), requestedAt: Date.now() - 7 * 24 * 60 * 60 * 1000 });
  await expectCode(call("cancelTreasureChestCashPurchase", adminUser, {
    purchaseId: "chest-expired", cancellationId: "chest-expired_single_1", itemType: "single", itemIndex: 1,
  }), "failed-precondition");

  await call("purchaseTreasureChestsWithCash", adminUser, { requestId: "chest-cash-fence", chestCount: 1 });
  const accountPath = "gameSeriesWallet/accounts/chest-admin";
  writePath(accountPath, {
    ...readPath(accountPath),
    refundReservations: { refundPending: { cashAmount: 1400 } },
  });
  await expectCode(call("purchaseTreasureChestsWithCash", adminUser, { requestId: "chest-insufficient", chestCount: 1 }), "failed-precondition");

  const ledgerPurchase = readPath("gameSeriesWallet/ledger/chest-admin/chest-order-19_treasureChestPurchase");
  const ledgerCancel = readPath("gameSeriesWallet/ledger/chest-admin/chest-order-19_single_1_treasureChestCancellation");
  assert.equal(ledgerPurchase.kind, "treasureChestPurchase");
  assert.equal(ledgerCancel.kind, "treasureChestCancellation");
  console.log("treasure chest checks passed: admin gate, stopped legacy/free paths, cash debit, exact bundle bonus, retry safety, FIFO, single/bundle cancellation, expiry, refund reservation");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
