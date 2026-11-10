#!/usr/bin/env node
// 기본 DB와 전용 DB의 대상 경로를 읽어서 hash·항목 수를 대조하는 읽기 전용 도구다.
const admin = require("firebase-admin");
const { getDatabase, getDatabaseWithUrl } = require("firebase-admin/database");
const {
  TRANSFER_ROOTS,
  buildTransferBundle,
  compareBundles,
} = require("./stockMarketMigrationCore");

const SHARED_URL = "https://soop-stock-market-default-rtdb.firebaseio.com";
const STOCK_URL = "https://soop-stock-market-rtdb.firebaseio.com";

async function main() {
  admin.initializeApp({ projectId: "soop-stock-market", databaseURL: SHARED_URL });
  const sharedDb = getDatabase();
  const stockDb = getDatabaseWithUrl(STOCK_URL, admin.app());
  const roots = [...TRANSFER_ROOTS, "users", "adminCenter"];
  const source = Object.fromEntries(await Promise.all(roots.map(async (root) => [root, (await sharedDb.ref(root).get()).val()])));
  const expected = buildTransferBundle(source);
  const actual = Object.fromEntries(await Promise.all(Object.keys(expected).map(async (root) => [root, (await stockDb.ref(root).get()).val()])));
  const result = compareBundles(expected, actual);
  console.log(JSON.stringify({ matches: result.every((entry) => entry.matches), paths: result }, null, 2));
  if (!result.every((entry) => entry.matches)) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
