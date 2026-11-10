const { onCall } = require("firebase-functions/v2/https");
const { getDatabase } = require("firebase-admin/database");
const { getMarketDatabaseContext } = require("./marketDatabases");

function publicChartBanners(data, now = Date.now()) {
  return Object.entries(data || {}).sort(([a], [b]) => a.localeCompare(b)).flatMap(([, item]) => {
    if (!item || typeof item !== "object" || typeof item.img !== "string") return [];
    const link = typeof item.link === "string" ? item.link : "";
    try {
      if (!item.img.startsWith("images/") && !["http:", "https:"].includes(new URL(item.img).protocol)) return [];
      if (link && !["http:", "https:"].includes(new URL(link).protocol)) return [];
    } catch { return []; }
    let expiresAt = null;
    if (item.endDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(item.endDate)) return [];
      expiresAt = Date.parse(`${item.endDate}T23:59:59.999+09:00`) + 1;
      if (!Number.isFinite(expiresAt) || expiresAt <= now) return [];
    }
    return [{ name: String(item.name || ""), img: item.img, link, expiresAt }];
  });
}

const getSharedChartBanners = onCall({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, async () => {
  const sharedDatabase = getDatabase();
  const { db } = await getMarketDatabaseContext({ sharedDatabase });
  const snapshot = await db.ref("chartBanner").get();
  return { banners: publicChartBanners(snapshot.val()).slice(0, 1) };
});

module.exports = { getSharedChartBanners, publicChartBanners };
