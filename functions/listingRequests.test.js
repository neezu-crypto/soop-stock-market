const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeListingName } = require('./listingRequests');

test('상장 신청 중복 검사에서 크루 접두어를 제외한 대표 이름을 만든다', () => {
  assert.equal(normalizeListingName('[감캄퍼니] 감스트'), '감스트');
  assert.equal(normalizeListingName('  [감컴퍼니]   감스트  '), '감스트');
  assert.equal(normalizeListingName('감스트'), '감스트');
});

test('상장명 내부의 공백과 보이지 않는 문자는 중복 비교 전에 정리한다', () => {
  assert.equal(normalizeListingName('감\u200B스트'), '감스트');
  assert.equal(normalizeListingName('감   스트'), '감 스트');
});
