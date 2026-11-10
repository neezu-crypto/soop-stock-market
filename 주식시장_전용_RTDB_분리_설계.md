# 주식시장 전용 RTDB 분리 설계

작성일: 2026-11-09  
상태: 2026-11-10 운영 전환 완료(A·B·C·D). 전용 DB 규칙 배포, 시장 데이터 복사·hash 대조(32개 경로 일치), `market-primary` 전환, 클라이언트·자매 서비스 전환 배포. 관찰(E)·레거시 정리 진행 중.
전환 중 발견: `instance:'*'` DB 트리거는 전용 인스턴스 쓰기도 받아 한 요청이 수천 이벤트면 `TOO_MANY_TRIGGERS`가 난다(복사는 자식 단위 분할로 해결). `getDatabase(app, url)`은 URL을 받지 않으므로 `getDatabaseWithUrl(url, app)`을 쓴다.

## 1. 목적

주식시장 데이터의 읽기·쓰기 부하를 공유 기본 RTDB에서 분리해 다음을 달성한다.

- 주식시장 실시간 시세·차트 트래픽이 인증, 통합 캐시, 다른 게임 서비스에 영향을 주지 않게 한다.
- RTDB 사용량을 주식시장 단위로 확인하고 최적화한다.
- 기본 DB의 공용 계정·인증 경로를 유지해 기존 로그인과 스트리머 인증을 깨지 않는다.

분리 자체는 다운로드 바이트를 줄이지 않는다. 다운로드 절감은 이후 전체 목록 조회, 불필요한 구독, 차트 조회 범위를 별도로 최적화해 달성한다.

## 2. 목표 구조

### 2.1 인스턴스

| 구분 | 인스턴스 | 역할 |
| --- | --- | --- |
| 공유 기본 DB | `soop-stock-market-default-rtdb` | Firebase Auth와 연결된 공용 계정·인증·통합 캐시·관리 데이터 |
| 주식시장 전용 DB | `soop-stock-market-rtdb` (신규) | 시세, 차트, 시장 상태, 시장 전용 신청·거래·보유 데이터 |

두 인스턴스는 같은 Firebase 프로젝트와 Firebase Authentication을 공유한다. 웹 클라이언트는 `sharedDb`와 `stockDb`를 동시에 만들되, 화면별 필요한 경로만 연결한다.

### 2.2 기본 DB에 유지할 공용 데이터

- `users/{uid}` 중 계정 식별·로그인 연동·스트리머 인증 관련 필드
  - `googleLinked`, `kakaoLinked`, `streamerVerified`, 계정 전환 신호 등
- `streamerVerifications`, `streamerVerificationsPublic`, `streamerNames`, `privateUserIds`
- `gameSeriesWallet`, `cashChargeRequests` 등 통합 캐시·고객센터 원장
- `adminCenter`, `maintenance`, `announcement`, `bannedAccounts`, 공용 `presence`
- 배팅시장·팬페이지·메신저·인생게임 등 다른 서비스 소유 경로

### 2.3 전용 DB로 이전할 시장 소유 데이터

초기 이전 후보는 아래와 같다. 정확한 최종 목록은 실제 writer와 reader를 다시 대조한 뒤 확정한다.

| 분류 | 경로 |
| --- | --- |
| 종목·시세 | `stocks`, `stocksPublic`, `pinnedStocks`, `rankings`, `lastUnfreezeEvent` |
| 차트 | `candlesticks`, `sparklines` |
| 시장 계정 | `stockMarket/accounts/{uid}` (신규), `stockMarket/*` |
| 상장·상폐 | `listingRequests`, `delistedStocksLog`, 동결 관련 시장 데이터 |
| 시장 상품 | `lottery`, `lotteryFreeClaims`, `lotteryPurchases`, `lotteryTicketRequests`, `lotteryTripleSevenLog` |
| 시장 내 홍보 | `bannerRequests`, `chartBanner`, `chartBannerRequests`, `cardBannerRequests`, `pinRequests`, `relayRooms`, `relayRoomRequests` |
| 보물상자 | `treasureChestRequests`, `treasureChestOpens` 및 시장 소유 보유·구매 이력 |

### 2.4 전용 DB의 확정 경로 골격

```text
stockMarketAdminUids/{uid}                  # 서버가 기본 DB 관리자 목록에서 동기화하는 비공개 권한 미러

stockMarket/accounts/{uid}                  # 본인만 읽는 시장 현금·보유 종목·출석·도전과제
stockMarket/operations/{operationId}        # 교차 DB 차감·지급 보상 처리 원장
stockMarket/treasureChestInventory/{uid}    # 구매 순서·보너스 묶음·취소 가능 상태, callable 전용
stockMarket/migration/*                     # 전환 상태·대조 hash·폴백 계측, 클라이언트 비공개
stockMarket/auditLog/{entryId}              # 시장 작업 감사 로그, 클라이언트 비공개
stockMarket/jobs/{jobId}                    # 재시도 가능한 비동기 시장 작업, 클라이언트 비공개

stocks/{stockId}                            # 서버 전용 원본 종목
stocksPublic/{stockId}                      # 공개 카드·현재가 전용 뷰
candlesticks/{stockId}/{minuteTs}           # 공개 분봉
sparklines/{stockId}                        # 공개 미니차트
rankings/top5                               # 공개 거래량 상위 종목
rankings/profitEntriesPublic/{uid}          # 공개 수익 랭킹 뷰
```

