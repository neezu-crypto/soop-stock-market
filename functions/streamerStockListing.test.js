"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isStreamerStockListed, normalizeStreamerStockMatchName } = require("./streamerStockListing");

test("matches exact listed nicknames with crew labels and edge decorations", () => {
  assert.equal(isStreamerStockListed({ stock1: { name: "✨ 온이유 👑" } }, "온이유"), true);
  assert.equal(isStreamerStockListed({ stock1: { name: "[인생게임] 온이유" } }, "온이유"), true);
});

test("normalizes Unicode and case for stock-name comparison", () => {
  assert.equal(isStreamerStockListed({ stock1: { name: "Bottom" } }, "bottom"), true);
  assert.equal(isStreamerStockListed({ stock1: { name: "온이유" } }, "온이유"), true);
  assert.equal(normalizeStreamerStockMatchName(" ✨ 온이유 👑 "), "온이유");
});

test("does not treat missing or unrelated stock names as a listing", () => {
  assert.equal(isStreamerStockListed({ stock1: { name: "다른 스트리머" }, stock2: {} }, "온이유"), false);
  assert.equal(isStreamerStockListed({ stock1: { name: "온이유" } }, ""), false);
  assert.equal(isStreamerStockListed({ stock1: { name: "온이유 팬클럽" } }, "온이유"), false);
});
