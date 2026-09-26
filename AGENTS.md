# Codex 작업 지침 (AGENTS.md)

이 문서는 `/Users/jaechanpark/Documents/GitHub` 아래 관련 프로젝트에서 Codex가 작업할 때
따르는 공통·프로젝트별 지침이다. 프로젝트 구성이 바뀌면 아래 목록과 각 저장소의
`AGENTS.md`를 함께 확인해 최신 상태로 유지한다.

---

## 0. 이 생태계의 구조

아래 서비스들은 **같은 Firebase 프로젝트(`soop-stock-market`)와 RTDB
(`soop-stock-market-default-rtdb`)를 공유**한다:

- `StreamBet-Market` (스트리머 배팅시장)
- `soop-stock-market` (스트리머 주식시장)
- `interior-3d-viewer` (스트리머 배경시장 / OBS 배경 갤러리)
- `streamer-life-game` (스트리머 인생게임)
- `streamer-gallery` (스트리머 갤러리, 이미지는 Cloudflare R2)
- `onyu-vn` (온이유 비주얼 노벨)
- `streamer-messenger` (스트리머 메신저)

`admin-center`는 이 서비스들의 통합 관리 콘솔이며, 같은 Firebase 프로젝트를 쓰고
자체 `functions/`(codebase: `admincenter`)를 갖는다. 온이유의 인증·접근·후기 callable도
현재 이 codebase에서 관리한다.

`hanja-story-quiz`는 이 생태계와 무관한 독립 프로젝트다.

현재 로컬 폴더에 `rocket-game` 저장소는 없다. 과거 함수명 충돌 사례의 역사적 언급 외에
현행 프로젝트나 배포 대상으로 취급하지 않는다.

---

## 1. 공통 원칙 (모든 프로젝트 공통)

### 1.1 작업 완료 후 자동 커밋·배포
- 사용자가 구현·수정 작업을 요청하면, 검증이 모두 통과한 뒤 별도 확인 없이 작업에 필요한
  변경만 한글 커밋 메시지로 커밋하고 기본 브랜치에 push한다. 완료된 런타임 변경은 해당
  프로젝트의 서버 배포와 GitHub Pages 배포까지 자동으로 진행하고, 배포 완료 여부를 확인한다.
- 서버 코드가 바뀐 경우 변경한 함수·서비스만 정확히 지정해 배포한다. 서버 코드가 바뀌지
  않았다면 서버 배포는 생략한다. 정적 GitHub Pages 프로젝트는 push 후 Pages 배포 작업이
  성공할 때까지 확인한다. 해당 호스팅 구성이 없는 프로젝트에는 임의의 배포 방식을 만들지 않는다.
- 문서 전용 변경은 한글 커밋·push까지 진행하되 서버 배포는 하지 않는다. Pages 사이트의
  문서가 공개 콘텐츠에 포함되는 경우에만 Pages 배포 완료를 확인한다.
- 커밋에는 이번 작업에 속한 파일만 포함한다. 이미 존재하는 사용자 변경, 미추적 지침 파일,
  비밀값·로컬 설정 등 관련 없는 변경은 절대 함께 stage하거나 덮어쓰지 않는다.
- 검증 실패, 배포 대상의 모호성, 자매 서비스에 영향을 줄 수 있는 범위 불명확한 작업,
  필요한 인증·권한 부재가 있으면 커밋/배포를 강행하지 말고 구체적인 원인과 함께 사용자에게 알린다.
- 사용자가 이번 작업에서 커밋·push·배포를 보류하거나 하지 말라고 명시하면 그 지시를 우선한다.
- 커밋 메시지는 한글로 작성한다.

### 1.2 구현 후 검증 필수
코드를 구현한 뒤 배포·커밋으로 넘어가기 전에 반드시 검증 단계를 거친다. 필드명·
파라미터명·상태값을 "이렇게 생겼겠지"라고 추측하지 말고, 실제로 그 데이터를 쓰는
(write) 쪽 소스 코드(자매 레포 포함)를 다시 읽어 대조한다.

