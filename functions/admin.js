const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { requireAdmin, findStockIdByName, bannerStatus, INITIAL_CASH, LEGACY_INITIAL_CASH, LEGACY_INITIAL_CASH_500K, ANON_INITIAL_CASH_TOPUP, DAILY_ATTENDANCE_REWARDS, LOTTERY_POOL_FLOOR, todayKeyKST, creditUserCash, chargeUserCash } = require("./common");
const {
  actionListBannerRequests,
  actionApproveBannerRequest,
  actionRejectBannerRequest,
  actionListChartBannerRequests,
  actionApproveChartBannerRequest,
  actionRejectChartBannerRequest,
} = require("./bannerRequests");
const {
  actionListCashChargeRequests,
  actionApproveCashChargeRequest,
  actionRejectCashChargeRequest,
} = require("./cashCharge");
const {
  actionListPinRequests,
  actionListActivePins,
  actionApprovePinRequest,
  actionRejectPinRequest,
  actionDeletePin,
} = require("./pinRequests");
const {
  actionListRelayRoomRequests,
  actionListActiveRelayRooms,
  actionApproveRelayRoomRequest,
  actionRejectRelayRoomRequest,
  actionDeleteRelayRoom,
} = require("./relayRoom");
const {
  actionListUnfreezeDonationRequests,
  actionApproveUnfreezeDonationRequest,
  actionRejectUnfreezeDonationRequest,
  actionListFrozenStocks,
  actionForceUnfreezeStock,
} = require("./stockFreeze");
const {
  actionListListingRequests,
  actionApproveListingRequest,
  actionRejectListingRequest,
} = require("./listingRequests");
const { pickNewJackpot } = require("./jackpot");

// ══════════════════════════════════════════════════════════
// 관리자 페이지 기능 — 전부 Admin SDK로 처리해 RTDB 규칙의
// 이메일 매칭 없이도 안전하게 동작한다 (아래 각 action 함수 참고)
// ══════════════════════════════════════════════════════════

async function actionUpdateSinglePrice(db, { stockId, price }) {
  if (!stockId) throw new HttpsError("invalid-argument", "stockId가 필요합니다.");
  const newPrice = Math.round(Number(price));
  if (!Number.isFinite(newPrice)) throw new HttpsError("invalid-argument", "정확한 가격을 입력해주세요.");

  const snap = await db.ref(`stocks/${stockId}`).get();
  if (!snap.exists()) throw new HttpsError("not-found", "종목을 찾을 수 없습니다.");
  const stock = snap.val();

  await db.ref().update({
    [`stocks/${stockId}/price`]: newPrice,
  });
  return { ok: true, name: stock.name, price: newPrice };
}

async function actionUpdateStockData(db, { stockId, price, bannerImg, link, bannerEndDate }) {
  if (!stockId) throw new HttpsError("invalid-argument", "stockId가 필요합니다.");
  const newPrice = Math.round(Number(price));
  if (!Number.isFinite(newPrice)) throw new HttpsError("invalid-argument", "가격은 숫자여야 합니다.");

  await db.ref().update({
    [`stocks/${stockId}/price`]:         newPrice,
    [`stocks/${stockId}/bannerImg`]:     String(bannerImg || ""),
    [`stocks/${stockId}/link`]:          String(link || ""),
    [`stocks/${stockId}/bannerEndDate`]: String(bannerEndDate || ""),
  });
  return { ok: true };
}

async function actionAdjustAllPrices(db, { percent }) {
  const pct = Number(percent);
  if (!Number.isFinite(pct)) throw new HttpsError("invalid-argument", "숫자를 입력해주세요.");

  const snap = await db.ref("stocks").get();
  const data = snap.val();
  if (!data) return { ok: true, count: 0 };

  const multiplier = 1 + pct / 100;
  const updates = {};
  Object.keys(data).forEach((id) => {
    const oldPrice = data[id].price;
    const newPrice = Math.round(oldPrice * multiplier);
    updates[`stocks/${id}/price`] = newPrice;
  });
  await db.ref().update(updates);
  return { ok: true, count: Object.keys(data).length };
}

async function actionResetAllPrices(db) {
  const snap = await db.ref("stocks").get();
  const data = snap.val();
  if (!data) return { ok: true, count: 0 };

  const RESET_PRICE = 10000;
  const updates = {};
  Object.keys(data).forEach((id) => {
    updates[`stocks/${id}/price`]  = RESET_PRICE;
    updates[`stocks/${id}/volume`] = 0; // 누적 거래량도 함께 리셋 — 안 지우면 랭킹(top5)에 리셋 이전 거래량이 그대로 남는다
  });
  updates["rankings/top5"] = null; // 위 volume 리셋과 함께 캐시된 랭킹도 비워 다음 거래부터 새로 집계되게 한다
  await db.ref().update(updates);
  return { ok: true, count: Object.keys(data).length };
}

async function actionUploadStocks(db, { names }) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new HttpsError("invalid-argument", "이름을 입력해주세요.");
  }
  const uniqueNames = [...new Set(names.map((n) => String(n).trim()))].filter((n) => n !== "");
  if (uniqueNames.length === 0) throw new HttpsError("invalid-argument", "이름을 입력해주세요.");

  const stocks = {};
  uniqueNames.forEach((name, i) => {
    stocks[`id_${Date.now()}_${i}`] = { name, price: 10000 };
  });
  await db.ref("stocks").update(stocks);
  return { ok: true, count: uniqueNames.length };
}

async function actionDeleteStocks(db, { names }) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new HttpsError("invalid-argument", "삭제할 이름을 입력해주세요.");
  }
  const namesToDelete = names.map((n) => String(n).trim()).filter((n) => n !== "");
  const snap = await db.ref("stocks").get();
  const data = snap.val();
  if (!data) return { ok: true, count: 0 };

  const updates = {};
  let foundCount = 0;
  Object.entries(data).forEach(([id, stock]) => {
    if (namesToDelete.includes(stock.name)) {
      updates[`stocks/${id}`] = null;
      updates[`chartBanner/${id}`] = null; // 종목 삭제 시 연결된 차트 배너도 함께 삭제(orphan 방지)
      foundCount++;
    }
  });
  if (foundCount > 0) await db.ref().update(updates);
  return { ok: true, count: foundCount };
}

