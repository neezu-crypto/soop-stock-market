const { onCall } = require("firebase-functions/v2/https");
const { requireAdmin } = require("./common");
const {
  STOCK_MARKET_MIGRATION_STATE_PATH,
  sharedDb,
  stockDb,
} = require("./marketDatabases");

function summarizeMarketOperations(operations) {
  const entries = Object.entries(operations || {}).map(([operationId, operation]) => ({ operationId, ...(operation || {}) }));
  const counts = { processing: 0, complete: 0, failed: 0, other: 0 };
  for (const operation of entries) {
    if (Object.hasOwn(counts, operation.state)) counts[operation.state] += 1;
    else counts.other += 1;
  }
  return {
    counts,
    recent: entries.sort((a, b) => Number(b.startedAt || b.completedAt || 0) - Number(a.startedAt || a.completedAt || 0)).slice(0, 50),
  };
}

const getStockMarketMigrationStatus = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const sharedDatabase = sharedDb();
  await requireAdmin(sharedDatabase, request.auth);
  const [stateSnap, operationsSnap] = await Promise.all([
    sharedDatabase.ref(STOCK_MARKET_MIGRATION_STATE_PATH).get(),
    stockDb().ref("stockMarket/operations").orderByChild("startedAt").limitToLast(100).get(),
  ]);
  return {
    state: stateSnap.val() || null,
    operations: summarizeMarketOperations(operationsSnap.val()),
  };
});

module.exports = { summarizeMarketOperations, getStockMarketMigrationStatus };
