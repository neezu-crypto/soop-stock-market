const { HttpsError } = require("firebase-functions/v2/https");

// ── 전역 공통 상수 ────────────────────────────────────────────
// 테스트 기간 동안 플레이 시간 충전(유료)만 막았었다 — 2026-07-12 해제.
// 클라이언트(index.html)에도 동일한 이름의 상수가 있어 항상 함께 바꿔야 한다.
const TEST_PERIOD_ACTIVE       = false;
const ADMIN_EMAIL              = "skftodwocks2@gmail.com"; // 관리자 페이지와 동일 계정
// 2026-07-12 정책 변경: 익명/로그인 유저의 초기 자산 격차(50만원+50만원
// 보너스 방식)를 없애고 접속 즉시 누구나 100만원을 받는다 — 익명 계정을
// 여러 개 파도 계정끼리 자산을 옮기거나 합칠 방법이 없어(송금/양도 기능
// 없음), 초기 지급액을 동일하게 맞추는 것 자체는 악용 경로가 되지 않는다.
// 반면 잭팟·복권·출석 보상처럼 "여러 계정의 기여를 한 계정이 몰아서
// 수령"할 수 있는 지급형 이벤트는 계속 로그인(계정 보호) 유저 전용으로
// 남긴다 — 그 기능들만 실제 악용 경로가 있기 때문.
const INITIAL_CASH             = 1000000;  // 접속 즉시 지급되는 시작 자금(익명/로그인 동일)
// 2026-07 정책 변경(익명 20만원+카카오 80만원 → 익명 50만원+카카오 50만원) 이전에
// 이미 생성된 익명 유저는 20만원만, 그 다음 세대는 50만원만 받은 상태다. 실제로
// 거래해본(=진짜 이용한) 익명 유저에 한해 새 기준(100만원)과의 차액을 1회 보정
// 지급한다 — actionPreviewAnonTopUp/actionApplyAnonTopUp(admin.js)에서 사용.
// 카카오/구글로 이미 보호된 유저는 예전 기준으로도 합산 100만원을 이미 받았으므로
// (구 정책들 모두 우연히 합산 100만원으로 귀결됨) 대상에서 제외된다.
const ANON_INITIAL_CASH_TOPUP  = 500000;
// 정책 변경 이전 지급 기준들 — isInactiveUser(admin.js)가 "미거래 유저"를 판정할
// 때 지금 기준(INITIAL_CASH=100만원)뿐 아니라 이 값들과도 비교해야, 예전 기준으로
// 받고 한 번도 거래하지 않은 계정도 계속 정상적으로 잡아낼 수 있다.
const LEGACY_INITIAL_CASH      = 200000; // 가장 오래된 지급 기준
const LEGACY_INITIAL_CASH_500K = 500000; // 이번 변경 직전까지의 익명 지급 기준
const STREAMER_ID_RE           = /^[a-z0-9]{2,20}$/;
const URL_RE                   = /^https?:\/\/.+/i;
const MAX_BANNER_REQUEST_DAYS  = 7;        // 신청 시 신청자가 고를 수 있는 노출 기간 상한
const BANNER_COST_PER_DAY      = 500000;   // 우측 랭킹 배너 신청 1일당 차감되는 게임자산
const CHART_BANNER_COST_PER_DAY = 1000000; // 차트 하단 배너 신청 1일당 차감되는 게임자산
// 종목 카드 프로필 배너 — "이 종목의 실제 소유주(대량 보유자)"만 신청할 수
// 있는 홍보 상품. 우측 배너와 달리 종목 리스트의 카드 자체(가장 노출 빈도가
// 높은 화면)에 원형 프로필 사진을 띄운다. 신청 후 보유 수량이 기준 미만으로
// 떨어지면(되팔기 등) 자동으로 삭제된다 — trade.js의 매도 처리에서 검사.
const CARD_BANNER_COST_PER_DAY    = 500000; // 1일당 차감되는 게임자산
const CARD_BANNER_MIN_HOLDING_QTY = 10;     // 신청/유지에 필요한 최소 보유 수량
const MAX_PIN_HOURS            = 12;       // 최상단 고정 노출 신청 시 고를 수 있는 시간 상한
const PIN_COST_PER_HOUR        = 250000;   // 최상단 고정 노출 1시간당 차감되는 게임자산
const MAX_PINNED_SLOTS         = 3;        // 동시에 고정 노출 가능한 최대 종목 수
const PROFIT_RANKING_CHECK_COST = 500000;  // 손익 랭킹 확인(및 내 순위 갱신) 1회당 차감되는 게임자산
const PROFIT_RANKING_TOP_N      = 10;      // 랭킹판에 노출되는 상위 인원 수

