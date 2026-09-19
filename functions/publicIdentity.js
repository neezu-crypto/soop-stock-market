const crypto = require('crypto');

function publicIdFor(app, uid) {
  const digest = crypto.createHash('sha256').update(`${app}:${uid}`).digest('base64url');
  return `${app.slice(0, 3).toUpperCase()}-${digest.slice(0, 12)}`;
}

async function ensurePublicId(db, app, uid) {
  if (!uid) throw new Error('uid is required');
  const uidRef = db.ref(`privateUserIds/${app}/byUid/${uid}`);
  const existing = await uidRef.get();
  if (existing.exists() && existing.val()) return existing.val();
  const id = publicIdFor(app, uid);
  await db.ref().update({
    [`privateUserIds/${app}/byUid/${uid}`]: id,
    [`privateUserIds/${app}/byPublicId/${id}`]: uid,
  });
  return id;
}

function publicVerificationRecord(record) {
  return {
    nickname: record.nickname || '',
    soopId: record.soopId || null,
    verifiedAt: record.verifiedAt || null,
  };
}

async function syncPublicVerification(db, recordId, record) {
  if (!recordId || !record) return;
  await db.ref(`streamerVerificationsPublic/${recordId}`).set(publicVerificationRecord(record));
}

async function removePublicVerification(db, recordId) {
  if (!recordId) return;
  await db.ref(`streamerVerificationsPublic/${recordId}`).remove();
}

module.exports = { ensurePublicId, publicIdFor, syncPublicVerification, removePublicVerification };
