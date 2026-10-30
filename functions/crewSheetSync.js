const crypto = require("node:crypto");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  parseCrewRosterCsv,
  parseCrewSheetLinkMap,
  parseSpreadsheetUrl,
  resolveCrewRosterIdentities,
  validateIntervalHours,
  planCrewRosterSync,
  listValue,
} = require("./crewSheetSyncCore");

const ROOT = "stockMarket/adminCrewSheetSync";
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const LOCK_TTL_MS = 3 * 60 * 1000;
const IDENTITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15 * 1000;
const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const SOOP_STREAMER_SEARCH_API = "https://sch.sooplive.co.kr/api.php";
const SOOP_ID_PATTERN = /^[a-z0-9]{2,20}$/i;
const IDENTITY_LOOKUP_ATTEMPTS = 5;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    const releaseResult = await lockRef.transaction((current) => current?.token === token ? null : undefined);
    if (!releaseResult.committed) {
      const latest = (await lockRef.get()).val();
      if (latest?.token === token) {
        console.warn("Crew sheet sync lock transaction did not commit; clearing the unchanged lock token.");
        await lockRef.remove();
      }
    }
  };
}

async function readTextResponse(url, maxBytes, label) {
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", accept: "text/html,application/json,text/csv,*/*" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${label} 읽기 실패 (${response.status}). 공개 열람 권한과 주소를 확인해주세요.`);
  const declaredLength = Number(response.headers?.get?.("content-length") || 0);
  if (declaredLength > maxBytes) throw new Error(`${label} 파일이 너무 큽니다.`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`${label} 파일이 너무 큽니다.`);
  return text;
}

async function soopSearch(query) {
  const params = new URLSearchParams({
    l: "DF",
    m: "bjSearch",
    v: "3.0",
    szOrder: "score",
    szKeyword: String(query || "").trim().toLocaleLowerCase(),
    nPageNo: "1",
    nListCnt: "10",
    w: "webk",
    tab: "bj",
  });
  const response = await fetch(`${SOOP_STREAMER_SEARCH_API}?${params}`, {
    headers: { accept: "application/json, text/plain, */*", "user-agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`SOOP 닉네임 조회 실패 (${response.status}). 잠시 후 다시 시도해주세요.`);
  const payload = await response.json();
  if (Number(payload?.RESULT) !== 1 || !Array.isArray(payload.DATA)) {
    throw new Error("SOOP 닉네임 조회 응답을 확인하지 못했습니다.");
  }
  return payload.DATA;
}

async function lookupNicknameByStationId(stationId) {
  const id = String(stationId || "").trim().toLowerCase();
  if (!SOOP_ID_PATTERN.test(id)) return null;
  for (let attempt = 0; attempt < IDENTITY_LOOKUP_ATTEMPTS; attempt++) {
    try {
      const rows = await soopSearch(id);
      const matches = rows.filter((row) => String(row?.user_id || "").trim().toLowerCase() === id);
      if (matches.length === 1) {
        const row = matches[0];
        const nickname = typeof row.user_nick === "string" && row.user_nick.trim()
          ? row.user_nick.trim()
          : typeof row.station_name === "string" ? row.station_name.trim() : "";
        return nickname ? { nickname, stationId: id } : null;
      }
      if (matches.length > 1 || attempt === IDENTITY_LOOKUP_ATTEMPTS - 1) return null;
    } catch (error) {
      if (attempt === IDENTITY_LOOKUP_ATTEMPTS - 1) throw error;
    }
    await delay(250 * (attempt + 1));
  }
  return null;
}