전용 DB에는 기본 DB의 관리자 UID를 직접 참조할 수 없으므로, `stockMarketAdminUids`는 서버가 동기화하는 최소 권한 미러다. 브라우저가 쓰지 않으며, 관리자 판정은 이 미러와 서버의 기본 DB 재검증을 함께 사용한다.

### 2.5 기존 `users/{uid}` 시장 필드의 이전 명세

기본 DB의 `users/{uid}` 전체를 복사하거나 삭제하지 않는다. 아래 시장 전용 필드만 `stockMarket/accounts/{uid}`로 옮긴다.

```text
cash, stocks, lastTradeTime, tradeCount
lastAttendanceDate, attendanceStreak
achievements, assetHistory, lastAssetSnapshotDate
realizedPL
playQuotaDate, playSecondsUsedToday, bonusSecondsToday, lastHeartbeatAt, purchasedHoursToday, playTimeExpiresAt 등 주식시장 이용 시간 상태
anonTopUpAppliedAt, lastListingRequestAt
lotteryTicketCharges, lotteryTicketPayouts, treasureChests
```

기존 `users/{uid}/treasureChests`는 이미 보유한 레거시 상자 수다. 전환 때 시장 계정의 `stockMarket/accounts/{uid}/treasureChests`로 복사하고, 새 코드가 이 값을 먼저 개봉하도록 한다. 레거시 값은 충분한 검증 기간 동안 기본 DB에서 삭제하지 않는다. 이 절차는 기존 상자 보유·선입선출 개봉·취소 정책을 보존하기 위한 필수 조건이다.

## 3. 사용자 시장 계정 분리

현재 시장 현금·보유 종목은 `users/{uid}`에 있고, 인증 필드도 같은 객체에 섞여 있다. 전용 DB로 시세만 옮기면 거래 때 기본 DB의 사용자 잔고와 전용 DB의 종목 가격을 함께 갱신해야 한다.

따라서 시장 전용 상태는 다음 경로로 옮긴다.

```text
stockMarket/accounts/{uid}
  cash
  stocks
  lastTradeTime
  tradeCount
  realizedPL
  attendance / attendanceStreak
  achievements
  playQuotaDate / playSecondsUsedToday / bonusSecondsToday / lastHeartbeatAt / purchasedHoursToday
  assetHistory / lastAssetSnapshotDate / anonTopUpAppliedAt / lastListingRequestAt
  시장 전용 복권·보물상자 상태
```

기본 DB `users/{uid}`에는 계정 보호·인증에 필요한 필드만 남긴다. 클라이언트는 `identityData`와 `marketAccountData`를 별도 구독하고, 렌더링 시에만 읽기 전용 화면 상태 `myData`로 조합한다. 따라서 인증 변경이 시장 포트폴리오 전체 재전송을 유발하지 않는다.

## 4. 교차 DB 처리 원칙

RTDB 트랜잭션은 인스턴스를 넘어서 원자적으로 실행되지 않는다. 다음 작업은 단일 `update()`로 처리하면 안 된다.

- 주식 매매: 종목 가격·거래량·사용자 현금·보유 수량
- 통합 캐시 보물상자 구매: 기본 DB 통합 캐시 차감·전용 DB 보물상자 지급
- 승인·취소·환불: 시장 신청 상태와 통합 캐시 반환

### 4.1 보상 처리 원장

각 교차 DB 작업에는 요청 ID를 사용하고, 시장 DB에 변경 불가능한 작업 원장을 둔다. 통합 캐시의 원래 입출금 기록은 계속 기본 DB에 남긴다.

```text
stockMarket/operations/{operationId}
  type: stockChestPurchase | stockPromotionPurchase | ...
  uid
  status: processing | complete | failed
  createdAt / updatedAt
  payloadHash
```

처리 순서:

1. 요청 ID와 payload hash로 작업 원장을 `processing`으로 예약한다.
2. 기본 DB 또는 전용 DB의 첫 단계 변경을 기록한다.
3. 반대 DB 변경을 idempotent하게 적용한다.
4. 양쪽 결과를 재조회해 `complete`로 확정한다.
5. 중단·오류는 `failed`로 남기고 관리자 조회·재처리에서 같은 요청 ID로 재개한다.

