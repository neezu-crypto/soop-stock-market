const { onCall } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { INITIAL_CASH, TRADE_COOLDOWN_MS, PRESENCE_GRACE_MS, updateVolumeRanking } = require("./common");
const { executeSimulatedTrade } = require("./stockSimulator");

// ══════════════════════════════════════════════════════════
// 트레이딩 봇(2026-08-27, 사용자 지시) — 실제 유저와 짝지어져 같이
// "접속"하고, 실제 유저가 거래할 때마다 확률적으로 반응해 스스로의
// 자산/보유량 안에서 매수·매도를 반복하는 가상 참여자.
//
// stockSimulator.js(관리자 전용 차트 활성화 도구)와의 차이 — 그쪽은 주인
// 없는 시세 조작이라 유저 보상(잭팟·도전과제·랭킹)을 전부 건너뛰는 게
// 당연했지만, 이 봇은 "실제 유저처럼 보이는 포트폴리오"를 요구받았다.
// 다만 잭팟 기여·도전과제 지급은 여전히 건너뛴다 — 둘 다 "그 거래를 한
// 진짜 사람"에게 보상이 가야 하는데 봇 뒤에는 아무도 없어, 지급 대상이
// 없거나 악용 소지가 생기는 건 기존 시뮬레이터와 같은 이유다. 시세·거래량·
// 캔들·스파크라인 갱신은 executeSimulatedTrade를 그대로 재사용해 실제
// 거래와 완전히 동일한 흔적을 남긴다.
//
// 접속자 수에는 실제 유저와 구분 없이 그대로 잡힌다(사용자가 명시적으로
// 요청·확정한 사양) — presence 노드에 isBot 플래그를 남기는 건 어드민이
// 나중에 구분/정리할 수 있도록 하는 내부 기록일 뿐, 접속자 수 집계 로직
// (index.html의 lastSeen 카운트)은 이 플래그를 보지 않으므로 화면 표시에는
// 영향이 없다.
// ══════════════════════════════════════════════════════════

const BOT_SPAWN_CHANCE  = 0.2;   // 조건2 - 실제 유저 거래마다 봇 생성 확률
const MIN_CONNECTED_MS  = 30000; // 조건1 - 접속 30초 이후부터 봇 발동 가능
// 락이 걸린 채로 60초가 지나면 만료된 것으로 간주하고 강제로 풀어준다 —
// 패턴 하나가 아무리 길어도(③④, 최대 20건) 20~25초 안에는 끝나므로 넉넉한
// 안전 마진. 인스턴스가 중간에 죽어 finally를 못 타는 극단적인 경우에도
// 락이 영영 안 풀리는 걸 막기 위한 자기 치유 장치.
const LOCK_STALE_MS     = 60000;
const MIN_ORDERS        = 5;
const MAX_ORDERS        = 10;
const MIN_ORDER_QTY     = 1;
const MAX_ORDER_QTY     = 5;     // 주문 1건당 수량(실제 유저 1회 최대 10주보다 보수적으로 - 봇은 여러 건을 이어서 내므로 총량이 과해지지 않게)
// 주문 사이 대기(2026-08-27, 사용자 지시 - "봇의 매매속도도 실제 유저처럼
// 1초당 1거래만 가능하게") - TRADE_COOLDOWN_MS(1000ms)보다 살짝 여유를 둬
// 매번 확실히 쿨다운을 넘기게 하고, 봇이 정확히 기계적인 리듬으로만
// 움직이지 않도록 약간의 랜덤 지터를 더한다. placeBotOrder 안의
// lastTradeTime 검사가 실제 방어선이고, 이 대기는 그 방어선에 걸려
// 낭비되는 재시도가 없도록 미리 넉넉히 기다려주는 역할이다.
const ORDER_DELAY_MS    = [TRADE_COOLDOWN_MS + 20, TRADE_COOLDOWN_MS + 180];
const LEG_GAP_DELAY_MS  = [TRADE_COOLDOWN_MS + 200, TRADE_COOLDOWN_MS + 500]; // 패턴 내 방향 전환 시 추가 대기
// 실제 유저 응답과는 더 이상 무관하다 - 봇 반응은 trade()가 아니라 별도
// triggerBotReaction 호출 안에서 실행되고, 클라이언트는 그 호출을 기다리지
// 않는다(아래 참고). 다만 이 값들 때문에 패턴 하나가 최악의 경우(③④,
// 10회+10회) 대략 20초 가까이 걸릴 수 있다는 점은 감안할 것 - onCall
// timeoutSeconds를 그에 맞춰 넉넉히 잡아야 한다.

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function opposite(type) {
  return type === "buy" ? "sell" : "buy";
}

