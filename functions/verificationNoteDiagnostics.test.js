const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyStreamerVerificationNoteNoMatch } = require("./verificationNoteDiagnostics");

test("발신자에 대응하는 대기 신청이 없으면 구분한다", () => {
  assert.equal(classifyStreamerVerificationNoteNoMatch({}, "byunja", 100), "no-pending-request-for-sender");
  assert.equal(classifyStreamerVerificationNoteNoMatch({ other: { status: "pending", soopId: "other" } }, "byunja", 100), "no-pending-request-for-sender");
});

test("인증 코드가 없거나 만료되면 구분한다", () => {
  assert.equal(classifyStreamerVerificationNoteNoMatch({ a: { status: "pending", soopId: "byunja" } }, "byunja", 100), "pending-request-code-missing-or-expired");
  assert.equal(classifyStreamerVerificationNoteNoMatch({ a: { status: "pending", soopId: "byunja", noteVerificationCodeHash: "hash", noteVerificationCodeExpiresAt: 99 } }, "byunja", 100), "pending-request-code-missing-or-expired");
});

test("유효한 코드가 있지만 후보와 일치하지 않으면 구분한다", () => {
  assert.equal(classifyStreamerVerificationNoteNoMatch({ a: { status: "pending", soopId: "byunja", noteVerificationCodeHash: "hash", noteVerificationCodeExpiresAt: 101 } }, "byunja", 100), "code-mismatch");
});