async function actionCleanupDuplicateStocks(db) {
  const snap = await db.ref("stocks").get();
  const data = snap.val();
  if (!data) return { ok: true, count: 0 };

  const deleteUpdates = {};
  let duplicateFoundCount = 0;
  const commonTags = ["BJ", "TV", "S2", "H_", "T1", "DK", "공식", "S", "P"];
  const stockList = Object.entries(data)
    .map(([id, stock]) => {
      const name = stock.name.trim();
      let pureName = name;
      commonTags.forEach((tag) => { pureName = pureName.replace(new RegExp(tag, "gi"), ""); });
      pureName = pureName.replace(/[^ㄱ-ㅎ가-힣a-zA-Z0-9]/g, "").toLowerCase();
      return { id, originalName: name, pureName };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  for (let i = 0; i < stockList.length; i++) {
    const master = stockList[i];
    if (deleteUpdates[`stocks/${master.id}`] === null) continue;
    if (master.pureName.length < 2) continue;
    for (let j = i + 1; j < stockList.length; j++) {
      const target = stockList[j];
      if (deleteUpdates[`stocks/${target.id}`] === null) continue;
      let isMatch = false;
      if (master.pureName === target.pureName) isMatch = true;
      else if (target.originalName.includes(master.originalName)) {
        const diffLength = target.originalName.length - master.originalName.length;
        if (diffLength > 0 && diffLength <= 4) isMatch = true;
      }
      if (isMatch && master.pureName !== target.pureName) {
        if (master.originalName.includes("BJ") && target.originalName.includes("BJ")) isMatch = false;
      }
      if (isMatch) {
        deleteUpdates[`stocks/${target.id}`] = null;
        deleteUpdates[`chartBanner/${target.id}`] = null; // 종목 삭제 시 연결된 차트 배너도 함께 삭제(orphan 방지)
        duplicateFoundCount++;
      }
    }
  }

  if (duplicateFoundCount > 0) await db.ref().update(deleteUpdates);
  return { ok: true, count: duplicateFoundCount };
}

/**
 * 우측 랭킹 배너(stocks/{id})와 차트 하단 배너(chartBanner/{id})를 한데 모아
 * 진행중/만료 목록으로 분류한다. 관리자 페이지의 통합 배너 관리 탭에서 사용.
 */
async function actionListActiveBanners(db) {
  const [stocksSnap, chartSnap] = await Promise.all([
    db.ref("stocks").get(),
    db.ref("chartBanner").get(),
  ]);
  const stocksData = stocksSnap.val() || {};
  const chartData  = chartSnap.val()  || {};

  const items = [];
  Object.entries(stocksData).forEach(([id, s]) => {
    if (!s.bannerImg) return;
    const { active, daysLeft } = bannerStatus(s.bannerEndDate);
    items.push({
      type: "ranking", stockId: id, name: s.name || id, stockName: s.name || id,
      img: s.bannerImg, link: s.link || "", endDate: s.bannerEndDate || "",
      active, daysLeft,
    });
  });
  Object.entries(stocksData).forEach(([id, s]) => {
    if (!s.cardBannerImg) return;
    const { active, daysLeft } = bannerStatus(s.cardBannerEndDate);
    items.push({
      type: "card", stockId: id, name: s.name || id, stockName: s.name || id,
      img: s.cardBannerImg, link: s.cardBannerLink || "", endDate: s.cardBannerEndDate || "",
      holderUid: s.cardBannerHolderUid || "",
      active, daysLeft,
    });
  });
  Object.entries(chartData).forEach(([id, c]) => {
    // chartBanner는 예전에 전체 종목 공동 노출용 평면 필드(img/link/endDate/name)로
    // 쓰이던 경로라, 과거 잔재가 최상위에 남아있으면 문자열 값이 종목ID처럼
    // 섞여 들어올 수 있다 — 실제 종목별 배너 객체가 아니면 건너뛴다.
    if (!c || typeof c !== "object") return;
    const { active, daysLeft } = bannerStatus(c.endDate);
    // name(광고주 닉네임, 관리자가 자유롭게 수정 가능)과 stockName(실제 종목의
    // 현재 표시명, stocks/{id}.name)을 분리해서 넘긴다 — 닉네임을 나중에
    // 수정해도 "실제 어느 종목에 붙어있는지"는 항상 정확히 알 수 있도록.
    items.push({
      type: "chart", stockId: id,
      name: c.name || (stocksData[id] && stocksData[id].name) || id,
      stockName: (stocksData[id] && stocksData[id].name) || "(삭제된 종목)",
      img: c.img, link: c.link || "", endDate: c.endDate || "",
      active, daysLeft,
    });
  });

  return {
    ok: true,
    active:  items.filter((i) => i.active).sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity)),
    expired: items.filter((i) => !i.active).sort((a, b) => (b.daysLeft ?? -Infinity) - (a.daysLeft ?? -Infinity)),
  };
}

/** 진행중/만료 탭에서 배너 내용을 직접 수정(연장 포함)한다. */
async function actionUpdateBanner(db, { type, stockId, name, img, link, endDate }) {
  if (!stockId) throw new HttpsError("invalid-argument", "stockId가 필요합니다.");
  const bannerImg = String(img || "").trim();
  if (!bannerImg) throw new HttpsError("invalid-argument", "배너 이미지 링크를 입력해주세요.");

  if (type === "chart") {
    await db.ref(`chartBanner/${stockId}`).set({
      name:    String(name || "").trim(),
      img:     bannerImg,
      link:    String(link || "").trim(),
      endDate: String(endDate || "").trim(),
    });
  } else if (type === "card") {
    await db.ref().update({
      [`stocks/${stockId}/cardBannerImg`]:     bannerImg,
      [`stocks/${stockId}/cardBannerLink`]:    String(link || "").trim(),
      [`stocks/${stockId}/cardBannerEndDate`]: String(endDate || "").trim(),
    });
  } else {
    await db.ref().update({
      [`stocks/${stockId}/bannerImg`]:     bannerImg,
      [`stocks/${stockId}/link`]:          String(link || "").trim(),
      [`stocks/${stockId}/bannerEndDate`]: String(endDate || "").trim(),
    });
  }
  return { ok: true };
}