/**
 * 실제 유저 1명당 봇 반응은 한 번에 하나만 — 유저가 연속으로 두 번 거래해
 * 20% 트리거가 두 번 다 발동해도(2026-08-27, 사용자 지적 - "봇이 거래
 * 진행중일땐 이후 연속으로 트리거가 작동해도 중복거래 발생 안하는게
 * 좋겠는데"), 앞선 패턴이 끝나기 전까진 뒤이은 트리거를 그냥 건너뛴다.
 * botAssignments 생성 자체도 이 락 안에서 이뤄지므로("봇이 아직 없을 때"
 * 트리거가 겹치면 봇이 2개 만들어질 수 있는 스폰 경합도 같이 막아준다).
 * RTDB 트랜잭션으로 "현재 잠겨 있지 않을 때만 내가 잠근다"를 원자적으로
 * 처리 — 두 요청이 동시에 도착해도 하나만 락을 얻는다.
 */
async function acquireBotLock(realUid, db) {
  const lockRef = db.ref(`botLocks/${realUid}`);
  const result = await lockRef.transaction((current) => {
    if (current && current.lockedAt && Date.now() - current.lockedAt < LOCK_STALE_MS) {
      return; // abort - 이미 다른 실행이 진행 중
    }
    return { lockedAt: Date.now() };
  });
  return result.committed;
}
async function releaseBotLock(realUid, db) {
  await db.ref(`botLocks/${realUid}`).set(null).catch(() => {});
}

/**
 * 봇 주문 1건 체결 — 시세는 executeSimulatedTrade로 갱신하고, 봇 자신의
 * cash/stocks는 별도 트랜잭션으로 갱신한다(실제 유저의 users/{uid}와 완전히
 * 같은 스키마를 botUsers/{botUid}에 유지). 자산/보유량이 부족하면 그
 * 주문만 조용히 건너뛴다(전체 패턴을 중단시키지 않음 - 실제 유저도 잔액
 * 부족 시 그 주문만 실패하는 것과 같은 결).
 */