// ── 스트리머 인증 ────────────────────────────────────────────
// 카카오/구글 연동을 꺼리는 스트리머를 위한 대체 계정 보호 경로. 신청 시
// 서버가 4자리 인증번호를 발급하고, 신청자는 본인 방송에서 그 번호를
// 언급해 소유권을 증명한다. 관리자가 다시보기에서 번호를 직접 확인한 뒤
// 승인해야만 보호가 확정된다 — 닉네임 자체는 아무나 입력할 수 있어 증명력이
// 없으므로, 매 승인마다(최초 인증뿐 아니라 다른 기기로 넘어가는 재인증도)
// 반드시 이 랜덤 코드 확인을 거치게 해 타 계정 탈취를 막는다.
const STREAMER_VERIFICATION_NICKNAME_MAX_LENGTH = 20;
const STREAMER_VERIFICATION_COOLDOWN_MS         = 60 * 1000; // 매크로/도배성 재신청 방지

// ── 잭팟 종목 ────────────────────────────────────────────────
// 매일(또는 당첨될 때까지) 랜덤 종목 1개를 "잭팟 종목"으로 선정해, 전체
// 유저가 그 종목을 매매한 수량(매수+매도 합산)이 목표치에 도달하는 순간
// 그 매매를 실행한 유저가 상금을 받는다. 혼자 반복 매매해서 셀프로 채우는
// 것을 막기 위해 계정당 기여량에 상한을 둔다 — 목표치를 상한으로 나눈
// 값(예: 1000/100=10명)만큼 서로 다른 계정이 실제로 참여해야만 도달 가능.
const JACKPOT_PRIZE_AMOUNT       = 2000000; // 당첨금
const JACKPOT_PER_ACCOUNT_CAP    = 100;     // 계정당 목표치에 반영되는 최대 기여량(그 이상 매매해도 더 반영 안 됨)
const JACKPOT_TARGET_MIN         = 1000;    // 목표치 하한선(트래픽이 적어도 이 아래로는 안 내려감)
const JACKPOT_TARGET_RATIO       = 0.2;     // 목표치 = 전일 최고 매매량 델타 × 이 비율
const JACKPOT_TARGET_VARIANCE    = 0.2;     // 목표치에 적용하는 랜덤 변동폭(±20%)

// ── 복권함 ───────────────────────────────────────────────────
// 계정 보호 유저만 20만원에 복권 1장을 살 수 있고, 구매 즉시 서버가 세
// 자리 숫자(각 자리 1~7)를 확정한다. "긁기"는 이미 정해진 결과를 보여주는
// 연출일 뿐, 실제 당첨 판정과 지급은 구매 시점에 서버에서 끝난다. 777이면
// 그 시점 누적 모금액의 90%를 받고 모금액은 다시 초기값으로 리셋된다.
// 익명 계정 무한 생성 파밍을 막기 위해 계정 보호 유저로 대상을 한정한다
// (출석 보상과 동일한 이유). 1인당 구매 개수 제한은 없다 — 티켓마다 실제
// 비용이 드는 구조라, 많이 사는 건 파밍이 아니라 정상적인 복권 원리다.
const LOTTERY_TICKET_PRICE   = 200000;  // 복권 1장 가격
const LOTTERY_POOL_FLOOR     = 1000000; // 모금액 초기값 및 당첨 후 리셋값
const LOTTERY_PAYOUT_RATIO   = 0.9;     // 당첨 시 누적 모금액 중 지급 비율
const LOTTERY_DIGIT_MIN      = 1;       // 각 자리 숫자 범위 하한
const LOTTERY_DIGIT_MAX      = 7;       // 각 자리 숫자 범위 상한(당첨 조합은 7-7-7)

// 최근 7일 자산 변동 그래프용 — 화면엔 7일치만 보여주지만, 자정 근처
// 타임존 오차나 하루 접속을 건너뛴 경우까지 여유 있게 보려고 이틀치를 더
// 남겨둔다. 하루 1번(그날 첫 하트비트)만 기록해 저장량을 최소화한다.
const ASSET_HISTORY_RETENTION_DAYS = 9;