검증 없이 넘어갔다면 조용히 묻혔을 실제 사례들:
- 집계 로직에서 `uid` 필드가 실제로는 `requesterUid`였던 걸 가정만 하고 넘어가 절반
  가까운 항목이 누락될 뻔한 일
- 감사 로그 자동 기록 대상 액션 3개가 누락된 일
- 신청 유형 하나가 최근 리팩터로 이미 즉시 자동 승인되도록 바뀌어 있어 "승인 대기"
  큐 UI를 만들어도 절대 나타나지 않는다는 걸 뒤늦게 발견한 일

구체적으로 확인할 것:
1. 문법 검사(`node -c` 등)
2. 새 HTML id/함수명이 정의·호출 양쪽에 다 있는지 교차 확인
3. RTDB 규칙 변경은 `--dry-run`으로 먼저 확인
4. 새로 읽거나 다루는 RTDB 노드의 필드명은 그 노드를 실제로 쓰는 코드를 찾아 대조

### 1.3 Firebase Cloud Functions 배포 — 함수명 유일성 주의
- 이 프로젝트(`soop-stock-market`)는 여러 자매 앱의 Cloud Functions가 함께 배포돼
  있다. `firebase deploy --only functions`처럼 함수명을 지정하지 않고 전체 배포하면,
  로컬 소스에 없는 다른 앱 소유 함수들을 삭제 대상으로 인식한다. **반드시
  `firebase deploy --only functions:<codebase>:<함수명>,...` 형태로 codebase와
  함수명을 지정**해서 변경/추가한 함수만 배포한다.
- 배포 전 `firebase deploy --only functions --project soop-stock-market`을 한 번
  시도해 "found in your project but do not exist in your local source code" 목록이
  뜨면(실제 삭제 전에 중단됨), 그게 지금 시점에 절대 건드리면 안 되는 다른 앱 소유
  함수 목록이다.
- **주의(2026-09-04 실제 발생)**: `codebase`는 firebase-tools가 로컬에서 배포 단위를
  구분하는 개념일 뿐, 실제 GCP Cloud Function 리소스 이름은 codebase로 네임스페이스
  되지 않는다 — 프로젝트+리전 전체에서 함수 이름이 유일해야 한다. 실제로
  과거 `rocket-game`이 활성 상태였을 때 `streamer-gallery`의 `whoAmI`가 동명 함수를
  덮어쓴 적 있다(로직은 우연히 같았고, `galleryCheckAdmin`으로 이름을 바꿔 재발 방지).
  새 함수를 추가할 때는 배포 전 `firebase functions:list --project soop-stock-market`
  으로 겹치는 이름이 없는지 먼저 확인한다.

레포별 codebase:
| 레포 | codebase |
|---|---|
| StreamBet-Market, soop-stock-market | `default` |
| admin-center | `admincenter` |
| interior-3d-viewer | `presetgallery` |
| streamer-life-game | `lifegame` |
| streamer-gallery | `gallery` |
| streamer-messenger | `messenger` |

### 1.4 `database.rules.json` 동기화 필수 (2026-09-26 현황 확인)
- 이 파일의 기준 원본은 `StreamBet-Market`이다. 현재 같은 RTDB 규칙 파일을 보유한
  6개 레포는 `StreamBet-Market`, `soop-stock-market`, `interior-3d-viewer`,
  `streamer-life-game`, `streamer-gallery`, `streamer-messenger`이며, 반드시 바이트 단위로
  동일하게 유지한다. 규칙은 Firebase 프로젝트 전체에 적용되므로 한 레포에서만 수정·배포하면
  다른 서비스의 접근 조건이 유실되거나 오래된 규칙으로 덮어써질 수 있다.
- 규칙을 수정하기 전에는 6개 파일의 실제 내용과 최근 변경 이력을 확인하고, 가장 최신의
  합의된 규칙을 판단한다. `streamer-messenger`도 반드시 모든 규칙 변경을 동기화한다.
- `onyu-vn`은 같은 RTDB를 사용하지만 현재 로컬에 `database.rules.json` 사본이 없다.
  새 사본이 추가되면 이 목록과 동기화 절차를 다시 확인한다.
- **어느 사본을 수정하든 나머지 5개 레포에도 같은 변경을 반영하고, 6개 파일의 diff가
  0줄인지 확인한다.** 부분 수동 편집으로 내용이 갈라지지 않게 한다.