이미 처리된 요청은 다시 차감·지급하지 않는다. 보상 처리 실패를 조용히 무시하지 않고, 감사 로그와 관리자 경고 대상에 남긴다.

### 4.2 거래 처리

매매는 전용 DB 내부에서 종목·시장 계정을 처리한다. 인증·정지·점검은 시작 전에 공유 기본 DB에서 읽기만 한다.

1. 공유 DB에서 로그인·정지·점검·인증 상태를 검사한다.
2. 전용 DB에서 종목 가격과 `stockMarket/accounts/{uid}`를 순서 보장 로직으로 갱신한다.
3. 실패 시 전용 DB의 작업 원장을 기준으로 되돌리거나 재처리한다.
4. 차트·스파크라인·랭킹은 거래 확정 뒤 best-effort가 아니라 재시도 가능한 후속 작업으로 기록한다.

### 4.3 관리자 권한 미러와 전환 차단 스위치

전용 DB 규칙에서 관리자 경로를 보호하려면 `stockMarketAdminUids/{uid}`가 필요하다. 이는 다음 방식으로 관리한다.

1. 최초 전환 전에 서버 Admin SDK로 공유 DB `adminCenter/adminUids`를 읽어 전용 DB 미러를 채운다.
2. 이후 공유 DB의 관리자 UID 변경을 감지하는 서버 트리거가 전용 DB의 동일 UID를 `true` 또는 `null`로 동기화한다.
3. 관리자 callable은 규칙 미러만 신뢰하지 않고, 항상 공유 DB의 관리자 권한을 다시 확인한다.
4. 미러 동기화 실패는 관리자 알림과 재처리 작업으로 남긴다. 실패한 경우 권한을 넓히지 않으며 관리자 전용 요청은 거절한다.

전환 선택 상태는 **공유 기본 DB**의 `adminCenter/stockMarketDatabaseMigration/state`에 둔다. 전환 시 `phase === "market-primary"`일 때만 전용 DB를 선택하고, 그 외 모든 상태는 기본 DB를 유지한다. 전용 DB의 `stockMarket/migration`은 대조 결과·폴백 계측만 보관하며, 전환 판단의 기준으로 쓰지 않는다.

## 5. 다른 서비스 연동 변경

시장 공개 데이터는 다음 서비스도 사용하므로 참조를 함께 바꾼다.

| 소비 서비스 | 변경 대상 |
| --- | --- |
| 배팅시장 | 종목 제안·홍보 목록의 `stocksPublic` |
| 팬페이지·고점체크 | 종목 주가와 `sparklines` |
| 메신저 | 채팅방 시장의 `stocksPublic`, `sparklines` |
| 인생게임 | 시장 변동에 따른 `candlesticks`, `sparklines` 갱신 |
| 통합 관리 센터 | 상장·홍보 신청 대기열, 시장 현황, 감사 로그 |

공개 시세를 읽는 클라이언트에는 다음처럼 명시적인 전용 DB 참조를 사용한다.

```js
const sharedDb = getDatabase(app);
const stockDb = getDatabase(app, 'https://soop-stock-market-rtdb.firebaseio.com');
```

인증·통합 캐시·관리자 권한은 `sharedDb`, 시세·차트는 `stockDb`만 사용한다. 한 화면에서 기본 DB 루트 전체를 전용 DB로 바꾸는 방식은 금지한다.

## 6. 보안 규칙

- 전용 DB 규칙 파일은 `stock-market.database.rules.json`으로 로컬 전용 관리한다. 실제 배포 전 target 연결과 dry-run 검증을 수행하며, 규칙 배포는 운영 전환 단계에서만 진행한다.
- 클라이언트 직접 쓰기는 시세·거래·신청·보물상자 원장에 허용하지 않는다.
- 클라이언트는 공개 시세·필요한 개인 시장 계정만 읽는다.
- 관리자 전용 신청·감사 경로는 서버 callable만 접근한다.
- 규칙 배포 전 `firebase deploy --only database:stockmarket --dry-run`으로 검증한다.
- 최종 규칙 파일은 Git에 올리지 않고 외장 SSD의 `RTDB-Rule-Backups`에 권한 600으로 백업한다.

## 7. 단계별 전환 절차

### 단계 A — 준비

1. `soop-stock-market-rtdb` 인스턴스를 만들고 전용 규칙을 작성한다.
2. 모든 시장 reader/writer를 목록화하고, 각 경로의 소유 서비스·필드·권한을 대조한다.
3. 클라이언트·함수에 `sharedDb()`와 `stockDb()` 접근 계층을 추가한다.
4. 관리자센터에 전환 상태와 실패 작업 조회만 추가한다.
5. 관리자 UID 미러 초기 동기화·해제 동기화·실패 알림을 구현하고 테스트한다.
6. `users/{uid}` 시장 필드와 레거시 보물상자 수의 이전 매핑을 테스트 데이터로 검증한다.

