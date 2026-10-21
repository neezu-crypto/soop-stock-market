const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { GoogleAuth } = require("google-auth-library");
const { requireAdmin } = require("./common");

const CACHE_MS = 60 * 60 * 1000;
const RETENTION_DAYS = 30;
// stock market's two deployed onSchedule functions: autoTickJackpotProgress and
// checkFrozenStockDelistings. Scheduler job free quota is shared at billing-account scope.
const STOCK_SCHEDULER_JOB_COUNT = 2;
const SCHEDULER_USD_PER_JOB_MONTH = 0.10;

// 현재 배포 목록에서 이 두 함수는 lifegame codebase가 소유하고 있어 제외한다.
// 집계 함수 자체는 관리 기능이므로 주식시장 사용량 합계에서 제외한다.
const EXCLUDED_FUNCTIONS = new Set([
  "getStockMarketUsage",
  "linkGoogleAccount",
  "linkKakaoAccount",
]);

const PRICING = {
  rtdbFreeDownloadBytes: 10 * 1e9,
  rtdbFreeStorageBytes: 1 * 1e9,
  rtdbDownloadUsdPerGb: 1,
  rtdbStorageUsdPerGbMonth: 5,
  cloudRunCpuUsdPerVcpuSecond: 0.000024,
  cloudRunMemoryUsdPerGiBSecond: 0.0000025,
  cloudRunRequestUsdPerMillion: 0.40,
  assumedVcpu: 1,
  assumedMemoryGiB: 0.25,
};

function utcDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function dailyKey(point) {
  return point.endTime ? utcDateKey(new Date(Date.parse(point.endTime) - 1)) : "";
}

function ensureDaily(daily, key) {
  if (key) daily[key] = daily[key] || {};
}

function extractPoint(point) {
  const value = point.value || {};
  const distribution = value.distributionValue || {};
  return {
    endTime: point.interval?.endTime || "",
    value: Number(value.int64Value || value.doubleValue || 0),
    distributionCount: Number(distribution.count || 0),
    distributionMean: Number(distribution.mean || 0),
  };
}

