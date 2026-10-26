const { listAllowedSymbols, listAllowedMarketKinds } = require("../providers/binance/binance-config");
const { DAY_MS } = require("./archive-schedule");

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 10_000;

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function auditGapsForPair(
  storageDb,
  symbol,
  marketKind,
  { batchSize = DEFAULT_BATCH_SIZE, isCancelled = () => false, yieldNow = yieldToEventLoop } = {},
) {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new Error("storage-gap-audit: batchSize must be a positive safe integer");
  }
  const selectBatch = storageDb.raw.prepare(
    `SELECT id, first_update_id, last_update_id, previous_update_id
     FROM l2_depth_events
     WHERE symbol = ? AND market_kind = ? AND id > ?
     ORDER BY id ASC
     LIMIT ?`,
  );
  let cursor = 0;
  let priorLastUpdateId = null;
  let rowsChecked = 0;
  let gapsDetected = 0;

  while (!isCancelled()) {
    const rows = selectBatch.all(symbol, marketKind, cursor, batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      rowsChecked += 1;
      cursor = row.id;
      if (priorLastUpdateId === null) {
        priorLastUpdateId = row.last_update_id;
        continue;
      }
      if (row.last_update_id <= priorLastUpdateId) continue;
      if (marketKind === "PERPETUAL") {
        if (row.previous_update_id !== priorLastUpdateId) gapsDetected += 1;
      } else if (row.first_update_id > priorLastUpdateId + 1) {
        gapsDetected += 1;
      }
      priorLastUpdateId = row.last_update_id;
    }

    if (rows.length < batchSize) break;
    await yieldNow();
  }

  return { rowsChecked, gapsDetected };
}

function assertArchiveDayStart(dayStartMs) {
  if (!Number.isSafeInteger(dayStartMs) || dayStartMs < 0 || dayStartMs % DAY_MS !== 0) {
    throw new Error("storage-gap-audit: dayStartMs must be a UTC day-start safe integer");
  }
}

function updateSequenceState(state, row, marketKind) {
  if (state.priorLastUpdateId === null) {
    state.priorLastUpdateId = row.last_update_id;
    return;
  }
  if (row.last_update_id <= state.priorLastUpdateId) return;
  if (marketKind === "PERPETUAL") {
    if (row.previous_update_id !== state.priorLastUpdateId) state.gapsDetected += 1;
  } else if (row.first_update_id > state.priorLastUpdateId + 1) {
    state.gapsDetected += 1;
  }
  state.priorLastUpdateId = row.last_update_id;
}

function auditAndRecordDepthContinuityDay(storageDb, { dayStartMs, auditedAt = Date.now() } = {}) {
  if (!storageDb || typeof storageDb.raw?.prepare !== "function" ||
      typeof storageDb.getLatestDepthContinuityAudit !== "function" ||
      typeof storageDb.recordDepthContinuityAudit !== "function") {
    throw new Error("storage-gap-audit: storageDb must support durable depth continuity audit records");
  }
  assertArchiveDayStart(dayStartMs);
  if (!Number.isSafeInteger(auditedAt) || auditedAt < 0) {
    throw new Error("storage-gap-audit: auditedAt must be a safe non-negative integer");
  }
  const selectRows = storageDb.raw.prepare(
    "SELECT first_update_id, last_update_id, previous_update_id FROM l2_depth_events " +
    "WHERE symbol = ? AND market_kind = ? AND ts >= ? AND ts < ? ORDER BY id ASC",
  );
  const perPair = {};
  let totalGaps = 0;
  let totalRows = 0;
  let unanchoredPairs = 0;
  let noDataPairs = 0;
  storageDb.raw.transaction(() => {
    for (const marketKind of listAllowedMarketKinds()) {
      for (const symbol of listAllowedSymbols()) {
        const prior = storageDb.getLatestDepthContinuityAudit({ beforeDayStart: dayStartMs, symbol, marketKind });
        const state = { priorLastUpdateId: Number.isSafeInteger(prior?.last_update_id) ? prior.last_update_id : null, gapsDetected: 0 };
        const hasPriorAnchor = state.priorLastUpdateId !== null;
        let rowsChecked = 0;
        let firstUpdateId = null;
        for (const row of selectRows.iterate(symbol, marketKind, dayStartMs, dayStartMs + DAY_MS)) {
          firstUpdateId ??= row.first_update_id;
          rowsChecked += 1;
          updateSequenceState(state, row, marketKind);
        }
        const hasRows = rowsChecked > 0;
        const anchorStatus = hasRows ? hasPriorAnchor ? "ANCHORED" : "BASELINE" : "NO_DATA";
        const lastUpdateId = hasRows ? state.priorLastUpdateId : null;
        if (!hasRows) noDataPairs += 1;
        if (anchorStatus === "BASELINE") unanchoredPairs += 1;
        storageDb.recordDepthContinuityAudit({
          dayStart: dayStartMs,
          symbol,
          marketKind,
          firstUpdateId,
          lastUpdateId,
          rowsChecked,
          gapsDetected: state.gapsDetected,
          anchorStatus,
          auditedAt,
        });
        const result = { rowsChecked, gapsDetected: state.gapsDetected, anchorStatus, firstUpdateId, lastUpdateId };
        perPair[`${symbol}:${marketKind}`] = result;
        totalRows += rowsChecked;
        totalGaps += state.gapsDetected;
      }
    }
  })();
  return { dayStartMs, perPair, totalRows, totalGaps, unanchoredPairs, noDataPairs };
}