/** 진행중/만료 탭에서 배너를 완전히 제거한다. */
async function actionDeleteBanner(db, { type, stockId }) {
  if (!stockId) throw new HttpsError("invalid-argument", "stockId가 필요합니다.");
  if (type === "chart") {
    await db.ref(`chartBanner/${stockId}`).remove();
  } else if (type === "card") {
    await db.ref().update({
      [`stocks/${stockId}/cardBannerImg`]:       null,
      [`stocks/${stockId}/cardBannerLink`]:      null,
      [`stocks/${stockId}/cardBannerEndDate`]:   null,
      [`stocks/${stockId}/cardBannerHolderUid`]: null,
    });
  } else {
    await db.ref().update({
      [`stocks/${stockId}/bannerImg`]:     null,
      [`stocks/${stockId}/link`]:          null,
      [`stocks/${stockId}/bannerEndDate`]: null,
    });
  }
  return { ok: true };
}

async function calcTop5(db) {
  const [usersSnap, stocksSnap] = await Promise.all([
    db.ref("users").get(),
    db.ref("stocks").get(),
  ]);
  const usersData  = usersSnap.val()  || {};
  const stocksData = stocksSnap.val() || {};
  const ownership  = {};
  Object.values(usersData).forEach((user) => {
    if (!user.stocks) return;
    Object.entries(user.stocks).forEach(([stockId, info]) => {
      const qty = parseInt(info.qty) || 0;
      if (qty > 0) ownership[stockId] = (ownership[stockId] || 0) + qty;
    });
  });
  return Object.entries(ownership)
    .map(([id, totalQty]) => {
      const stock = stocksData[id] || {};
      return { id, name: stock.name || id, price: stock.price || 0, totalQty };
    })
    .sort((a, b) => b.totalQty - a.totalQty)
    .slice(0, 5);
}

async function actionPreviewRankings(db) {
  return { ok: true, top5: await calcTop5(db) };
}

async function actionSaveRankings(db) {
  const top5 = await calcTop5(db);
  const payload = {
    savedAt: new Date().toISOString(),
    items: top5.map((s, i) => ({ rank: i + 1, id: s.id, name: s.name, price: s.price, totalQty: s.totalQty })),
  };
  await db.ref("rankings/top5").set(payload);
  return { ok: true, top5 };
}

function isInactiveUser(user) {
  // 지금 기준(INITIAL_CASH)뿐 아니라 예전 지급 기준들(LEGACY_INITIAL_CASH,
  // LEGACY_INITIAL_CASH_500K)도 함께 봐야 한다 — 여러 차례의 초기 자산 정책
  // 변경 이전에 만들어져 예전 기준만 받고 한 번도 거래하지 않은 계정도
  // "미거래 유저"로 계속 잡아내기 위함.
  const cash = user.cash ?? INITIAL_CASH;
  const isDefaultCash = cash === INITIAL_CASH || cash === LEGACY_INITIAL_CASH || cash === LEGACY_INITIAL_CASH_500K;
  const hasNoStocks   = !user.stocks || Object.keys(user.stocks).length === 0;
  const hasZeroStocks = user.stocks && Object.values(user.stocks).every((s) => (s.qty || 0) === 0);
  return isDefaultCash && (hasNoStocks || hasZeroStocks);
}

async function getInactiveUserIds(db) {
  const snap = await db.ref("users").get();
  const data = snap.val() || {};
  return Object.entries(data)
    .filter(([, user]) => isInactiveUser(user))
    .map(([uid]) => uid);
}

async function actionPreviewInactiveUsers(db) {
  const inactive = await getInactiveUserIds(db);
  return { ok: true, count: inactive.length };
}

async function actionCleanupInactiveUsers(db) {
  const inactive = await getInactiveUserIds(db);
  if (inactive.length === 0) return { ok: true, count: 0 };

  const BATCH = 500;
  for (let i = 0; i < inactive.length; i += BATCH) {
    const batch   = inactive.slice(i, i + BATCH);
    const updates = {};
    batch.forEach((uid) => { updates[`users/${uid}`] = null; });
    await db.ref().update(updates);
  }
  return { ok: true, count: inactive.length };
}

/**
 * 익명 유저 초기자산 보정 — 2026-07 정책 변경(익명 20만원+카카오 80만원 →
 * 익명 50만원+카카오/구글 50만원) 이전에 이미 생성된 익명 유저는 20만원만
 * 받은 상태다. 새로 생성되는 계정은 initializeUser가 이미 새 INITIAL_CASH
 * (50만원)를 지급하므로 손댈 필요 없고, 대상은 "예전 기준으로 이미 만들어졌고
 * 실제로 한 번이라도 거래해본(=진짜 이용한) 아직 미보호(카카오·구글 둘 다
 * 미연동) 익명 유저"로 한정한다 — 한 번도 안 써본 방문성 계정까지 소급
 * 지급할 필요는 없기 때문. 이미 계정 보호된 유저는 예전 기준으로도
 * 20만+80만=100만원을 이미 받았을 것으로 보고 제외한다(정책 변경 이후에야
 * 새로 연동한 극소수 예외는 감안하지 않음). anonTopUpAppliedAt 마커로 중복
 * 지급을 막아, 나중에 다시 실행해도(그 사이 새로 거래를 시작한 유저만)
 * 안전하게 추가로 잡아낼 수 있다.
 */
async function getAnonTopUpEligibleUserIds(db) {
  const snap = await db.ref("users").get();
  const data = snap.val() || {};
  return Object.entries(data)
    .filter(([, user]) => !user.kakaoLinked && !user.googleLinked && user.lastTradeTime && !user.anonTopUpAppliedAt)
    .map(([uid]) => uid);
}