async function placeBotOrder(db, botUid, stockId, type) {
  const stockSnap = await db.ref(`stocks/${stockId}`).get();
  const stock = stockSnap.val();
  if (!stock || stock.frozenAt) return false;

  const botSnap = await db.ref(`botUsers/${botUid}`).get();
  const bot = botSnap.val() || { cash: INITIAL_CASH, stocks: {} };

  // 실제 유저와 동일한 매매 속도 제한(TRADE_COOLDOWN_MS) - ORDER_DELAY_MS가
  // 이미 이 값보다 크게 잡혀 있어 정상 흐름에선 거의 걸릴 일이 없지만,
  // trade.js의 쿨다운 검사와 같은 자리에 방어선을 하나 더 둔다(방어적
  // 프로그래밍 - 타이밍이 어떻게 바뀌어도 이 규칙만은 항상 지켜지게).
  if (bot.lastTradeTime && Date.now() - bot.lastTradeTime < TRADE_COOLDOWN_MS) {
    return false;
  }

  const desiredQty = randInt(MIN_ORDER_QTY, MAX_ORDER_QTY);

  let qty = desiredQty;
  if (type === "buy") {
    const maxAffordable = Math.floor((bot.cash || 0) / stock.price);
    qty = Math.min(desiredQty, maxAffordable);
  } else {
    const held = (bot.stocks || {})[stockId]?.qty || 0;
    qty = Math.min(desiredQty, held);
  }
  if (qty < 1) return false; // 자산/보유량 부족 - 이번 주문은 건너뜀

  const result = await executeSimulatedTrade(db, stockId, type, qty);
  if (!result) return false;

  await db.ref(`botUsers/${botUid}`).transaction((current) => {
    const b = current || { cash: INITIAL_CASH, stocks: {} };
    const stocks = { ...(b.stocks || {}) };
    const pos = stocks[stockId] || { qty: 0, avg: 0 };

    if (type === "buy") {
      const cost = result.price * qty;
      if ((b.cash || 0) < cost) return; // 트랜잭션 재시도 중 자산이 바뀌었으면 포기
      const newQty = pos.qty + qty;
      stocks[stockId] = { qty: newQty, avg: Math.round((pos.qty * pos.avg + cost) / newQty) };
      b.cash = (b.cash || 0) - cost;
    } else {
      if (pos.qty < qty) return;
      const newQty = pos.qty - qty;
      stocks[stockId] = { qty: newQty, avg: newQty === 0 ? 0 : pos.avg };
      b.cash = (b.cash || 0) + result.price * qty;
    }
    b.stocks = stocks;
    b.lastTradeTime = Date.now();
    b.tradeCount = (b.tradeCount || 0) + 1;
    // 관리자 페이지 봇 관리 세션(2026-08-27)에서 "최근 거래 종목"을 보여주기
    // 위한 필드 — stocks 맵만으로는 "가장 최근에" 거래한 종목을 알 수 없어
    // (여러 종목을 들고 있을 수 있으므로) 별도로 남긴다.
    b.lastStockId = stockId;
    b.lastStockName = stock.name;
    b.lastTradeType = type;
    return b;
  });

  // 거래량 랭킹 갱신(2026-08-27, 사용자 지시 - "봇 거래량 갱신도 똑같이
  // 적용해줘") - 실제 유저 거래와 동일한 공용 함수를 호출한다. 매번 시도하되
  // common.js의 RANKING_DEBOUNCE_MS(30초) 안이면 조용히 건너뛰므로, 패턴 하나가
  // 5~20건을 연달아 내도 실제로 rankings/top5에 쓰는 횟수는 그 이하로 자연스레
  // 제한된다.
  try {
    const freshStock = (await db.ref(`stocks/${stockId}`).get()).val();
    await updateVolumeRanking(db, stockId, freshStock?.name, result.price, freshStock?.volume);
  } catch (e) {
    // best-effort
  }

  return true;
}

async function runOrders(db, botUid, stockId, type, count) {
  for (let i = 0; i < count; i++) {
    await placeBotOrder(db, botUid, stockId, type);
    await sleep(randInt(...ORDER_DELAY_MS));
  }
}

// 5가지 패턴 - 각 20%. 1~3번은 사용자 지정, 4~5번은 "기타 다양한 패턴"
// 요청에 맞춰 추가한 것(각각 분할 매집형·지연 반응형 트레이더를 흉내).
const PATTERNS = [
  // 1) 모멘텀 추종 - 같은 방향으로 5~10회
  async (db, botUid, stockId, direction) => {
    await runOrders(db, botUid, stockId, direction, randInt(MIN_ORDERS, MAX_ORDERS));
  },
  // 2) 역추세 - 반대 방향으로 5~10회
  async (db, botUid, stockId, direction) => {
    await runOrders(db, botUid, stockId, opposite(direction), randInt(MIN_ORDERS, MAX_ORDERS));
  },
  // 3) 추종 후 반전 - 같은 방향 5~10회 → 반대 방향 5~10회
  async (db, botUid, stockId, direction) => {
    await runOrders(db, botUid, stockId, direction, randInt(MIN_ORDERS, MAX_ORDERS));
    await sleep(randInt(...LEG_GAP_DELAY_MS));
    await runOrders(db, botUid, stockId, opposite(direction), randInt(MIN_ORDERS, MAX_ORDERS));
  },
  // 4) 분할 매집 후 일부 차익실현 - 같은 방향으로 여러 번 나눠 담았다가,
  //    마지막에 한 번에 크게(더 적은 횟수·더 큰 수량) 반대로 정리
  async (db, botUid, stockId, direction) => {
    await runOrders(db, botUid, stockId, direction, randInt(MIN_ORDERS, MAX_ORDERS));
    await sleep(randInt(...LEG_GAP_DELAY_MS));
    await runOrders(db, botUid, stockId, opposite(direction), randInt(2, 4));
  },
  // 5) 관망 후 뒤늦은 반응 - 잠깐 지켜보다가(대기) 같은 방향으로 소수의
  //    굵직한 주문만 몰아서 낸다(느리게 반응하지만 확신은 강한 트레이더)
  async (db, botUid, stockId, direction) => {
    await sleep(randInt(...LEG_GAP_DELAY_MS));
    await runOrders(db, botUid, stockId, direction, randInt(2, 4));
  },
];