### 단계 B — 검증용 복사

1. 운영 쓰기를 중단하기 직전, 기본 DB의 대상 경로 전체를 외장 SSD에 백업한다.
2. 전용 DB의 같은 경로도 빈 상태임을 기록한다.
3. 대상 데이터만 전용 DB에 복사한다.
4. 경로별 canonical JSON hash·항목 수·바이트 수를 대조한다.
5. 검증 실패 시 기본 DB는 건드리지 않고 전용 DB 전환을 중단한다.
6. `stockMarket/accounts/{uid}`(기존 상자 수 포함)와 `treasureChestInventory/{uid}`의 항목 수·금액·상자 수를 사용자 단위로 대조한다.

### 단계 C — 읽기 전환

1. 서버 함수부터 전용 DB 읽기·쓰기로 전환한다.
2. 주식시장 클라이언트와 연동 서비스의 시세·차트 참조를 전용 DB로 전환한다.
3. 짧은 관찰 기간에는 전용 DB를 우선 읽고, 누락 경로만 기본 DB를 읽는 읽기 전용 폴백을 둔다.
4. 폴백으로 읽힌 횟수는 관리자 감사 로그에 기록한다.

### 단계 D — 정리

1. 로그인, 거래, 차트, 상장 신청, 보물상자, 통합 캐시 구매·취소, 팬페이지·메신저·배팅시장 연동을 모두 검증한다.
2. 폴백 조회가 0이고 전용 DB 데이터가 일치할 때만 기본 DB의 시장 경로를 삭제 대상으로 확정한다.
3. 삭제 직전에 기본 DB와 전용 DB를 다시 외장 SSD에 백업하고 hash를 검증한다.
4. 경로 단위로만 기본 DB의 레거시 시장 데이터를 정리한다. 전체 기본 DB 교체는 금지한다.
5. 레거시 경로 삭제는 사용자 승인으로 정한 관찰 기간과 복구 계획이 충족된 뒤에만 실행한다.

## 8. 검증 시나리오

- 기존 Google·Kakao·스트리머 인증 로그인 유지
- 기존 사용자 포트폴리오·현금·출석·도전과제 일치
- 기존 보물상자·복권·자산 이력·이용 시간 상태 일치
- 신규 사용자 초기 자산 생성
- 매수·매도 성공, 잔액 부족, 동시 거래, 네트워크 중단 후 재접속
- 시세 카드·분봉 차트·스파크라인·랭킹 갱신
- 팬페이지·고점체크·메신저·배팅시장에서 주가 표시
- 통합 캐시 보물상자 구매, 10개 보너스, 취소·환불 조건, 중단 후 재처리
- 상장·차트배너·카드배너·핀·중계방 신청과 관리자 승인
- 전환 중 중복 요청·재시도·작업 원장 복구
- 기본 DB 레거시 경로를 읽지 않는지 감사 로그·Monitoring으로 확인

## 9. 완료 기준

- 대상 경로의 전환 전·후 hash와 항목 수가 일치한다.
- 모든 적용 가능한 검증 시나리오가 통과한다.
- 교차 DB 작업이 중단되어도 중복 차감·중복 지급·자산 손실이 없다.
- 관리자 UID 미러가 추가·해제 모두 공유 기본 DB와 일치하고, 미러 동기화 실패 시 권한이 확대되지 않는다.
- 다른 서비스의 주가·차트·신청 화면이 전용 DB를 정상 참조한다.
- 기본 DB의 시장 레거시 경로를 제거한 뒤에도 폴백 읽기가 발생하지 않는다.

## 10. 비목표

- Firebase Authentication, 스트리머 인증, 통합 캐시를 새 DB로 옮기지 않는다.
- 전환 과정에서 전체 기본 RTDB를 덮어쓰지 않는다.
- 전용 DB 분리만으로 다운로드 비용이 감소한다고 가정하지 않는다.
- 별도 사용자 공지·점검 일정·실제 데이터 이전은 이 문서만으로 실행하지 않는다.

## 11. 주식시장 코드 파일별 변경 목록

이 절은 실제 전환 구현 때 수정할 파일과 책임을 정리한 목록이다. **기본 DB의 `db`를 전역적으로 전용 DB로 치환하지 않는다.** 각 읽기·쓰기는 데이터 소유권에 따라 `sharedDb` 또는 `stockDb`를 명시적으로 받거나 선택해야 한다.

### 11.1 주식시장 클라이언트