async function actionPreviewAnonTopUp(db) {
  const eligible = await getAnonTopUpEligibleUserIds(db);
  return { ok: true, count: eligible.length, totalCost: eligible.length * ANON_INITIAL_CASH_TOPUP };
}

async function actionApplyAnonTopUp(db) {
  const eligible = await getAnonTopUpEligibleUserIds(db);
  for (const uid of eligible) {
    await creditUserCash(db, uid, ANON_INITIAL_CASH_TOPUP);
    await db.ref(`users/${uid}/anonTopUpAppliedAt`).set(Date.now());
  }
  return { ok: true, count: eligible.length, totalCost: eligible.length * ANON_INITIAL_CASH_TOPUP };
}

// ── 점검모드 ────────────────────────────────────────────────
// 관리자가 실시간으로 켜고 끌 수 있는 "소프트 점검모드". 코드 배포가
// 필요한 LONG_MAINTENANCE(index.html의 전체 화면 차단)와 달리, 페이지는
// 그대로 보여주고 거래·홍보 신청 등 게임 상태를 바꾸는 활동만 클라이언트
// 단에서 막는다. 켜는 즉시 시작하지 않고 30초의 유예를 둬서 지금 막
// 거래 중인 유저가 놀라지 않게 한다.
const MAINTENANCE_COUNTDOWN_MS = 30 * 1000;

async function actionSetMaintenanceMode(db, { active }) {
  const isActive = !!active;
  if (isActive) {
    await db.ref("maintenance").set({
      active:  true,
      startAt: Date.now() + MAINTENANCE_COUNTDOWN_MS,
    });
  } else {
    await db.ref("maintenance").set({ active: false });
  }
  return { ok: true, active: isActive };
}

// ── 잭팟 종목 ────────────────────────────────────────────────
// 정상 운영 중에는 당첨 시 jackpot.js가 자동으로 다음 사이클을 시작하므로
// 관리자가 손댈 일이 거의 없다 — 이 액션은 최초 1회 부트스트랩(잭팟이
// 아직 한 번도 시작 안 됐을 때)이나, 수동으로 종목/목표치를 새로 뽑고
// 싶을 때(예: 특정 종목이 부적절해서 다시 뽑고 싶은 경우)만 사용한다.
async function actionRerollJackpot(db) {
  await pickNewJackpot(db);
  const snap = await db.ref("jackpot/state").get();
  return { ok: true, state: snap.val() };
}

/**
 * 손익 랭킹 조회 — 유저가 "내 손익 랭킹" 확인 시마다 갱신되는
 * rankings/profitEntries를 관리자가 통째로 확인한다. 익명 표시(anonId)
 * 만으로는 어뷰징 의심 계정을 특정할 수 없으므로 uid를 함께 반환한다.
 */
async function actionListProfitRankings(db) {
  const snap = await db.ref("rankings/profitEntries").get();
  const data = snap.val() || {};
  const entries = Object.entries(data)
    .map(([uid, r]) => ({ uid, ...r }))
    .sort((a, b) => (b.value || 0) - (a.value || 0));
  return { ok: true, entries };
}

/**
 * 관리자 페이지 상단 알람용 — 승인 대기(status:"pending") 건수를 섹션별로
 * 집계한다. 각 섹션 패널이 이미 개별적으로 pending 목록을 불러오지만,
 * 페이지 진입 시점에 "지금 뭐가 밀려있는지"를 한눈에 보여주는 용도라
 * 별도로 가볍게 카운트만 뽑는다.
 */
async function actionGetPendingSummary(db) {
  const sections = [
    { key: "banner",      sectionId: "section-banner",      label: "배너 광고",       paths: ["bannerRequests", "chartBannerRequests"] },
    { key: "cashcharge",  sectionId: "section-cashcharge",  label: "자산 충전 신청", paths: ["cashChargeRequests"] },
    { key: "pin",         sectionId: "section-pin",         label: "최상단 고정 노출", paths: ["pinRequests"] },
    { key: "listing",     sectionId: "section-listing",     label: "종목 상장 신청", paths: ["listingRequests"] },
    { key: "relay",       sectionId: "section-relay",       label: "중계방 홍보",     paths: ["relayRoomRequests"] },
    { key: "freeze",      sectionId: "section-freeze",      label: "동결 해제(방송 후원)", paths: ["unfreezeDonationRequests"] },
  ];

  const allPaths = [...new Set(sections.flatMap((s) => s.paths))];
  const snaps = await Promise.all(allPaths.map((p) => db.ref(p).get()));
  const countByPath = {};
  allPaths.forEach((p, i) => {
    const data = snaps[i].val() || {};
    countByPath[p] = Object.values(data).filter((r) => r.status === "pending").length;
  });

  const items = sections.map((s) => ({
    key: s.key,
    sectionId: s.sectionId,
    label: s.label,
    count: s.paths.reduce((sum, p) => sum + countByPath[p], 0),
  }));

  return { ok: true, items, totalCount: items.reduce((sum, i) => sum + i.count, 0) };
}

const PURCHASE_HISTORY_LIMIT = 300; // 오래된 이력까지 매번 전부 내려보내지 않도록 최신 N건만 반환

/**
 * 유저 구매 현황 — 우측/차트/카드 배너·최상단 고정·중계방·플레이타임 충전·복권함처럼
 * 게임자산을 직접 차감해 즉시 적용되는 7가지 셀프 상품의 구매 이력을
 * 한 화면에서 통합 조회한다. 각 기능별 패널은 "신규/진행중/만료"만
 * 보여주도록 설계돼 있어, 시간이 지나 만료·삭제된 과거 구매까지 한눈에
 * 보긴 어려웠던 빈틈을 메운다. (자산 충전은 반대로 "지급"이라 구매가
 * 아니므로, 종목 상장 신청은 무료라 제외 — 각각 별도 패널에서 확인 가능)
 */