/**
 * 실제 유저 거래 직후 trade.js에서 호출 — 봇 발동 조건 확인 후 있으면
 * 반응, 없으면 조건 충족 시 새로 생성한다. 이 함수 내부 에러는 절대
 * 실제 유저의 거래 응답에 영향을 주면 안 되므로, 호출부(trade.js)에서
 * try/catch로 감싸 호출한다.
 *
 * 락 획득에 실패하면(=이 유저의 봇이 이미 다른 패턴을 진행 중이면) 아무
 * 것도 하지 않고 조용히 리턴한다 — "중복거래 방지"가 목적이라 대기열에
 * 쌓아 나중에 실행하지 않고, 이번 트리거는 그냥 건너뛴다.
 */
async function maybeSpawnAndRunBot(db, realUid, stockId, direction) {
  const presenceSnap = await db.ref(`presence/stockMarket/${realUid}`).get();
  const connectedAt = presenceSnap.val()?.connectedAt;
  if (!connectedAt || Date.now() - connectedAt < MIN_CONNECTED_MS) return; // 조건1 미충족

  const gotLock = await acquireBotLock(realUid, db);
  if (!gotLock) return; // 이미 진행 중인 패턴이 있음 - 이번 트리거는 건너뜀

  try {
    const assignRef = db.ref(`botAssignments/${realUid}`);
    let assignment = (await assignRef.get()).val();

    if (!assignment) {
      if (Math.random() >= BOT_SPAWN_CHANCE) return; // 조건2 - 20% 실패
      const botUid = "bot_" + db.ref().push().key;
      const now = Date.now();
      await db.ref(`botUsers/${botUid}`).set({ cash: INITIAL_CASH, stocks: {}, isBot: true, createdAt: now });
      await db.ref(`presence/stockMarket/${botUid}`).set({ lastSeen: now, connectedAt: now, isBot: true });
      assignment = { botUid, createdAt: now };
      await assignRef.set(assignment);
    } else {
      // 이미 짝지어진 봇이 있으면 접속 유지(하트비트 사이에도 이번 거래
      // 반응으로 lastSeen이 갱신되게) - 실제 유저가 활동 중인 동안엔 계속
      // "접속 중"으로 보이게 하는 보조 장치, 별도 하트비트 훅과 병행.
      await db.ref(`presence/stockMarket/${assignment.botUid}`).update({ lastSeen: Date.now() });
    }

    const pattern = PATTERNS[randInt(0, PATTERNS.length - 1)];
    await pattern(db, assignment.botUid, stockId, direction);
  } finally {
    await releaseBotLock(realUid, db);
  }
}

// 봇이 "1초에 한 거래" 속도 제한을 지키면서 5~20건짜리 패턴을 다 도는 데
// 최악의 경우 20초 가까이 걸릴 수 있어(2026-08-27 재설계), 이 실행을
// trade() 응답 안에서 기다리게 하면 실제 유저가 자기 거래 버튼 하나 누른
// 결과를 그만큼 기다리게 된다. 그래서 완전히 독립된 onCall로 분리했다 —
// 클라이언트는 trade() 응답을 받은 즉시 화면을 갱신하고, 이 함수는
// 기다리지 않고("fire and forget") 별도로 호출한다.
const triggerBotReaction = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const auth = request.auth;
  if (!auth?.uid) return { ok: false };

  const stockId = String(request.data?.stockId || "").trim();
  const type = String(request.data?.type || "").trim().toLowerCase();
  if (!stockId || (type !== "buy" && type !== "sell")) return { ok: false };

  const db = admin.database();

  // 악용 방지 — 클라이언트가 이 함수를 트레이딩 없이 반복 호출해 봇 생성
  // 확률만 계속 재추첨하는 걸 막는다. 진짜로 방금 거래했을 때만(서버가 기록한
  // users/{uid}.lastTradeTime 기준 최근 10초 이내) 동작하게 한다 — 클라이언트가
  // 보낸 stockId/type을 그대로 신뢰하는 대신, "정말 방금 거래했는가"만
  // 서버 값으로 검증하고 실제 반응 대상 종목/방향은 클라이언트 값을 쓴다(어차피
  // 이 값이 틀려도 봇 자산에만 영향이 있을 뿐 실제 유저 자산과는 무관해
  // 보안상 치명적이지 않다 - 방지하려는 건 "무한 재추첨 스팸"뿐이다).
  try {
    const lastTradeTime = (await db.ref(`users/${auth.uid}/lastTradeTime`).get()).val();
    if (!lastTradeTime || Date.now() - lastTradeTime > 10000) return { ok: false };

    await maybeSpawnAndRunBot(db, auth.uid, stockId, type);
  } catch (e) {
    // best-effort — 실패해도 실제 유저에게는 아무 영향 없음(애초에 안 기다림)
  }

  return { ok: true };
});

