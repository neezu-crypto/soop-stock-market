const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { requireAdmin } = require('./common');
const { ensurePublicId, publicIdFor } = require('./publicIdentity');
const { activeStockMarketDatabase } = require('./marketDatabases');

// UID가 들어 있던 공개 미러를 앱 전용 공개 ID 기반으로 옮긴다. 이 함수는 관리자만
// 호출할 수 있으며, 기존 원장(UID 포함)은 삭제하지 않고 서버 내부 호환용으로 남긴다.
const migratePublicIdentityData = onCall({ cors: true, timeoutSeconds: 60, memory: '256MiB' }, async (request) => {
  const sharedDatabase = admin.database();
  await requireAdmin(sharedDatabase, request.auth);
  const marketDatabase = await activeStockMarketDatabase(sharedDatabase);

  const [verificationSnap, profitSnap, profileSnap, rankingSnap, stocksSnap] = await Promise.all([
    sharedDatabase.ref('streamerVerifications').get(),
    marketDatabase.ref('rankings/profitEntries').get(),
    sharedDatabase.ref('bettingMarket/profiles').get(),
    sharedDatabase.ref('bettingMarket/rankings').get(),
    marketDatabase.ref('stocks').get(),
  ]);

  const sharedUpdates = {};
  const marketUpdates = {};
  let verificationCount = 0;
  verificationSnap.forEach((child) => {
    const record = child.val() || {};
    if (!record.uid) return;
    sharedUpdates[`streamerVerificationsPublic/${child.key}`] = {
      nickname: record.nickname || '',
      soopId: record.soopId || null,
      verifiedAt: record.verifiedAt || null,
    };
    sharedUpdates[`users/${record.uid}/streamerVerified`] = true;
    sharedUpdates[`users/${record.uid}/streamerProfile`] = {
      nickname: record.nickname || '',
      soopId: record.soopId || null,
    };
    verificationCount += 1;
  });

  let profitCount = 0;
  profitSnap.forEach((child) => {
    const uid = child.key;
    const value = child.val() || {};
    if (!uid || uid.startsWith('STO-')) return;
    const publicId = value.publicId || publicIdFor('stock', uid);
    sharedUpdates[`privateUserIds/stock/byUid/${uid}`] = publicId;
    sharedUpdates[`privateUserIds/stock/byPublicId/${publicId}`] = uid;
    marketUpdates[`rankings/profitEntriesPublic/${publicId}`] = {
      anonId: value.anonId || `트레이더-${publicId.slice(-6)}`,
      value: Number(value.value) || 0,
      updatedAt: value.updatedAt || null,
    };
    profitCount += 1;
  });

  let profileCount = 0;
  profileSnap.forEach((child) => {
    const uid = child.key;
    const profile = child.val() || {};
    if (!uid) return;
    const publicId = publicIdFor('bet', uid);
    sharedUpdates[`privateUserIds/bet/byUid/${uid}`] = publicId;
    sharedUpdates[`privateUserIds/bet/byPublicId/${publicId}`] = uid;
    sharedUpdates[`bettingMarket/publicProfiles/${publicId}`] = {
      nickname: profile.nickname || '',
      avatarUrl: profile.avatarUrl || '',
    };
    profileCount += 1;
  });

  const rankingPublic = {};
  for (const category of ['asset', 'winrate', 'profit']) {
    const source = rankingSnap.child(category);
    const dest = {};
    source.forEach((child) => {
      const entry = child.val() || {};
      const uid = entry.uid || child.key;
      if (!uid) return;
      const publicId = publicIdFor('bet', uid);
      sharedUpdates[`privateUserIds/bet/byUid/${uid}`] = publicId;
      sharedUpdates[`privateUserIds/bet/byPublicId/${publicId}`] = uid;
      const sanitized = Object.assign({}, entry);
      delete sanitized.uid;
      sanitized.publicId = publicId;
      dest[publicId] = sanitized;
    });
    rankingPublic[category] = dest;
  }
  rankingPublic.updatedAt = rankingSnap.child('updatedAt').val() || null;
  sharedUpdates['bettingMarket/rankingsPublic'] = rankingPublic;

  stocksSnap.forEach((child) => {
    const value = Object.assign({}, child.val() || {});
    delete value.cardBannerHolderUid;
    delete value.freezeTriggerUid;
    delete value.triggerUid;
    marketUpdates[`stocksPublic/${child.key}`] = value;
  });

  await Promise.all([
    sharedDatabase.ref().update(sharedUpdates),
    marketDatabase.ref().update(marketUpdates),
  ]);
  return { ok: true, verificationCount, profitCount, profileCount };
});

module.exports = { migratePublicIdentityData };