// 출석 보상 — 계정 보호(카카오/구글) 유저만 대상(익명 계정은 무한정 새로 만들
// 수 있어 파밍 방지 목적). 1~7일차 순으로 지급되며, 하루라도 놓치면 1일차로
// 리셋(연속 스트릭이 완전히 끊기는 대신 "출석부"가 다시 시작되는 방식).
const DAILY_ATTENDANCE_REWARDS  = [30000, 50000, 70000, 100000, 130000, 160000, 300000];

// ── 플레이타임 제한 관련 상수 ──────────────────────────────────
const ANON_DAILY_SECONDS       = 15 * 60;  // 익명 유저 하루 무료 이용 시간
const PROTECTED_DAILY_SECONDS  = 60 * 60;  // 계정 보호(카카오 또는 구글 연동) 유저 하루 무료 이용 시간
const PLAYTIME_BASE_RATE       = 0.10;     // 기준단가 = 총자산(현금+평가금액) × 이 비율 (1시간, 할증 전)
const PLAYTIME_SURCHARGE_STEP  = 0.10;     // 당일 n번째 추가 구매마다 할증률 +10%p
const PLAYTIME_SURCHARGE_MAX   = 0.50;     // 할증률 상한 (5번째 이상은 +50%로 고정)
const MAX_PLAYTIME_BUY_HOURS   = 12;       // 1회 요청으로 구매 가능한 시간 상한
const MAX_HEARTBEAT_GAP_SECONDS = 90;      // 하트비트 1회당 인정되는 최대 경과 시간(절전/재접속 등 이상치 방지)

const MAX_RELAY_ROOM_HOURS     = 8;        // 중계방 홍보 신청 시 고를 수 있는 시간 상한 (최소 1시간)
const RELAY_ROOM_COST_PER_HOUR = 300000;   // 중계방 홍보 1시간당 차감되는 게임자산
const MAX_RELAY_ROOMS          = 3;        // 동시에 등록 가능한 최대 중계방 수

// ── 종목 거래 동결(서킷브레이커) 관련 상수 ──────────────────────
// 목적: 유저들이 무작정 주가를 펌핑하는 게 손해라는 걸 경험하게 하고,
// 목표가 임박 시 패닉셀 심리를, 미해제 시 "공동책임" 심리를 유도한다.
const STOCK_FREEZE_THRESHOLD     = 1000000;        // 이 가격 이상에서 동결 판정 시작
const STOCK_FREEZE_CANDLE_COUNT  = 5;              // 연속 몇 개의 1분봉 종가가 기준 이상이어야 실제 동결되는지
                                                    // (평균이 아니라 "전부 다" 조건 — 단발성 조작에 강함)
const STOCK_UNFREEZE_PRICE       = 500000;         // 해제 시 강제로 낮추는 가격
const STOCK_FREEZE_COOLDOWN_MS   = 5 * 60 * 1000;  // 동결 직후 해제 자체가 불가능한 유예시간(드라마/경쟁 유도)
const STOCK_DELIST_DEADLINE_MS   = 12 * 60 * 60 * 1000; // 유예시간 내 미해제 시 상장폐지까지 걸리는 시간
const UNFREEZE_CASH_COST         = 1000000;        // 게임자산으로 해제 시 차감액
const UNFREEZE_CASH_REWARD       = 2000000;        // 게임자산으로 해제한 유저에게 지급되는 보상(해제비용의 2배, 순이익 100만원)
const UNFREEZE_DONATION_REWARD   = 1000000;        // 방송 후원으로 해제한 유저에게 지급되는 보상
const UNFREEZE_DONATION_BALLOONS = 50;             // 안내용 — 방송 후원 시 필요한 별풍선 개수(별도 실행은 방송에서)

