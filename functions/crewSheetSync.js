const crypto = require("node:crypto");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  parseCrewRosterCsv,
  parseSpreadsheetUrl,
  validateIntervalHours,
  planCrewRosterSync,
  listValue,
} = require("./crewSheetSyncCore");

const ROOT = "stockMarket/adminCrewSheetSync";
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const LOCK_TTL_MS = 3 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15 * 1000;
const MAX_CSV_BYTES = 2 * 1024 * 1024;

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function acquireLock(db) {
  const lockRef = db.ref(`${ROOT}/lock`);
  const token = crypto.randomUUID();
  const now = Date.now();
  const result = await lockRef.transaction((current) => {
    if (current?.expiresAt > now) return;
    return { token, expiresAt: now + LOCK_TTL_MS };
  });
  if (!result.committed) throw new HttpsError("aborted", "크루 동기화가 이미 실행 중입니다. 잠시 후 다시 시도해주세요.");
  return async () => {
    await lockRef.transaction((current) => current?.token === token ? null : undefined);
  };
}

async function fetchRoster(sheetUrl) {
  const { exportUrl } = parseSpreadsheetUrl(sheetUrl);
  const response = await fetch(exportUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`시트 읽기 실패 (${response.status}). 공개 열람 권한과 시트 주소를 확인해주세요.`);
  const csv = await response.text();
  if (Buffer.byteLength(csv, "utf8") > MAX_CSV_BYTES) throw new Error("시트 내보내기 파일이 너무 큽니다.");
  return parseCrewRosterCsv(csv);
}

async function getInputs(db) {
  const [stockSnap, stateSnap] = await Promise.all([
    db.ref("stocks").get(),
    db.ref(`${ROOT}/state`).get(),
  ]);
  const stocks = stockSnap.val() || {};
  const state = stateSnap.val() || {};
  const inputHash = digest({
    names: Object.fromEntries(Object.entries(stocks).map(([id, stock]) => [id, stock?.name || null]).sort(([a], [b]) => a.localeCompare(b))),
    initialized: !!state.initialized,
    snapshot: state.snapshot || [],
    absenceStreaks: state.absenceStreaks || [],
  });
  return { stocks, state, inputHash };
}

function summarizePlan(plan, roster) {
  return {
    appliedCount: plan.updates.length,
    assignedCount: plan.updates.filter((item) => item.type === "crew-added").length,
    movedCount: plan.updates.filter((item) => item.type === "crew-changed").length,
    removedCount: plan.updates.filter((item) => item.type === "crew-removed").length,
    alreadyMatchedCount: plan.alreadyMatchedCount,
    reviewCount: plan.reviews.length,
    pendingRemovalCount: plan.pendingRemovals.length,
    memberCount: roster.length,
  };
}

async function applyStockNameChanges(db, changes) {
  for (let offset = 0; offset < changes.length; offset += 20) {
    const batch = changes.slice(offset, offset + 20);
    const results = await Promise.all(batch.map(async (change) => {
      const nameRef = db.ref(`stocks/${change.stockId}/name`);
      const result = await nameRef.transaction((currentName) => {
        if (currentName === change.after) return currentName;
        if (currentName !== change.before) return;
        return change.after;
      });
      return { change, committed: result.committed, currentName: result.snapshot.val() };
    }));
    const conflict = results.find(({ change, currentName }) => currentName !== change.after);
    if (conflict) {
      throw new HttpsError("failed-precondition", `적용 중 '${conflict.change.nickname}' 종목명이 바뀌었습니다. 일부 안전한 변경은 반영됐을 수 있으니 다시 미리보기해주세요.`);
    }
  }
}

async function actionGetCrewSheetSyncStatus(db) {
  const [settingsSnap, stateSnap, statusSnap] = await Promise.all([
    db.ref(`${ROOT}/settings`).get(),
    db.ref(`${ROOT}/state`).get(),
    db.ref(`${ROOT}/status`).get(),
  ]);
  const settings = settingsSnap.val() || {};
  const state = stateSnap.val() || {};
  const status = statusSnap.val() || {};
  return {
    ok: true,
    settings: {
      sheetUrl: settings.sheetUrl || "",
      intervalHours: Number(settings.intervalHours || 6),
      enabled: !!settings.enabled,
      updatedAt: settings.updatedAt || null,
    },
    initialized: !!state.initialized,
    status: {
      ...status,
      reviewItems: listValue(status.reviewItems),
      pendingRemovalItems: listValue(status.pendingRemovalItems),
    },
  };
}

