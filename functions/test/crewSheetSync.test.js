const test = require("node:test");
const assert = require("node:assert/strict");
const {
  actionGetCrewSheetSyncStatus,
  actionSaveCrewSheetSyncSettings,
  actionPreviewCrewSheetSync,
  actionApplyCrewSheetSyncPreview,
} = require("../crewSheetSync");

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function pathParts(path) {
  return String(path || "").split("/").filter(Boolean);
}

class MemoryDatabase {
  constructor(value = {}) { this.value = value; }
  ref(path = "") {
    const db = this;
    const parts = pathParts(path);
    const read = () => parts.reduce((node, key) => node == null ? undefined : node[key], db.value);
    const write = (targetPath, value) => {
      const keys = pathParts(targetPath);
      let node = db.value;
      for (const key of keys.slice(0, -1)) node = node[key] ||= {};
      if (keys.length) {
        if (value == null) delete node[keys.at(-1)];
        else node[keys.at(-1)] = clone(value);
      } else {
        db.value = clone(value) || {};
      }
    };
    return {
      get: async () => ({ val: () => clone(read()), exists: () => read() !== undefined && read() !== null }),
      set: async (value) => write(path, value),
      remove: async () => write(path, null),
      update: async (updates) => {
        if (parts.length) {
          const parent = read() || {};
          for (const [key, value] of Object.entries(updates)) {
            if (value == null) delete parent[key]; else parent[key] = clone(value);
          }
          write(path, parent);
        } else {
          for (const [key, value] of Object.entries(updates)) write(key, value);
        }
      },
      transaction: async (callback) => {
        const next = callback(clone(read()) ?? null);
        if (next === undefined) return { committed: false, snapshot: { val: () => clone(read()) } };
        write(path, next);
        return { committed: true, snapshot: { val: () => clone(read()) } };
      },
    };
  }
}

function rosterCsv(names, titleCount = names.length) {
  const row = Array(21).fill("");
  row[1] = `테스트크루(${titleCount})`;
  const members = Array(21).fill("");
  names.forEach((name, index) => { members[index + 2] = name; });
  return [row, members].map((cells) => cells.map((value) => {
    const text = String(value || "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(",")).join("\n");
}

function makeSheetFetch(csv, identities) {
  const entries = Object.entries(identities || {}).map(([displayLabel, value], index) => {
    const identity = typeof value === "string" ? { nickname: value } : value;
    return {
      displayLabel,
      nickname: identity.nickname,
      stationId: identity.stationId || `streamer${index + 1}`,
      linked: identity.linked !== false,
      synonym: identity.synonym || [displayLabel],
    };
  });
  const html = entries.filter((entry) => entry.linked).map(({ displayLabel, stationId }) => {
    const encodedCell = JSON.stringify(JSON.stringify({
      2: 131075,
      3: [2, displayLabel],
      6: 88,
      24: `https://www.sooplive.com/station/${stationId}`,
    })).slice(1, -1);
    return encodedCell;
  }).join(",");
  const profilesById = new Map(entries.map((entry) => [entry.stationId.toLowerCase(), entry.nickname]));
  const profilesByDisplay = new Map(entries.map((entry) => [entry.displayLabel.trim().toLowerCase(), {
    user_id: entry.stationId.toLowerCase(),
    user_nick: entry.nickname,
    synonym: entry.synonym,
  }]));
  return async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "docs.google.com") {
      const content = url.searchParams.get("output") === "html" ? html : csv;
      return { ok: true, status: 200, text: async () => content };
    }
    if (url.hostname === "sch.sooplive.co.kr") {
      const id = url.searchParams.get("szKeyword").toLowerCase();
      const profile = profilesByDisplay.get(id);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          RESULT: 1,
          DATA: profilesById.has(id)
            ? [{ user_id: id, user_nick: profilesById.get(id) }]
            : profile ? [profile] : [],
        }),
      };
    }
    throw new Error(`Unexpected fetch URL: ${url.hostname}`);
  };
}

