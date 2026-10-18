"use strict";

function normalizeStreamerStockMatchName(value) {
  return String(value || "").normalize("NFC").toLocaleLowerCase("ko-KR").trim()
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "");
}

// Stocks store display names (stocks/{stockId}.name), not SOOP IDs. Keep this
// comparison aligned with Admin Center's unlisted-streamer card: stock names
// may include decorative prefixes/suffixes around the streamer's nickname.
function isStreamerStockListed(stocks, nickname) {
  const normalizedNickname = normalizeStreamerStockMatchName(nickname);
  if (!normalizedNickname) return false;
  return Object.values(stocks || {}).some((stock) =>
    normalizeStreamerStockMatchName(stock && stock.name).includes(normalizedNickname));
}

module.exports = { normalizeStreamerStockMatchName, isStreamerStockListed };