async function actionListPurchaseHistory(db) {
  const [bannerSnap, chartBannerSnap, cardBannerSnap, pinSnap, relaySnap, playTimeSnap, lotterySnap] = await Promise.all([
    db.ref("bannerRequests").get(),
    db.ref("chartBannerRequests").get(),
    db.ref("cardBannerRequests").get(),
    db.ref("pinRequests").get(),
    db.ref("relayRoomRequests").get(),
    db.ref("playTimePurchases").get(),
    db.ref("lotteryPurchases").get(),
  ]);

  const purchases = [];

  Object.entries(bannerSnap.val() || {}).forEach(([id, r]) => purchases.push({
    id, type: "banner", typeLabel: "📢 우측 배너",
    label: `${r.nickname || "-"} (${r.days || 0}일)`,
    amount: r.chargedAmount || 0, uid: r.requesterUid, status: r.status,
    at: r.requestedAt || 0,
  }));

  Object.entries(cardBannerSnap.val() || {}).forEach(([id, r]) => purchases.push({
    id, type: "cardBanner", typeLabel: "🎴 종목 카드 배너",
    label: `${r.nickname || "-"} (${r.days || 0}일)`,
    amount: r.chargedAmount || 0, uid: r.requesterUid, status: r.status,
    at: r.requestedAt || 0,
  }));

  Object.entries(chartBannerSnap.val() || {}).forEach(([id, r]) => purchases.push({
    id, type: "chartBanner", typeLabel: "🖼 차트 하단 배너",
    label: `${r.stockName || r.nickname || "-"} (${r.days || 0}일)`,
    amount: r.chargedAmount || 0, uid: r.requesterUid, status: r.status,
    at: r.requestedAt || 0,
  }));

  Object.entries(pinSnap.val() || {}).forEach(([id, r]) => purchases.push({
    id, type: "pin", typeLabel: "📌 최상단 고정",
    label: `${r.stockName || "-"} (${r.hours || 0}시간)`,
    amount: r.chargedAmount || 0, uid: r.requesterUid, status: r.status,
    at: r.requestedAt || 0,
  }));

  Object.entries(relaySnap.val() || {}).forEach(([id, r]) => purchases.push({
    id, type: "relayRoom", typeLabel: "🎥 중계방",
    label: `${r.nickname || "-"} (${r.hours || 0}시간)`,
    amount: r.chargedAmount || 0, uid: r.requesterUid, status: r.status,
    at: r.requestedAt || 0,
  }));

  Object.entries(playTimeSnap.val() || {}).forEach(([id, r]) => purchases.push({
    id, type: "playTime", typeLabel: "⏱ 플레이타임 충전",
    label: `${r.hours || 0}시간`,
    amount: r.chargedAmount || 0, uid: r.uid, status: "approved",
    at: r.purchasedAt || 0,
  }));

  Object.entries(lotterySnap.val() || {}).forEach(([id, r]) => purchases.push({
    id, type: "lottery", typeLabel: "🎟️ 복권함",
    label: r.won ? `🎉 당첨! +${(r.prizeAmount || 0).toLocaleString()}원` : "미당첨",
    amount: r.chargedAmount || 0, uid: r.uid, status: "approved",
    at: r.purchasedAt || 0,
  }));

  purchases.sort((a, b) => b.at - a.at);

  return { ok: true, purchases: purchases.slice(0, PURCHASE_HISTORY_LIMIT), totalCount: purchases.length };
}

// ── 크루 프리픽스 일괄 적용 ──────────────────────────────────
// 크루 닉네임 목록을 상장 종목과 매칭해 [크루명] 프리픽스를 일괄 적용하거나,
// 매칭 안 되는 닉네임은 신규 상장 후보로 표시한다. 정확히 일치하면 자동
// 매칭되고, 끝 장식문자(∀·_·, 등)만 다른 경우는 부분매칭 후보로 보여줘
// 관리자가 직접 고르게 한다 — 이 세션에서 사람이 수작업으로 하던 매칭
// 로직(닉네임 끝 장식문자를 떼고 비교)을 그대로 옮긴 것.
function stripDecoration(name) {
  return String(name || "").replace(/[∀_,.!^~*♡♬★☆●▲◆■♥♪]+$/g, "").trim();
}

async function actionPreviewCrewPrefixMatch(db, { crewName, nicknames }) {
  const crew = String(crewName || "").trim();
  if (!crew) throw new HttpsError("invalid-argument", "크루명을 입력해주세요.");
  const nameList = Array.isArray(nicknames) ? nicknames.map((n) => String(n).trim()).filter(Boolean) : [];
  if (nameList.length === 0) throw new HttpsError("invalid-argument", "닉네임 목록을 입력해주세요.");

  const snap = await db.ref("stocks").get();
  const entries = Object.entries(snap.val() || {}).map(([id, s]) => ({ id, name: s.name || "" }));
  const prefix = `[${crew}] `;

  const results = nameList.map((nickname) => {
    const exact = entries.find((e) => e.name === nickname);
    if (exact) {
      return {
        nickname,
        status: exact.name.startsWith(prefix) ? "already" : "exact",
        candidates: [{ stockId: exact.id, name: exact.name }],
      };
    }
    const base = stripDecoration(nickname);
    const partial = base
      ? entries.filter((e) => {
          const eBase = stripDecoration(e.name);
          return eBase === base || e.name.includes(base) || (base.length >= 2 && base.includes(eBase) && eBase.length >= 2);
        })
      : [];
    if (partial.length > 0) {
      return {
        nickname,
        status: "partial",
        candidates: partial.map((e) => ({ stockId: e.id, name: e.name, alreadyPrefixed: e.name.startsWith(prefix) })),
      };
    }
    return { nickname, status: "notfound", candidates: [] };
  });

  return { ok: true, crewName: crew, results };
}

/**
 * assignments: [{ nickname, action: "prefix"|"newListing"|"skip", stockId? }]
 */