// ── 도전과제(업적) ───────────────────────────────────────────
// 현금 보상 없이 배지만 지급한다 — 보상이 걸리면 익명 계정을 무한정 새로
// 만들 수 있는 이 앱 구조상 곧바로 파밍 어뷰징으로 이어지기 때문에(출석
// 보상이 계정 보호 유저로 대상을 한정하는 것과 같은 이유), 도전과제는
// 계정 보호 여부와 무관하게 누구나 달성할 수 있게 열어두는 대신 보상은
// 순수 기록/표시용으로만 둔다. users/{uid}/achievements/{id}에 달성
// 시각(ms)만 기록되며, ID·아이콘·설명은 여기 한 곳에서만 관리해 클라이언트
// (index.html의 ACHIEVEMENT_DEFS)와 반드시 동일하게 맞춘다.
const ACHIEVEMENTS = [
  { id: "first_trade",       icon: "🎉", label: "첫 매매",        desc: "종목을 처음으로 매수 또는 매도했어요" },
  { id: "trade_10",          icon: "📈", label: "매매의 정석",    desc: "누적 매매 10회를 달성했어요" },
  { id: "trade_50",          icon: "🔁", label: "트레이더",       desc: "누적 매매 50회를 달성했어요" },
  { id: "account_protected", icon: "🔒", label: "계정 보호 완료", desc: "카카오, 구글, 또는 스트리머 인증으로 계정을 보호했어요" },
  { id: "profit_published",  icon: "💰", label: "손익 공개",      desc: "내 손익 랭킹을 처음으로 게시했어요" },
  { id: "profit_top10",      icon: "🏆", label: "TOP 10 진입",    desc: "손익 랭킹 TOP 10에 진입했어요" },
  { id: "unfreeze_hero",     icon: "🧊", label: "동결 해제 성공", desc: "동결(서킷브레이커)된 종목을 해제했어요" },
  { id: "attendance_streak", icon: "🎁", label: "개근",           desc: "출석 보상 7일차를 달성했어요" },
  { id: "listing_approved",  icon: "🚀", label: "상장 성공",      desc: "내가 신청한 종목이 상장 승인됐어요" },
  { id: "first_support",     icon: "📢", label: "첫 후원",        desc: "배너(우측/차트/배너 홍보)·고정노출·중계방 홍보 상품을 처음 구매했어요" },
  { id: "jackpot_winner",    icon: "🎰", label: "잭팟 당첨",      desc: "오늘의 잭팟 종목 목표 매매량을 채운 그 매매의 주인공이 됐어요" },
  { id: "lottery_winner",    icon: "🎟️", label: "복권 당첨",      desc: "복권함에서 777을 맞춰 누적 모금액의 90%를 받았어요" },
];

/**
 * 도전과제를 idempotent하게 지급한다 — 이미 달성한 도전과제면 아무 것도
 * 하지 않고 false를 반환, 처음 달성한 것이면 시각을 기록하고 true를 반환.
 * 호출부는 대부분 best-effort(try/catch로 감싸 실패해도 본 기능은
 * 그대로 성공하도록)로 사용한다.
 */
async function grantAchievement(db, uid, achievementId) {
  if (!uid || !achievementId) return false;
  const ref  = db.ref(`users/${uid}/achievements/${achievementId}`);
  const snap = await ref.get();
  if (snap.exists()) return false;
  await ref.set(Date.now());
  return true;
}

/** KST(한국시간) 기준 날짜 키(YYYY-MM-DD). offsetDays로 "어제"/"내일"도 계산할 수 있다. */
function todayKeyKST(offsetDays = 0) {
  const kst = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400000);
  return kst.toISOString().split("T")[0];
}

function requireAdmin(auth) {
  if (!auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  if (auth.token?.email !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "관리자 권한이 없습니다.");
  }
}

/** 카카오/구글 연동 또는 스트리머 인증 중 하나라도 됐으면 "계정 보호됨"으로 취급한다. */
function isUserProtected(user) {
  return !!(user?.kakaoLinked || user?.googleLinked || user?.streamerVerified);
}

/**
 * 자산충전/배너/중계방/고정노출 등 "로그인 유저 전용" 셀프 서비스 신청에서
 * 공통으로 쓰는 게이트. 이 앱의 익명 로그인은 접속 시 자동으로 이뤄지므로,
 * 여기서 말하는 "로그인"은 실제로는 계정 보호(카카오·구글 연동, 스트리머
 * 인증, 혹은 관리자 Google 계정)를 뜻한다 — 매크로/도배성 신청을 어렵게 하고,
 * 실제 신원이 있는 유저만 게임자산을 실제 홍보 슬롯으로 바꿀 수 있게 하기 위함.
 */
async function requireLinkedUser(db, uid, auth) {
  if (auth.token?.email === ADMIN_EMAIL) return; // 관리자는 이미 Google 로그인 상태
  const user = (await db.ref(`users/${uid}`).get()).val();
  if (!isUserProtected(user)) {
    throw new HttpsError(
      "permission-denied",
      "로그인이 필요한 기능입니다. 카카오 연동, 구글 연동, 또는 스트리머 인증 후 이용해주세요."
    );
  }
}

/**
 * 점검모드 중엔 관리자를 제외한 모든 "활동성" 액션(매매/충전/홍보 신청 등)을
 * 서버에서도 막는다. 클라이언트(index.html)의 blockIfMaintenance()는 UI만
 * 막을 뿐이라, 개발자도구 등으로 Cloud Function을 직접 호출하면 우회될 수
 * 있었다 — 카운트다운이 끝나 실제로 active 상태가 된 뒤(startAt 경과)만
 * 차단하는 것까지 클라이언트와 동일하게 맞춘다.
 */