| 파일 | 변경 내용 | 유지할 기본 DB 경로 | 전용 DB로 바꿀 경로 |
| --- | --- | --- | --- |
| `index.html` | Firebase 초기화를 `sharedDb = getDatabase(app)`와 `stockDb = getDatabase(app, STOCK_DATABASE_URL)`로 분리한다. 로그인 사용자 구독도 신원 데이터와 시장 계정을 별도로 구독해 화면용 상태로 합친다. 전환 상태가 준비되지 않았을 때만 읽기 전용 폴백을 적용하고 폴백 횟수를 기록한다. | `users/{uid}`의 로그인·인증 상태, `gameSeriesWallet/accounts/{uid}`, `maintenance`, `announcement`, `devbarLinks`, `presence/stockMarket/{uid}` | `stockMarket/accounts/{uid}`, `stocksPublic`, `stocks`, `candlesticks`, `sparklines`, `rankings`, `lottery`, `relayRooms`, 시장 신청·공개 시세 |
| `js/chartModal.js` | 차트 모듈 생성 시 `stockDb`를 주입받도록 바꾸고, 캔들·시세·스파크라인 조회가 기본 DB를 참조하지 않도록 한다. 모듈 내부에서 기본 DB를 새로 만들지 않는다. | 없음 | `candlesticks/{stockId}`, `stocksPublic/{stockId}`, `sparklines/{stockId}` |
| `maintenance-admin-gate.js` | 점검 우회 권한은 공유 관리자 권한과 공유 점검 상태를 기준으로 계속 검사한다. 전용 DB를 추가하지 않는다. | `adminCenter/adminUids`, `maintenance` | 없음 |

`index.html`에서 현재 `users/{uid}` 한 번의 구독으로 채우는 `myData`는 그대로 시장 원장으로 쓰지 않는다. `identityData`(기본 DB)와 `marketAccount`(전용 DB)를 분리한 뒤 렌더링 직전에 읽기 전용 화면 상태로 조합한다. 이렇게 해야 스트리머 인증·통합 캐시·계정 연동이 시장 데이터 이전 실패로 영향을 받지 않는다.

### 11.2 공통 서버 DB 접근 계층

| 파일 | 변경 내용 |
| --- | --- |
| `functions/market-databases.js` (신규) | Admin SDK의 기본 인스턴스를 반환하는 `sharedDb()`와 전용 URL을 명시한 `stockDb()`를 제공한다. 전용 DB 준비 상태 확인, 관리자 UID 미러 확인, 전환 버전 확인을 이 계층에 둔다. 경로 문자열만 보고 자동으로 DB를 고르는 범용 `routedDb()`는 만들지 않는다. |
| `functions/index.js` | 기존 기본 앱 초기화와 Auth는 유지한다. 함수별로 위 두 DB 접근 계층을 전달하도록 정리하고, 전환 상태 조회·관리자 UID 미러 동기화·이전 감사용 함수만 별도 export한다. 배포 시 변경된 함수명만 `functions:default:<이름>`으로 지정한다. |
| `functions/common.js` | `requireLinkedUser`, 점검·정지·관리자 검사처럼 신원에 관한 헬퍼는 기본 DB에 남긴다. 현금·도전과제·자산 이력·일일 스냅샷·시세 랭킹처럼 시장 원장을 바꾸는 헬퍼는 `stockDb`를 명시적으로 받도록 분리한다. |

### 11.3 거래·자산·게임 경제 서버 함수

| 파일 | 변경 내용 |
| --- | --- |
| `functions/trade.js` | 기본 DB에서 신원·정지·연동 상태만 확인하고, 전용 DB transaction으로 `stockMarket/accounts/{uid}`·`stocks/{stockId}`·캔들·스파크라인을 처리한다. 현재의 사용자 잔액과 시세를 서로 다른 DB에서 순차적으로 되돌리는 구조는 제거하고, 작업 ID·멱등 키·보류/완료 원장을 둔다. |
| `functions/attendance.js` | 출석일·연속 출석·보상 기록과 시장 재화 증감은 전용 시장 계정으로 옮긴다. 구독·인증 여부 확인은 공유 기본 DB에서 읽는다. |
| `functions/playTime.js` | 주식시장 이용 시간, 구매 이력, 자산 스냅샷과 시장 재화 차감은 전용 DB로 옮긴다. Firebase 계정·점검·정지 검사만 공유 DB에 남긴다. |
| `functions/lottery.js` | 복권 풀·티켓·당첨·지급 원장과 시장 계정 잔액은 전용 DB에서 처리한다. 외부 구독 권한 등 공유 상태를 필요로 하면 읽기만 하고, 두 DB를 걸친 지급은 작업 원장으로 재시도 가능하게 만든다. |
| `functions/profitRanking.js` | 자산 기반 순위 산출과 `rankings/*` 공개 결과를 전용 DB에서 관리한다. 기본 DB의 `users` 전체 스캔에 의존하지 않도록 변경한다. |
| `functions/stockFreeze.js` | 상장 종목 동결·상장폐지·해제·관련 시장 로그를 전용 DB로 옮긴다. 스케줄러는 전용 DB만 스캔하며, 관리자 신원은 공유 DB로 확인한다. |

### 11.4 보물상자·신청·홍보 기능

