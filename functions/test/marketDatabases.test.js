const test = require("node:test");
const assert = require("node:assert/strict");
const {
  STOCK_MARKET_DATABASE_URL,
  STOCK_MARKET_PRIMARY_PHASE,
  sharedDb,
  stockDb,
  isStockMarketPrimary,
  resolveMarketDatabase,
  marketAccountPath,
  getMarketDatabaseContext,
  getMarketUserContext,
} = require("../marketDatabases");

test("sharedDb uses the default Firebase database without a URL override", () => {
  const calls = [];
  const result = sharedDb((...args) => {
    calls.push(args);
    return { name: "shared" };
  });

  assert.deepEqual(result, { name: "shared" });
  assert.deepEqual(calls, [[]]);
});

test("market user context keeps shared identity distinct from the market account", async () => {
  const shared = {
    ref: (path) => ({ get: async () => ({ val: () => {
      if (path === 'users/u1') return { googleLinked: true };
      if (path === 'adminCenter/stockMarketDatabaseMigration/state') return { phase: STOCK_MARKET_PRIMARY_PHASE };
      return null;
    } }) }),
  };
  const stock = { ref: (path) => ({ get: async () => ({ val: () => path === 'stockMarket/accounts/u1' ? { cash: 10 } : null }) }) };
  const context = await getMarketUserContext({
    uid: 'u1',
    sharedDatabase: shared,
    getStockDatabase: () => stock,
  });
  assert.deepEqual(context.identity, { googleLinked: true });
  assert.deepEqual(context.account, { cash: 10 });
});

test("stockDb always selects the dedicated stock-market database URL", () => {
  const calls = [];
  const app = { name: "test-app" };
  const result = stockDb((...args) => {
    calls.push(args);
    return { name: "stock" };
  }, app);

  assert.deepEqual(result, { name: "stock" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], STOCK_MARKET_DATABASE_URL);
  assert.equal(calls[0][1], app);
  assert.equal(STOCK_MARKET_DATABASE_URL, "https://soop-stock-market-rtdb.firebaseio.com");
});

test("market DB remains shared until the explicit market-primary migration phase", () => {
  const shared = { name: "shared" };
  const stock = { name: "stock" };

  assert.equal(isStockMarketPrimary(null), false);
  assert.equal(isStockMarketPrimary({ phase: "copying" }), false);
  assert.equal(isStockMarketPrimary({ phase: STOCK_MARKET_PRIMARY_PHASE }), true);
  assert.deepEqual(resolveMarketDatabase({ migrationState: null, sharedDatabase: shared, stockDatabase: stock }), {
    db: shared,
    mode: "shared",
  });
  assert.deepEqual(resolveMarketDatabase({
    migrationState: { phase: STOCK_MARKET_PRIMARY_PHASE },
    sharedDatabase: shared,
    stockDatabase: stock,
  }), { db: stock, mode: "stock" });
  assert.throws(() => resolveMarketDatabase({
    migrationState: { phase: STOCK_MARKET_PRIMARY_PHASE },
    sharedDatabase: shared,
  }), /stockDatabase/);
});

test("market context keeps accounts in shared users until cutover, then selects dedicated accounts", async () => {
  const makeDatabase = (state) => ({
    ref: (path) => ({
      get: async () => ({ val: () => path === "adminCenter/stockMarketDatabaseMigration/state" ? state : null }),
      path,
    }),
  });
  const shared = makeDatabase(null);
  const stock = { ref: (path) => ({ path }) };
  const legacy = await getMarketDatabaseContext({ sharedDatabase: shared, getStockDatabase: () => stock });
  assert.equal(legacy.mode, "shared");
  assert.equal(legacy.accountPath("uid-1"), "users/uid-1");
  assert.equal(legacy.accountRef("uid-1").path, "users/uid-1");

  const primary = await getMarketDatabaseContext({
    sharedDatabase: makeDatabase({ phase: STOCK_MARKET_PRIMARY_PHASE }),
    getStockDatabase: () => stock,
  });
  assert.equal(primary.mode, "stock");
  assert.equal(primary.accountPath("uid-1"), "stockMarket/accounts/uid-1");
  assert.equal(primary.accountRef("uid-1").path, "stockMarket/accounts/uid-1");
  assert.equal(marketAccountPath("shared", "uid-2"), "users/uid-2");
});

test("stockDb with the real firebase-admin factory points at the dedicated instance, not the default one", async () => {
  const admin = require("firebase-admin");
  const { getDatabase } = require("firebase-admin/database");
  const app = admin.initializeApp({
    projectId: "soop-stock-market",
    databaseURL: "https://soop-stock-market-default-rtdb.firebaseio.com",
  }, "market-databases-url-regression");
  try {
    assert.equal(stockDb(undefined, app).ref().toString(), STOCK_MARKET_DATABASE_URL + "/");
    assert.notEqual(getDatabase(app).ref().toString(), STOCK_MARKET_DATABASE_URL + "/");
  } finally {
    await app.delete();
  }
});
