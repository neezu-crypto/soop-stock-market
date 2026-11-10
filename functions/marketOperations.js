const crypto = require("node:crypto");

const MARKET_OPERATION_ROOT = "stockMarket/operations";
const MARKET_AUDIT_ROOT = "stockMarket/auditLog";
const ACTIVE_OPERATION_LEASE_MS = 2 * 60 * 1000;

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertOperationId(operationId) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(operationId || ""))) {
    throw new Error("operationId는 16~128자의 영문·숫자·밑줄·하이픈이어야 합니다.");
  }
}

function decideOperationClaim(current, { uid, kind, requestHash, now, leaseMs = ACTIVE_OPERATION_LEASE_MS }) {
  if (!current) {
    return {
      action: "execute",
      next: { uid, kind, requestHash, state: "processing", attempts: 1, startedAt: now, leaseUntil: now + leaseMs },
    };
  }
  if (current.uid !== uid || current.kind !== kind || current.requestHash !== requestHash) {
    return { action: "conflict", next: current };
  }
  if (current.state === "complete") return { action: "replay", next: current };
  if (current.state === "processing" && Number(current.leaseUntil || 0) > now) {
    return { action: "in-progress", next: current };
  }
  return {
    action: "execute",
    next: {
      ...current,
      state: "processing",
      attempts: Number(current.attempts || 0) + 1,
      startedAt: now,
      leaseUntil: now + leaseMs,
      lastError: null,
    },
  };
}

async function claimMarketOperation(stockDatabase, {
  operationId,
  uid,
  kind,
  request,
  now = Date.now(),
  leaseMs = ACTIVE_OPERATION_LEASE_MS,
}) {
  assertOperationId(operationId);
  if (!uid || !kind) throw new Error("작업 UID와 종류가 필요합니다.");
  const requestHash = fingerprint(request);
  // Firebase transaction 콜백은 로컬 추정값과 서버 재시도 과정에서 여러 번
  // 호출될 수 있다. 같은 호출이 방금 기록한 processing 값을 다시 받았을 때
  // 다른 요청이 점유한 것으로 오판하지 않도록, 이 claim 시도만의 토큰을 남긴다.
  const claimToken = crypto.randomUUID();
  let decision = null;
  const ref = stockDatabase.ref(`${MARKET_OPERATION_ROOT}/${operationId}`);
  const transaction = await ref.transaction((current) => {
    if (current?.state === "processing" && current.claimToken === claimToken) {
      decision = { action: "execute", next: current };
      return current;
    }
    decision = decideOperationClaim(current, { uid, kind, requestHash, now, leaseMs });
    if (decision.action === "conflict" || decision.action === "replay" || decision.action === "in-progress") return;
    return { ...decision.next, claimToken };
  });
  const value = transaction.snapshot.val();
  return { action: decision?.action || "in-progress", operation: value, requestHash, ref };
}

async function completeMarketOperation(ref, { requestHash, result, now = Date.now() }) {
  // Admin SDK transaction callbacks can receive null before their first server
  // value arrives. Keep a confirmed pre-read so that a completion never gets
  // spuriously aborted solely because the local cache was empty.
  const before = (await ref.get()).val();
  let completed = false;
  const transaction = await ref.transaction((current) => {
    const source = current === null ? before : current;
    if (!source || source.requestHash !== requestHash) return;
    if (source.state === "complete") return source;
    completed = true;
    return {
      ...source,
      state: "complete",
      completedAt: now,
      leaseUntil: null,
      result,
    };
  });
  return { completed, operation: transaction.snapshot.val() };
}

async function failMarketOperation(ref, { requestHash, error, now = Date.now() }) {
  const message = String(error?.message || error || "unknown").slice(0, 500);
  const before = (await ref.get()).val();
  const transaction = await ref.transaction((current) => {
    const source = current === null ? before : current;
    if (!source || source.requestHash !== requestHash || source.state === "complete") return;
    return { ...source, state: "failed", failedAt: now, leaseUntil: null, lastError: message };
  });
  return transaction.snapshot.val();
}

async function writeMarketAudit(stockDatabase, operationId, entry) {
  assertOperationId(operationId);
  await stockDatabase.ref(`${MARKET_AUDIT_ROOT}/${operationId}`).set({
    ...entry,
    operationId,
    recordedAt: Date.now(),
  });
}

module.exports = {
  MARKET_OPERATION_ROOT,
  MARKET_AUDIT_ROOT,
  ACTIVE_OPERATION_LEASE_MS,
  fingerprint,
  assertOperationId,
  decideOperationClaim,
  claimMarketOperation,
  completeMarketOperation,
  failMarketOperation,
  writeMarketAudit,
};
