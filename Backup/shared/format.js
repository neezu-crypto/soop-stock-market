export function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export function normalizeSearchKeyword(v) {
  try {
    return String(v || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\u200B-\u200D\uFEFF\u2060]/g, "")
      .replace(/\s+/g, "")
      .trim();
  } catch (_) {
    return String(v || "")
      .toLowerCase()
      .replace(/[\u200B-\u200D\uFEFF\u2060]/g, "")
      .replace(/\s+/g, "")
      .trim();
  }
}