- 배포 전엔 항상 `firebase deploy --only database --project soop-stock-market
  --dry-run`으로 문법부터 확인한다.
- (`admin-center`는 이 파일을 직접 갖지 않는다. Cloud Functions/Admin SDK 작업은 RTDB
  규칙과 별도이며, 브라우저가 RTDB를 직접 구독하는 경로는 실제 규칙의 `.read` 조건을
  따른다.)

### 1.5 신규 자매 프로젝트 온보딩 시 admin-center 등록 체크리스트
새 자매 사이트를 만들 때 `admin-center`에도 반드시 등록해야 하는 항목들
(2026-09-04, 실제 3개 게임이 이 등록 없이 누락된 채 운영됐던 적 있음):
1. **`GAME_CATALOG`**(`functions/index.js`) — 없으면 콘텐츠 동결 토글·게시글 홍보
   현황 관리를 못 씀.
2. **`PRESENCE_APPS`**(`functions/index.js`) — 접속자 수 분석에 포함하려면 등록 +
   클라이언트가 `presence/{appId}/{uid}`에 `{ lastSeen: <ms> }` 형태로 직접 써야 함.
3. **게임별 정지(ban) 관리 UI** — 새 게임에서 개별 유저를 정지하려면 그 게임
   저장소에 자체 `banAccount`/`unbanAccount` 함수(`bannedAccounts/{uid}/games/<name>`
   경로에 씀)를 만들고 admin-center에 전용 UI 섹션을 추가하거나, 최소한 "전체 게임
   정지"(`banAccountAllGames`)로 대응 가능함을 인지한다.
4. **Discord 신고 알림(`makeQueueTrigger`)** — 새 게임에 신고/승인 대기 큐가 생기면
   여기 추가해야 관리자가 즉시 Discord 알림을 받는다.
5. **통합 감사 로그(`listAuditLogOverview`)** — 새 게임의 `auditLog`도 합치려면 이
   함수에 소스를 추가해야 한다.

---

## 2. 프로젝트별 지침

### 2.1 admin-center
같은 Firebase 생태계의 서비스들을 관리하며 관리자만 접근 가능한 통합 관리 콘솔. 사용자 검색, 신고·정지,
감사 로그, R2 파일 점검, 홍보 링크, Adult Image Generator, 온이유 인증·접근·후기 등
기능이 이 저장소의 UI와 `functions/index.js`에 추가된다. 새 기능을 다룰 때는 현재
화면과 callable 구현을 먼저 확인하고, 함수 배포는 `admincenter` codebase와 정확한
함수명을 지정한다.
Firebase Functions 배포 시 `codebase: admincenter`, 함수명 지정 필수
(`firebase deploy --only functions:admincenter:<함수명>,...`).

### 2.2 interior-3d-viewer (스트리머 배경시장)
Three.js 기반 OBS 방송 배경 화면 모음. 번들러 없는 정적 HTML, 페이지별 독립 파일.

- **페이지/기술 스택**: `index.html`·`ski-resort.html`은 three.js **r128**(classic
  script). `fireworks.html`은 최신 three.js를 **ES 모듈(importmap)**로 로드하는
  첫 페이지. **새 배경 페이지는 `fireworks.html`처럼 최신 방식으로 새로 시작**하고,
  기존 r128 페이지는 마이그레이션하지 않는다(회귀 위험 대비 이득 적음). 버전은
  `StreamBet-Market`(`js/winter-scene.js`, `js/firework-scene.js`)과 맞춘다.
