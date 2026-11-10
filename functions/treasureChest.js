const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  TREASURE_CHEST_MAX_BUY_COUNT,
  TREASURE_CHEST_BULK_BONUS_THRESHOLD,
  TREASURE_CHEST_OPEN_BIG_RATE,
  TREASURE_CHEST_REWARD_SMALL,
  TREASURE_CHEST_REWARD_BIG,
  requireNotInMaintenance,
  requireLinkedUser,
  assertNotBanned,
  creditUserCash,
} = require("./common");
const { getMarketDatabaseContext } = require("./marketDatabases");
const {
  claimMarketOperation,
  completeMarketOperation,
  failMarketOperation,
  writeMarketAudit,
} = require("./marketOperations");

const WALLET_ROOT = "gameSeriesWallet";
const CHEST_INVENTORY_ROOT = "stockMarket/treasureChestInventory";
const CHEST_PRICE_CASH = 33;
const CHEST_CANCEL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_WALLET_CASH = Number.MAX_SAFE_INTEGER;

function computeChestPurchase(chestCount) {
  const bonusChestCount = Math.floor(chestCount / TREASURE_CHEST_BULK_BONUS_THRESHOLD);
  return {
    chestCount,
    bonusChestCount,
    totalChestCount: chestCount + bonusChestCount,
    cashAmount: chestCount * CHEST_PRICE_CASH,
  };
}

function requireUid(request) {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  return uid;
}

/**
 * 보물상자 캐시 상품은 계정 보호를 마친 로그인 이용자에게만 제공한다.
 * 관리자 여부는 이 기능의 접근 기준이 아니다. 실제 캐시 잔액·상자 재고는
 * 언제나 요청한 UID 아래에서만 처리한다.
 */
async function requireChestUser(db, request) {
  const uid = requireUid(request);
  await requireLinkedUser(db, uid, request.auth);
  await assertNotBanned(db, request.auth);
  return uid;
}

// 통합 캐시 지갑은 모든 시리즈가 공유하므로 기본 DB에 계속 둔다. 반면 보물
// 상자 재고·개봉 보상은 주식시장 데이터이므로 시장 DB로 옮긴다. 전환 전에는
// marketDatabase가 sharedDatabase와 같아 기존 경로·동작이 그대로 유지된다.
async function getChestContext(sharedDatabase = admin.database()) {
  const marketContext = await getMarketDatabaseContext({ sharedDatabase });
  return {
    sharedDatabase,
    marketContext,
    marketDatabase: marketContext.db,
  };
}

function safeRequestId(value, label = "요청 번호") {
  const id = String(value || "");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) {
    throw new HttpsError("invalid-argument", `${label}가 올바르지 않습니다.`);
  }
  return id;
}

function reservedRefundCash(account, exceptRequestId = "") {
  const reservations = account?.refundReservations && typeof account.refundReservations === "object"
    ? account.refundReservations : {};
  return Object.entries(reservations).reduce((sum, [requestId, reservation]) => {
    if (requestId === exceptRequestId) return sum;
    return sum + Math.max(0, Math.floor(Number(reservation?.cashAmount) || 0));
  }, 0);
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function inventoryChestCount(inventory) {
  const purchases = inventory?.purchases && typeof inventory.purchases === "object"
    ? inventory.purchases : {};
  return Object.values(purchases).reduce((sum, purchase) => {
    const groups = Array.isArray(purchase?.bundleGroups) ? purchase.bundleGroups : [];
    const bundleRemaining = groups.reduce((groupSum, group) => groupSum + nonNegativeInteger(group?.remaining), 0);
    return sum + bundleRemaining + nonNegativeInteger(purchase?.singleRemaining);
  }, 0);
}

function inventoryPurchaseList(inventory) {
  const purchases = inventory?.purchases && typeof inventory.purchases === "object"
    ? inventory.purchases : {};
  return Object.values(purchases)
    .map((purchase) => ({ ...purchase }))
    .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
}

function normalizeRequestCount(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > TREASURE_CHEST_MAX_BUY_COUNT) {
    throw new HttpsError("invalid-argument", `구매 개수는 1~${TREASURE_CHEST_MAX_BUY_COUNT}개 사이여야 합니다.`);
  }
  return count;
}