async function requireNotInMaintenance(db, auth) {
  if (auth?.token?.email === ADMIN_EMAIL) return;
  const data = (await db.ref("maintenance").get()).val();
  if (data?.active && Date.now() >= (data.startAt || 0)) {
    throw new HttpsError("failed-precondition", "현재 점검 중입니다. 점검이 끝난 후 다시 시도해주세요.");
  }
}

async function findStockIdByName(db, name) {
  const snap = await db.ref("stocks").get();
  const data = snap.val() || {};
  let targetId = null;
  Object.entries(data).forEach(([id, s]) => { if (s.name === name) targetId = id; });
  return targetId;
}

/** endDate 문자열로 활성/만료 여부와 남은 일수를 계산한다. 빈 값이면 무기한(항상 활성). */
function bannerStatus(endDateStr) {
  if (!endDateStr) return { active: true, daysLeft: null };
  const end = new Date(endDateStr);
  end.setHours(23, 59, 59, 999);
  const daysLeft = Math.ceil((end - new Date()) / 86400000);
  return { active: daysLeft >= 0, daysLeft };
}

/**
 * 유저 게임자산(cash)에서 cost만큼 차감한다. 잔액 부족 시 예외를 던진다.
 * trueUser 선조회는 Admin SDK 트랜잭션 콜백에 currentUser가 null(캐시 미스)로
 * 들어와도 "신규 유저 기본값"으로 오판하지 않기 위함 — 트랜잭션 콜백이 활성
 * 리스너 없는 경로는 캐시하지 않는 Admin SDK 특성 때문에 null을 받을 수 있다.
 *
 * allowNegative가 true이면(플레이타임 충전 전용) 잔액이 모자라도 막지 않고
 * 그대로 cost만큼 차감해 마이너스 자산(미수금)이 되도록 허용한다.
 * 반환값의 resultingCash로 차감 후 잔액(음수 여부)을 호출자가 알 수 있다.
 */
async function chargeUserCash(db, uid, cost, { allowNegative = false } = {}) {
  const userRef  = db.ref(`users/${uid}`);
  const trueUser = (await userRef.get()).val();
  let insufficient = false;

  const userTx = await userRef.transaction((currentUser) => {
    const user    = currentUser || trueUser || { cash: INITIAL_CASH, stocks: {} };
    const newCash = (user.cash || 0) - cost;
    if (newCash < 0 && !allowNegative) {
      insufficient = true;
      return; // abort
    }
    return { ...user, cash: newCash };
  });

  if (insufficient) {
    throw new HttpsError("failed-precondition", `게임자산이 부족합니다! (필요 금액: ${cost.toLocaleString()}원)`);
  }
  if (!userTx.committed) {
    throw new HttpsError("aborted", "신청 처리 중 문제가 발생했습니다. 다시 시도해주세요.");
  }

  return { resultingCash: userTx.snapshot.val()?.cash ?? 0 };
}

/** 보유 현금 + 보유 주식 평가금액(현재가 기준)을 합산한 총자산을 계산한다. */
async function computeTotalAssets(db, user) {
  const holdings = Object.entries(user?.stocks || {}).filter(([, s]) => (s?.qty || 0) > 0);
  if (holdings.length === 0) return user?.cash || 0;

  const priceSnaps = await Promise.all(
    holdings.map(([stockId]) => db.ref(`stocks/${stockId}/price`).get())
  );
  const stockValue = holdings.reduce((sum, [, s], i) => {
    const price = priceSnaps[i].val() || 0;
    return sum + price * (s.qty || 0);
  }, 0);

  return (user?.cash || 0) + stockValue;
}

/**
 * 최근 7일 자산 변동 그래프용 — 하루에 한 번(그날 첫 하트비트 시점)만
 * users/{uid}/assetHistory/{YYYY-MM-DD}에 스냅샷을 남긴다. 이미 오늘 기록을
 * 남겼으면(user.lastAssetSnapshotDate === today) 즉시 반환해 매 하트비트마다
 * 무거운 보유주식 가격 조회가 반복되지 않게 한다. 오래된 기록은 매번
 * 같이 정리해 저장량이 무한정 늘지 않게 한다.
 */