- **공통 규칙**:
  - 카메라 항상 고정(`FIXED_ASPECT = 16/9`, `fitCanvas()` 패턴 재사용). 예외:
    `fireworks.html`의 미세한 핸드헬드 흔들림(`applyHandheldShake`)만 예외적으로
    허용, 새 페이지 기본값으로 복사하지 말 것.
  - 상단 devbar, 우측 `#sidePanel` 모든 페이지 공통 — 새 페이지에 통째로 복사.
  - `window.obsstudio` 감지 시 devbar/패널 숨김, 더블클릭 전체화면 전환 전 페이지
    지원 필수.
  - 로컬 프리셋은 `localStorage`의 `interior3dViewer.presets` 키를 모든 페이지가
    공유. 방 설정 없는 페이지는 `{ sceneUrl: '파일명.html' }` 형태로 저장.
  - 공개 갤러리는 Firebase RTDB `presetGallery` + Cloud Functions(codebase
    `presetgallery`). 게시/수정/삭제는 `ADMIN_EMAIL`(`skftodwocks2@gmail.com`) 계정만
    서버(`requireAdmin`)에서 검증 — 클라이언트는 버튼 표시 여부만 판단.
  - 갤러리 "적용"/"OBS" 버튼 클릭은 서버에 자동 집계(`incrementPresetApplyCount`/
    `incrementPresetObsLinkCount`). **새 배경 페이지 만들 때 이 호출을 반드시 같이
    복사** — 빠뜨리면 겉보기엔 정상 작동하는데 집계만 안 되는, 알아채기 어려운 버그가
    생긴다(실제로 `ski-resort.html`/`fireworks.html`에서 발생했었음). `sceneUrl`
    프리셋의 "적용" 버튼은 `location.href` 이동 전에 `#sceneApplyOverlay`를 띄운 채
    집계 요청 완료 또는 5초 안전장치를 기다려야 한다.
  - 배경음은 기본 꺼둠(`soundEnabled: false`) — 방송 중 갑자기 소리 나면 사고 위험.
- **후처리(블러) 관련 — 반드시 지킬 것**:
  - `BokehPass`(또는 씬을 `MeshDepthMaterial`로 다시 그려 깊이 텍스처를 얻는 방식)는
    쓰지 않는다 — 실제 사용자 GPU에서 프레임마다 블러가 깜빡이는 버그가 확인됨. 근본
    원인은 "같은 프레임 안에서 텍스처를 렌더타겟으로 썼다가 바로 다시 읽는" 패턴 자체.
  - 블러(피사계심도)가 필요하면 **틸트시프트 방식**(화면 세로 좌표 `vUv.y`와 고정된
    초점 띠 위치 차이로 블러 반경 결정)을 쓴다(`ski-resort.html`, `fireworks.html`
    구현 참고).
  - 반사는 렌더타겟을 다시 읽는 `Reflector` 대신, 지오메트리를 복제해 y를 뒤집고
    불투명도를 낮추는 "가짜 반사"를 쓴다.
  - `UnrealBloomPass`의 threshold(4번째 인자)를 0으로 두면 넓은 광원이 있을 때 화면
    전체가 뿌옇게 뜬다 — 밝은 표면이 있는 씬이면 0.3~0.4로 올릴 것.
  - `onBeforeCompile`로 셰이더 코드를 끼워 넣을 때, three.js 버전마다 셰이더 청크
    구조가 다르다(r128엔 `#include <opaque_fragment>`가 없고 `gl_FragColor` 인라인).
    `String.replace()`는 매칭 실패 시 조용히 원본을 반환하므로, 삽입이 실제로 됐는지
    `fragmentShader.indexOf(...)`로 확인하는 안전장치를 넣을 것.
- **토글(배경/블러 등) 추가 시**: `localStorage`에만 저장하면 안 된다 — OBS는 별개
  크롬 프로필이라 `localStorage`를 공유하지 않는다. **`localStorage` + URL 쿼리
  파라미터 둘 다** 반영해야 한다(토글 시 `history.replaceState`로 URL 갱신, OBS/공유
  링크에 현재 토글 상태 쿼리로 포함, 로드 시 URL이 `localStorage`보다 우선). 검증 시
  완전히 새 브라우저 컨텍스트/프로필로 열어서 확인할 것(같은 프로필 재사용 테스트는
  이 버그를 못 잡음).
- **테스트**: 빌드/서버 없음. `python3 -m http.server 8080 --directory
  /Users/jaechanpark/Documents/GitHub/interior-3d-viewer`로 로컬 확인. 헤드리스
  브라우저(SwiftShader 소프트웨어 렌더링)는 실제 GPU와 동작이 다를 수 있어 타이밍/
  드라이버 민감 버그는 재현 안 될 수 있음 — 의심되면 사용자에게 실제 브라우저 화면
  녹화 요청.
