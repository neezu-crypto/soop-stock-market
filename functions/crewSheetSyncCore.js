const ALLOWED_INTERVAL_HOURS = Object.freeze([1, 6, 12, 24]);
const CREW_HEADER = /^\s*(.+?)\s*[（(]\s*(\d+)\s*[）)]\s*$/u;

function parseCsv(text) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function normalizeNickname(value) {
  return String(value || "").replace(/^[\s👑]+|[\s👑]+$/gu, "").trim();
}

function parseCrewRosterCsv(csvText) {
  const rows = parseCsv(csvText);
  const headersByRow = new Map();
  const crews = [];

  rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      const match = String(value || "").match(CREW_HEADER);
      if (!match) return;
      const crewName = match[1].trim();
      const expectedCount = Number(match[2]);
      if (!crewName || !Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 500) {
        throw new Error(`시트 ${rowIndex + 1}행의 크루 인원 표기를 확인해주세요.`);
      }
      const header = { rowIndex, columnIndex, crewName, expectedCount };
      const rowHeaders = headersByRow.get(rowIndex) || [];
      rowHeaders.push(header);
      headersByRow.set(rowIndex, rowHeaders);
      crews.push(header);
    });
  });

  if (!crews.length) throw new Error("크루명(인원수) 형식의 제목을 찾지 못했습니다.");
  const crewNames = new Set();
  for (const crew of crews) {
    if (crewNames.has(crew.crewName)) throw new Error(`시트에 '${crew.crewName}' 제목이 중복되어 있습니다.`);
    crewNames.add(crew.crewName);
  }

  for (const crew of crews) {
    const sameRowHeaders = headersByRow.get(crew.rowIndex).sort((a, b) => a.columnIndex - b.columnIndex);
    const nextHeader = sameRowHeaders.find((header) => header.columnIndex > crew.columnIndex);
    // 현재 시트는 한 크루 블록이 8개 열 너비다. 이 범위를 벗어난 셀은
    // 메모/사진 영역일 수 있으므로 닉네임으로 오인하지 않는다.
    const endColumn = Math.min(nextHeader?.columnIndex ?? Infinity, crew.columnIndex + 9);
    let endRow = rows.length;
    for (let rowIndex = crew.rowIndex + 1; rowIndex < rows.length; rowIndex++) {
      if (headersByRow.has(rowIndex)) {
        endRow = rowIndex;
        break;
      }
    }

    const members = [];
    for (let rowIndex = crew.rowIndex + 1; rowIndex < endRow; rowIndex++) {
      for (let columnIndex = crew.columnIndex + 1; columnIndex < endColumn; columnIndex++) {
        const nickname = normalizeNickname(rows[rowIndex][columnIndex]);
        if (nickname) members.push(nickname);
      }
    }
    if (members.length !== crew.expectedCount && members.length - 1 !== crew.expectedCount) {
      throw new Error(
        `${crew.crewName}: 제목은 ${crew.expectedCount}명인데 목록은 ${members.length}개(수장 제외 ${members.length - 1}명)입니다. 시트를 확인한 뒤 다시 미리보기해주세요.`,
      );
    }
    crew.leaderNickname = members[0];
    crew.members = members.slice(1);
  }

  const assignments = new Map();
  const upperCrewName = "감컴퍼니";
  for (const crew of crews) {
    const leader = crew.leaderNickname;
    const existing = assignments.get(leader);
    if (existing && existing.crewName !== upperCrewName) {
      throw new Error(`수장 '${leader}' 닉네임이 다른 크루 멤버와 중복되어 있습니다.`);
    }
    assignments.set(leader, { nickname: leader, crewName: upperCrewName });
  }
  for (const crew of crews) {
    for (const nickname of crew.members) {
      const existing = assignments.get(nickname);
      // 여러 크루를 맡은 수장, 또는 시트에 별도 표시된 감컴퍼니 멤버는
      // 상위 크루 배정을 중복으로 만들지 않는다.
      if (existing?.crewName === upperCrewName && crew.crewName === upperCrewName) continue;
      if (existing) throw new Error(`'${nickname}' 닉네임이 둘 이상의 크루에 있습니다.`);
      assignments.set(nickname, { nickname, crewName: crew.crewName });
    }
  }
  const roster = [...assignments.values()];
  return {
    crews: crews.map(({ crewName, expectedCount, leaderNickname, members }) => ({
      crewName,
      expectedCount,
      leaderNickname,
      members,
      sourceListedCount: members.length + 1,
    })),
    roster,
  };
}

function parseSpreadsheetUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch (_error) {
    throw new Error("Google 스프레드시트 주소를 입력해주세요.");
  }
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com") {
    throw new Error("https://docs.google.com 스프레드시트 주소만 사용할 수 있습니다.");
  }
  const match = url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})\//);
  if (!match) throw new Error("스프레드시트 주소에서 문서 ID를 확인할 수 없습니다.");
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  const gid = url.searchParams.get("gid") || hashParams.get("gid") || "0";
  if (!/^\d+$/.test(gid)) throw new Error("시트 탭 번호(gid)가 올바르지 않습니다.");
  return {
    spreadsheetId: match[1],
    gid,
    exportUrl: `https://docs.google.com/spreadsheets/d/${match[1]}/gviz/tq?tqx=out:csv&gid=${gid}`,
  };
}

function validateIntervalHours(value) {
  const hours = Number(value);
  if (!ALLOWED_INTERVAL_HOURS.includes(hours)) {
    throw new Error("동기화 주기는 1, 6, 12, 24시간 중에서 선택해주세요.");
  }
  return hours;
}