async function fetchMonitoringSeries(accessToken, metricType, startTime, endTime, aligner, extraFilter = "") {
  const filters = [`metric.type="${metricType}"`, extraFilter].filter(Boolean);
  const params = new URLSearchParams({
    filter: filters.join(" AND "),
    "interval.startTime": startTime,
    "interval.endTime": endTime,
    "aggregation.alignmentPeriod": "86400s",
    "aggregation.perSeriesAligner": aligner,
    view: "FULL",
  });
  const response = await fetch(
    `https://monitoring.googleapis.com/v3/projects/soop-stock-market/timeSeries?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new HttpsError("internal", `Cloud Monitoring 조회 실패 (${response.status}): ${detail}`);
  }
  const payload = await response.json();
  return (payload.timeSeries || []).flatMap((series) =>
    (series.points || []).map((point) => extractPoint(point))
  );
}

function estimateFunctionCostUsd(executions, billableSeconds) {
  return billableSeconds * (
    PRICING.cloudRunCpuUsdPerVcpuSecond * PRICING.assumedVcpu +
    PRICING.cloudRunMemoryUsdPerGiBSecond * PRICING.assumedMemoryGiB
  ) + executions * PRICING.cloudRunRequestUsdPerMillion / 1e6;
}

// 관리자 전용 사용량 조회. RTDB 메트릭은 Firebase 프로젝트 전체 공용이며,
// 함수 비용은 주식시장 저장소의 배포 함수만 분리해 계산한다.
const getStockMarketUsage = onCall({ timeoutSeconds: 120, memory: "256MiB" }, async (request) => {
  const db = admin.database();
  await requireAdmin(db, request.auth);

  const cacheRef = db.ref("stockMarket/adminUsage/summaryCache");
  const cacheSnap = await cacheRef.get();
  const cache = cacheSnap.val();
  if (cache?.data && Date.now() - (cache.computedAt || 0) < CACHE_MS) return cache.data;

  const end = new Date();
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - (RETENTION_DAYS - 1)));
  const startTime = start.toISOString();
  const endTime = end.toISOString();
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/monitoring.read"] });
  const client = await auth.getClient();
  const tokenResult = await client.getAccessToken();
  const accessToken = typeof tokenResult === "string" ? tokenResult : tokenResult.token;
  if (!accessToken) throw new HttpsError("internal", "Cloud Monitoring 인증 토큰을 가져오지 못했습니다.");

  const [downloadPoints, storagePoints] = await Promise.all([
    fetchMonitoringSeries(accessToken, "firebasedatabase.googleapis.com/network/sent_bytes_count", startTime, endTime, "ALIGN_SUM"),
    fetchMonitoringSeries(accessToken, "firebasedatabase.googleapis.com/storage/total_bytes", startTime, endTime, "ALIGN_MAX"),
  ]);

  // index.js의 exports를 기준으로 관리하되, 실제 배포 목록에서 lifegame 소유로 확인된
  // 계정 연결 함수와 이 비용 조회 callable은 집계 대상에서 뺀다.
  const functionNames = Object.keys(require("./index"))
    .filter((name) => !EXCLUDED_FUNCTIONS.has(name))
    .sort();
  const countPoints = [];
  const executionPoints = [];
  const billablePoints = [];
  for (let offset = 0; offset < functionNames.length; offset += 18) {
    const names = functionNames.slice(offset, offset + 18);
    // Function names are globally unique within this Firebase project. Avoid
    // combining an OR set with another resource.labels restriction: Monitoring
    // rejects mixed AND/OR restrictions on the same resource-label field.
    const functionFilter = names.map((name) => `resource.labels.function_name="${name}"`).join(" OR ");
    const serviceFilter = names.map((name) => `resource.labels.service_name="${name.toLowerCase()}"`).join(" OR ");
    const [counts, executions, billable] = await Promise.all([
      fetchMonitoringSeries(accessToken, "cloudfunctions.googleapis.com/function/execution_count", startTime, endTime, "ALIGN_SUM", functionFilter),
      fetchMonitoringSeries(accessToken, "cloudfunctions.googleapis.com/function/execution_times", startTime, endTime, "ALIGN_SUM", functionFilter),
      fetchMonitoringSeries(accessToken, "run.googleapis.com/container/billable_instance_time", startTime, endTime, "ALIGN_SUM", serviceFilter),
    ]);
    countPoints.push(...counts);
    executionPoints.push(...executions);
    billablePoints.push(...billable);
  }

  const daily = {};
  const downloadByDay = {};
  downloadPoints.forEach((point) => {
    const key = dailyKey(point);
    if (!key) return;
    downloadByDay[key] = (downloadByDay[key] || 0) + point.value;
  });
  Object.entries(downloadByDay).forEach(([day, bytes]) => {
    ensureDaily(daily, day);
    daily[day].sharedRtdbDownloadedBytes = Math.round(bytes);
  });
  storagePoints.forEach((point) => {
    const key = dailyKey(point);
    if (!key) return;
    ensureDaily(daily, key);
    // 저장량은 게이지 값이므로 일별 샘플 중 가장 큰 값을 기록한다.
    daily[key].sharedRtdbStoredBytes = Math.max(daily[key].sharedRtdbStoredBytes || 0, point.value);
  });

  const executionsByDay = {};
  countPoints.forEach((point) => {
    const key = dailyKey(point);
    if (key) executionsByDay[key] = (executionsByDay[key] || 0) + point.value;
  });
  const runtimeByDay = {};
  executionPoints.forEach((point) => {
    const key = dailyKey(point);
    if (key) runtimeByDay[key] = (runtimeByDay[key] || 0) + point.distributionCount * point.distributionMean / 1e9;
  });
  const billableByDay = {};
  billablePoints.forEach((point) => {
    const key = dailyKey(point);
    if (key) billableByDay[key] = (billableByDay[key] || 0) + point.value;
  });
  new Set([
    ...Object.keys(daily),
    ...Object.keys(executionsByDay),
    ...Object.keys(runtimeByDay),
    ...Object.keys(billableByDay),
  ]).forEach((day) => {
    ensureDaily(daily, day);
    const executions = executionsByDay[day] || 0;
    const billableSeconds = billableByDay[day] || 0;
    daily[day].stockFunctionExecutions = Math.round(executions);
    daily[day].stockFunctionRuntimeSeconds = Math.round(runtimeByDay[day] || 0);
    daily[day].stockFunctionBillableSeconds = Math.round(billableSeconds);
    daily[day].stockFunctionEstimatedUsdNoFreeTier = estimateFunctionCostUsd(executions, billableSeconds);
  });

  const downloadBytes30d = downloadPoints.reduce((sum, point) => sum + point.value, 0);
  const latestStorage = storagePoints.sort((a, b) => Date.parse(b.endTime || 0) - Date.parse(a.endTime || 0))[0];
  const storedBytes = latestStorage?.value || 0;
  const executions30d = countPoints.reduce((sum, point) => sum + point.value, 0);
  const runtimeSeconds30d = executionPoints.reduce((sum, point) => sum + point.distributionCount * point.distributionMean / 1e9, 0);
  const billableSeconds30d = billablePoints.reduce((sum, point) => sum + point.value, 0);
  const downloadGb30d = downloadBytes30d / 1e9;
  const storedGb = storedBytes / 1e9;
  const downloadOverageGb = Math.max(0, downloadGb30d - PRICING.rtdbFreeDownloadBytes / 1e9);
  const storageOverageGb = Math.max(0, storedGb - PRICING.rtdbFreeStorageBytes / 1e9);
  const sampledAt = endTime;
  const data = {
    scope: "shared-project-rtdb-and-stock-functions",
    sampledAt,
    rangeStart: startTime,
    rangeEnd: endTime,
    sharedRtdbDownloadBytes30d: Math.round(downloadBytes30d),
    sharedRtdbStoredBytes: Math.round(storedBytes),
    sharedRtdbEstimatedDownloadUsd: downloadOverageGb * PRICING.rtdbDownloadUsdPerGb,
    sharedRtdbEstimatedStorageUsdMonthly: storageOverageGb * PRICING.rtdbStorageUsdPerGbMonth,
    sharedRtdbEstimatedUsdMonthly: downloadOverageGb * PRICING.rtdbDownloadUsdPerGb + storageOverageGb * PRICING.rtdbStorageUsdPerGbMonth,
    stockFunctionCount: functionNames.length,
    stockFunctionExecutions30d: Math.round(executions30d),
    stockFunctionRuntimeSeconds30d: Math.round(runtimeSeconds30d),
    stockFunctionBillableSeconds30d: Math.round(billableSeconds30d),
    stockFunctionEstimatedUsdNoFreeTier: estimateFunctionCostUsd(executions30d, billableSeconds30d),
    stockSchedulerJobCount: STOCK_SCHEDULER_JOB_COUNT,
    stockSchedulerEstimatedUsdMonthlyMin: 0,
    stockSchedulerEstimatedUsdMonthlyMax: STOCK_SCHEDULER_JOB_COUNT * SCHEDULER_USD_PER_JOB_MONTH,
    daily: Object.keys(daily).sort().map((day) => ({ day, ...daily[day] })),
    pricing: {
      rtdbFreeDownloadGbPerMonth: 10,
      rtdbFreeStorageGb: 1,
      rtdbDownloadUsdPerGb: PRICING.rtdbDownloadUsdPerGb,
      rtdbStorageUsdPerGbMonth: PRICING.rtdbStorageUsdPerGbMonth,
      cloudRunCpuUsdPerVcpuSecond: PRICING.cloudRunCpuUsdPerVcpuSecond,
      cloudRunMemoryUsdPerGiBSecond: PRICING.cloudRunMemoryUsdPerGiBSecond,
      cloudRunRequestUsdPerMillion: PRICING.cloudRunRequestUsdPerMillion,
      assumedVcpu: PRICING.assumedVcpu,
      assumedMemoryGiB: PRICING.assumedMemoryGiB,
    },
  };

  const dailyRef = db.ref("stockMarket/adminUsage/rtdbDaily");
  const existingSnap = await dailyRef.get();
  const existing = existingSnap.val() || {};
  const updates = {};
  Object.entries(daily).forEach(([day, record]) => {
    updates[day] = { ...existing[day], ...record, sampledAt };
  });
  const cutoffDay = utcDateKey(start);
  Object.keys(existing).forEach((day) => {
    if (day < cutoffDay) updates[day] = null;
  });
  if (Object.keys(updates).length) await dailyRef.update(updates);
  await cacheRef.set({ computedAt: Date.now(), data });
  return data;
});

module.exports = { getStockMarketUsage };