async function actionSaveCrewSheetSyncSettings(db, payload) {
  const sheetUrl = String(payload.sheetUrl || "").trim();
  if (sheetUrl.length > 2048) throw new HttpsError("invalid-argument", "시트 주소가 너무 깁니다.");
  try {
    parseSpreadsheetUrl(sheetUrl);
  } catch (error) {
    throw new HttpsError("invalid-argument", error.message);
  }
  let intervalHours;
  try {
    intervalHours = validateIntervalHours(payload.intervalHours);
  } catch (error) {
    throw new HttpsError("invalid-argument", error.message);
  }
  const enabled = payload.enabled === true;
  const [stateSnap, settingsSnap] = await Promise.all([
    db.ref(`${ROOT}/state`).get(),
    db.ref(`${ROOT}/settings`).get(),
  ]);
  const previousSettings = settingsSnap.val() || {};
  const previousState = stateSnap.val() || {};
  const sourceChanged = !!previousSettings.sheetUrl && previousSettings.sheetUrl !== sheetUrl;
  if (enabled && (!previousState.initialized || sourceChanged)) {
    throw new HttpsError("failed-precondition", "첫 미리보기를 확인하고 적용해 기준 스냅샷을 만든 뒤 자동 동기화를 켜주세요.");
  }
  const now = Date.now();
  const updates = {
    [`${ROOT}/settings`]: { sheetUrl, intervalHours, enabled, updatedAt: now },
    [`${ROOT}/preview`]: null,
    [`${ROOT}/status/nextRunAt`]: enabled ? now + intervalHours * 60 * 60 * 1000 : null,
  };
  if (sourceChanged) {
    updates[`${ROOT}/state/initialized`] = false;
    updates[`${ROOT}/state/snapshot`] = null;
    updates[`${ROOT}/state/absenceStreaks`] = null;
    updates[`${ROOT}/state/initializedAt`] = null;
    updates[`${ROOT}/state/lastSourceHash`] = null;
    updates[`${ROOT}/status/nextRunAt`] = null;
  }
  await db.ref().update(updates);
  return { ok: true, settings: { sheetUrl, intervalHours, enabled } };
}

async function actionPreviewCrewSheetSync(db, auth) {
  const release = await acquireLock(db);
  try {
    await db.ref(`${ROOT}/preview`).remove();
    const settingsSnap = await db.ref(`${ROOT}/settings`).get();
    const settings = settingsSnap.val() || {};
    if (!settings.sheetUrl) throw new HttpsError("failed-precondition", "먼저 시트 주소와 주기를 저장해주세요.");
    const sheet = await fetchRoster(settings.sheetUrl);
    const { stocks, state, inputHash } = await getInputs(db);
    const plan = planCrewRosterSync({
      roster: sheet.roster,
      stocks,
      previousSnapshot: state.snapshot || [],
      absenceStreaks: state.absenceStreaks || [],
      initialized: !!state.initialized,
    });
    const previewId = crypto.randomUUID();
    const preview = {
      previewId,
      createdAt: Date.now(),
      createdByUid: auth?.uid || null,
      sheetUrl: settings.sheetUrl,
      sourceHash: digest(sheet.roster),
      inputHash,
    };
    await db.ref(`${ROOT}/preview`).set(preview);
    return {
      ok: true,
      previewId,
      firstRun: !state.initialized,
      crews: sheet.crews.map(({ crewName, expectedCount, members }) => ({ crewName, memberCount: members.length, expectedCount })),
      actions: plan.updates,
      reviews: plan.reviews,
      pendingRemovals: plan.pendingRemovals,
      summary: summarizePlan(plan, sheet.roster),
      expiresAt: preview.createdAt + PREVIEW_TTL_MS,
    };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("failed-precondition", error.message || "시트 미리보기에 실패했습니다.");
  } finally {
    await release();
  }
}

async function applyRoster(db, { sheetUrl, roster, trigger, authUid = null, previewId = null, expectedInputHash = null, requireEnabled = false }) {
  const { stocks, state, inputHash } = await getInputs(db);
  if (expectedInputHash && inputHash !== expectedInputHash) {
    throw new HttpsError("failed-precondition", "종목 또는 동기화 기준이 미리보기 뒤 바뀌었습니다. 다시 미리보기해주세요.");
  }
  const wasInitialized = !!state.initialized;
  const plan = planCrewRosterSync({
    roster,
    stocks,
    previousSnapshot: state.snapshot || [],
    absenceStreaks: state.absenceStreaks || [],
    initialized: wasInitialized,
  });
  const now = Date.now();
  const settingsSnap = await db.ref(`${ROOT}/settings`).get();
  const settings = settingsSnap.val() || {};
  if (settings.sheetUrl !== sheetUrl || (requireEnabled && !settings.enabled)) {
    throw new HttpsError("failed-precondition", "동기화 설정이 바뀌었습니다. 다시 시도해주세요.");
  }
  const updates = {
    [`${ROOT}/state/initialized`]: true,
    [`${ROOT}/state/snapshot`]: plan.nextSnapshot,
    [`${ROOT}/state/absenceStreaks`]: plan.nextAbsenceStreaks,
    [`${ROOT}/state/initializedAt`]: state.initializedAt || now,
    [`${ROOT}/state/lastSourceHash`]: digest(roster),
    [`${ROOT}/status/lastAttemptAt`]: now,
    [`${ROOT}/status/lastSuccessAt`]: now,
    [`${ROOT}/status/lastResult`]: "success",
    [`${ROOT}/status/lastError`]: null,
    [`${ROOT}/status/lastTrigger`]: trigger,
    [`${ROOT}/status/lastActorUid`]: authUid,
    [`${ROOT}/status/appliedCount`]: plan.updates.length,
    [`${ROOT}/status/reviewCount`]: plan.reviews.length,
    [`${ROOT}/status/pendingRemovalCount`]: plan.pendingRemovals.length,
    [`${ROOT}/status/reviewItems`]: plan.reviews,
    [`${ROOT}/status/pendingRemovalItems`]: plan.pendingRemovals,
    [`${ROOT}/status/crewCount`]: new Set(roster.map((item) => item.crewName)).size,
    [`${ROOT}/status/memberCount`]: roster.length,
    [`${ROOT}/status/nextRunAt`]: settings.enabled ? now + Number(settings.intervalHours || 6) * 60 * 60 * 1000 : null,
  };
  await applyStockNameChanges(db, plan.updates);
  if (previewId) updates[`${ROOT}/preview`] = null;
  await db.ref().update(updates);
  return { ok: true, ...summarizePlan(plan, roster), initialized: true, nextRunAt: updates[`${ROOT}/status/nextRunAt`] };
}