async function auditAllPairs(storageDb, options) {
  const perPair = {};
  let totalGaps = 0;
  let totalRows = 0;
  for (const marketKind of listAllowedMarketKinds()) {
    for (const symbol of listAllowedSymbols()) {
      if (options?.isCancelled?.()) return null;
      const result = await auditGapsForPair(storageDb, symbol, marketKind, options);
      perPair[`${symbol}:${marketKind}`] = result;
      totalGaps += result.gapsDetected;
      totalRows += result.rowsChecked;
    }
  }
  return { perPair, totalGaps, totalRows };
}

function createStorageGapAudit({
  storageDb,
  logger,
  intervalMs = DEFAULT_INTERVAL_MS,
  batchSize = DEFAULT_BATCH_SIZE,
  onError = null,
} = {}) {
  if (!storageDb || typeof storageDb.raw !== "object" || storageDb.raw === null) {
    throw new Error("storage-gap-audit: storageDb must expose a raw better-sqlite3 handle");
  }
  if (!logger || typeof logger.info !== "function" || typeof logger.warn !== "function") {
    throw new Error("storage-gap-audit: logger must expose info() and warn()");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("storage-gap-audit: intervalMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new Error("storage-gap-audit: batchSize must be a positive safe integer");
  }
  if (onError !== null && typeof onError !== "function") {
    throw new Error("storage-gap-audit: onError must be a function when provided");
  }
  let timer = null;
  let lastReport = null;
  let inFlight = null;
  let generation = 0;

  function runOnce() {
    if (inFlight) return inFlight;
    const runGeneration = generation;
    let promise;
    promise = (async () => {
      const report = await auditAllPairs(storageDb, {
        batchSize,
        isCancelled: () => generation !== runGeneration,
      });
      if (report === null || generation !== runGeneration) return null;
      lastReport = report;
      if (report.totalGaps > 0) {
        logger.warn("depth-event continuity gaps detected", { gaps: report.totalGaps, rowsChecked: report.totalRows });
      } else {
        logger.info("depth-event continuity check clean", { rowsChecked: report.totalRows });
      }
      return report;
    })().finally(() => {
      if (inFlight === promise) inFlight = null;
    });
    inFlight = promise;
    return promise;
  }

  function runScheduledAudit() {
    void runOnce().catch((error) => {
      console.error("storage-gap-audit: scheduled audit failed", error?.message ?? error);
      try {
        onError?.(error);
      } catch (callbackError) {
        console.error("storage-gap-audit: error callback failed", callbackError?.message ?? callbackError);
      }
    });
  }

  function start() {
    if (timer) return;
    timer = setInterval(runScheduledAudit, intervalMs);
    timer.unref?.();
  }

  async function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    generation += 1;
    await inFlight?.catch(() => {});
  }

  return Object.freeze({ start, stop, runOnce, getLastReport: () => lastReport });
}

module.exports = {
  createStorageGapAudit,
  auditGapsForPair,
  auditAllPairs,
  auditAndRecordDepthContinuityDay,
  DEFAULT_INTERVAL_MS,
  DEFAULT_BATCH_SIZE,
};