async function actionApplyCrewPrefix(db, { crewName, assignments }) {
  const crew = String(crewName || "").trim();
  if (!crew) throw new HttpsError("invalid-argument", "크루명을 입력해주세요.");
  if (!Array.isArray(assignments) || assignments.length === 0) {
    throw new HttpsError("invalid-argument", "적용할 항목이 없습니다.");
  }

  const prefix  = `[${crew}] `;
  const updates = {};
  let prefixedCount = 0;
  let listedCount   = 0;
  let idx = 0;

  for (const a of assignments) {
    if (a.action === "prefix" && a.stockId) {
      const nameSnap     = await db.ref(`stocks/${a.stockId}/name`).get();
      const currentName  = nameSnap.val();
      if (currentName && !currentName.startsWith(prefix)) {
        updates[`stocks/${a.stockId}/name`] = `${prefix}${currentName}`;
        prefixedCount++;
      }
    } else if (a.action === "newListing") {
      const nickname = String(a.nickname || "").trim();
      if (nickname) {
        updates[`stocks/id_${Date.now()}_crew${idx}`] = { name: `${prefix}${nickname}`, price: 10000 };
        listedCount++;
        idx++;
      }
    }
    // action === "skip"은 아무 것도 하지 않는다.
  }

  if (Object.keys(updates).length > 0) {
    await db.ref().update(updates);
  }
  return { ok: true, prefixedCount, listedCount };
}

// ── 공지 배너 ────────────────────────────────────────────────
// 점검모드와 별개로, 관리자가 자유 문구를 지갑 카드 아래에 띄웠다 내렸다
// 할 수 있는 기능. maintenance와 동일하게 공개 읽기 전용 경로(announcement)에
// 쓰기만 Admin SDK로 처리한다.
async function actionSetAnnouncement(db, { active, text }) {
  const isActive = !!active;
  const trimmed  = String(text || "").trim();
  if (isActive && !trimmed) {
    throw new HttpsError("invalid-argument", "공지 문구를 입력해주세요.");
  }
  await db.ref("announcement").set({
    active: isActive,
    text:   trimmed,
    updatedAt: Date.now(),
  });
  return { ok: true, active: isActive, text: trimmed };
}

// ── 출석 보상 현황 ───────────────────────────────────────────
// 개별 클레임 로그는 남기지 않고 users/{uid}.lastAttendanceDate/attendanceStreak만
// 갱신되므로, "오늘 몇 명이 받았고 총 얼마가 나갔는지"는 전체 유저를 스캔해
// lastAttendanceDate가 오늘인 사람만 집계해서 구한다.
async function actionGetAttendanceStats(db) {
  const today = todayKeyKST();
  const snap  = await db.ref("users").get();
  const data  = snap.val() || {};

  let claimedCount   = 0;
  let totalPaidToday = 0;
  const streakBuckets = {};

  Object.values(data).forEach((user) => {
    if (user.lastAttendanceDate !== today) return;
    claimedCount++;
    const streak = Math.min(Math.max(user.attendanceStreak || 1, 1), DAILY_ATTENDANCE_REWARDS.length);
    totalPaidToday += DAILY_ATTENDANCE_REWARDS[streak - 1];
    streakBuckets[streak] = (streakBuckets[streak] || 0) + 1;
  });

  return { ok: true, today, claimedCount, totalPaidToday, streakBuckets };
}

/**
 * 크루가 해체되거나 이름이 바뀌었을 때, [크루명] 프리픽스가 붙은 종목을
 * 한꺼번에 찾아 해제 후보로 보여준다. applyCrewPrefix의 반대 동작.
 */
async function actionPreviewCrewPrefixRemove(db, { crewName }) {
  const crew = String(crewName || "").trim();
  if (!crew) throw new HttpsError("invalid-argument", "크루명을 입력해주세요.");

  const prefix = `[${crew}] `;
  const snap   = await db.ref("stocks").get();
  const data   = snap.val() || {};

  const matches = Object.entries(data)
    .filter(([, s]) => (s.name || "").startsWith(prefix))
    .map(([id, s]) => ({ stockId: id, name: s.name, nameAfter: s.name.slice(prefix.length) }));

  return { ok: true, crewName: crew, matches };
}

/** stockIds: 해제할 종목 id 배열 */
async function actionApplyCrewPrefixRemove(db, { crewName, stockIds }) {
  const crew = String(crewName || "").trim();
  if (!crew) throw new HttpsError("invalid-argument", "크루명을 입력해주세요.");
  if (!Array.isArray(stockIds) || stockIds.length === 0) {
    throw new HttpsError("invalid-argument", "해제할 종목을 선택해주세요.");
  }

  const prefix  = `[${crew}] `;
  const updates = {};
  let removedCount = 0;

  for (const stockId of stockIds) {
    const nameSnap    = await db.ref(`stocks/${stockId}/name`).get();
    const currentName = nameSnap.val();
    if (currentName && currentName.startsWith(prefix)) {
      updates[`stocks/${stockId}/name`] = currentName.slice(prefix.length);
      removedCount++;
    }
  }

  if (Object.keys(updates).length > 0) {
    await db.ref().update(updates);
  }
  return { ok: true, removedCount };
}

