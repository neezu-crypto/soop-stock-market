"use strict";

function normalizeStreamerStockMatchName(value) {
  return String(value || "").normalize("NFC").trim()
    .replace(/^\[[^\]]+\]\s*/u, "")
    .toLocaleLowerCase("ko-KR")
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "");
}

// Stocks store display names (stocks/{stockId}.name), not SOOP IDs. Keep this
// comparison strict: a substring match could approve a different streamer with
// a short nickname. Crew labels and edge decorations are normalized away.
function isStreamerStockListed(stocks, nickname) {
  const normalizedNickname = normalizeStreamerStockMatchName(nickname);
  if (!normalizedNickname) return false;
  return Object.values(stocks || {}).some((stock) =>
    normalizeStreamerStockMatchName(stock && stock.name) === normalizedNickname);
}

module.exports = { normalizeStreamerStockMatchName, isStreamerStockListed };