// 신규 신청은 중단한다. 이미 제출된 별풍선 신청은 관리자 검수 기능으로 계속 처리할 수 있다.
const submitTreasureChestPurchaseRequest = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  requireUid(request);
  throw new HttpsError("failed-precondition", "별풍선 보물상자 신청은 중단되었습니다. 보물상자는 통합 캐시 구매로 이용해 주세요.");
});

// 구독자 무료 지급은 기능 재개 전까지 중단한다. 과거 지급 기록과 보유 수량은 수정하지 않는다.
const claimMonthlyFreeTreasureChest = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  requireUid(request);
  throw new HttpsError("failed-precondition", "무료 보물상자 지급은 일시 중단되었습니다.");
});

// 함수명은 기존 클라이언트 호환을 위해 유지한다. 접근 권한은 로그인 이용자 기준이다.
const getAdminTreasureChestState = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const { sharedDatabase, marketContext, marketDatabase } = await getChestContext();
  const uid = await requireChestUser(sharedDatabase, request);
  const [accountSnap, inventorySnap, legacySnap] = await Promise.all([
    sharedDatabase.ref(`${WALLET_ROOT}/accounts/${uid}`).get(),
    marketDatabase.ref(`${CHEST_INVENTORY_ROOT}/${uid}`).get(),
    marketContext.accountRef(uid).child("treasureChests").get(),
  ]);
  const account = accountSnap.val() || {};
  const inventory = inventorySnap.val() || {};
  const balanceCash = nonNegativeInteger(account.balanceCash);
  const reservedCash = reservedRefundCash(account);
  const legacyChestCount = nonNegativeInteger(legacySnap.val());
  const purchasedChestCount = inventoryChestCount(inventory);
  const purchases = inventoryPurchaseList(inventory);
  const cancellationEntries = Object.entries(inventory.cancellations || {}).map(([id, value]) => ({ id, ...value }));
  const pendingCancellations = cancellationEntries.filter((item) => item.walletCredited !== true);
  return {
    ok: true,
    uid,
    balanceCash,
    reservedRefundCash: reservedCash,
    availableCash: Math.max(0, balanceCash - reservedCash),
    legacyChestCount,
    purchasedChestCount,
    totalChestCount: legacyChestCount + purchasedChestCount,
    purchases,
    pendingCancellations,
    priceCash: CHEST_PRICE_CASH,
    cancelWindowMs: CHEST_CANCEL_WINDOW_MS,
  };
});