// ── 통계 요약 ────────────────────────────────────────────────
// 관리자 페이지 곳곳에 흩어져 있는 통계(출석 보상, 구매 매출, 유저 현황,
// 손익 랭킹 게시 건수)를 한 화면에서 확인할 수 있도록 모아서 반환한다.
async function actionGetOverviewStats(db) {
  const [
    attendance,
    usersSnap,
    bannerSnap, chartBannerSnap, cardBannerSnap, pinSnap, relaySnap, playTimeSnap,
    profitSnap,
    lotterySnap, lotteryPoolSnap,
  ] = await Promise.all([
    actionGetAttendanceStats(db),
    db.ref("users").get(),
    db.ref("bannerRequests").get(),
    db.ref("chartBannerRequests").get(),
    db.ref("cardBannerRequests").get(),
    db.ref("pinRequests").get(),
    db.ref("relayRoomRequests").get(),
    db.ref("playTimePurchases").get(),
    db.ref("rankings/profitEntries").get(),
    db.ref("lotteryPurchases").get(),
    db.ref("lottery/pool").get(),
  ]);

  const today = todayKeyKST();
  const toKSTDateKey = (ms) => new Date((ms || 0) + 9 * 3600 * 1000).toISOString().split("T")[0];

  // 실제로 매출로 잡을 수 있는 건: 승인 완료(approved)된 배너/차트배너/카드배너/고정/중계방
  // 신청 + 즉시 적용되는 플레이타임 충전(별도 status 없이 전부 유효).
  // 자산 충전(지급)·종목 상장(무료)은 성격이 달라 구매 현황과 동일하게 제외한다.
  const revenueEntries = [
    ...Object.values(bannerSnap.val() || {}).filter((r) => r.status === "approved").map((r) => ({ amount: r.chargedAmount || 0, at: r.requestedAt || 0 })),
    ...Object.values(chartBannerSnap.val() || {}).filter((r) => r.status === "approved").map((r) => ({ amount: r.chargedAmount || 0, at: r.requestedAt || 0 })),
    ...Object.values(cardBannerSnap.val() || {}).filter((r) => r.status === "approved").map((r) => ({ amount: r.chargedAmount || 0, at: r.requestedAt || 0 })),
    ...Object.values(pinSnap.val() || {}).filter((r) => r.status === "approved").map((r) => ({ amount: r.chargedAmount || 0, at: r.requestedAt || 0 })),
    ...Object.values(relaySnap.val() || {}).filter((r) => r.status === "approved").map((r) => ({ amount: r.chargedAmount || 0, at: r.requestedAt || 0 })),
    ...Object.values(playTimeSnap.val() || {}).map((r) => ({ amount: r.chargedAmount || 0, at: r.purchasedAt || 0 })),
  ];

  const purchase = revenueEntries.reduce((acc, e) => {
    acc.totalCount++;
    acc.totalRevenue += e.amount;
    if (toKSTDateKey(e.at) === today) {
      acc.todayCount++;
      acc.todayRevenue += e.amount;
    }
    return acc;
  }, { totalCount: 0, totalRevenue: 0, todayCount: 0, todayRevenue: 0 });

  const usersData = usersSnap.val() || {};
  const userList  = Object.values(usersData);
  const users = {
    totalUsers: userList.length,
    protectedUsers: userList.filter((u) => u.kakaoLinked || u.googleLinked).length,
    anonUsers: userList.filter((u) => !u.kakaoLinked && !u.googleLinked).length,
  };

  const profitRankingEntryCount = Object.keys(profitSnap.val() || {}).length;

  // 복권함은 판매액 대부분이 당첨금으로 다시 유저에게 나가는 구조라, 다른
  // 셀프 상품처럼 판매액을 그대로 "매출"에 합산하면 실제보다 부풀려 보인다.
  // 그래서 판매액/지급액/순이익을 별도로 분리해서 보여준다.
  const lotteryEntries = Object.values(lotterySnap.val() || {});
  const lottery = lotteryEntries.reduce((acc, r) => {
    acc.totalSold++;
    acc.totalRevenue += r.chargedAmount || 0;
    if (r.won) { acc.totalWins++; acc.totalPayout += r.prizeAmount || 0; }
    return acc;
  }, { totalSold: 0, totalRevenue: 0, totalWins: 0, totalPayout: 0 });
  lottery.netRevenue = lottery.totalRevenue - lottery.totalPayout;
  lottery.currentPool = lotteryPoolSnap.val() || LOTTERY_POOL_FLOOR;

  return {
    ok: true,
    attendance: { today: attendance.today, claimedCount: attendance.claimedCount, totalPaidToday: attendance.totalPaidToday },
    purchase,
    users,
    profitRankingEntryCount,
    lottery,
  };
}

// ── 유저 상세 조회 및 수동 조치 ──────────────────────────────
// 개별 거래는 로그로 남기지 않으므로(체결가/잔고만 갱신), 보여줄 수 있는 건
// 현재 보유 스냅샷과 손익 누적치까지다.
async function actionGetUserDetail(db, { uid }) {
  if (!uid) throw new HttpsError("invalid-argument", "uid가 필요합니다.");
  const snap = await db.ref(`users/${uid}`).get();
  if (!snap.exists()) throw new HttpsError("not-found", "해당 uid의 유저를 찾을 수 없습니다.");
  const user = snap.val();

  const holdingEntries = Object.entries(user.stocks || {}).filter(([, s]) => (s?.qty || 0) > 0);
  const stockSnaps = await Promise.all(holdingEntries.map(([id]) => db.ref(`stocks/${id}`).get()));
  const holdings = holdingEntries.map(([id, pos], i) => {
    const stock = stockSnaps[i].val() || {};
    const currentPrice = stock.price || 0;
    return {
      stockId: id,
      name: stock.name || "(삭제된 종목)",
      qty: pos.qty,
      avg: pos.avg,
      currentPrice,
      unrealizedPL: Math.round((currentPrice - pos.avg) * pos.qty),
    };
  });

  return {
    ok: true,
    uid,
    cash: user.cash ?? INITIAL_CASH,
    kakaoLinked: !!user.kakaoLinked,
    googleLinked: !!user.googleLinked,
    realizedPL: user.realizedPL || 0,
    lastTradeTime: user.lastTradeTime || null,
    lastAttendanceDate: user.lastAttendanceDate || null,
    attendanceStreak: user.attendanceStreak || 0,
    achievements: Object.keys(user.achievements || {}),
    holdings,
  };
}

/** amount는 양수(지급)/음수(차감) 모두 가능. 조정 사유와 함께 adminCashAdjustments에 기록해 감사 추적을 남긴다. */
async function actionAdjustUserCash(db, { uid, amount, reason }) {
  if (!uid) throw new HttpsError("invalid-argument", "uid가 필요합니다.");
  const delta = Math.round(Number(amount));
  if (!Number.isFinite(delta) || delta === 0) {
    throw new HttpsError("invalid-argument", "조정할 금액을 입력해주세요.");
  }

  if (delta > 0) {
    await creditUserCash(db, uid, delta);
  } else {
    await chargeUserCash(db, uid, -delta, { allowNegative: true });
  }

  const ref = db.ref("adminCashAdjustments").push();
  await ref.set({
    uid,
    amount: delta,
    reason: String(reason || "").trim(),
    adjustedAt: Date.now(),
  });

  return { ok: true, id: ref.key };
}

