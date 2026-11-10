const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertOperationId,
  decideOperationClaim,
  claimMarketOperation,
  completeMarketOperation,
  failMarketOperation,
} = require("../marketOperations");

class MemoryRef {
  constructor(store, path) { this.store = store; this.path = path; }
  async get() { return { val: () => structuredClone(this.store[this.path] ?? null) }; }
  async transaction(callback) {
    const next = callback(this.store[this.path] ?? null);
    if (next !== undefined) this.store[this.path] = structuredClone(next);
    return { committed: next !== undefined, snapshot: { val: () => structuredClone(this.store[this.path] ?? null) } };
  }
  async set(value) { this.store[this.path] = structuredClone(value); }
}

class MemoryDatabase {
  constructor() { this.store = {}; }
  ref(path) { return new MemoryRef(this.store, path); }
}

test("operation IDs have a strict stable format", () => {
  assert.doesNotThrow(() => assertOperationId("trade_0123456789abcd"));
  assert.throws(() => assertOperationId("short"), /operationId/);
  assert.throws(() => assertOperationId("spaces are forbidden 012345"), /operationId/);
});

test("claim decision replays completed requests and rejects altered requests", () => {
  const first = decideOperationClaim(null, { uid: "u", kind: "trade", requestHash: "a", now: 100 });
  assert.equal(first.action, "execute");
  const complete = decideOperationClaim({ ...first.next, state: "complete" }, { uid: "u", kind: "trade", requestHash: "a", now: 101 });
  assert.equal(complete.action, "replay");
  const conflict = decideOperationClaim(first.next, { uid: "u", kind: "trade", requestHash: "different", now: 101 });
  assert.equal(conflict.action, "conflict");
  const busy = decideOperationClaim(first.next, { uid: "u", kind: "trade", requestHash: "a", now: 101 });
  assert.equal(busy.action, "in-progress");
  const retry = decideOperationClaim({ ...first.next, leaseUntil: 100 }, { uid: "u", kind: "trade", requestHash: "a", now: 101 });
  assert.equal(retry.action, "execute");
  assert.equal(retry.next.attempts, 2);
});

test("ledger completes a request once and returns replay state on retry", async () => {
  const db = new MemoryDatabase();
  const operationId = "trade_0123456789abcd";
  const claimed = await claimMarketOperation(db, { operationId, uid: "u", kind: "trade", request: { stockId: "s", qty: 1 }, now: 100 });
  assert.equal(claimed.action, "execute");
  const completed = await completeMarketOperation(claimed.ref, { requestHash: claimed.requestHash, result: { cash: 900 }, now: 101 });
  assert.equal(completed.completed, true);
  const replay = await claimMarketOperation(db, { operationId, uid: "u", kind: "trade", request: { stockId: "s", qty: 1 }, now: 102 });
  assert.equal(replay.action, "replay");
  assert.deepEqual(replay.operation.result, { cash: 900 });
});

test("failed operations are marked retryable without overwriting a completed result", async () => {
  const db = new MemoryDatabase();
  const claimed = await claimMarketOperation(db, { operationId: "refund_0123456789abcd", uid: "u", kind: "refund", request: { amount: 1 }, now: 100 });
  const failed = await failMarketOperation(claimed.ref, { requestHash: claimed.requestHash, error: new Error("network"), now: 101 });
  assert.equal(failed.state, "failed");
  const retry = await claimMarketOperation(db, { operationId: "refund_0123456789abcd", uid: "u", kind: "refund", request: { amount: 1 }, now: 102 });
  assert.equal(retry.action, "execute");
});
