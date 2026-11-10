const test = require("node:test");
const assert = require("node:assert/strict");
const control = require("./schedulerControl");

function makeDb(seed = {}) {
  const data = structuredClone(seed);
  const parts = (path) => path.split("/").filter(Boolean);
  const valueAt = (path) => parts(path).reduce((value, key) => value?.[key] ?? null, data);
  const writeAt = (path, value) => {
    const keys = parts(path);
    let parent = data;
    for (const key of keys.slice(0, -1)) parent = parent[key] ||= {};
    parent[keys.at(-1)] = structuredClone(value);
  };
  const ref = (path = "") => ({
    get: async () => ({ val: () => { const v = valueAt(path); return v == null ? null : structuredClone(v); } }),
    update: async (value) => { for (const [key, item] of Object.entries(value)) writeAt([path, key].filter(Boolean).join("/"), item); },
  });
  return { ref, data };
}

test("jobs are enabled by default and only an explicit false disables them", async () => {
  const db = makeDb();
  assert.equal(await control.isSchedulerEnabled(db, control.STOCK_DELIST_JOB), true);
  db.data.stockMarket = { adminSchedulerControl: { [control.STOCK_DELIST_JOB]: { enabled: false } } };
  assert.equal(await control.isSchedulerEnabled(db, control.STOCK_DELIST_JOB), false);
  assert.equal(await control.isSchedulerEnabled(db, control.CREW_SYNC_JOB), true);
});

test("a run is recorded without touching the enabled flag", async () => {
  const db = makeDb({ stockMarket: { adminSchedulerControl: { [control.STOCK_DELIST_JOB]: { enabled: true } } } });
  await control.recordSchedulerRun(db, control.STOCK_DELIST_JOB, { lastDelistedCount: 2 });
  const state = db.data.stockMarket.adminSchedulerControl[control.STOCK_DELIST_JOB];
  assert.equal(state.enabled, true);
  assert.equal(state.lastDelistedCount, 2);
  assert.ok(state.lastRunAt > 0);
});