| 파일 | 변경 내용 |
| --- | --- |
| `functions/treasureChest.js` | 통합 캐시 지갑(`gameSeriesWallet`)과 사용자 신원은 기본 DB에 남기고, 보물상자 재고·구매·개봉·취소 원장은 전용 DB로 옮긴다. 두 DB를 함께 바꾸는 구매·취소·환불은 `stockMarket/operations/{operationId}`로 상태를 남겨 중복 지급·차감을 막는다. 기존 `users/{uid}/treasureChests`는 복사 검증 전 삭제하지 않는다. |
| `functions/listingRequests.js` | 상장 신청·검토 결과·종목 생성은 전용 DB에 저장한다. 신청자의 로그인/인증 확인만 공유 DB에서 수행한다. |
| `functions/bannerRequests.js`, `functions/cardBannerRequests.js`, `functions/pinRequests.js`, `functions/relayRoomRequests.js`, `functions/sharedChartBanners.js` | 주식시장 화면에만 쓰이는 신청·승인 대기열·공개 결과는 전용 DB로 옮긴다. 다른 서비스가 함께 쓰는 공통 홍보 데이터는 사전 경로 대조 후 기본 DB에 남긴다. |
| `functions/promotionCash.js`, `functions/subscriptionBenefits.js` | 통합 구독·통합 캐시의 권한/잔액 원장은 공유 DB에 유지한다. 주식시장에만 반영되는 무료 지급·혜택 사용 내역은 전용 DB에 기록하고, 교차 DB 지급은 보물상자와 같은 작업 원장을 사용한다. |

### 11.5 관리자·집계·연동 서버 함수

| 파일 | 변경 내용 |
| --- | --- |
| `functions/admin.js` | 관리자 인증·감사 권한은 기본 DB, 종목·계정·신청 처리와 시장 감사 로그는 전용 DB로 분리한다. 관리자 액션마다 어떤 DB 경로를 쓰는지 표로 검증한다. |
| `functions/usageMetrics.js` | 기본 DB와 전용 DB의 다운로드·읽기량·데이터 크기를 분리해 관리자 통계에 표시한다. 하나의 합계만 보고 원인을 판단하지 않도록 인스턴스별 지표를 보존한다. |
| `functions/crewSheetSync.js`, `functions/streamerNamesSync.js` | 종목명·크루명·공개 종목 목록을 갱신하는 쓰기는 전용 DB로 바꾼다. 스트리머 인증 원본은 공유 기본 DB에 유지한다. |
| `functions/presence.js`, `functions/streamerVisitLog.js` | 서비스 접속·방문 기록은 공유 기본 DB에 그대로 둔다. 시장 시세 데이터와 함께 옮기지 않는다. |
| `functions/google.js`, `functions/kakao.js`, `functions/streamerVerification.js` | 로그인·계정 연결·스트리머 인증은 공유 기본 DB에 유지한다. 이 파일에서 시장 도전과제/보상이 호출되는 경우에만 해당 부분에 `stockDb`를 명시적으로 주입한다. |
| `functions/privacyMigration.js` | 개인정보 열람·삭제 흐름이 기본 DB와 전용 DB 양쪽의 시장 데이터를 모두 포함하도록 수정한다. 삭제 작업은 각 DB에서 성공을 확인한 뒤에만 완료 처리하며, 실패는 재처리 큐에 남긴다. |

### 11.6 자매 서비스와 통합 관리 센터 변경 대상

| 저장소·파일 | 변경 내용 |
| --- | --- |
| `StreamBet-Market/js/promoted-streamers.js`, `StreamBet-Market/js/propose-modal.js` | `stocksPublic` 조회를 전용 주식시장 DB로 바꾼다. 배팅 데이터·사용자 지갑은 공유 기본 DB에 남긴다. |
| `streamer-fanpage/app.js` | 고점체크·팬페이지의 `stocksPublic`, `sparklines` 참조만 전용 DB로 분리한다. 팬페이지 인증·사용자 데이터는 공유 DB를 유지한다. |
| `streamer-messenger/js/firebase-init.js`, `streamer-messenger/js/app.js` | 메신저 자체 DB와 공유 DB의 현재 분리 구조를 유지하면서, 시장 종목·스파크라인 전용 세 번째 DB 참조를 추가한다. |
| `streamer-life-game/functions/index.js` | 인생게임이 쓰는 `candlesticks`, `sparklines` 업데이트를 전용 주식시장 DB로 명시 전환한다. 인생게임 세션·인증 데이터는 인생게임 DB/공유 DB에 그대로 둔다. |
| `admin-center/functions/index.js` 및 해당 관리 화면 | 상장·홍보·차트 배너·카드 배너·핀·중계방·보물상자·시장 감사 로그의 reader/writer를 전용 DB로 바꾼다. 관리자 권한과 전체 서비스 설정은 공유 기본 DB를 유지한다. |