- **Firebase**: 프로젝트 `soop-stock-market`, codebase `presetgallery`.
  `database.rules.json`은 `presetGallery`/`presetMergeTickets`/`presetMergeFailures`
  노드만 소유 — 나머지는 다른 서비스 소유이니 건드리지 않음.

### 2.3 soop-stock-market (스트리머 주식시장)
- Firebase Functions 배포 시 codebase가 `default`라 `StreamBet-Market`(스트리머
  배팅시장)과 겹친다. 이 레포 소스엔 없지만 실제 배포돼 있는 배팅시장 소유 함수들
  (adminAction, autoTickJackpotProgress, buyLotteryTicket, buyPlayTime,
  checkFrozenStockDelistings, checkProfitRanking, claimDailyAttendance, heartbeat,
  initializeUser, linkGoogleAccount, linkKakaoAccount, openTreasureChest,
  requestStreamerVerification, submitBannerRequest, submitCardBannerRequest,
  submitCashChargeRequest, submitChartBannerRequest, submitListingRequest,
  submitPinRequest, submitRelayRoomRequest, submitTreasureChestPurchaseRequest,
  submitUnfreezeDonationRequest, trade, unfreezeWithCash 등)을 절대 삭제하지 않는다.
  목록은 시점에 따라 부정확할 수 있으므로, 배포 전 `firebase deploy --only functions
  --project soop-stock-market`로 "found in your project but do not exist in your
  local source code" 경고를 먼저 확인한다.

### 2.4 StreamBet-Market (스트리머 배팅시장)
- Firebase Functions 배포 시 codebase가 `default`라 `soop-stock-market`(스트리머
  주식시장)과 겹친다. 이 레포 소스엔 없지만 실제 배포돼 있는 주식시장 소유 함수들
  (adminAdjustBalance, adminLookupUser, addPromotedStreamer, approveChestPurchase,
  approveStreamerRequest, approveVerification, banAccount, blockNickname, cancelBet,
  cancelPendingJudgment, claimAttendance, claimJackpotDraw, closeBettingScheduled,
  closeMarketEarly, dismissChestPurchase, dismissMarketReport, dismissNicknameReport,
  dismissStreamerRequest, distributeJackpotWeekly, equipSkin, exchangeCurrency,
  getAdminDashboardStats, getAnomalyMonitor, getExchangeLog, getStatsTimeseries,
  judgeMarket, onLikeWritten, openChest, placeBet, purchaseSkin, rejectVerification,
  removePromotedStreamer, reportMarket, reportNickname, reviewProposal, revokeVerification,
  sendAdminChatMessage, setMinParticipantsOverride, setVerifiedSoopId, submitChestPurchase,
  submitMarketProposal, submitStreamerRequest, submitVerificationRequest, unbanAccount,
  unblockNickname, updateProfile, voidMarket 등)을 절대 삭제하지 않는다. 배포 전
  `firebase deploy --only functions --project soop-stock-market`로 경고를 먼저 확인.
- `database.rules.json`의 원본 레포다(1.4절 동기화 규칙의 기준 사본).

### 2.5 streamer-life-game (스트리머 인생게임)
스트리머 이름을 검색해 주인공을 짓고 0~100세를 3지선다로 살아보는 인터랙티브 소설
게임. 번들러 없는 정적 HTML + Firebase. codebase `lifegame`.

- **Firebase 프로젝트 공유**: 별도 프로젝트를 새로 만들지 않고 `soop-stock-market`을
  그대로 공유(스트리머 이름 검색용 `stocks` 노드를 바로 읽기 위함). 이 게임 전용
  데이터는 전부 `lifeGame/` 네임스페이스 아래에만 쓴다.
- **스트리머 이름 데이터**: `stocks` RTDB 노드를 매번 직접 읽지 않고
  `streamer-names.json`(루트 - 클라이언트용, `functions/streamer-names.json` -
  서버용, 내용 항상 동일)이라는 정적 파일을 쓴다. **갱신은 스케줄러 없이 수동** —
  사용자가 지시하면 `node scripts/update-streamer-names.js` 실행 후 반드시 두 파일을
  커밋(및 필요 시 배포)해야 실제로 반영된다.
