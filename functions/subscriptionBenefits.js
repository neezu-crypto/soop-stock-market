const { createHash } = require("node:crypto");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { isAdmin, assertNotBanned } = require("./common");

const SUBSCRIPTION_PATH = "streamerFanPageViewerSubscriptions";
const BENEFIT_PATH = "stockSubscriptionBenefits";
const SUBSCRIPTION_PAYMENT_METHOD = "subscription-entitlement";
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const APPROVAL_LEASE_MS = 60 * 1000;
const CHEST_CLAIM_LEASE_MS = 60 * 1000;

const BENEFITS = Object.freeze({
  banner: { limit: 7, unit: "일", usageField: "bannerDaysUsed", requestPath: "bannerRequests", label: "우측 랭킹 배너" },
  chartBanner: { limit: 7, unit: "일", usageField: "chartBannerDaysUsed", requestPath: "chartBannerRequests", label: "차트 하단 배너" },
  cardBanner: { limit: 7, unit: "일", usageField: "cardBannerDaysUsed", requestPath: "cardBannerRequests", label: "종목 카드 배너" },
  pin: { limit: 12, unit: "시간", usageField: "pinHoursUsed", requestPath: "pinRequests", label: "최상단 고정 노출" },
  relayRoom: { limit: 8, unit: "시간", usageField: "relayHoursUsed", requestPath: "relayRoomRequests", label: "중계방 홍보" },
});

