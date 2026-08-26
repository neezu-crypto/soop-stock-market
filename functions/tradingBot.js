const { INITIAL_CASH } = require("./common");
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
const MIN_ORDERS        = 5;
const MAX_ORDERS        = 10;
const MIN_ORDER_QTY     = 1;
const MAX_ORDER_QTY     = 5;     // 주문 1건당 수량(실제 유저 1회 최대 10주보다 보수적으로 - 봇은 여러 건을 이어서 내므로 총량이 과해지지 않게)
const ORDER_DELAY_MS    = [50, 130];    // 주문 사이 랜덤 대기(자연스러운 체결 속도 흉내)
const LEG_GAP_DELAY_MS  = [200, 400];   // 패턴 내 방향 전환 시 추가 대기
// 위 값들은 실제 유저 응답 지연과 직결된다(아래 8번 단계에서 끝까지
// await하므로) - 최악의 경우(패턴3/4, 10회+10회) 대략 (10*130+400+10*130)
// ≈ 3초 안팎으로 상한을 잡았다. 이보다 더 "빠릿하게" 만들고 싶으면 이
// 배열들만 줄이면 되고, 반대로 체결 속도를 더 자연스럽게(느리게) 하고
// 싶으면 늘리면 되는데, 그만큼 실제 유저의 매수/매도 버튼 응답도 같이
// 느려진다는 점을 기억할 것.

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
    return b;
  });

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
 */
async function maybeSpawnAndRunBot(db, realUid, stockId, direction) {
  const presenceSnap = await db.ref(`presence/stockMarket/${realUid}`).get();
  const connectedAt = presenceSnap.val()?.connectedAt;
  if (!connectedAt || Date.now() - connectedAt < MIN_CONNECTED_MS) return; // 조건1 미충족

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
}

module.exports = { maybeSpawnAndRunBot };