### 11.7 Firebase 설정·전환 도구

| 파일 | 변경 내용 |
| --- | --- |
| `.firebaserc` | `stockmarket` database target을 전용 인스턴스에 연결한다. |
| `firebase.json` | `database` 설정에 `target: "stockmarket"`, 로컬 전용 `stock-market.database.rules.json`을 연결한다. 실제 배포 전에는 dry-run으로 대상 인스턴스를 확인한다. |
| `stock-market.database.rules.json` | 작성된 전용 DB 규칙 초안이다. Git·Pages 산출물에는 포함하지 않고, 실제 규칙 배포 전 외장 SSD 백업과 바이트 대조를 다시 수행한다. |
| `scripts/migrate-stock-market-rtdb.js` (신규, 로컬 운영 도구) | 경로별 export/hash/항목 수 검증 후 복사만 수행한다. 기본 DB 삭제 기능은 별도 명령·별도 확인 절차로 분리하며, 기본 동작으로 삭제하지 않는다. |
| `scripts/verify-stock-market-rtdb-migration.js` (신규, 로컬 운영 도구) | 사용자별 시장 계정, 종목, 캔들, 상자, 신청 큐의 hash·개수·금액을 대조하고 불일치 보고서를 만든다. |

### 11.8 구현 순서와 파일 단위 완료 조건

1. `market-databases.js`와 전용 규칙·Firebase target을 준비한 뒤, 테스트 인스턴스에서 연결만 검증한다.
2. `common.js`와 `trade.js`를 먼저 전환해 시장 계정·거래의 단일 원장을 만든다.
3. 출석·복권·이용 시간·랭킹·보물상자와 신청 기능을 전환하고, 각 함수별 멱등 재시도를 검증한다.
4. `index.html`, `chartModal.js`, 자매 서비스, 관리자센터의 읽기 경로를 전용 DB로 변경한다.
5. migration/verify 도구의 결과가 일치하고 폴백 조회가 0일 때만 기본 DB의 레거시 시장 경로 정리를 별도 작업으로 검토한다.

각 파일 변경 후에는 실제 writer의 필드명과 대상 경로를 다시 대조하고, 새 함수가 기존 배포 함수명과 충돌하지 않는지 `firebase functions:list --project soop-stock-market`으로 확인한다.

## 13. 운영 전환 작업 기획서

### 13.1 작업 목표와 완료 범위

주식시장 전용 RTDB로 시장 원장을 분리하되, Firebase 로그인·스트리머 인증·통합 캐시·다른 게임의 계정 데이터를 공유 기본 DB에 유지한다. 전환은 한 번에 전체 기본 DB를 교체하는 방식이 아니라, 시장 소유 경로만 검증 후 전용 DB로 복사하고 reader/writer를 단계적으로 바꾸는 방식으로 진행한다.

이번 운영 작업의 완료 기준은 아래 네 가지다.

1. 전용 DB의 시장 데이터가 복사 직전 기본 DB 데이터와 경로별 hash·수량·금액 기준으로 일치한다.
2. 시장 거래·출석·복권·보물상자·신청/승인과 자매 서비스 시세 표시가 전용 DB에서 정상 동작한다.
3. 로그인, 스트리머 인증, 통합 캐시 지갑, 배팅시장·팬페이지·메신저 자체 데이터가 기본 DB에서 계속 정상 동작한다.
4. 관찰 기간 동안 전환 폴백·권한 오류·교차 DB 작업 실패가 없고, 관리자 화면에서 작업 원장과 신청 큐를 확인할 수 있다.

### 13.2 역할과 데이터 소유권

| 구분 | 공유 기본 DB | 주식시장 전용 DB |
| --- | --- | --- |
| 계정·권한 | Firebase UID, 로그인 연결, 스트리머 인증, 관리자 권한, 정지·점검 | 관리자 UID 최소 미러(`stockMarketAdminUids`) |
| 재화 | 통합 캐시 지갑 및 충전 요청 | 시장 현금, 보유 종목, 출석·복권·이용 시간·자산 이력 |
| 시장 콘텐츠 | 없음(전환 완료 후 레거시만 보존) | 종목, 시세, 캔들, 스파크라인, 랭킹, 상장·홍보·보물상자 신청 |
| 운영 기록 | 통합 감사 로그, 전환 상태 | 시장 작업 원장, 시장 감사·migration 검증 결과 |

### 13.3 실행 전 확인 목록

