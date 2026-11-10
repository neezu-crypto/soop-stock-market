#!/usr/bin/env node
/*
 * 주식시장 전용 RTDB 이전 도구.
 * 기본 실행은 읽기·계획 출력 전용이다. --apply는 별도 사용자 지시와 변경 직전
 * 외장 SSD 백업 검증이 끝난 운영 전환 창에서만 사용한다.
 */
const fs = require("node:fs/promises");
const path = require("node:path");
const admin = require("firebase-admin");
const { getDatabase, getDatabaseWithUrl } = require("firebase-admin/database");
const {
  TRANSFER_ROOTS,
  buildTransferBundle,
  compareBundles,
  summarizeBundle,
} = require("./stockMarketMigrationCore");

const PROJECT_ID = "soop-stock-market";
const SHARED_URL = "https://soop-stock-market-default-rtdb.firebaseio.com";
const STOCK_URL = "https://soop-stock-market-rtdb.firebaseio.com";
const BACKUP_ROOT = "/Volumes/재찬의 T7/RTDB-Backups/";
const APPLY_CONFIRMATION = "copy-stock-market-data";

function parseArgs(argv) {
  const args = new Map(argv.slice(2).map((arg) => {
    const [key, value = true] = arg.split("=", 2);
    return [key, value];
  }));
  return {
    apply: args.has("--apply"),
    confirmation: args.get("--confirm"),
    backupDir: args.get("--backup-dir"),
  };
}

function assertApplyArguments(options) {
  if (!options.apply) return;
  if (options.confirmation !== APPLY_CONFIRMATION) {
    throw new Error(`실제 복사는 --confirm=${APPLY_CONFIRMATION} 확인 문자열이 필요합니다.`);
  }
  if (!options.backupDir || !path.resolve(options.backupDir).startsWith(BACKUP_ROOT)) {
    throw new Error(`실제 복사는 외장 SSD 백업 경로(${BACKUP_ROOT})가 필요합니다.`);
  }
}

async function readSourceBundle(sharedDb) {
  const roots = [...TRANSFER_ROOTS, "users", "adminCenter"];
  const entries = await Promise.all(roots.map(async (root) => [root, (await sharedDb.ref(root).get()).val()]));
  return buildTransferBundle(Object.fromEntries(entries));
}

async function assertTargetEmpty(stockDatabase, bundle) {
  const entries = await Promise.all(Object.keys(bundle).map(async (root) => [root, (await stockDatabase.ref(root).get()).val()]));
  // 관리자 UID 미러는 복사 전에 트리거가 먼저 실행될 수 있다. 정확히 같은
  // 값인 경우에만 허용하며, 다른 전용 시장 데이터가 하나라도 있으면 중단한다.
  const occupied = entries
    .filter(([root, value]) => value != null && (root !== "stockMarketAdminUids" || JSON.stringify(value) !== JSON.stringify(bundle[root])))
    .map(([root]) => root);
  if (occupied.length) throw new Error(`전용 DB에 이미 데이터가 있어 복사를 중단합니다: ${occupied.join(", ")}`);
}

async function writeVerifiedBackup(backupDir, bundle) {
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
  const backupPath = path.join(backupDir, "stock-market-source-before-copy.json");
  const payload = JSON.stringify(bundle, null, 2);
  await fs.writeFile(backupPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const restored = JSON.parse(await fs.readFile(backupPath, "utf8"));
  const differences = compareBundles(bundle, restored).filter((entry) => !entry.matches);
  if (differences.length) throw new Error(`백업 검증 실패: ${differences.map((entry) => entry.path).join(", ")}`);
  return backupPath;
}

const CHUNK_CONCURRENCY = 10;
const CHUNK_THRESHOLD = 50;

async function writeRootChunked(stockDatabase, root, value) {
  if (value == null) return;
  const isObject = typeof value === "object" && !Array.isArray(value);
  const keys = isObject ? Object.keys(value) : [];
  if (keys.length <= CHUNK_THRESHOLD) {
    await stockDatabase.ref(root).set(value);
    return;
  }
  for (let i = 0; i < keys.length; i += CHUNK_CONCURRENCY) {
    await Promise.all(keys.slice(i, i + CHUNK_CONCURRENCY).map((key) => stockDatabase.ref(`${root}/${key}`).set(value[key])));
  }
  console.log(`  ${root}: ${keys.length}개 자식 분할 기록 완료`);
}

async function main() {
  const options = parseArgs(process.argv);
  assertApplyArguments(options);
  admin.initializeApp({ projectId: PROJECT_ID, databaseURL: SHARED_URL });
  const sharedDb = getDatabase();
  const stockDb = getDatabaseWithUrl(STOCK_URL, admin.app());
  const bundle = await readSourceBundle(sharedDb);

  console.log(JSON.stringify({ mode: options.apply ? "apply" : "plan", summary: summarizeBundle(bundle) }, null, 2));
  if (!options.apply) return;

  await assertTargetEmpty(stockDb, bundle);
  const backupPath = await writeVerifiedBackup(path.resolve(options.backupDir), bundle);
  // 전용 인스턴스 쓰기도 instance:'*' 트리거가 받는다. 한 요청이 수천 이벤트를 만들면
  // TOO_MANY_TRIGGERS로 실패하므로 자식 단위로 나눠 쓴다. 요청 루트(알림 트리거)는 마지막에 쓴다.
  const isRequestRoot = (root) => /Requests$/.test(root);
  const ordered = Object.entries(bundle).sort(([a], [b]) => Number(isRequestRoot(a)) - Number(isRequestRoot(b)));
  for (const [root, value] of ordered) await writeRootChunked(stockDb, root, value);

  const copied = Object.fromEntries(await Promise.all(Object.keys(bundle).map(async (root) => [root, (await stockDb.ref(root).get()).val()])));
  const differences = compareBundles(bundle, copied).filter((entry) => !entry.matches);
  if (differences.length) throw new Error(`복사 검증 실패: ${differences.map((entry) => entry.path).join(", ")}`);
  console.log(JSON.stringify({ copied: true, backupPath, summary: summarizeBundle(copied) }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