function mockSheet(csv, identities) {
  const originalFetch = global.fetch;
  global.fetch = makeSheetFetch(csv, identities);
  return () => { global.fetch = originalFetch; };
}

const auth = { uid: "admin-test-uid" };
const settings = {
  sheetUrl: "https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuvwxyz_123456/edit?gid=0",
  intervalHours: 6,
  enabled: false,
};

test("admin flow previews and applies exact matches, then enables scheduled sync", async () => {
  const db = new MemoryDatabase({ stocks: { alpha: { name: "알파" }, beta: { name: "베타" } } });
  const restoreFetch = mockSheet(rosterCsv(["알파", "베타"]), { 알파: "알파", 베타: "베타" });
  try {
    await actionSaveCrewSheetSyncSettings(db, settings);
    const preview = await actionPreviewCrewSheetSync(db, auth);
    assert.equal(preview.firstRun, true);
    assert.equal(preview.summary.assignedCount, 2);
    assert.equal(db.value.stocks.alpha.name, "알파");
    assert.equal(db.value.stockMarket.adminCrewSheetSync.lock, undefined);
    const result = await actionApplyCrewSheetSyncPreview(db, { previewId: preview.previewId }, auth);
    assert.equal(result.appliedCount, 2);
    assert.equal(db.value.stocks.alpha.name, "[감컴퍼니] 알파");
    assert.equal(db.value.stocks.beta.name, "[테스트크루] 베타");
    assert.equal(db.value.stockMarket.adminCrewSheetSync.state.initialized, true);

    await actionSaveCrewSheetSyncSettings(db, { ...settings, enabled: true });
    const status = await actionGetCrewSheetSyncStatus(db);
    assert.equal(status.settings.enabled, true);
    assert.ok(status.status.nextRunAt > Date.now());
  } finally {
    restoreFetch();
  }
});

test("matches the real SOOP nickname behind a stripped sheet label instead of renaming a similarly named stock", async () => {
  const db = new MemoryDatabase({ stocks: {
    leader: { name: "[감컴퍼니] 수장" },
    canonical: { name: "[테스트크루] 예니_ouo" },
    unrelated: { name: "[YC]예니" },
  } });
  const restoreFetch = mockSheet(rosterCsv(["수장", "예니"]), { 수장: "수장", 예니: "예니_ouo" });
  try {
    await actionSaveCrewSheetSyncSettings(db, settings);
    const preview = await actionPreviewCrewSheetSync(db, auth);
    assert.equal(preview.summary.resolvedIdentityCount, 2);
    assert.equal(preview.summary.alreadyMatchedCount, 2);
    assert.equal(preview.summary.appliedCount, 0);
    assert.equal(preview.actions.some((item) => item.stockId === "unrelated"), false);

    const result = await actionApplyCrewSheetSyncPreview(db, { previewId: preview.previewId }, auth);
    assert.equal(result.appliedCount, 0);
    assert.equal(db.value.stocks.canonical.name, "[테스트크루] 예니_ouo");
    assert.equal(db.value.stocks.unrelated.name, "[YC]예니");
  } finally {
    restoreFetch();
  }
});

test("resolves a label without a sheet link only when SOOP search identifies one exact synonym", async () => {
  const db = new MemoryDatabase({ stocks: {
    leader: { name: "[감컴퍼니] 리더" },
    member: { name: "[테스트크루] 홍타쿠!" },
  } });
  const restoreFetch = mockSheet(rosterCsv(["리더", "홍타쿠"]), {
    리더: "리더",
    홍타쿠: { nickname: "홍타쿠!", linked: false, synonym: ["홍타쿠"] },
  });
  try {
    await actionSaveCrewSheetSyncSettings(db, settings);
    const preview = await actionPreviewCrewSheetSync(db, auth);
    assert.equal(preview.summary.resolvedIdentityCount, 2);
    assert.equal(preview.summary.reviewCount, 0);
    assert.equal(preview.summary.alreadyMatchedCount, 2);
  } finally {
    restoreFetch();
  }
});