function splitStockName(name) {
  const currentName = String(name || "").trim();
  const match = currentName.match(/^\[([^\]]+)\]\s*(.+)$/u);
  return match
    ? { crewName: match[1].trim(), nickname: match[2].trim() }
    : { crewName: null, nickname: currentName };
}

function listValue(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.keys(value).sort((a, b) => Number(a) - Number(b)).map((key) => value[key]);
}

function stableSnapshot(entries) {
  return [...listValue(entries)]
    .filter((entry) => entry && entry.nickname && entry.crewName && entry.stockId)
    .map((entry) => ({ nickname: String(entry.nickname), crewName: String(entry.crewName), stockId: String(entry.stockId) }))
    .sort((a, b) => a.nickname.localeCompare(b.nickname, "ko"));
}

function planCrewRosterSync({ roster, stocks, previousSnapshot = [], absenceStreaks = [], initialized = false }) {
  const stockData = stocks && typeof stocks === "object" ? stocks : {};
  const byNickname = new Map();
  for (const [stockId, stock] of Object.entries(stockData)) {
    if (!stock || typeof stock.name !== "string") continue;
    const parsed = splitStockName(stock.name);
    if (!parsed.nickname) continue;
    const items = byNickname.get(parsed.nickname) || [];
    items.push({ stockId, currentName: stock.name, currentCrew: parsed.crewName });
    byNickname.set(parsed.nickname, items);
  }

  const previous = new Map(stableSnapshot(previousSnapshot).map((entry) => [entry.nickname, entry]));
  const streaks = new Map(listValue(absenceStreaks)
    .filter((entry) => entry && entry.nickname && Number(entry.count) > 0)
    .map((entry) => [String(entry.nickname), Number(entry.count)]));
  const currentNames = new Set(roster.map((entry) => entry.nickname));
  const updates = [];
  const reviews = [];
  const pendingRemovals = [];
  const nextSnapshot = new Map();
  const nextStreaks = new Map();
  let alreadyMatchedCount = 0;

  for (const member of roster) {
    const matches = byNickname.get(member.nickname) || [];
    const old = previous.get(member.nickname);
    if (matches.length === 0) {
      reviews.push({ nickname: member.nickname, crewName: member.crewName, reason: "종목을 찾지 못함" });
      if (old) nextSnapshot.set(member.nickname, old);
      continue;
    }
    if (matches.length > 1) {
      reviews.push({ nickname: member.nickname, crewName: member.crewName, reason: "같은 닉네임의 종목이 여러 개" });
      if (old) nextSnapshot.set(member.nickname, old);
      continue;
    }

    const stock = matches[0];
    const desiredName = `[${member.crewName}] ${member.nickname}`;
    if (stock.currentName !== desiredName) {
      updates.push({ stockId: stock.stockId, nickname: member.nickname, crewName: member.crewName, before: stock.currentName, after: desiredName, type: stock.currentCrew ? "crew-changed" : "crew-added" });
    } else {
      alreadyMatchedCount++;
    }
    nextSnapshot.set(member.nickname, { nickname: member.nickname, crewName: member.crewName, stockId: stock.stockId });
  }

  if (initialized) {
    for (const [nickname, old] of previous) {
      if (currentNames.has(nickname) || nextSnapshot.has(nickname)) continue;
      const stock = stockData[old.stockId];
      if (!stock || typeof stock.name !== "string") continue;
      const expectedOldName = `[${old.crewName}] ${nickname}`;
      const sameNicknameStocks = byNickname.get(nickname) || [];
      if (sameNicknameStocks.length !== 1 || sameNicknameStocks[0].stockId !== old.stockId) {
        reviews.push({ nickname, crewName: old.crewName, reason: "같은 닉네임의 종목이 여러 개" });
        nextSnapshot.set(nickname, old);
        continue;
      }
      if (stock.name !== expectedOldName) {
        reviews.push({ nickname, crewName: old.crewName, reason: "시트와 다르게 종목명이 변경됨" });
        continue;
      }
      const missingRuns = (streaks.get(nickname) || 0) + 1;
      if (missingRuns >= 2) {
        updates.push({ stockId: old.stockId, nickname, crewName: old.crewName, before: stock.name, after: nickname, type: "crew-removed" });
      } else {
        nextSnapshot.set(nickname, old);
        nextStreaks.set(nickname, missingRuns);
        pendingRemovals.push({ nickname, crewName: old.crewName, missingRuns, requiredRuns: 2 });
      }
    }
  } else {
    for (const entry of previous.values()) nextSnapshot.set(entry.nickname, entry);
  }

  for (const entry of roster) nextStreaks.delete(entry.nickname);
  return {
    updates,
    reviews,
    pendingRemovals,
    alreadyMatchedCount,
    nextSnapshot: stableSnapshot([...nextSnapshot.values()]),
    nextAbsenceStreaks: [...nextStreaks.entries()].map(([nickname, count]) => ({ nickname, count })).sort((a, b) => a.nickname.localeCompare(b.nickname, "ko")),
    initialized: true,
  };
}

module.exports = {
  ALLOWED_INTERVAL_HOURS,
  parseCsv,
  parseCrewRosterCsv,
  parseSpreadsheetUrl,
  validateIntervalHours,
  splitStockName,
  listValue,
  stableSnapshot,
  planCrewRosterSync,
};