const purchaseTreasureChestsWithCash = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const { sharedDatabase, marketDatabase, marketContext } = await getChestContext();
  const uid = await requireChestUser(sharedDatabase, request);
  const requestId = safeRequestId(request.data?.requestId, "구매 요청 번호");
  const chestCount = normalizeRequestCount(request.data?.chestCount);
  const purchase = computeChestPurchase(chestCount);
  const operation = await claimMarketOperation(marketDatabase, {
    operationId: `chest_purchase_${requestId}`,
    uid,
    kind: "treasure-chest-purchase",
    request: { requestId, chestCount, cashAmount: purchase.cashAmount },
  });
  if (operation.action === "replay") return operation.operation.result;
  if (operation.action === "conflict") throw new HttpsError("already-exists", "요청 번호가 다른 구매 내역에 이미 사용됐습니다.");
  if (operation.action === "in-progress") throw new HttpsError("aborted", "같은 구매 요청을 처리 중입니다. 잠시 후 다시 확인해 주세요.");

  try {
  const accountRef = sharedDatabase.ref(`${WALLET_ROOT}/accounts/${uid}`);
  const accountBefore = (await accountRef.get()).val() || null;
  let insufficientBalance = false;
  let availableAtRequest = 0;
  let requestConflict = false;
  const debit = await accountRef.transaction((value) => {
    insufficientBalance = false;
    requestConflict = false;
    // Admin SDK may first invoke this callback with an empty local cache. Returning
    // null forces a server read before validating the balance or recording a debit.
    const source = value === null ? accountBefore : value;
    const account = source && typeof source === "object" ? source : {};
    const records = account.treasureChestPurchases && typeof account.treasureChestPurchases === "object"
      ? { ...account.treasureChestPurchases } : {};
    const previous = records[requestId];
    if (previous) {
      if (Number(previous.paidChestCount) !== chestCount || Number(previous.cashAmount) !== purchase.cashAmount) {
        requestConflict = true;
        return account;
      }
      return account;
    }
    const balance = nonNegativeInteger(account.balanceCash);
    const available = Math.max(0, balance - reservedRefundCash(account));
    availableAtRequest = available;
    if (available < purchase.cashAmount) {
      insufficientBalance = true;
      return;
    }
    if (balance > MAX_WALLET_CASH - purchase.cashAmount) {
      insufficientBalance = true;
      return;
    }
    records[requestId] = {
      purchaseId: requestId,
      status: "granting",
      paidChestCount: chestCount,
      bonusChestCount: purchase.bonusChestCount,
      totalChestCount: purchase.totalChestCount,
      cashAmount: purchase.cashAmount,
      requestedAt: Date.now(),
      requestedByUid: uid,
    };
    return { ...account, balanceCash: balance - purchase.cashAmount, treasureChestPurchases: records };
  }, undefined, false);
  if (requestConflict) throw new HttpsError("already-exists", "요청 번호가 다른 구매 내역에 이미 사용됐습니다.");
  if (insufficientBalance) throw new HttpsError("failed-precondition", `사용 가능한 캐시가 부족합니다. 필요 ${purchase.cashAmount.toLocaleString()}캐시, 사용 가능 ${availableAtRequest.toLocaleString()}캐시`);
  if (!debit.committed) throw new HttpsError("aborted", "캐시 차감이 완료되지 않았습니다. 같은 요청 번호로 다시 시도해 주세요.");

  const inventoryRef = marketDatabase.ref(`${CHEST_INVENTORY_ROOT}/${uid}`);
  const inventoryBefore = (await inventoryRef.get()).val() || null;
  let inventoryConflict = false;
  const inventoryTx = await inventoryRef.transaction((value) => {
    inventoryConflict = false;
    const source = value === null ? inventoryBefore : value;
    const inventory = source && typeof source === "object" ? source : {};
    const records = inventory.purchases && typeof inventory.purchases === "object"
      ? { ...inventory.purchases } : {};
    const existing = records[requestId];
    if (existing) {
      if (Number(existing.paidChestCount) !== chestCount || Number(existing.cashAmount) !== purchase.cashAmount) {
        inventoryConflict = true;
        return inventory;
      }
      return inventory;
    }
    const sequence = nonNegativeInteger(inventory.nextSequence) + 1;
    const bundleCount = Math.floor(chestCount / TREASURE_CHEST_BULK_BONUS_THRESHOLD);
    records[requestId] = {
      purchaseId: requestId,
      sequence,
      requestedAt: Number(debit.snapshot.val()?.treasureChestPurchases?.[requestId]?.requestedAt) || Date.now(),
      paidChestCount: chestCount,
      bonusChestCount: purchase.bonusChestCount,
      totalChestCount: purchase.totalChestCount,
      cashAmount: purchase.cashAmount,
      bundleGroups: Array.from({ length: bundleCount }, (_, index) => ({ index, remaining: 11, openedCount: 0, cancelled: false })),
      singleRemaining: chestCount % TREASURE_CHEST_BULK_BONUS_THRESHOLD,
      singleCancelledCount: 0,
      openedChestCount: 0,
      cancelledChestCount: 0,
    };
    return { ...inventory, nextSequence: sequence, purchases: records };
  }, undefined, false);
  if (inventoryConflict) throw new HttpsError("data-loss", "구매 기록과 보물상자 지급 기록이 일치하지 않습니다. 관리자 확인이 필요합니다.");
  if (!inventoryTx.committed) throw new HttpsError("aborted", "보물상자 지급 기록을 저장하지 못했습니다. 같은 요청 번호로 다시 시도해 주세요.");

  const purchaseRecord = inventoryTx.snapshot.val()?.purchases?.[requestId];
  let finalizeFailed = false;
  const finalize = await accountRef.transaction((value) => {
    finalizeFailed = false;
    if (value === null) return null;
    const account = value && typeof value === "object" ? value : {};
    const records = account.treasureChestPurchases && typeof account.treasureChestPurchases === "object"
      ? { ...account.treasureChestPurchases } : {};
    const previous = records[requestId];
    if (!previous) { finalizeFailed = true; return account; }
    records[requestId] = {
      ...previous,
      status: "purchased",
      sequence: Number(purchaseRecord?.sequence) || 0,
      purchasedAt: Number(purchaseRecord?.requestedAt) || Date.now(),
      remainingChestCount: purchase.totalChestCount,
      openedChestCount: 0,
      cancelledChestCount: 0,
    };
    return { ...account, treasureChestPurchases: records };
  }, undefined, false);
  if (finalizeFailed || !finalize.committed) {
    throw new HttpsError("aborted", "상자는 지급됐지만 구매 처리를 마무리하지 못했습니다. 구매 요청을 다시 불러와 주세요.");
  }

  await sharedDatabase.ref(`${WALLET_ROOT}/ledger/${uid}/${requestId}_treasureChestPurchase`).set({
    kind: "treasureChestPurchase",
    requestId,
    productId: "treasureChest",
    paidChestCount: chestCount,
    bonusChestCount: purchase.bonusChestCount,
    cashAmount: purchase.cashAmount,
    amountKrw: purchase.cashAmount * 100,
    balanceDelta: -purchase.cashAmount,
    createdAt: Number(purchaseRecord?.requestedAt) || Date.now(),
    createdByUid: uid,
  });
  const result = {
    ok: true,
    requestId,
    ...purchase,
    remainingCash: nonNegativeInteger(finalize.snapshot.val()?.balanceCash),
    totalOwnedChestCount: nonNegativeInteger((await marketContext.accountRef(uid).child("treasureChests").get()).val()) + inventoryChestCount(inventoryTx.snapshot.val()),
  };
  await completeMarketOperation(operation.ref, { requestHash: operation.requestHash, result });
  await writeMarketAudit(marketDatabase, `chest_purchase_${requestId}`, {
    kind: "treasure-chest-purchase", uid, requestId, cashAmount: purchase.cashAmount,
  });
  return result;
  } catch (error) {
    await failMarketOperation(operation.ref, { requestHash: operation.requestHash, error });
    throw error;
  }
});