test("stale preview and invalid roster never mutate stock names", async () => {
  const db = new MemoryDatabase({ stocks: { alpha: { name: "알파" } } });
  const restoreFetch = mockSheet(rosterCsv(["알파"]));
  try {
    await actionSaveCrewSheetSyncSettings(db, settings);
    const preview = await actionPreviewCrewSheetSync(db, auth);
    global.fetch = makeSheetFetch(rosterCsv(["다른닉"]), { 다른닉: "다른닉" });
    await assert.rejects(
      actionApplyCrewSheetSyncPreview(db, { previewId: preview.previewId }, auth),
      (error) => error.code === "failed-precondition",
    );
    assert.equal(db.value.stocks.alpha.name, "알파");
    assert.equal(db.value.stockMarket.adminCrewSheetSync.state, undefined);

    global.fetch = makeSheetFetch(rosterCsv(["알파"], 2), { 알파: "알파" });
    await assert.rejects(actionPreviewCrewSheetSync(db, auth), /제목은 2명인데 목록은 1개/);
    assert.equal(db.value.stocks.alpha.name, "알파");
  } finally {
    restoreFetch();
  }
});

test("automatic absence confirmation waits two successful applications before removing a prefix", async () => {
  const db = new MemoryDatabase({ stocks: { alpha: { name: "[테스트크루] 알파" }, beta: { name: "[테스트크루] 베타" } } });
  const restoreFetch = mockSheet(rosterCsv(["알파", "베타"]), { 알파: "알파", 베타: "베타" });
  try {
    await actionSaveCrewSheetSyncSettings(db, settings);
    const firstPreview = await actionPreviewCrewSheetSync(db, auth);
    await actionApplyCrewSheetSyncPreview(db, { previewId: firstPreview.previewId }, auth);

    global.fetch = makeSheetFetch(rosterCsv(["알파"]), { 알파: "알파" });
    const secondPreview = await actionPreviewCrewSheetSync(db, auth);
    const firstAbsentResult = await actionApplyCrewSheetSyncPreview(db, { previewId: secondPreview.previewId }, auth);
    assert.equal(firstAbsentResult.pendingRemovalCount, 1);
    assert.equal(db.value.stocks.beta.name, "[테스트크루] 베타");

    const thirdPreview = await actionPreviewCrewSheetSync(db, auth);
    const secondAbsentResult = await actionApplyCrewSheetSyncPreview(db, { previewId: thirdPreview.previewId }, auth);
    assert.equal(secondAbsentResult.removedCount, 1);
    assert.equal(db.value.stocks.beta.name, "베타");
  } finally {
    restoreFetch();
  }
});

test("changing the source sheet resets the baseline without stripping existing crew prefixes", async () => {
  const db = new MemoryDatabase({ stocks: { alpha: { name: "[감컴퍼니] 알파" } } });
  const restoreFetch = mockSheet(rosterCsv(["알파"]), { 알파: "알파" });
  try {
    await actionSaveCrewSheetSyncSettings(db, settings);
    const preview = await actionPreviewCrewSheetSync(db, auth);
    await actionApplyCrewSheetSyncPreview(db, { previewId: preview.previewId }, auth);
    const changedUrl = "https://docs.google.com/spreadsheets/d/zyxwvutsrqponmlkjihgfedcba_654321/edit?gid=7";
    await actionSaveCrewSheetSyncSettings(db, { ...settings, sheetUrl: changedUrl });
    assert.equal(db.value.stockMarket.adminCrewSheetSync.state.initialized, false);
    assert.equal(db.value.stockMarket.adminCrewSheetSync.state.snapshot, undefined);
    assert.equal(db.value.stocks.alpha.name, "[감컴퍼니] 알파");
    await assert.rejects(
      actionSaveCrewSheetSyncSettings(db, { ...settings, sheetUrl: changedUrl, enabled: true }),
      (error) => error.code === "failed-precondition",
    );
  } finally {
    restoreFetch();
  }
});
