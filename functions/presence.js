const { onCall } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

// presence/{appId}/{uid}는 공개 읽기를 막고 서버에서만 집계한다. UID 목록을
// 브라우저로 내려주지 않고 활성 사용자 수만 반환한다.
const getStockMarketPresenceCount = onCall(async () => {
  const snap = await admin.database().ref('presence/stockMarket').get();
  const cutoff = Date.now() - 60 * 60 * 1000;
  let count = 0;
  snap.forEach((child) => {
    const value = child.val() || {};
    if (Number(value.lastSeen) >= cutoff) count += 1;
  });
  return { count };
});

module.exports = { getStockMarketPresenceCount };
