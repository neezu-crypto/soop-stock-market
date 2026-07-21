## Git 커밋 규칙

- 커밋 메시지(요약)는 한글로 작성한다.
- 작업(파일 수정)을 마치면 사용자에게 묻지 않고 자동으로 git commit을 수행한다. (단, git push는 여전히 하지 않는다 — 별도 요청 시에만.)

## Firebase 데이터 소모량 경고

- 작업 지시를 받았을 때, 그 작업이 Firebase(Realtime Database 읽기/쓰기, Cloud Functions 호출 등) 관련 데이터 소모량이 더 커지는 방향(예: 폴링 주기 단축, 실시간 리스너 추가, 불필요한 전체 스캔/재조회 증가 등)으로 이뤄질 것 같으면, 바로 작업을 시작하지 말고 먼저 사용자에게 경고하고 확인을 받는다.

## Firebase Functions 배포 주의사항

- 이 Firebase 프로젝트(soop-stock-market)는 "스트리머 배팅시장"이라는 별도 웹앱의 Cloud Functions와 같이 쓰인다(예: approveVerification, blockNickname, cancelBet, claimAttendance, closeBettingScheduled, closeMarketEarly, dismissMarketReport, distributeJackpotWeekly, exchangeCurrency, judgeMarket, onLikeWritten, placeBet, rejectVerification, reportMarket, reportNickname, reviewProposal, revokeVerification, submitMarketProposal, unblockNickname, updateProfile, voidMarket). 이 함수들은 이 레포의 `functions/` 소스에는 없지만 실제 배포된 상태로 존재하며, 절대 삭제하면 안 된다.
- `firebase deploy --only functions`처럼 함수명을 지정하지 않고 전체 배포하면, 로컬 소스에 없는 위 함수들을 삭제 대상으로 인식해 삭제를 시도한다. 반드시 `firebase deploy --only functions:<함수명>` 형태로 변경/추가한 함수만 지정해서 배포한다.
