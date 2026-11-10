const test = require("node:test");
const assert = require("node:assert/strict");
const { syncStockMarketAdminUid, MARKET_ADMIN_MIRROR_ROOT } = require("../marketAdminMirror");

function snapshot(value) {
  return { exists: () => value !== null && value !== undefined, val: () => value };
}

test("mirrors an enabled shared administrator into the dedicated database", async () => {
  const writes = [];
  const stock = { ref: (path) => ({ set: async (value) => writes.push({ path, value }) }) };
  const result = await syncStockMarketAdminUid({
    params: { uid: "admin-1" },
    data: { after: snapshot(true) },
  }, { getStockDatabase: () => stock });
  assert.deepEqual(result, { uid: "admin-1", mirrored: true });
  assert.deepEqual(writes, [{ path: `${MARKET_ADMIN_MIRROR_ROOT}/admin-1`, value: true }]);
});

test("removes the dedicated mirror when the shared administrator is revoked", async () => {
  const removals = [];
  const stock = { ref: (path) => ({ remove: async () => removals.push(path) }) };
  const result = await syncStockMarketAdminUid({
    params: { uid: "former-admin" },
    data: { after: snapshot(null) },
  }, { getStockDatabase: () => stock });
  assert.deepEqual(result, { uid: "former-admin", mirrored: false });
  assert.deepEqual(removals, [`${MARKET_ADMIN_MIRROR_ROOT}/former-admin`]);
});