const cancelTreasureChestCashPurchase = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const { sharedDatabase, marketDatabase, marketContext } = await getChestContext();
  const uid = await requireChestUser(sharedDatabase, request);
  const purchaseId = safeRequestId(request.data?.purchaseId, "구매 번호");
  const cancellationId = safeRequestId(request.data?.cancellationId, "취소 요청 번호");
  const itemType = String(request.data?.itemType || "");
  const itemIndex = Number(request.data?.itemIndex);
  if (!Number.isSafeInteger(itemIndex) || itemIndex < 0 || !["bundle", "single"].includes(itemType)) {
    throw new HttpsError("invalid-argument", "취소할 상자 항목을 확인할 수 없습니다.");
  }
  const operation = await claimMarketOperation(marketDatabase, {
    operationId: `chest_cancel_${cancellationId}`,
    uid,
    kind: "treasure-chest-cancellation",
    request: { purchaseId, cancellationId, itemType, itemIndex },
  });
  if (operation.action === "replay") return operation.operation.result;
  if (operation.action === "conflict") throw new HttpsError("already-exists", "취소 요청 번호가 다른 처리에 이미 사용됐습니다.");
  if (operation.action === "in-progress") throw new HttpsError("aborted", "같은 취소 요청을 처리 중입니다. 잠시 후 다시 확인해 주세요.");

  try {
  const now = Date.now();
  const inventoryRef = marketDatabase.ref(`${CHEST_INVENTORY_ROOT}/${uid}`);
  const inventoryBefore = (await inventoryRef.get()).val() || null;
  let cancelError = "";
  const inventoryTx = await inventoryRef.transaction((value) => {
    cancelError = "";
    const source = value === null ? inventoryBefore : value;
    const inventory = source && typeof source === "object" ? source : {};
    const cancellations = inventory.cancellations && typeof inventory.cancellations === "object"
      ? { ...inventory.cancellations } : {};
    const existingCancellation = cancellations[cancellationId];
    if (existingCancellation) return inventory;
    const purchases = inventory.purchases && typeof inventory.purchases === "object"
      ? { ...inventory.purchases } : {};
    const purchase = purchases[purchaseId];
    if (!purchase) { cancelError = "not-found"; return; }
    const purchasedAt = Number(purchase.requestedAt) || 0;
    if (now < purchasedAt || now - purchasedAt >= CHEST_CANCEL_WINDOW_MS) {
      cancelError = "expired";
      return;
    }
    const nextPurchase = { ...purchase };
    if (itemType === "bundle") {
      const groups = Array.isArray(purchase.bundleGroups) ? purchase.bundleGroups.map((group) => ({ ...group })) : [];
      const group = groups[itemIndex];
      if (!group || group.cancelled || Number(group.remaining) !== 11 || Number(group.openedCount) !== 0) {
        cancelError = "used";
        return;
      }
      groups[itemIndex] = { ...group, remaining: 0, cancelled: true, cancelledAt: now, cancellationId };
      nextPurchase.bundleGroups = groups;
    } else {
      if (itemIndex !== Number(purchase.singleCancelledCount || 0) + 1 || Number(purchase.singleRemaining) < 1) {
        cancelError = "used";
        return;
      }
      nextPurchase.singleRemaining = Number(purchase.singleRemaining) - 1;
      nextPurchase.singleCancelledCount = Number(purchase.singleCancelledCount || 0) + 1;
    }
    const chestCount = itemType === "bundle" ? 11 : 1;
    const cashAmount = itemType === "bundle" ? CHEST_PRICE_CASH * 10 : CHEST_PRICE_CASH;
    nextPurchase.cancelledChestCount = Number(purchase.cancelledChestCount || 0) + chestCount;
    nextPurchase.cancelledCashAmount = Number(purchase.cancelledCashAmount || 0) + cashAmount;
    nextPurchase.remainingChestCount =
      (nextPurchase.bundleGroups || []).reduce((sum, group) => sum + nonNegativeInteger(group.remaining), 0)
      + nonNegativeInteger(nextPurchase.singleRemaining);
    purchases[purchaseId] = nextPurchase;
    cancellations[cancellationId] = {
      purchaseId,
      itemType,
      itemIndex,
      chestCount,
      cashAmount,
      requestedAt: now,
      walletCredited: false,
    };
    return { ...inventory, purchases, cancellations };
  }, undefined, false);
  if (cancelError === "not-found") throw new HttpsError("not-found", "보물상자 구매 내역을 찾을 수 없습니다.");
  if (cancelError === "expired") throw new HttpsError("failed-precondition", "구매 후 7일이 지나 취소할 수 없습니다.");
  if (cancelError === "used") throw new HttpsError("failed-precondition", "이미 사용했거나 취소할 수 없는 상자입니다.");
  if (!inventoryTx.committed) throw new HttpsError("aborted", "취소 상태를 저장하지 못했습니다. 같은 취소 요청 번호로 다시 시도해 주세요.");

  const cancellation = inventoryTx.snapshot.val()?.cancellations?.[cancellationId];
  if (!cancellation) throw new HttpsError("data-loss", "취소 기록을 확인할 수 없습니다.");
  const accountRef = sharedDatabase.ref(`${WALLET_ROOT}/accounts/${uid}`);
  const accountBefore = (await accountRef.get()).val() || null;
  let missingPurchase = false;
  let cashOverflow = false;
  const refundTx = await accountRef.transaction((value) => {
    missingPurchase = false;
    cashOverflow = false;
    const source = value === null ? accountBefore : value;
    const account = source && typeof source === "object" ? source : {};
    const processed = account.processedChestCancellations && typeof account.processedChestCancellations === "object"
      ? { ...account.processedChestCancellations } : {};
    if (processed[cancellationId]) return account;
    const purchases = account.treasureChestPurchases && typeof account.treasureChestPurchases === "object"
      ? { ...account.treasureChestPurchases } : {};
    const purchase = purchases[purchaseId];
    if (!purchase) { missingPurchase = true; return account; }
    const balance = nonNegativeInteger(account.balanceCash);
    if (balance > MAX_WALLET_CASH - Number(cancellation.cashAmount)) {
      cashOverflow = true;
      return account;
    }
    processed[cancellationId] = {
      purchaseId,
      cashAmount: Number(cancellation.cashAmount),
      chestCount: Number(cancellation.chestCount),
      processedAt: now,
    };
    const inventoryPurchase = inventoryTx.snapshot.val()?.purchases?.[purchaseId] || {};
    purchases[purchaseId] = {
      ...purchase,
      status: Number(inventoryPurchase.remainingChestCount) === 0
        ? (Number(inventoryPurchase.openedChestCount) > 0 ? "completed" : "cancelled")
        : "partially-cancelled",
      remainingChestCount: nonNegativeInteger(inventoryPurchase.remainingChestCount),
      openedChestCount: nonNegativeInteger(inventoryPurchase.openedChestCount),
      cancelledChestCount: nonNegativeInteger(inventoryPurchase.cancelledChestCount),
      cancelledCashAmount: nonNegativeInteger(inventoryPurchase.cancelledCashAmount),
      cancellations: { ...(purchase.cancellations || {}), [cancellationId]: processed[cancellationId] },
    };
    return {
      ...account,
      balanceCash: balance + Number(cancellation.cashAmount),
      processedChestCancellations: processed,
      treasureChestPurchases: purchases,
    };
  }, undefined, false);
  if (missingPurchase) throw new HttpsError("failed-precondition", "캐시 구매 원장을 찾을 수 없습니다. 관리자 확인이 필요합니다.");
  if (cashOverflow) throw new HttpsError("failed-precondition", "캐시 잔액 한도를 초과해 취소 환급을 완료할 수 없습니다.");
  if (!refundTx.committed) throw new HttpsError("aborted", "캐시 반환을 완료하지 못했습니다. 같은 취소 요청 번호로 다시 시도해 주세요.");

  await sharedDatabase.ref(`${WALLET_ROOT}/ledger/${uid}/${cancellationId}_treasureChestCancellation`).set({
    kind: "treasureChestCancellation",
    requestId: cancellationId,
    purchaseId,
    productId: "treasureChest",
    chestCount: Number(cancellation.chestCount),
    cashAmount: Number(cancellation.cashAmount),
    amountKrw: Number(cancellation.cashAmount) * 100,
    balanceDelta: Number(cancellation.cashAmount),
    createdAt: Number(cancellation.requestedAt) || now,
    createdByUid: uid,
  });
  await inventoryRef.child(`cancellations/${cancellationId}`).update({ walletCredited: true, creditedAt: now });
  const latest = await getChestCounts(marketDatabase, uid, marketContext.accountPath(uid));
  const result = {
    ok: true,
    cancellationId,
    purchaseId,
    itemType,
    chestCount: Number(cancellation.chestCount),
    cashAmount: Number(cancellation.cashAmount),
    balanceCash: nonNegativeInteger(refundTx.snapshot.val()?.balanceCash),
    totalChestCount: latest.totalChestCount,
  };
  await completeMarketOperation(operation.ref, { requestHash: operation.requestHash, result });
  await writeMarketAudit(marketDatabase, `chest_cancel_${cancellationId}`, {
    kind: "treasure-chest-cancellation", uid, purchaseId, cancellationId,
    cashAmount: Number(cancellation.cashAmount),
  });
  return result;
  } catch (error) {
    await failMarketOperation(operation.ref, { requestHash: operation.requestHash, error });
    throw error;
  }
});