async function actionApplyCrewSheetSyncPreview(db, payload, auth) {
  const release = await acquireLock(db);
  try {
    const previewSnap = await db.ref(`${ROOT}/preview`).get();
    const preview = previewSnap.val();
    if (!preview || preview.previewId !== String(payload.previewId || "")) {
      throw new HttpsError("failed-precondition", "미리보기가 만료되었거나 다른 미리보기로 바뀌었습니다. 다시 미리보기해주세요.");
    }
    if (preview.createdByUid !== auth?.uid) throw new HttpsError("permission-denied", "미리보기를 만든 관리자만 적용할 수 있습니다.");
    if (Date.now() - preview.createdAt > PREVIEW_TTL_MS) throw new HttpsError("deadline-exceeded", "미리보기가 만료되었습니다. 다시 미리보기해주세요.");
    const settingsSnap = await db.ref(`${ROOT}/settings`).get();
    const settings = settingsSnap.val() || {};
    if (settings.sheetUrl !== preview.sheetUrl) throw new HttpsError("failed-precondition", "시트 설정이 바뀌었습니다. 다시 미리보기해주세요.");
    const sheet = await fetchRoster(settings.sheetUrl);
    if (digest(sheet.roster) !== preview.sourceHash) throw new HttpsError("failed-precondition", "미리보기 뒤 시트 내용이 바뀌었습니다. 다시 미리보기해주세요.");
    const inputs = await getInputs(db);
    if (inputs.inputHash !== preview.inputHash) throw new HttpsError("failed-precondition", "미리보기 뒤 종목 또는 동기화 기준이 바뀌었습니다. 다시 미리보기해주세요.");
    return await applyRoster(db, {
      sheetUrl: settings.sheetUrl,
      roster: sheet.roster,
      trigger: "manual",
      authUid: auth.uid,
      previewId: preview.previewId,
      expectedInputHash: preview.inputHash,
    });
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", error.message || "크루 시트 적용에 실패했습니다.");
  } finally {
    await release();
  }
}

const syncCrewRosterFromSheet = onSchedule({ schedule: "every 15 minutes", timeZone: "Asia/Seoul", timeoutSeconds: 120, memory: "512MiB" }, async () => {
  const db = admin.database();
  const release = await acquireLock(db);
  try {
    const [settingsSnap, stateSnap, statusSnap] = await Promise.all([
      db.ref(`${ROOT}/settings`).get(),
      db.ref(`${ROOT}/state`).get(),
      db.ref(`${ROOT}/status`).get(),
    ]);
    const settings = settingsSnap.val() || {};
    const state = stateSnap.val() || {};
    const status = statusSnap.val() || {};
    const now = Date.now();
    if (!settings.enabled || !state.initialized || !settings.sheetUrl || !status.nextRunAt || status.nextRunAt > now) return;

    const sheet = await fetchRoster(settings.sheetUrl);
    await applyRoster(db, { sheetUrl: settings.sheetUrl, roster: sheet.roster, trigger: "scheduled", requireEnabled: true });
  } catch (error) {
    const now = Date.now();
    const latestSettings = (await db.ref(`${ROOT}/settings`).get()).val() || {};
    await db.ref(`${ROOT}/status`).update({
      lastAttemptAt: now,
      lastResult: "failed",
      lastError: String(error?.message || error).slice(0, 500),
      lastTrigger: "scheduled",
      nextRunAt: latestSettings.enabled ? now + 60 * 60 * 1000 : null,
    });
    console.error("Crew sheet sync failed", error);
    throw error;
  } finally {
    await release();
  }
});

module.exports = {
  actionGetCrewSheetSyncStatus,
  actionSaveCrewSheetSyncSettings,
  actionPreviewCrewSheetSync,
  actionApplyCrewSheetSyncPreview,
  syncCrewRosterFromSheet,
};
