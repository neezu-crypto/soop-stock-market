const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseCrewRosterCsv,
  parseSpreadsheetUrl,
  validateIntervalHours,
  planCrewRosterSync,
} = require("../crewSheetSyncCore");

function makeCsv(rows) {
  return rows.map((row) => row.map((value) => {
    const text = String(value || "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(",")).join("\r\n");
}

function grid() {
  return Array.from({ length: 4 }, () => Array(21).fill(""));
}

test("parses side-by-side crew blocks, quoted cells, and leader crown wrappers", () => {
  const rows = grid();
  rows[0][1] = "버컴퍼니(2)";
  rows[0][11] = "홍피스 (1)";
  rows[1][2] = "👑감스트👑";
  rows[1][3] = "유설아,별";
  rows[1][12] = "홍타쿠";
  const parsed = parseCrewRosterCsv(makeCsv(rows));
  assert.deepEqual(parsed.crews.map((crew) => [crew.crewName, crew.expectedCount, crew.members.length]), [
    ["버컴퍼니", 2, 1], ["홍피스", 1, 0],
  ]);
  assert.deepEqual(parsed.roster, [
    { nickname: "감스트", crewName: "감컴퍼니" },
    { nickname: "홍타쿠", crewName: "감컴퍼니" },
    { nickname: "유설아,별", crewName: "버컴퍼니" },
  ]);
});

test("rejects count mismatches and duplicate members instead of producing a partial roster", () => {
  const mismatch = grid();
  mismatch[0][1] = "크루(2)";
  mismatch[1][2] = "한명";
  assert.throws(() => parseCrewRosterCsv(makeCsv(mismatch)), /크루: 제목은 2명인데 목록은 1개\(수장 제외 0명\)/);

  const duplicate = grid();
  duplicate[0][1] = "첫크루(2)";
  duplicate[0][11] = "둘째크루(2)";
  duplicate[1][2] = "첫수장";
  duplicate[1][3] = "중복닉";
  duplicate[1][12] = "둘째수장";
  duplicate[1][13] = "중복닉";
  assert.throws(() => parseCrewRosterCsv(makeCsv(duplicate)), /둘 이상의 크루/);
});

test("treats the first listed name as a GamCompany member while allowing one leader-only count difference", () => {
  const rows = grid();
  rows[0][1] = "로스타시티(1)";
  rows[1][2] = "👑수장👑";
  rows[1][3] = "일반멤버";
  const parsed = parseCrewRosterCsv(makeCsv(rows));
  assert.equal(parsed.crews[0].leaderNickname, "수장");
  assert.deepEqual(parsed.crews[0].members, ["일반멤버"]);
  assert.deepEqual(parsed.roster, [
    { nickname: "수장", crewName: "감컴퍼니" },
    { nickname: "일반멤버", crewName: "로스타시티" },
  ]);
});

test("accepts only Google Sheets links and supported intervals", () => {
  const parsed = parseSpreadsheetUrl("https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuvwxyz_123456/edit#gid=42");
  assert.equal(parsed.gid, "42");
  assert.equal(parsed.exportUrl, "https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuvwxyz_123456/gviz/tq?tqx=out:csv&gid=42");
  assert.throws(() => parseSpreadsheetUrl("https://example.com/spreadsheets/d/abcdefghijklmnopqrstuvwxyz_123456/edit"), /docs.google.com/);
  assert.equal(validateIntervalHours("6"), 6);
  assert.throws(() => validateIntervalHours(3), /1, 6, 12, 24/);
});

test("plans exact matches and crew moves while leaving missing or duplicate stock names for review", () => {
  const plan = planCrewRosterSync({
    roster: [
      { nickname: "Alpha", crewName: "새크루" },
      { nickname: "Beta", crewName: "새크루" },
      { nickname: "Missing", crewName: "새크루" },
      { nickname: "Dup", crewName: "새크루" },
    ],
    stocks: {
      alpha: { name: "Alpha" },
      beta: { name: "[기존크루] Beta" },
      dup1: { name: "Dup" },
      dup2: { name: "[다른크루] Dup" },
    },
  });
  assert.deepEqual(plan.updates.map((item) => [item.stockId, item.after, item.type]), [
    ["alpha", "[새크루] Alpha", "crew-added"],
    ["beta", "[새크루] Beta", "crew-changed"],
  ]);
  assert.equal(plan.reviews.length, 2);
  assert.equal(plan.nextSnapshot.length, 2);
  assert.equal(plan.updates.some((item) => item.type === "newListing"), false);
});

test("removes a prefix only after two successful absences and preserves manual changes", () => {
  const base = {
    roster: [],
    stocks: { a: { name: "[기존크루] 알파" } },
    previousSnapshot: [{ nickname: "알파", crewName: "기존크루", stockId: "a" }],
    initialized: true,
  };
  const first = planCrewRosterSync(base);
  assert.equal(first.updates.length, 0);
  assert.equal(first.pendingRemovals.length, 1);
  const second = planCrewRosterSync({ ...base, previousSnapshot: first.nextSnapshot, absenceStreaks: first.nextAbsenceStreaks });
  assert.deepEqual(second.updates.map((item) => [item.before, item.after, item.type]), [
    ["[기존크루] 알파", "알파", "crew-removed"],
  ]);

  const manual = planCrewRosterSync({ ...base, stocks: { a: { name: "[수동수정] 알파" } } });
  assert.equal(manual.updates.length, 0);
  assert.match(manual.reviews[0].reason, /다르게 종목명이 변경/);
});
