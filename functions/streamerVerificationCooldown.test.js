const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
let db;
let lifeDb;
class HttpsError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } }
const originalLoad = Module._load;
Module._load = function(name, parent, isMain) {
  if (name === 'firebase-functions/v2/https') return { onCall: (_, handler) => handler, HttpsError };
  if (name === 'firebase-admin') return { database: () => db, app: () => ({}) };
  if (name === 'firebase-admin/database') return { getDatabaseWithUrl: () => lifeDb };
  if (name === './common' && parent.filename.endsWith('/streamerVerification.js')) return { STREAMER_ID_RE: /^[a-z0-9]{2,20}$/, requireNotInMaintenance: async () => {}, assertNotBanned: async () => {} };
  if (name === './adminAuditLog' && parent.filename.endsWith('/streamerVerification.js')) return {};
  if (name === './publicIdentity' && parent.filename.endsWith('/streamerVerification.js')) return {};
  return originalLoad.call(this, name, parent, isMain);
};
const { requestStreamerVerification } = require('./streamerVerification');
Module._load = originalLoad;
function fixture(now) {
  const state = { users: { user: {} }, streamerVerificationRequests: { req: { uid: 'user', status: 'pending', nickname: '테스트', soopId: 'tester', requestedAt: now - 1000, noteVerificationCodeHash: 'original', noteVerificationCodeIssuedAt: now, noteVerificationCodeExpiresAt: now + 900000 } }, streamerVerifications: null };
  function get(path) { return path.split('/').filter(Boolean).reduce((v,k)=>v?.[k],state); }
  const snapshot = v => ({val:()=>v == null ? null : structuredClone(v),exists:()=>v != null});
  function ref(path) { const r={ get:async()=>snapshot(get(path)), once:async()=>snapshot(get(path)), orderByChild:()=>r, equalTo:()=>r, limitToFirst:()=>r, transaction:async update=>{ const old=get(path); const value=update(structuredClone(old)); if(value===undefined)return {committed:false,snapshot:snapshot(old)}; let keys=path.split('/');let obj=state;for(const key of keys.slice(0,-1)) obj=obj[key];obj[keys.at(-1)]=value;return {committed:true,snapshot:snapshot(value)}; } }; return r; }
  db={ref};
  lifeDb={ref};
  return state;
}
const request = data => requestStreamerVerification({auth:{uid:'user'},data});
test('신청 재호출과 상태 확인은 코드를 유지하고 명시적 재발급에 대기 시간을 적용한다',async()=>{
 const now=Date.now();const state=fixture(now);const before=structuredClone(state.streamerVerificationRequests.req);
 for (const data of [{nickname:'테스트',soopId:'tester'}, {checkOnly:true}]) {const result=await request(data);assert.equal(result.action,'pending');assert.equal(result.verificationCode,'');assert.equal(result.nextCodeIssueAt,now+60000);}
 await assert.rejects(request({renewCode:true}),e=>e.code==='resource-exhausted' && e.details.nextCodeIssueAt===now+60000);
 assert.deepEqual(state.streamerVerificationRequests.req,before);
 state.streamerVerificationRequests.req.noteVerificationCodeIssuedAt=now-61000;
 const results=await Promise.allSettled([request({renewCode:true}),request({renewCode:true})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected' && r.reason.code==='resource-exhausted').length,1);
 assert.notEqual(state.streamerVerificationRequests.req.noteVerificationCodeHash,'original');
});
test('기존 자매 서비스의 빈 재발급 요청도 제한을 따르고 쪽지 확인 중엔 코드를 유지한다',async()=>{
 const now=Date.now();const state=fixture(now);await assert.rejects(request({source:'onyu-vn'}),e=>e.code==='resource-exhausted');
 state.streamerVerificationRequests.req.noteVerificationCodeIssuedAt=now-61000;state.streamerVerificationRequests.req.noteVerificationClaim={token:'busy',claimedAt:now};
 await assert.rejects(request({source:'onyu-vn'}),e=>e.code==='failed-precondition');assert.equal(state.streamerVerificationRequests.req.noteVerificationCodeHash,'original');
});