async function recordDailyAssetSnapshot(db, uid, user) {
  const today = todayKeyKST();
  if (!user || user.lastAssetSnapshotDate === today) return;

  const cash = user.cash || 0;
  const totalAssets = await computeTotalAssets(db, user);
  const stockValue = totalAssets - cash;

  const updates = {
    [`users/${uid}/assetHistory/${today}`]: {
      totalAssets: Math.round(totalAssets),
      cash: Math.round(cash),
      stockValue: Math.round(stockValue),
      at: Date.now(),
    },
    [`users/${uid}/lastAssetSnapshotDate`]: today,
  };

  const cutoffKey = todayKeyKST(-ASSET_HISTORY_RETENTION_DAYS);
  const histSnap = await db.ref(`users/${uid}/assetHistory`).get();
  const hist = histSnap.val() || {};
  Object.keys(hist).forEach((dateKey) => {
    if (dateKey < cutoffKey) updates[`users/${uid}/assetHistory/${dateKey}`] = null;
  });

  await db.ref().update(updates);
}

/** 유저 게임자산(cash)에 amount만큼 더한다 (배너 신청 환불, 카카오 연동 보너스, 자산 충전 승인 등에 재사용). */
async function creditUserCash(db, uid, amount) {
  if (!uid || !amount) return;
  const userRef  = db.ref(`users/${uid}`);
  const trueUser = (await userRef.get()).val();
  await userRef.transaction((currentUser) => {
    const user = currentUser || trueUser;
    if (!user) return currentUser; // 지급 대상 유저 데이터가 없으면 그대로 둔다
    return { ...user, cash: (user.cash || 0) + amount };
  });
}

module.exports = {
  TEST_PERIOD_ACTIVE,
  ADMIN_EMAIL,
  INITIAL_CASH,
  ANON_INITIAL_CASH_TOPUP,
  LEGACY_INITIAL_CASH,
  LEGACY_INITIAL_CASH_500K,
  STREAMER_ID_RE,
  URL_RE,
  MAX_BANNER_REQUEST_DAYS,
  BANNER_COST_PER_DAY,
  CHART_BANNER_COST_PER_DAY,
  CARD_BANNER_COST_PER_DAY,
  CARD_BANNER_MIN_HOLDING_QTY,
  MAX_PIN_HOURS,
  PIN_COST_PER_HOUR,
  MAX_PINNED_SLOTS,
  PROFIT_RANKING_CHECK_COST,
  PROFIT_RANKING_TOP_N,
  STREAMER_VERIFICATION_NICKNAME_MAX_LENGTH,
  STREAMER_VERIFICATION_COOLDOWN_MS,
  JACKPOT_PRIZE_AMOUNT,
  JACKPOT_PER_ACCOUNT_CAP,
  JACKPOT_TARGET_MIN,
  JACKPOT_TARGET_RATIO,
  JACKPOT_TARGET_VARIANCE,
  LOTTERY_TICKET_PRICE,
  LOTTERY_POOL_FLOOR,
  LOTTERY_PAYOUT_RATIO,
  LOTTERY_DIGIT_MIN,
  LOTTERY_DIGIT_MAX,
  ASSET_HISTORY_RETENTION_DAYS,
  DAILY_ATTENDANCE_REWARDS,
  ANON_DAILY_SECONDS,
  PROTECTED_DAILY_SECONDS,
  PLAYTIME_BASE_RATE,
  PLAYTIME_SURCHARGE_STEP,
  PLAYTIME_SURCHARGE_MAX,
  MAX_PLAYTIME_BUY_HOURS,
  MAX_HEARTBEAT_GAP_SECONDS,
  MAX_RELAY_ROOM_HOURS,
  RELAY_ROOM_COST_PER_HOUR,
  MAX_RELAY_ROOMS,
  STOCK_FREEZE_THRESHOLD,
  STOCK_FREEZE_CANDLE_COUNT,
  STOCK_UNFREEZE_PRICE,
  STOCK_FREEZE_COOLDOWN_MS,
  STOCK_DELIST_DEADLINE_MS,
  UNFREEZE_CASH_COST,
  UNFREEZE_CASH_REWARD,
  UNFREEZE_DONATION_REWARD,
  UNFREEZE_DONATION_BALLOONS,
  ACHIEVEMENTS,
  todayKeyKST,
  requireAdmin,
  requireLinkedUser,
  requireNotInMaintenance,
  isUserProtected,
  findStockIdByName,
  bannerStatus,
  chargeUserCash,
  creditUserCash,
  grantAchievement,
  computeTotalAssets,
  recordDailyAssetSnapshot,
};
