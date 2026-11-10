const test = require("node:test");
const assert = require("node:assert/strict");
const { publicStockFrom, syncStockPublicProjection } = require("../streamerNamesSync");

function snapshot(value) {
  return {
    exists: () => value !== null && value !== undefined,
    val: () => structuredClone(value ?? null),
    child: (key) => snapshot(value?.[key]),
  };
}

function memoryDatabase() {
  const writes = [];
  return {
    writes,
    ref: (path) => ({
      set: async (value) => writes.push({ type: "set", path, value: structuredClone(value) }),
      remove: async () => writes.push({ type: "remove", path }),
    }),
  };
}

test("public stock projection strips private holder and trigger fields", () => {
  assert.deepEqual(publicStockFrom({ name: "테스트", price: 10, cardBannerHolderUid: "u", freezeTriggerUid: "v", triggerUid: "w" }), {
    name: "테스트", price: 10,
  });
});

test("dedicated stock update writes public price to market DB and name index to shared DB", async () => {
  const market = memoryDatabase();
  const shared = memoryDatabase();
  const result = await syncStockPublicProjection({
    params: { stockId: "stock-1" },
    data: { before: snapshot({ name: "이전" }), after: snapshot({ name: "현재", price: 123, freezeTriggerUid: "private" }) },
  }, { getMarketDatabase: () => market, getSharedDatabase: () => shared });
  assert.deepEqual(result, { stockId: "stock-1", nameChanged: true });
  assert.deepEqual(market.writes, [{ type: "set", path: "stocksPublic/stock-1", value: { name: "현재", price: 123 } }]);
  assert.equal(shared.writes[0].path, "streamerNames/stock-1");
  assert.equal(shared.writes[0].value, "현재");
  assert.equal(shared.writes[1].path, "streamerNamesMeta/updatedAt");
});