- **게임 콘텐츠**: `functions/game-data.js`의 `STAGES`(0~100세, 101개)는 이미 전
  나이대에 콘텐츠가 채워진 상태(2026-08-26 기준) — "아직 일부만 채워져 있다"고
  오해하지 말고 항상 실제 상태를 먼저 확인한다. 선택지 문장은 결과를 직접 알 수 없게
  쓰고(`publicStage()`가 서버 레벨에서 강제), 엔딩은 `ENDINGS` 배열에 항목만 추가하면
  된다.
- **배열 홀(array hole) 버그 — 반복 발생 주의**: `game-data.js`에 선택지를 대량
  추가할 땐 깊이 카운팅으로 매칭되는 닫는 `]`를 찾아 그 직전에 문자열로 끼워 넣는
  스크립트를 쓰되, **삽입 직전 위치가 이미 트레일링 콤마로 끝나 있는지 반드시 확인**
  해야 한다 — 콤마가 중복되면 문법 오류가 아니라 배열 원소 하나가 통째로 비는 "홀"이
  된다(`node -c`, `.forEach`/`.map`도 못 잡음; `i in arr` 체크나 `for...of`로만
  드러남). 콘텐츠 추가 후 배포 전 체크: 구문 검사 → 배열 홀 0건/id 중복 0건 확인 →
  새 id 존재 여부 대조 → `deltas`/`prizeTable[].deltas`에 오타 키 없는지 확인 →
  `prizeTable` weight 합 100 확인.
- **직업 루트 신설 표준 패턴**: 기존 선택지에 `setOccupation`+`startsRoute`를 얹어
  트리거로 승격시키는 쪽을 우선 고려. 희귀 트리거는 `mandatory: true`로 놓치지 않게
  하고, 동등한 갈림길은 `mandatory` 걸지 않음. 나이가 고정 안 되는 루트는
  `requiresRoute` 전역 배열 패턴 재사용. 직업 내 단계 분화는 `requiresOccupation`
  재사용.
- **일탈(`deviant-*`) 이벤트**: `prizeTable`은 항상 2단계(가벼운 일탈 90/10, 위험한
  일탈 82/18) — 3단계(벌금/징역 세분화) 구조는 쓰지 않는다. 징역 연동은 경제·문서
  범죄+도박 카테고리만.
- **`requiresSufficientCash`**: 비용은 서버가
  `cost = Math.abs(choice.deltas.wealth||0) * cashUnitForAge(나이)`로 자동 계산 —
  절대 금액을 직접 넣지 않는다. 이 검사는 선택 확정 시점에만 작동, 노출 단계엔
  관여 안 함.
- **임대사업 자산(`RENTAL_INCOME_BY_ASSET_ID`)**: 새 임대용 부동산 자산을 추가하면
  이 맵에도 항목을 추가해야 실제 수입이 발생한다. 거주 목적 부동산은 이 맵에 넣지
  않는다.
- **`appearChance`**: 조건은 갖췄지만 매 턴 일정 확률로만 후보에 뜨게 하고 싶을 때
  선택지에 `appearChance: 0~1`을 붙인다(통과 시 그 턴엔 무조건 노출).
- **아키텍처**: 직업·루트·거주지는 저장 필드가 아니라 매번 `choiceLog`에서
  재계산된다(`buildOccupationHistory` 등) — `choiceLog.length = 0` 한 줄로 세 가지
  전부 초기화됨.
- **QA**: 선택지 텍스트가 자산/가족/건강 상태 변화를 암시하는데 `addAsset`/
  `removeAsset`/`requires(No)FamilyMember` 등이 실제로 있는지 대조. Playwright QA
  시 토스트는 `.show` 클래스까지 확인, 주사위 애니메이션은 4500ms+ 대기, `.family-chip`
  클래스는 4개 섹션에서 재사용되므로 셀렉터 주의, 클릭은 `page.click(selector)` 사용.
  프로덕션 RTDB에 실제 기록을 남기는 라이브 테스트는 백그라운드로 돌리면 안전 분류기에
  차단되므로 포그라운드로 넉넉한 타임아웃으로 실행.