async function actionResetUserProfitRanking(db, { uid }) {
  if (!uid) throw new HttpsError("invalid-argument", "uid가 필요합니다.");
  await db.ref(`rankings/profitEntries/${uid}`).remove();
  return { ok: true };
}

async function actionDeleteUser(db, { uid }) {
  if (!uid) throw new HttpsError("invalid-argument", "uid가 필요합니다.");
  await db.ref(`users/${uid}`).remove();
  return { ok: true };
}

/**
 * 관리자 페이지 전용 액션 디스패처.
 * 클라이언트는 { action, payload }만 전달하고, 실제 stocks/users/rankings/
 * chartBanner 쓰기·users 읽기는 전부 여기서 Admin SDK로 처리한다.
 */
const adminAction = onCall({ cors: true, timeoutSeconds: 120, memory: "256MiB" }, async (request) => {
  requireAdmin(request.auth);

  const db      = admin.database();
  const action  = String(request.data?.action || "");
  const payload = request.data?.payload || {};

  switch (action) {
    case "updateSinglePrice":      return actionUpdateSinglePrice(db, payload);
    case "updateStockData":        return actionUpdateStockData(db, payload);
    case "adjustAllPrices":        return actionAdjustAllPrices(db, payload);
    case "resetAllPrices":         return actionResetAllPrices(db);
    case "uploadStocks":           return actionUploadStocks(db, payload);
    case "deleteStocks":           return actionDeleteStocks(db, payload);
    case "cleanupDuplicateStocks": return actionCleanupDuplicateStocks(db);
    case "listActiveBanners":      return actionListActiveBanners(db);
    case "updateBanner":           return actionUpdateBanner(db, payload);
    case "deleteBanner":           return actionDeleteBanner(db, payload);
    case "listCashChargeRequests":   return actionListCashChargeRequests(db);
    case "approveCashChargeRequest": return actionApproveCashChargeRequest(db, payload);
    case "rejectCashChargeRequest":  return actionRejectCashChargeRequest(db, payload);
    case "listPinRequests":    return actionListPinRequests(db);
    case "listActivePins":     return actionListActivePins(db);
    case "approvePinRequest":  return actionApprovePinRequest(db, payload);
    case "rejectPinRequest":   return actionRejectPinRequest(db, payload);
    case "deletePin":          return actionDeletePin(db, payload);
    case "listRelayRoomRequests":    return actionListRelayRoomRequests(db);
    case "listActiveRelayRooms":     return actionListActiveRelayRooms(db);
    case "approveRelayRoomRequest":  return actionApproveRelayRoomRequest(db, payload);
    case "rejectRelayRoomRequest":   return actionRejectRelayRoomRequest(db, payload);
    case "deleteRelayRoom":          return actionDeleteRelayRoom(db, payload);
    case "listUnfreezeDonationRequests":   return actionListUnfreezeDonationRequests(db);
    case "approveUnfreezeDonationRequest": return actionApproveUnfreezeDonationRequest(db, payload);
    case "rejectUnfreezeDonationRequest":  return actionRejectUnfreezeDonationRequest(db, payload);
    case "listFrozenStocks":               return actionListFrozenStocks(db);
    case "forceUnfreezeStock":             return actionForceUnfreezeStock(db, payload);
    case "listListingRequests":    return actionListListingRequests(db);
    case "approveListingRequest":  return actionApproveListingRequest(db, payload);
    case "rejectListingRequest":   return actionRejectListingRequest(db, payload);
    case "previewRankings":        return actionPreviewRankings(db);
    case "saveRankings":           return actionSaveRankings(db);
    case "previewInactiveUsers":   return actionPreviewInactiveUsers(db);
    case "cleanupInactiveUsers":   return actionCleanupInactiveUsers(db);
    case "listBannerRequests":     return actionListBannerRequests(db);
    case "approveBannerRequest":   return actionApproveBannerRequest(db, payload);
    case "rejectBannerRequest":    return actionRejectBannerRequest(db, payload);
    case "listChartBannerRequests":   return actionListChartBannerRequests(db);
    case "approveChartBannerRequest": return actionApproveChartBannerRequest(db, payload);
    case "rejectChartBannerRequest":  return actionRejectChartBannerRequest(db, payload);
    case "setMaintenanceMode":     return actionSetMaintenanceMode(db, payload);
    case "rerollJackpot":          return actionRerollJackpot(db);
    case "listProfitRankings":     return actionListProfitRankings(db);
    case "listPurchaseHistory":    return actionListPurchaseHistory(db);
    case "getPendingSummary":      return actionGetPendingSummary(db);
    case "previewAnonTopUp":       return actionPreviewAnonTopUp(db);
    case "applyAnonTopUp":         return actionApplyAnonTopUp(db);
    case "previewCrewPrefixMatch":  return actionPreviewCrewPrefixMatch(db, payload);
    case "applyCrewPrefix":         return actionApplyCrewPrefix(db, payload);
    case "previewCrewPrefixRemove": return actionPreviewCrewPrefixRemove(db, payload);
    case "applyCrewPrefixRemove":   return actionApplyCrewPrefixRemove(db, payload);
    case "getUserDetail":          return actionGetUserDetail(db, payload);
    case "adjustUserCash":         return actionAdjustUserCash(db, payload);
    case "resetUserProfitRanking": return actionResetUserProfitRanking(db, payload);
    case "deleteUser":             return actionDeleteUser(db, payload);
    case "setAnnouncement":        return actionSetAnnouncement(db, payload);
    case "getAttendanceStats":     return actionGetAttendanceStats(db);
    case "getOverviewStats":       return actionGetOverviewStats(db);
    default:
      throw new HttpsError("invalid-argument", `알 수 없는 action: ${action}`);
  }
});

module.exports = { adminAction };