function kstMonthKey(now = Date.now()) {
  const kst = new Date(now + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, "0")}`;
}

function nextKstMonthStart(now = Date.now()) {
  const kst = new Date(now + 9 * 60 * 60 * 1000);
  return Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth() + 1, 1) - 9 * 60 * 60 * 1000;
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestFingerprint(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

async function getSubscriptionExpiry(db, uid) {
  const snap = await db.ref(`${SUBSCRIPTION_PATH}/${uid}/expiresAt`).get();
  return Number(snap.val()) || 0;
}

function getBenefitView(account = {}, subscriptionExpiresAt = 0, now = Date.now(), adminEligible = false) {
  const month = kstMonthKey(now);
  const benefits = {};
  Object.entries(BENEFITS).forEach(([key, definition]) => {
    const used = Math.max(0, Number(account[definition.usageField]) || 0);
    benefits[key] = {
      label: definition.label,
      unit: definition.unit,
      limit: definition.limit,
      used,
      remaining: Math.max(0, definition.limit - used),
    };
  });
  const chestClaim = account.treasureChestClaim || null;
  const active = subscriptionExpiresAt > now;
  return {
    month,
    resetsAt: nextKstMonthStart(now),
    eligible: active || adminEligible,
    adminEligible,
    subscriptionExpiresAt,
    benefits,
    treasureChest: {
      limit: 1,
      claimed: chestClaim?.status === "granted",
      pending: chestClaim?.status === "reserved",
    },
  };
}

function isSubscriptionEntitlementRequest(requestData) {
  return requestData?.paymentMethod === SUBSCRIPTION_PAYMENT_METHOD;
}

function isSubscriptionApprovalRetryable(requestData, now = Date.now()) {
  return requestData?.status === "pending" ||
    (requestData?.status === "approving" && Number(requestData.approvalLeaseUntil) <= now);
}

function isRequestActionable(requestData, now = Date.now()) {
  if (requestData?.status === "pending") return true;
  if (!isSubscriptionEntitlementRequest(requestData)) return false;
  return isSubscriptionApprovalRetryable(requestData, now) ||
    (requestData?.status === "rejecting" && Number(requestData.rejectionLeaseUntil) <= now);
}

async function reserveMonthlyBenefit(db, {
  uid,
  product,
  units,
  requestId,
  requestData,
  auth,
  now = Date.now(),
}) {
  const definition = BENEFITS[product];
  if (!definition) throw new HttpsError("invalid-argument", "구독 이용권 종류가 올바르지 않습니다.");
  if (!Number.isInteger(units) || units < 1 || units > definition.limit) {
    throw new HttpsError("invalid-argument", `이용권은 1~${definition.limit}${definition.unit}까지 신청할 수 있습니다.`);
  }

  const [subscriptionExpiresAt, adminEligible] = await Promise.all([
    getSubscriptionExpiry(db, uid),
    isAdmin(db, uid, auth?.token?.email),
  ]);
  if (subscriptionExpiresAt <= now && !adminEligible) {
    throw new HttpsError("failed-precondition", "활성 통합 구독이 필요합니다. 구독 인증 상태를 확인해주세요.");
  }

  const id = String(requestId || db.ref(definition.requestPath).push().key || "");
  if (!REQUEST_ID_RE.test(id)) {
    throw new HttpsError("invalid-argument", "신청 식별자가 올바르지 않습니다. 새로고침 후 다시 시도해주세요.");
  }

  const month = kstMonthKey(now);
  const accountRef = db.ref(`${BENEFIT_PATH}/${uid}/${month}`);
  const fingerprint = requestFingerprint({ product, units, requestData });
  const storedRequest = {
    ...requestData,
    starBalloons: 0,
    status: "pending",
    requestedAt: now,
    requesterUid: uid,
    paymentMethod: SUBSCRIPTION_PAYMENT_METHOD,
    benefitMonth: month,
    benefitProduct: product,
    benefitUnits: units,
    benefitUnit: definition.unit,
    benefitSource: adminEligible ? "admin" : "subscription",
    refundStatus: "not-applicable",
  };

  let insufficient = false;
  let conflictingRequest = false;
  const tx = await accountRef.transaction((current) => {
    const account = current || {};
    const requests = account.requests || {};
    const existing = requests[id];
    if (existing) {
      conflictingRequest = existing.fingerprint !== fingerprint;
      return;
    }
    const used = Math.max(0, Number(account[definition.usageField]) || 0);
    insufficient = used + units > definition.limit;
    if (insufficient) return;

    return {
      ...account,
      [definition.usageField]: used + units,
      requests: {
        ...requests,
        [id]: {
          fingerprint,
          product,
          units,
          benefitMonth: month,
          requestPath: definition.requestPath,
          requestPayload: storedRequest,
          status: "reserved",
          reservedAt: now,
        },
      },
    };
  });

  const account = tx.snapshot.val() || {};
  const reservation = account.requests?.[id];
  if (conflictingRequest) {
    throw new HttpsError("already-exists", "이 신청 번호는 다른 내용으로 이미 사용됐습니다. 다시 시도해주세요.");
  }
  if (!reservation && insufficient) {
    const used = Math.max(0, Number(account[definition.usageField]) || 0);
    throw new HttpsError("resource-exhausted", `이번 달 ${definition.label} 이용권이 부족합니다. 잔여 ${Math.max(0, definition.limit - used)}${definition.unit}입니다.`);
  }
  if (!reservation) throw new HttpsError("aborted", "구독 이용권을 예약하지 못했습니다. 다시 시도해주세요.");
  if (!["reserved", "submitted"].includes(reservation.status)) {
    throw new HttpsError("failed-precondition", "이 신청 번호는 이미 처리됐습니다. 신청 상태를 새로 확인해주세요.");
  }

  const requestRef = db.ref(`${reservation.requestPath}/${id}`);
  let requestCollision = false;
  const requestTx = await requestRef.transaction((current) => {
    if (!current) return reservation.requestPayload;
    const isSameRequest = current.requesterUid === uid &&
      isSubscriptionEntitlementRequest(current) &&
      current.benefitMonth === month &&
      current.benefitProduct === product;
    requestCollision = !isSameRequest;
    return;
  });
  if (requestCollision || !requestTx.snapshot.val()) {
    await returnMonthlyBenefit(db, id, storedRequest, now);
    await accountRef.child(`requests/${id}`).remove();
    throw new HttpsError("already-exists", "신청 번호가 이미 사용됐습니다. 다시 신청해주세요.");
  }

  if (reservation.status === "reserved") {
    await accountRef.child(`requests/${id}`).update({ status: "submitted", submittedAt: now });
  }

  const view = getBenefitView(account, subscriptionExpiresAt, now, adminEligible);
  return {
    ok: true,
    id,
    benefitMonth: month,
    benefitProduct: product,
    benefitUnits: units,
    remaining: view.benefits[product].remaining,
    unit: definition.unit,
  };
}

async function reconcileReservedRequests(db, uid, month, account) {
  const entries = Object.entries(account?.requests || {}).filter(([, entry]) => entry?.status === "reserved");
  for (const [id, entry] of entries) {
    if (!entry.requestPath || !entry.requestPayload || entry.benefitMonth !== month) continue;
    const requestRef = db.ref(`${entry.requestPath}/${id}`);
    let collision = false;
    const tx = await requestRef.transaction((current) => {
      if (!current) return entry.requestPayload;
      collision = current.requesterUid !== uid || !isSubscriptionEntitlementRequest(current) || current.benefitMonth !== month;
      return;
    });
    if (!collision && tx.snapshot.val()) {
      await db.ref(`${BENEFIT_PATH}/${uid}/${month}/requests/${id}`).update({ status: "submitted", submittedAt: Date.now() });
    }
  }
  return (await db.ref(`${BENEFIT_PATH}/${uid}/${month}`).get()).val() || {};
}

async function getStockSubscriptionBenefits(db, uid, now = Date.now(), adminEligible = false) {
  const [expiresAt, accountSnap] = await Promise.all([
    getSubscriptionExpiry(db, uid),
    db.ref(`${BENEFIT_PATH}/${uid}/${kstMonthKey(now)}`).get(),
  ]);
  const account = await reconcileReservedRequests(db, uid, kstMonthKey(now), accountSnap.val() || {});
  return getBenefitView(account, expiresAt, now, adminEligible);
}

const getStockSubscriptionBenefitsCallable = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const db = admin.database();
  await assertNotBanned(db, request.auth);
  const adminEligible = await isAdmin(db, uid, request.auth.token?.email);
  return { ok: true, ...(await getStockSubscriptionBenefits(db, uid, Date.now(), adminEligible)) };
});

async function returnMonthlyBenefit(db, requestId, requestData, now = Date.now()) {
  if (!isSubscriptionEntitlementRequest(requestData)) return null;
  const definition = BENEFITS[requestData.benefitProduct];
  const units = Number(requestData.benefitUnits) || 0;
  const uid = requestData.requesterUid;
  const month = String(requestData.benefitMonth || "");
  if (!definition || !uid || !REQUEST_ID_RE.test(String(requestId || "")) || units < 1) {
    throw new HttpsError("failed-precondition", "구독 이용권 반환 정보가 올바르지 않습니다.");
  }

  const currentMonth = kstMonthKey(now);
  const accountRef = db.ref(`${BENEFIT_PATH}/${uid}/${month}`);
  let outcome = null;
  const tx = await accountRef.transaction((current) => {
    const account = current || {};
    const requests = account.requests || {};
    const entry = requests[requestId];
    if (!entry) return;
    if (entry.refundStatus) {
      outcome = { status: entry.refundStatus, units: Number(entry.refundUnits) || 0 };
      return;
    }
    const expired = month !== currentMonth;
    const returnedUnits = expired ? 0 : units;
    outcome = { status: expired ? "expired" : "returned", units: returnedUnits };
    const nextAccount = {
      ...account,
      requests: {
        ...requests,
        [requestId]: {
          ...entry,
          status: "rejected",
          refundStatus: outcome.status,
          refundUnits: returnedUnits,
          refundedAt: now,
        },
      },
    };
    if (returnedUnits > 0) {
      nextAccount[definition.usageField] = Math.max(0, (Number(account[definition.usageField]) || 0) - returnedUnits);
    }
    return nextAccount;
  });

  if (!outcome) {
    const entry = tx.snapshot.val()?.requests?.[requestId];
    if (entry?.refundStatus) outcome = { status: entry.refundStatus, units: Number(entry.refundUnits) || 0 };
  }
  if (!outcome) throw new HttpsError("failed-precondition", "신청 이용권 기록을 찾을 수 없어 반환을 완료하지 못했습니다.");
  return outcome;
}

async function rejectSubscriptionRequest(db, requestPath, requestId, requestData, now = Date.now()) {
  if (!isSubscriptionEntitlementRequest(requestData)) {
    if (requestData.status === "approved") throw new HttpsError("failed-precondition", "이미 승인된 신청은 거절할 수 없습니다.");
    if (requestData.status === "rejected") return { ok: true, alreadyProcessed: true, refundStatus: "not-applicable", refundUnits: 0 };
    await db.ref(`${requestPath}/${requestId}`).update({ status: "rejected", reviewedAt: now });
    return { ok: true, refundStatus: "not-applicable", refundUnits: 0 };
  }

  const requestRef = db.ref(`${requestPath}/${requestId}`);
  const lockTx = await requestRef.transaction((current) => {
    if (!current || current.status === "approved" || current.status === "rejected") return;
    if (current.status === "approving" && Number(current.approvalLeaseUntil) > now) return;
    if (current.status === "rejecting" && Number(current.rejectionLeaseUntil) > now) return;
    if (current.status === "pending" || current.status === "approving" || current.status === "rejecting") {
      return { ...current, status: "rejecting", approvalLeaseUntil: null, rejectionLeaseUntil: now + APPROVAL_LEASE_MS };
    }
    return;
  });
  const currentRequest = lockTx.snapshot.val();
  if (currentRequest?.status === "approved") {
    throw new HttpsError("failed-precondition", "이미 승인된 신청은 거절할 수 없습니다.");
  }
  if (currentRequest?.status === "rejected") {
    return { ok: true, alreadyProcessed: true, refundStatus: currentRequest.refundStatus, refundUnits: currentRequest.refundUnits || 0 };
  }
  if (currentRequest?.status === "approving") {
    throw new HttpsError("aborted", "신청 승인 처리가 진행 중입니다. 잠시 후 다시 확인해주세요.");
  }
  if (!lockTx.committed && currentRequest?.status === "rejecting") {
    throw new HttpsError("aborted", "신청 거절 처리가 진행 중입니다. 잠시 후 다시 확인해주세요.");
  }
  if (currentRequest?.status !== "rejecting") {
    throw new HttpsError("failed-precondition", "이미 처리됐거나 거절할 수 없는 신청입니다.");
  }

  let refund;
  try {
    refund = await returnMonthlyBenefit(db, requestId, currentRequest, now);
  } catch (error) {
    await requestRef.transaction((current) => current?.status === "rejecting"
      ? { ...current, status: "pending", rejectionLeaseUntil: null }
      : undefined);
    throw error;
  }
  await db.ref(`${requestPath}/${requestId}`).update({
    status: "rejected",
    reviewedAt: now,
    approvalLeaseUntil: null,
    rejectionLeaseUntil: null,
    refundStatus: refund.status,
    refundUnits: refund.units,
    refundNote: refund.status === "expired" ? "신청 월 이용권이 만료되어 반환되지 않았습니다." : "같은 달 이용권으로 반환했습니다.",
  });
  return { ok: true, refundStatus: refund.status, refundUnits: refund.units };
}

async function commitSubscriptionApproval(db, requestPath, requestId, requestData, updates, now = Date.now()) {
  if (!isSubscriptionEntitlementRequest(requestData)) {
    await db.ref().update(updates);
    return { alreadyProcessed: false };
  }

  const requestRef = db.ref(`${requestPath}/${requestId}`);
  const lockTx = await requestRef.transaction((current) => {
    if (!current) return;
    if (isSubscriptionApprovalRetryable(current, now)) {
      return { ...current, status: "approving", approvalLeaseUntil: now + APPROVAL_LEASE_MS, rejectionLeaseUntil: null };
    }
    return;
  });
  const currentRequest = lockTx.snapshot.val();
  if (!lockTx.committed) {
    if (currentRequest?.status === "approved") return { alreadyProcessed: true, request: currentRequest };
    if (currentRequest?.status === "approving") {
      throw new HttpsError("aborted", "신청 승인 처리가 진행 중입니다. 잠시 후 다시 확인해주세요.");
    }
    throw new HttpsError("failed-precondition", "이미 거절됐거나 처리할 수 없는 신청입니다.");
  }

  try {
    const reservationSnap = await db.ref(`${BENEFIT_PATH}/${currentRequest.requesterUid}/${currentRequest.benefitMonth}/requests/${requestId}`).get();
    const reservation = reservationSnap.val();
    if (reservation?.refundStatus || reservation?.status === "rejected") {
      const refundStatus = reservation.refundStatus || "expired";
      const refundUnits = Number(reservation.refundUnits) || 0;
      await requestRef.update({
        status: "rejected",
        reviewedAt: now,
        approvalLeaseUntil: null,
        rejectionLeaseUntil: null,
        refundStatus,
        refundUnits,
        refundNote: refundStatus === "expired" ? "신청 월 이용권이 만료되어 반환되지 않았습니다." : "같은 달 이용권으로 반환했습니다.",
      });
      throw new HttpsError("failed-precondition", "이미 반환 처리된 이용권 신청입니다. 신청 상태를 새로 확인해주세요.");
    }
    if (!reservation || !["reserved", "submitted"].includes(reservation.status)) {
      throw new HttpsError("aborted", "구독 이용권 예약 상태를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.");
    }
    const expiresAt = await getSubscriptionExpiry(db, currentRequest.requesterUid);
    if (currentRequest.benefitSource !== "admin" && expiresAt <= now) {
      const refund = await returnMonthlyBenefit(db, requestId, currentRequest, now);
      await requestRef.update({
        status: "rejected",
        reviewedAt: now,
        approvalLeaseUntil: null,
        refundStatus: refund.status,
        refundUnits: refund.units,
        refundNote: refund.status === "expired" ? "신청 월 이용권이 만료되어 반환되지 않았습니다." : "같은 달 이용권으로 반환했습니다.",
      });
      throw new HttpsError("failed-precondition", "통합 구독이 만료되어 신청을 거절했습니다. 이용권 반환 상태를 확인해주세요.");
    }
    await db.ref().update({ ...updates, [`${requestPath}/${requestId}/approvalLeaseUntil`]: null });
    return { alreadyProcessed: false };
  } catch (error) {
    if (error?.code !== "functions/failed-precondition" && error?.code !== "failed-precondition") {
      await requestRef.transaction((current) => current?.status === "approving"
        ? { ...current, status: "pending", approvalLeaseUntil: null }
        : undefined);
    }
    throw error;
  }
}

async function rejectExpiredSubscriptionRequest(db, requestPath, requestId, requestData, now = Date.now()) {
  if (!isSubscriptionEntitlementRequest(requestData)) return false;
  if (requestData.benefitSource === "admin") return false;
  if ((await getSubscriptionExpiry(db, requestData.requesterUid)) > now) return false;
  await rejectSubscriptionRequest(db, requestPath, requestId, requestData, now);
  return true;
}

async function claimMonthlyFreeTreasureChest(db, uid, now = Date.now(), auth = null) {
  const adminEligible = await isAdmin(db, uid, auth?.token?.email);
  const month = kstMonthKey(now);
  const claimId = `free-chest-${month}`;
  const accountRef = db.ref(`${BENEFIT_PATH}/${uid}/${month}`);
  let alreadyClaimed = false;
  const accountTx = await accountRef.transaction((current) => {
    const account = current || {};
    const claim = account.treasureChestClaim;
    if (claim?.status === "granted") {
      alreadyClaimed = true;
      return;
    }
    if (claim?.status === "reserved" && Number(claim.leaseUntil) > now) return;
    return {
      ...account,
      treasureChestClaim: { status: "reserved", claimId, requestedAt: now, leaseUntil: now + CHEST_CLAIM_LEASE_MS },
    };
  });

  let account = accountTx.snapshot.val() || {};
  if (alreadyClaimed || account.treasureChestClaim?.status === "granted") {
    const count = Number((await db.ref(`users/${uid}/treasureChests`).get()).val()) || 0;
    return { ok: true, alreadyClaimed: true, month, remaining: count };
  }
  if (!accountTx.committed && account.treasureChestClaim?.status === "reserved") {
    throw new HttpsError("aborted", "무료 보물상자 지급을 처리 중입니다. 잠시 후 다시 확인해주세요.");
  }
  if (account.treasureChestClaim?.claimId !== claimId) {
    throw new HttpsError("aborted", "이번 달 무료 보물상자를 예약하지 못했습니다.");
  }

  const subscriptionExpiresAt = await getSubscriptionExpiry(db, uid);
  if (subscriptionExpiresAt <= now && !adminEligible) {
    // 예약 전에는 활성 구독을 확인하지만, 이 방어 검사는 호출자 외부에서
    // 직접 이 helper를 재사용하는 경우에도 월 무료 지급 기준을 지킨다.
    await accountRef.child("treasureChestClaim").remove();
    throw new HttpsError("failed-precondition", "활성 통합 구독이 필요합니다. 구독 인증 상태를 확인해주세요.");
  }

  const userRef = db.ref(`users/${uid}`);
  let grantAlreadyExists = false;
  const userTx = await userRef.transaction((current) => {
    if (!current) return current;
    const grantIds = current.treasureChestGrantIds || {};
    if (grantIds[claimId]) {
      grantAlreadyExists = true;
      return current;
    }
    return {
      ...current,
      treasureChests: (Number(current.treasureChests) || 0) + 1,
      treasureChestGrantIds: { ...grantIds, [claimId]: now },
    };
  });
  if (!userTx.committed || !userTx.snapshot.val()?.treasureChestGrantIds?.[claimId]) {
    throw new HttpsError("aborted", "무료 보물상자 지급을 완료하지 못했습니다. 다시 시도해주세요.");
  }

  await accountRef.child("treasureChestClaim").update({ status: "granted", grantedAt: now, leaseUntil: null });
  return {
    ok: true,
    alreadyClaimed: grantAlreadyExists,
    month,
    remaining: Number(userTx.snapshot.val()?.treasureChests) || 0,
  };
}

module.exports = {
  BENEFITS,
  BENEFIT_PATH,
  SUBSCRIPTION_PAYMENT_METHOD,
  getSubscriptionExpiry,
  getBenefitView,
  kstMonthKey,
  nextKstMonthStart,
  isSubscriptionEntitlementRequest,
  isSubscriptionApprovalRetryable,
  isRequestActionable,
  reserveMonthlyBenefit,
  getStockSubscriptionBenefits,
  getStockSubscriptionBenefitsCallable,
  returnMonthlyBenefit,
  rejectSubscriptionRequest,
  rejectExpiredSubscriptionRequest,
  commitSubscriptionApproval,
  claimMonthlyFreeTreasureChest,
};