- **wealth 커버리지 기준선**: 정상 급여직은 30~37%가 `wealth` 델타를 가짐. 스타성
  직업(인기=수입)은 기준선보다 낮으면서 패시브 소득이 없으면 버그 — "떴다"고 볼 수
  있는 단계부터 `Math.round(stats.fame * cashUnitForAge(nextIndex) / 50)` 공식 검토.
- **커밋/배포**: 검증까지 마치고 이상 없으면 커밋 여부 묻지 않고 바로 커밋+push까지
  자동 진행(2026-09-08, 1.1절 예외 참고). 함수명을 정확히 나열한 배포
  (`functions:lifegame:<함수명>,...`)도 진행 여부 다시 묻지 않고 바로 실행 — 단,
  함수명 없는 전체 배포는 여전히 확인 필요.

### 2.6 streamer-gallery
스트리머·시청자가 방송 화면 스크린샷/AI 일러스트를 올리고 좋아요·댓글로 상호작용하는
갤러리. 자매 사이트와 Firebase 프로젝트/RTDB는 공유하지만 화폐 시스템은 없음(로그인은
신원 확인+신고/차단 식별용). codebase `gallery`.

- 이미지 원본은 RTDB가 아니라 **Cloudflare R2**(버킷 `streamer-gallery`, egress 요금
  없음)에 저장. 업로드는 Cloud Function이 발급한 presigned PUT URL로 클라이언트가 R2에
  직접 업로드(Functions 대역폭 우회). R2 API 크리덴셜은 반드시
  `firebase functions:secrets:set`으로만 저장, 소스에 하드코딩/커밋 금지.
- 업로드 경로(presigned URL 발급 → R2 직접 업로드 → 메타데이터 등록)는 3단계가
  분리돼 있으므로 "업로드는 성공했는데 메타데이터 등록 실패"(고아 파일) 케이스를 항상
  염두에 두고 설계/검증.

### 2.7 onyu-vn
번들러 없는 정적 비주얼 노벨이며 Firebase Authentication과 공유 RTDB를 사용한다.
온이유 전용 데이터는 `onyuVn/` 아래에 두며, 현재 공유 규칙 사본에서는 해당 경로의
클라이언트 `.read`/`.write`를 차단한다. 인증·접근 판정·플레이 후기 저장 같은 서버
작업은 `admin-center/functions/`의 callable을 통해 처리하고, 사용자 인증과 관리자
권한은 서버에서도 검사한다. 새 callable 추가 시 `admincenter` codebase와 전역 함수명
유일성을 확인한다. 게임 페이지 배포는 GitHub Pages 흐름을 따른다.

### 2.8 streamer-messenger
`streamer-messenger`는 같은 Firebase 프로젝트와 RTDB를 사용하는 서비스이며 Cloud Functions
codebase는 `messenger`다. 이 저장소의 `database.rules.json`은 현재 동일 RTDB를 사용하는
나머지 다섯 사본과 바이트 단위로 동일하게 유지한다. RTDB 규칙은 전체 프로젝트에 적용되므로
수정 전 모든 사본의 최신 내용과 변경 이력을 확인하고, 변경 사항은 여섯 사본 전부에
동기화·검증한다. messenger 전용 접근 조건도 전체 규칙 안에서 보존한다.

### 2.9 hanja-story-quiz
독립 프로젝트, 이 생태계와 무관. 작업이 끝나면 한글로 summary를 채우고 커밋한다.

---

## 3. Codex 사용 시 참고
- 자동 커밋·push·배포 정책은 이 사용자가 명시적으로 설정한 기본 정책이다. 이번 작업에서
  보류를 요청한 경우나 저장소 소유·배포 권한이 불분명한 다른 계정/저장소에서는 적용하지 않는다.
- 여러 레포에 걸친 변경(특히 `database.rules.json` 동기화, Cloud Functions 함수명
  중복 확인)은 한 레포만 보고 작업하면 놓치기 쉬우므로, 작업 시작 전에 이 문서의
  0~1절을 먼저 훑는다.