async function getChestCounts(db, uid, accountPath = `users/${uid}`) {
  const [legacySnap, inventorySnap] = await Promise.all([
    db.ref(`${accountPath}/treasureChests`).get(),
    db.ref(`${CHEST_INVENTORY_ROOT}/${uid}`).get(),
  ]);
  const legacyChestCount = nonNegativeInteger(legacySnap.val());
  const purchasedChestCount = inventoryChestCount(inventorySnap.val() || {});
  return { legacyChestCount, purchasedChestCount, totalChestCount: legacyChestCount + purchasedChestCount };
}

/**
 * Existing aggregate chest balances are treated as the oldest stock because their
 * original acquisition order is unavailable. Cash purchases follow by server sequence.
 */
async function consumeOldestChest(db, uid, accountPath = `users/${uid}`) {
  const legacyRef = db.ref(`${accountPath}/treasureChests`);
  const legacyBefore = (await legacyRef.get()).val();
  if (nonNegativeInteger(legacyBefore) > 0) {
    let legacyUnavailable = false;
    const legacyTx = await legacyRef.transaction((current) => {
      const count = nonNegativeInteger(current === null ? legacyBefore : current);
      if (count < 1) { legacyUnavailable = true; return; }
      return count - 1;
    }, undefined, false);
    if (legacyTx.committed) return { source: "legacy" };
    if (!legacyUnavailable) throw new HttpsError("aborted", "기존 보물상자를 차감하지 못했습니다. 다시 시도해 주세요.");
  }

  const inventoryRef = db.ref(`${CHEST_INVENTORY_ROOT}/${uid}`);
  let consumed;
  let missingChest = false;
  const inventoryTx = await inventoryRef.transaction((value) => {
    consumed = null;
    missingChest = false;
    if (value === null) return null;
    const inventory = value && typeof value === "object" ? value : {};
    const purchases = inventory.purchases && typeof inventory.purchases === "object"
      ? { ...inventory.purchases } : {};
    const ordered = Object.values(purchases).sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
    for (const purchase of ordered) {
      const groups = Array.isArray(purchase.bundleGroups) ? purchase.bundleGroups.map((group) => ({ ...group })) : [];
      const groupIndex = groups.findIndex((group) => !group.cancelled && nonNegativeInteger(group.remaining) > 0);
      const nextPurchase = { ...purchase };
      if (groupIndex >= 0) {
        groups[groupIndex].remaining = nonNegativeInteger(groups[groupIndex].remaining) - 1;
        groups[groupIndex].openedCount = nonNegativeInteger(groups[groupIndex].openedCount) + 1;
        nextPurchase.bundleGroups = groups;
        consumed = { source: "cash", purchaseId: purchase.purchaseId, itemType: "bundle", itemIndex: groupIndex };
      } else if (nonNegativeInteger(purchase.singleRemaining) > 0) {
        nextPurchase.singleRemaining = nonNegativeInteger(purchase.singleRemaining) - 1;
        consumed = { source: "cash", purchaseId: purchase.purchaseId, itemType: "single" };
      } else {
        continue;
      }
      nextPurchase.openedChestCount = nonNegativeInteger(purchase.openedChestCount) + 1;
      nextPurchase.remainingChestCount =
        groups.reduce((sum, group) => sum + nonNegativeInteger(group.remaining), 0)
        + nonNegativeInteger(nextPurchase.singleRemaining);
      purchases[purchase.purchaseId] = nextPurchase;
      return { ...inventory, purchases };
    }
    missingChest = true;
    return;
  }, undefined, false);
  if (missingChest || !inventoryTx.committed || !consumed) {
    throw new HttpsError("failed-precondition", "보유한 보물상자가 없습니다.");
  }
  return consumed;
}

