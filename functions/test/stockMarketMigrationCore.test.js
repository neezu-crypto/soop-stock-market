const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MARKET_ACCOUNT_FIELDS,
  TRANSFER_ROOTS,
  buildTransferBundle,
  compareBundles,
  hash,
} = require("../scripts/stockMarketMigrationCore");

test("extracts only market fields from shared user identities", () => {
  const bundle = buildTransferBundle({
    adminCenter: { adminUids: { adminA: true } },
    users: {
      userA: {
        cash: 1000,
        stocks: { streamer: 2 },
        attendanceStreak: 3,
        treasureChests: 4,
        googleLinked: true,
        streamerVerified: true,
        nickname: "공유 신원은 이전하지 않음",
      },
      userB: { nickname: "시장 데이터 없음" },
    },
    stocks: { streamer: { price: 100 } },
  });

  assert.deepEqual(bundle.stockMarket.accounts, {
    userA: { cash: 1000, stocks: { streamer: 2 }, attendanceStreak: 3, treasureChests: 4 },
  });
  assert.equal(bundle.stocks.streamer.price, 100);
  assert.deepEqual(bundle.stockMarketAdminUids, { adminA: true });
  assert.equal(bundle.stockMarket.accounts.userA.googleLinked, undefined);
  assert.equal(bundle.stockMarket.accounts.userA.nickname, undefined);
  assert.ok(MARKET_ACCOUNT_FIELDS.includes("cash"));
  assert.ok(MARKET_ACCOUNT_FIELDS.includes("realizedPL"));
  assert.ok(MARKET_ACCOUNT_FIELDS.includes("playSecondsUsedToday"));
  assert.ok(TRANSFER_ROOTS.includes("stocks"));
  assert.ok(TRANSFER_ROOTS.includes("chartBanner"));
  assert.ok(TRANSFER_ROOTS.includes("treasureChestRequests"));
  assert.ok(TRANSFER_ROOTS.includes("playTimePurchases"));
});

test("hashes object keys canonically and detects only real migration differences", () => {
  assert.equal(hash({ b: 1, a: 2 }), hash({ a: 2, b: 1 }));
  const same = compareBundles({ stocks: { a: 1 } }, { stocks: { a: 1 } });
  assert.equal(same[0].matches, true);
  const changed = compareBundles({ stocks: { a: 1 } }, { stocks: { a: 2 } });
  assert.equal(changed[0].matches, false);
});