- 사용자에게 전환 일시와 점검 범위를 알리고, 실제 쓰기 기능을 점검 상태로 제한한다.
- 외장 SSD `/Volumes/재찬의 T7/RTDB-Backups/`의 마운트·쓰기 가능 상태를 확인한다.
- 변경 직전에 공유 기본 DB의 이전 대상과 전용 DB의 대상 경로를 각각 새 KST 시각 폴더에 백업한다. JSON 파싱, 경로, hash를 검증하고 권한은 폴더 700·파일 600으로 제한한다.
- 전용 규칙 최종본을 `/Volumes/재찬의 T7/RTDB-Rule-Backups/`에 새 시각 폴더로 백업하고 바이트 대조한다.
- 배포할 함수 이름을 정확히 확정한다. `firebase deploy --only functions` 전체 배포는 금지하고, `functions:default:<함수명>`만 사용한다.
- 현재 운영 함수 목록을 조회해 신규 함수 이름 충돌이 없는지 확인한다.

### 13.4 실행 순서

#### A. 전용 DB 접근 준비

1. 전용 DB 규칙을 dry-run으로 확인한다.
2. 관리자 UID 미러를 초기 동기화하고, 추가·해제 동기화 테스트를 한다.
3. 전용 DB 규칙만 실제 배포한다.
4. 관리자 화면에서 전용 DB의 접근 거부·허용 범위를 확인한다.

#### B. 데이터 복사와 대조

1. 이전 스크립트를 기본 계획 모드로 실행해 대상 경로·수량을 기록한다.
2. 백업 검증 후에만 명시적 `--apply`와 확인 문자열로 시장 데이터만 복사한다.
3. 검증 스크립트로 종목·시세·캔들·랭킹·신청 큐·사용자 시장 계정·보물상자 수량을 경로별 대조한다.
4. 불일치가 하나라도 있으면 `market-primary` 상태를 기록하거나 클라이언트를 전환하지 않고, 원인을 해결한 뒤 다시 복사·검증한다.

#### C. 서버 우선 전환

1. 정확히 지정한 주식시장 서버 함수만 배포한다.
2. 공유 DB `adminCenter/stockMarketDatabaseMigration/state`를 `market-primary`로 설정해 서버 reader/writer를 전용 DB로 전환한다.
3. 관리자 테스트 계정으로 신규 시장 계정 생성, 매수·매도, 출석, 복권, 보물상자, 상장/홍보 신청·승인을 순서대로 검증한다.
4. 교차 DB 통합 캐시 차감·환불은 작업 원장이 `completed` 또는 재시도 가능한 실패 상태로 끝나는지 확인한다.

#### D. 클라이언트·자매 서비스 전환

1. 주식시장 정적 클라이언트의 `STOCK_MARKET_DATABASE_PRIMARY`를 `true`로 바꾼다.
2. 배팅시장, 팬페이지, 메신저, 인생게임, 관리자센터의 시장 시세/차트 reader를 함께 배포한다.
3. 로그인 상태와 비로그인 상태에서 공개 시세·차트·상장 신청·관리자 신청 큐를 각각 확인한다.
4. 자매 서비스의 자체 계정·채팅·게임 데이터는 공유/자체 DB에서 그대로 보이는지 회귀 확인한다.

#### E. 관찰과 정리

1. 최소 관찰 기간 동안 작업 원장, Discord 알림, 오류 로그, 전용 DB 다운로드량을 확인한다.
2. 폴백 접근, 권한 오류, 데이터 불일치가 0인지 확인한다.
3. 기본 DB의 레거시 시장 경로는 즉시 삭제하지 않는다. 별도 사용자 승인과 새 백업·대조가 끝난 뒤 경로 단위 정리 작업으로 분리한다.

### 13.5 실패 처리와 롤백

- **복사 대조 실패:** 전용 DB 전환을 하지 않는다. 기본 DB는 그대로 유지하고 전용 DB의 원인 경로만 조사한다.
- **서버 전환 직후 오류:** `market-primary`를 해제해 서버를 기존 기본 DB 경로로 되돌린다. 새로 생성된 시장 데이터는 작업 원장을 기준으로 별도 보존·대조하며 임의 삭제하지 않는다.
- **클라이언트 표시 오류:** 정적 클라이언트 플래그를 `false`로 되돌린 배포로 공개 reader만 기본 DB로 되돌린다. 서버 원장과 전용 DB 데이터를 덮어쓰지 않는다.
- **데이터 손실 의심:** 즉시 추가 쓰기를 멈추고, 현재 양쪽 경로를 외장 SSD에 사고 시점 백업으로 보존한 뒤 마지막 검증 백업과 hash를 비교한다. 전체 DB 복원 대신 정확히 손실된 경로만 복원한다.

### 13.6 운영 전환 이후 별도 과제

- 기본 DB 레거시 시장 경로의 보존 기간과 삭제 승인 기준 확정
- 전용 DB·공유 DB별 다운로드량/저장량 대시보드 추가
- 복사 검증 결과와 교차 DB 작업 실패 재처리 화면의 운영 절차 문서화
- 전환 완료 후 정적 클라이언트 플래그를 설정 값으로 통합할지 검토. 공개 클라이언트가 관리자 전용 전환 상태를 직접 구독하지 않는 원칙은 유지한다.