/** 계정 보호 로그인 이용자가 본인 보물상자만 개봉한다. */
const openTreasureChest = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const { sharedDatabase, marketDatabase, marketContext } = await getChestContext();
  const uid = await requireChestUser(sharedDatabase, request);
  await requireNotInMaintenance(sharedDatabase, request.auth);

  const accountPath = marketContext.accountPath(uid);
  const consumed = await consumeOldestChest(marketDatabase, uid, accountPath);
  const isBig = Math.random() < TREASURE_CHEST_OPEN_BIG_RATE;
  const reward = isBig ? TREASURE_CHEST_REWARD_BIG : TREASURE_CHEST_REWARD_SMALL;
  await creditUserCash(marketDatabase, uid, reward, { accountPath });
  await marketDatabase.ref("treasureChestOpens").push({
    uid,
    reward,
    isBig,
    openedAt: Date.now(),
    source: consumed.source,
    ...(consumed.purchaseId ? { purchaseId: consumed.purchaseId } : {}),
    ...(Number.isInteger(consumed.itemIndex) ? { bundleGroupIndex: consumed.itemIndex } : {}),
  });
  const counts = await getChestCounts(marketDatabase, uid, accountPath);
  return { ok: true, reward, isBig, remaining: counts.totalChestCount, source: consumed.source };
});

