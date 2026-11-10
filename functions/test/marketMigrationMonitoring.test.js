const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeMarketOperations } = require("../marketMigrationMonitoring");

test("migration monitoring counts operation states and returns newest first", () => {
  const summary = summarizeMarketOperations({
    old: { state: "complete", startedAt: 10 },
    failed: { state: "failed", startedAt: 30, lastError: "retry" },
    active: { state: "processing", startedAt: 20 },
    unknown: { state: "reserved", startedAt: 40 },
  });
  assert.deepEqual(summary.counts, { processing: 1, complete: 1, failed: 1, other: 1 });
  assert.deepEqual(summary.recent.map((item) => item.operationId), ["unknown", "failed", "active", "old"]);
});