async function lookupNicknameByDisplayLabel(displayLabel) {
  const query = String(displayLabel || "").trim().normalize("NFC").toLocaleLowerCase();
  for (let attempt = 0; attempt < IDENTITY_LOOKUP_ATTEMPTS; attempt++) {
    try {
      const rows = await soopSearch(displayLabel);
      const candidates = new Map();
      for (const row of rows) {
        const id = String(row?.user_id || "").trim().toLowerCase();
        if (!SOOP_ID_PATTERN.test(id)) continue;
        const nickname = typeof row.user_nick === "string" && row.user_nick.trim()
          ? row.user_nick.trim()
          : typeof row.station_name === "string" ? row.station_name.trim() : "";
        const exactNickname = nickname.normalize("NFC").toLocaleLowerCase() === query;
        const exactSynonym = Array.isArray(row.synonym) && row.synonym.some((item) => String(item || "").trim().normalize("NFC").toLocaleLowerCase() === query);
        if (nickname && (exactNickname || exactSynonym)) candidates.set(id, { nickname, stationId: id });
      }
      if (candidates.size === 1) return [...candidates.values()][0];
      if (candidates.size > 1 || attempt === IDENTITY_LOOKUP_ATTEMPTS - 1) return null;
    } catch (error) {
      if (attempt === IDENTITY_LOOKUP_ATTEMPTS - 1) throw error;
    }
    await delay(250 * (attempt + 1));
  }
  return null;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

function getFreshCachedIdentity(identityCache, stationId, now = Date.now()) {
  const id = String(stationId || "").trim().toLowerCase();
  const cached = identityCache?.[id];
  const checkedAt = Number(cached?.checkedAt);
  if (!SOOP_ID_PATTERN.test(id) || !cached?.nickname || !Number.isFinite(checkedAt)
      || checkedAt > now + 5 * 60 * 1000 || now - checkedAt > IDENTITY_CACHE_TTL_MS) return null;
  return { nickname: String(cached.nickname), stationId: id, fresh: false };
}

async function refreshIdentityCache(db, identityCacheUpdates) {
  if (!Array.isArray(identityCacheUpdates) || !identityCacheUpdates.length) return;
  const checkedAt = Date.now();
  const ref = db.ref(`${ROOT}/identityCache`);
  await ref.transaction((current) => {
    const next = current && typeof current === "object" ? { ...current } : {};
    for (const identity of identityCacheUpdates) {
      const stationId = String(identity.stationId || "").trim().toLowerCase();
      const nickname = String(identity.nickname || "").trim();
      if (SOOP_ID_PATTERN.test(stationId) && nickname) next[stationId] = { nickname, checkedAt };
    }
    return next;
  });
}

async function fetchRoster(sheetUrl, { resolveIdentities = true, identityCache = {} } = {}) {
  const { exportUrl, metadataUrl } = parseSpreadsheetUrl(sheetUrl);
  const [csv, html] = await Promise.all([
    readTextResponse(exportUrl, MAX_CSV_BYTES, "시트 데이터"),
    readTextResponse(metadataUrl, MAX_HTML_BYTES, "시트 닉네임 링크"),
  ]);
  const parsedRoster = parseCrewRosterCsv(csv);
  const linksByNickname = parseCrewSheetLinkMap(html);
  const displayLabels = [...new Set(parsedRoster.roster.map((entry) => entry.nickname))];
  const sourceHash = digest({
    crews: parsedRoster.crews.map(({ crewName, expectedCount, leaderNickname, members }) => ({
      crewName,
      expectedCount,
      leaderNickname,
      members,
    })),
    roster: parsedRoster.roster,
    links: [...displayLabels].sort((a, b) => a.localeCompare(b, "ko")).map((label) => [
      label,
      (linksByNickname.get(label) || []).map(({ stationId }) => stationId).sort(),
    ]),
  });
  if (!resolveIdentities) return { ...parsedRoster, sourceHash };

  const resolvedEntries = await mapWithConcurrency(displayLabels, 3, async (displayLabel) => {
    const links = linksByNickname.get(displayLabel) || [];
    if (links.length > 1) {
      return [displayLabel, { reason: "시트에 같은 표시명의 SOOP 링크가 여러 개" }];
    }
    if (links.length === 1) {
      const cached = getFreshCachedIdentity(identityCache, links[0].stationId);
      try {
        const identity = await lookupNicknameByStationId(links[0].stationId);
        if (identity) return [displayLabel, { ...identity, fresh: true }];
      } catch (error) {
        if (cached) return [displayLabel, cached];
        throw error;
      }
      return [displayLabel, cached || { reason: "SOOP 링크의 실제 닉네임을 확인하지 못함" }];
    }
    const identity = await lookupNicknameByDisplayLabel(displayLabel);
    return [displayLabel, identity ? { ...identity, fresh: true } : { reason: "SOOP 링크가 없거나 실제 닉네임을 하나로 확인하지 못함" }];
  });
  const identityCacheUpdates = resolvedEntries.map(([, identity]) => identity).filter((identity) => identity?.fresh);
  return { ...resolveCrewRosterIdentities(parsedRoster, new Map(resolvedEntries)), sourceHash, identityCacheUpdates };
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

function summarizePlan(plan, roster, sourceMemberCount = roster.length, resolvedIdentityCount = roster.length) {
  return {
    appliedCount: plan.updates.length,
    assignedCount: plan.updates.filter((item) => item.type === "crew-added").length,
    movedCount: plan.updates.filter((item) => item.type === "crew-changed").length,
    removedCount: plan.updates.filter((item) => item.type === "crew-removed").length,
    alreadyMatchedCount: plan.alreadyMatchedCount,
    reviewCount: plan.reviews.length,
    pendingRemovalCount: plan.pendingRemovals.length,
    memberCount: sourceMemberCount,
    resolvedIdentityCount,
  };
}

async function applyStockNameChanges(db, changes) {
  for (const change of changes) {
    // Trades and the simulator transact on the whole stocks/{id} object. Updating
    // only its name child can race with a parent transaction and get overwritten,
    // so change the name inside the same object-level transaction instead.
    const stockRef = db.ref(`stocks/${change.stockId}`);
    const result = await stockRef.transaction((currentStock) => {
      if (!currentStock || typeof currentStock !== "object") return;
      const currentName = typeof currentStock.name === "string" ? currentStock.name : null;
      if (currentName === change.after) return currentStock;
      if (currentName !== change.before) return;
      return { ...currentStock, name: change.after };
    });
    const currentName = result.snapshot.val()?.name || null;
    if (currentName !== change.after) {
      throw new HttpsError("failed-precondition", `적용 중 '${change.nickname}' 종목명이 바뀌었습니다. 일부 안전한 변경은 반영됐을 수 있으니 다시 미리보기해주세요.`);
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
    const identityCache = (await db.ref(`${ROOT}/identityCache`).get()).val() || {};
    const sheet = await fetchRoster(settings.sheetUrl, { identityCache });
    await refreshIdentityCache(db, sheet.identityCacheUpdates);
    const { stocks, state, inputHash } = await getInputs(db);
    const plan = planCrewRosterSync({
      roster: sheet.roster,
      stocks,
      previousSnapshot: state.snapshot || [],
      absenceStreaks: state.absenceStreaks || [],
      initialized: !!state.initialized,
      identityReviews: sheet.identityReviews,
      unresolvedSourceLabels: sheet.unresolvedSourceLabels,
    });
    const previewId = crypto.randomUUID();
    const preview = {
      previewId,
      createdAt: Date.now(),
      createdByUid: auth?.uid || null,
      sheetUrl: settings.sheetUrl,
      sourceHash: sheet.sourceHash,
      inputHash,
      roster: sheet.roster,
      identityReviews: sheet.identityReviews,
      unresolvedSourceLabels: sheet.unresolvedSourceLabels,
      sourceMemberCount: sheet.sourceMemberCount,
      resolvedIdentityCount: sheet.resolvedIdentityCount,
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
      summary: summarizePlan(plan, sheet.roster, sheet.sourceMemberCount, sheet.resolvedIdentityCount),
      expiresAt: preview.createdAt + PREVIEW_TTL_MS,
    };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("failed-precondition", error.message || "시트 미리보기에 실패했습니다.");
  } finally {
    await release();
  }
}

async function applyRoster(db, {
  sheetUrl,
  roster,
  identityReviews = [],
  unresolvedSourceLabels = [],
  sourceMemberCount = roster.length,
  resolvedIdentityCount = roster.length,
  trigger,
  authUid = null,
  previewId = null,
  expectedInputHash = null,
  requireEnabled = false,
}) {
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
    identityReviews,
    unresolvedSourceLabels,
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
    [`${ROOT}/state/lastSourceHash`]: digest({ roster, identityReviews, unresolvedSourceLabels }),
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
    [`${ROOT}/status/memberCount`]: sourceMemberCount,
    [`${ROOT}/status/resolvedIdentityCount`]: resolvedIdentityCount,
    [`${ROOT}/status/nextRunAt`]: settings.enabled ? now + Number(settings.intervalHours || 6) * 60 * 60 * 1000 : null,
  };
  await applyStockNameChanges(db, plan.updates);
  if (previewId) updates[`${ROOT}/preview`] = null;
  await db.ref().update(updates);
  return {
    ok: true,
    ...summarizePlan(plan, roster, sourceMemberCount, resolvedIdentityCount),
    initialized: true,
    nextRunAt: updates[`${ROOT}/status/nextRunAt`],
  };
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
    const sheetSource = await fetchRoster(settings.sheetUrl, { resolveIdentities: false });
    if (sheetSource.sourceHash !== preview.sourceHash) throw new HttpsError("failed-precondition", "미리보기 뒤 시트 내용 또는 방송국 링크가 바뀌었습니다. 다시 미리보기해주세요.");
    if (!Array.isArray(preview.roster) || !Array.isArray(preview.identityReviews) || !Array.isArray(preview.unresolvedSourceLabels)) {
      throw new HttpsError("failed-precondition", "저장된 미리보기 정보가 올바르지 않습니다. 다시 미리보기해주세요.");
    }
    const inputs = await getInputs(db);
    if (inputs.inputHash !== preview.inputHash) throw new HttpsError("failed-precondition", "미리보기 뒤 종목 또는 동기화 기준이 바뀌었습니다. 다시 미리보기해주세요.");
    return await applyRoster(db, {
      sheetUrl: settings.sheetUrl,
      roster: preview.roster,
      identityReviews: preview.identityReviews,
      unresolvedSourceLabels: preview.unresolvedSourceLabels,
      sourceMemberCount: preview.sourceMemberCount,
      resolvedIdentityCount: preview.resolvedIdentityCount,
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
    const [settingsSnap, stateSnap, statusSnap, identityCacheSnap] = await Promise.all([
      db.ref(`${ROOT}/settings`).get(),
      db.ref(`${ROOT}/state`).get(),
      db.ref(`${ROOT}/status`).get(),
      db.ref(`${ROOT}/identityCache`).get(),
    ]);
    const settings = settingsSnap.val() || {};
    const state = stateSnap.val() || {};
    const status = statusSnap.val() || {};
    const now = Date.now();
    if (!settings.enabled || !state.initialized || !settings.sheetUrl || !status.nextRunAt || status.nextRunAt > now) return;

    const sheet = await fetchRoster(settings.sheetUrl, { identityCache: identityCacheSnap.val() || {} });
    await refreshIdentityCache(db, sheet.identityCacheUpdates);
    await applyRoster(db, {
      sheetUrl: settings.sheetUrl,
      roster: sheet.roster,
      identityReviews: sheet.identityReviews,
      unresolvedSourceLabels: sheet.unresolvedSourceLabels,
      sourceMemberCount: sheet.sourceMemberCount,
      resolvedIdentityCount: sheet.resolvedIdentityCount,
      trigger: "scheduled",
      requireEnabled: true,
    });
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
  fetchRoster,
  actionGetCrewSheetSyncStatus,
  actionSaveCrewSheetSyncSettings,
  actionPreviewCrewSheetSync,
  actionApplyCrewSheetSyncPreview,
  syncCrewRosterFromSheet,
};