/**
 * 관리자 페이지 "🤖 봇 관리" 세션용 조회(2026-08-27) — adminAction
 * 디스패처의 한 액션으로 등록해서 쓴다(다른 관리자 조회들과 같은 패턴).
 * botAssignments 전체를 훑으며 각 봇의 포트폴리오·최근 거래·활성/거래중
 * 상태를 한 번에 모아 반환한다. 봇 개수가 "실제 유저 1명당 최대 1개"로
 * 애초에 제한돼 있어(1:1 비율) 동시 접속자 규모를 감안하면 전체 스캔 비용이
 * 크지 않다.
 */
async function actionGetBotSessions(db) {
  const [assignmentsSnap, botUsersSnap, presenceSnap, locksSnap, stocksSnap] = await Promise.all([
    db.ref("botAssignments").get(),
    db.ref("botUsers").get(),
    db.ref("presence/stockMarket").get(),
    db.ref("botLocks").get(),
    db.ref("stocks").get(), // 보유 종목 id → 스트리머 이름 변환용(2026-08-27, 관리자 페이지에 id 그대로 노출되던 문제 수정)
  ]);

  const assignments = assignmentsSnap.val() || {};
  const botUsers    = botUsersSnap.val() || {};
  const presence    = presenceSnap.val() || {};
  const locks       = locksSnap.val() || {};
  const stocks      = stocksSnap.val() || {};
  const now = Date.now();

  const sessions = Object.entries(assignments).map(([realUid, assignment]) => {
    const botUid = assignment?.botUid;
    const bot = botUsers[botUid] || {};
    const botPresence = presence[botUid];
    const lastSeen = botPresence?.lastSeen || 0;
    const isOnline = lastSeen > 0 && now - lastSeen <= PRESENCE_GRACE_MS;
    const lock = locks[realUid];
    const isTrading = !!(lock?.lockedAt && now - lock.lockedAt < LOCK_STALE_MS);

    const holdings = Object.entries(bot.stocks || {})
      .filter(([, pos]) => (pos?.qty || 0) > 0)
      .map(([stockId, pos]) => ({
        stockId,
        stockName: stocks[stockId]?.name || stockId,
        qty: pos.qty,
        avg: pos.avg,
      }));

    return {
      realUid,
      botUid,
      createdAt: assignment?.createdAt || bot.createdAt || null,
      isOnline,
      lastSeen: lastSeen || null,
      isTrading,
      cash: bot.cash ?? null,
      tradeCount: bot.tradeCount || 0,
      lastTradeTime: bot.lastTradeTime || null,
      lastStockId: bot.lastStockId || null,
      lastStockName: bot.lastStockName || null,
      lastTradeType: bot.lastTradeType || null,
      holdings,
    };
  });

  // 최근 거래한 봇이 위로 오도록 정렬 — 관리자가 가장 최근 활동을 먼저 보게.
  sessions.sort((a, b) => (b.lastTradeTime || 0) - (a.lastTradeTime || 0));

  return {
    ok: true,
    totalCount: sessions.length,
    onlineCount: sessions.filter((s) => s.isOnline).length,
    tradingCount: sessions.filter((s) => s.isTrading).length,
    sessions,
  };
}

module.exports = { maybeSpawnAndRunBot, triggerBotReaction, actionGetBotSessions };