async function actionListTreasureChestRequests(db) {
  const { marketDatabase } = await getChestContext(db);
  const snap = await marketDatabase.ref("treasureChestRequests").get();
  const data = snap.val() || {};
  const requests = Object.entries(data)
    .map(([id, value]) => ({ id, ...value }))
    .filter((value) => value.status === "pending")
    .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));
  return { ok: true, requests };
}

async function actionApproveTreasureChestRequest(db, { requestId }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");
  const { marketDatabase, marketContext } = await getChestContext(db);

  const reqSnap = await marketDatabase.ref(`treasureChestRequests/${requestId}`).get();
  if (!reqSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  const reqData = reqSnap.val();
  if (reqData.status !== "pending") {
    throw new HttpsError("failed-precondition", "이미 처리된 신청입니다.");
  }

  const chestRef = marketContext.accountRef(reqData.requesterUid).child("treasureChests");
  await chestRef.transaction((current) => (current || 0) + (reqData.totalChestCount || 0));

  await marketDatabase.ref(`treasureChestRequests/${requestId}`).update({
    status: "approved",
    reviewedAt: Date.now(),
  });

  return { ok: true, totalChestCount: reqData.totalChestCount || 0 };
}

async function actionRejectTreasureChestRequest(db, { requestId }) {
  if (!requestId) throw new HttpsError("invalid-argument", "requestId가 필요합니다.");
  const { marketDatabase } = await getChestContext(db);
  const requestRef = marketDatabase.ref(`treasureChestRequests/${requestId}`);
  const requestSnap = await requestRef.get();
  if (!requestSnap.exists()) throw new HttpsError("not-found", "신청 내역을 찾을 수 없습니다.");
  if (requestSnap.val().status !== "pending") throw new HttpsError("failed-precondition", "이미 처리된 신청입니다.");
  await requestRef.update({ status: "rejected", reviewedAt: Date.now() });
  return { ok: true };
}

module.exports = {
  submitTreasureChestPurchaseRequest,
  claimMonthlyFreeTreasureChest,
  getAdminTreasureChestState,
  purchaseTreasureChestsWithCash,
  cancelTreasureChestCashPurchase,
  openTreasureChest,
  actionListTreasureChestRequests,
  actionApproveTreasureChestRequest,
  actionRejectTreasureChestRequest,
  computeChestPurchase,
  inventoryChestCount,
  consumeOldestChest,
};
