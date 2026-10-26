const { calibrateVBucket, createVpinState, ingestVpinTrade, snapshotVpinState, assertValidVpinTrade } = require("./vpin-engine");

const DEFAULT_PAGE_LIMIT = 2_000;
const DEFAULT_MAX_PAGES_PER_TICK = 10;
const DEFAULT_MAX_BACKFILL_PAGES = 50_000;
const DEFAULT_MAX_HISTORY = 5_000;
const DEFAULT_VPIN_BACKFILL_SLICE_MS = 250;
const DEFAULT_VPIN_BACKFILL_CHUNK_MS = 6 * 60 * 60 * 1_000;
const VPIN_BACKFILL_MODES = new Set(["EXACT", "SLICED_APPROXIMATE"]);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function pushBoundedHistory(history, entry, maxHistory) {
  history.push(entry);
  if (history.length > maxHistory) history.shift();
}

async function deriveDailyVolumesUsd({ adapter, tickSize, fromTs, toTs }) {
  if (!adapter || (typeof adapter.readDailyNotional !== "function" && typeof adapter.readMinuteRollup !== "function")) {
    throw new Error("vpin-session: adapter must implement readDailyNotional or readMinuteRollup");
  }
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    throw new Error("vpin-session: tickSize must be a positive finite number");
  }
  if (!Number.isSafeInteger(fromTs) || fromTs < 0) {
    throw new Error("vpin-session: fromTs must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(toTs) || toTs < fromTs) {
    throw new Error("vpin-session: toTs must be a safe integer not before fromTs");
  }
  if (typeof adapter.readDailyNotional === "function") {
    const daily = await adapter.readDailyNotional(fromTs, toTs);
    if (daily?.available) {
      if (!Array.isArray(daily.rows)) throw new Error("vpin-session: readDailyNotional must return rows");
      return daily.rows
        .filter((row) => row && Number.isSafeInteger(row.dayTs) && row.dayTs >= 0 && Number.isFinite(row.notional) && row.notional >= 0)
        .map((row) => row.notional);
    }
    if (typeof adapter.readMinuteRollup !== "function") return null;
  }
  const { rows, available } = await adapter.readMinuteRollup(fromTs, toTs, tickSize);
  if (!available) return null;
  const byDay = new Map();
  for (const row of rows) {
    const price = row.priceBucket * tickSize;
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(row.volume) || row.volume < 0) continue;
    const dayKey = Math.floor(row.minuteTs / MS_PER_DAY);
    byDay.set(dayKey, (byDay.get(dayKey) ?? 0) + row.volume * price);
  }
  return [...byDay.values()];
}

function assertAdapterHasReadTradesSince(adapter, field) {
  if (!adapter || typeof adapter.readTradesSince !== "function") {
    throw new Error(`vpin-session: ${field} must implement readTradesSince`);
  }
}

function createVpinSession({ adapter, vBucket, nowMs, engineOptions = {} }) {
  assertAdapterHasReadTradesSince(adapter, "adapter");
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("vpin-session: nowMs must be a non-negative safe integer");
  }
  return {
    adapter,
    vpinState: createVpinState({ vBucket, ...engineOptions }),
    pollFromTs: nowMs,
    pollCursor: null,
    history: [],
  };
}

function tradeFromRow(row) {
  return { ts: row.ts, price: row.price, size: row.size, side: row.side };
}

function currentReading(session) {
  return { sealTs: session.vpinState.lastSealTs, ...snapshotVpinState(session.vpinState) };
}

function appendResultsToHistory(history, results, maxHistory) {
  const readings = [];
  for (const result of results) {
    const reading = { sealTs: result.sealed.sealTs, ...result.reading };
    pushBoundedHistory(history, reading, maxHistory);
    readings.push(reading);
  }
  return readings;
}

function appendReadingsToHistory(history, readings, maxHistory = DEFAULT_MAX_HISTORY) {
  if (!Array.isArray(history) || !Array.isArray(readings)) {
    throw new Error("vpin-session: history and readings must be arrays");
  }
  for (const reading of readings) pushBoundedHistory(history, reading, maxHistory);
  return history;
}

function assertLivePollResult(result) {
  if (!result || typeof result !== "object" || !result.vpinState || typeof result.vpinState !== "object") {
    throw new Error("vpin-session: live poll result must include vpinState");
  }
  if (!Number.isSafeInteger(result.pollFromTs) || result.pollFromTs < 0) {
    throw new Error("vpin-session: live poll result pollFromTs must be a non-negative safe integer");
  }
  if (
    result.pollCursor !== null &&
    (!result.pollCursor || typeof result.pollCursor !== "object" ||
      !Number.isSafeInteger(result.pollCursor.ts) || result.pollCursor.ts < 0 ||
      !Number.isSafeInteger(result.pollCursor.id) || result.pollCursor.id < 0)
  ) {
    throw new Error("vpin-session: live poll result pollCursor must be null or a timestamp/id cursor");
  }
  if (!Array.isArray(result.readings)) {
    throw new Error("vpin-session: live poll result readings must be an array");
  }
  for (const reading of result.readings) {
    if (!reading || typeof reading !== "object" || !Number.isSafeInteger(reading.sealTs) || reading.sealTs < 0) {
      throw new Error("vpin-session: live poll result contains an invalid reading");
    }
  }
}

function applyLivePollResult(session, result, maxHistory = DEFAULT_MAX_HISTORY) {
  assertLivePollResult(result);
  session.vpinState = result.vpinState;
  session.pollFromTs = result.pollFromTs;
  session.pollCursor = result.pollCursor;
  appendReadingsToHistory(session.history, result.readings, maxHistory);
  return result.readings;
}

async function pollLive(session, nowMs, {
  pageLimit = DEFAULT_PAGE_LIMIT,
  maxPagesPerTick = DEFAULT_MAX_PAGES_PER_TICK,
  maxHistory = DEFAULT_MAX_HISTORY,
} = {}) {
  if (!Number.isSafeInteger(nowMs) || nowMs < session.pollFromTs) {
    throw new Error("vpin-session: pollLive nowMs must be a safe integer not before the session's pollFromTs");
  }
  let pagesFetched = 0;
  let tradesApplied = 0;
  let sealedCount = 0;
  const readings = [];
  for (;;) {
    if (pagesFetched >= maxPagesPerTick) break;
    const { rows, nextCursor, available } = await session.adapter.readTradesSince(
      session.pollFromTs, nowMs, session.pollCursor, pageLimit,
    );
    pagesFetched += 1;
    if (!available) throw new Error("vpin-session: trade source unavailable");
    for (const row of rows) {
      assertValidVpinTrade(tradeFromRow(row));
    }
    for (const row of rows) {
      const results = ingestVpinTrade(session.vpinState, tradeFromRow(row));
      tradesApplied += 1;
      sealedCount += results.length;
      readings.push(...appendResultsToHistory(session.history, results, maxHistory));
    }
    if (nextCursor === null) break;
    session.pollCursor = nextCursor;
    if (rows.length < pageLimit) break;
  }
  return { tradesApplied, sealedCount, pagesFetched, readings };
}

async function replayTradesIntoState(vpinState, adapter, fromTs, toTs, {
  pageLimit = DEFAULT_PAGE_LIMIT,
  maxPages = DEFAULT_MAX_BACKFILL_PAGES,
} = {}) {
  const readings = [];
  let cursor = null;
  let pagesFetched = 0;
  let tradesApplied = 0;
  let complete = false;
  for (;;) {
    if (pagesFetched >= maxPages) break;
    const { rows, nextCursor, available } = await adapter.readTradesSince(fromTs, toTs, cursor, pageLimit);
    pagesFetched += 1;
    if (!available) return { readings, tradesApplied, pagesFetched, complete: false };
    for (const row of rows) {
      assertValidVpinTrade(tradeFromRow(row));
    }
    for (const row of rows) {
      const results = ingestVpinTrade(vpinState, tradeFromRow(row));
      tradesApplied += 1;
      for (const result of results) readings.push({ sealTs: result.sealed.sealTs, ...result.reading });
    }
    if (nextCursor === null || rows.length < pageLimit) {
      complete = true;
      break;
    }
    cursor = nextCursor;
  }
  return { readings, tradesApplied, pagesFetched, complete };
}

function slicedRowToTrades(row) {
  const trades = [];
  if (row.buyNotional > 0) trades.push({ ts: row.sliceTs, price: 1, size: row.buyNotional, side: "buy" });
  if (row.sellNotional > 0) trades.push({ ts: row.sliceTs, price: 1, size: row.sellNotional, side: "sell" });
  return trades;
}

function assertSlicedGeometry(sliceMs, chunkMs) {
  if (!Number.isSafeInteger(sliceMs) || sliceMs <= 0) {
    throw new Error("vpin-session: sliceMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(chunkMs) || chunkMs < sliceMs) {
    throw new Error("vpin-session: chunkMs must be a safe integer of at least one slice");
  }
}

function slicedChunkEnd(cursor, toTs, sliceMs, chunkMs) {
  return Math.min(toTs, Math.floor((cursor + chunkMs) / sliceMs) * sliceMs);
}

async function replaySlicedBackfillIntoState(vpinState, adapter, fromTs, toTs, { sliceMs, chunkMs }) {
  const readings = [];
  let tradesApplied = 0;
  let slicesRead = 0;
  let chunksRead = 0;
  let cursor = fromTs;
  while (cursor < toTs) {
    const chunkEnd = slicedChunkEnd(cursor, toTs, sliceMs, chunkMs);
    const { rows, available } = await adapter.readSlicedNotional(cursor, chunkEnd, sliceMs);
    if (!available) {
      return { readings, tradesApplied, pagesFetched: 0, slicesRead, chunksRead, complete: false, reason: "SLICED_UNAVAILABLE" };
    }
    for (const row of rows) {
      for (const trade of slicedRowToTrades(row)) {
        assertValidVpinTrade(trade);
        const results = ingestVpinTrade(vpinState, trade);
        tradesApplied += 1;
        for (const result of results) readings.push({ sealTs: result.sealed.sealTs, ...result.reading });
      }
    }
    slicesRead += rows.length;
    chunksRead += 1;
    cursor = chunkEnd;
  }
  return { readings, tradesApplied, pagesFetched: 0, slicesRead, chunksRead, complete: true };
}

async function replayBackfillIntoState(vpinState, adapter, fromTs, toTs, {
  pageLimit = DEFAULT_PAGE_LIMIT,
  maxPages = DEFAULT_MAX_BACKFILL_PAGES,
  sliceMs = DEFAULT_VPIN_BACKFILL_SLICE_MS,
  chunkMs = DEFAULT_VPIN_BACKFILL_CHUNK_MS,
  backfillMode = "EXACT",
} = {}) {
  if (!VPIN_BACKFILL_MODES.has(backfillMode)) {
    throw new Error("vpin-session: backfillMode must be EXACT or SLICED_APPROXIMATE");
  }
  if (backfillMode === "SLICED_APPROXIMATE") {
    if (typeof adapter.readSlicedNotional !== "function") {
      throw new Error("vpin-session: the sliced backfill needs an adapter that implements readSlicedNotional");
    }
    assertSlicedGeometry(sliceMs, chunkMs);
    return replaySlicedBackfillIntoState(vpinState, adapter, fromTs, toTs, { sliceMs, chunkMs });
  }
  return replayTradesIntoState(vpinState, adapter, fromTs, toTs, { pageLimit, maxPages });
}

function assertBackfillRange(fromTs, toTs, field) {
  if (!Number.isSafeInteger(fromTs) || fromTs < 0) {
    throw new Error(`vpin-session: ${field} fromTs must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(toTs) || toTs < fromTs) {
    throw new Error(`vpin-session: ${field} toTs must be a safe integer not before fromTs`);
  }
}

async function runBackfill({
  adapter,
  vBucket,
  fromTs,
  toTs,
  engineOptions = {},
  pageLimit = DEFAULT_PAGE_LIMIT,
  maxPages = DEFAULT_MAX_BACKFILL_PAGES,
  sliceMs = DEFAULT_VPIN_BACKFILL_SLICE_MS,
  chunkMs = DEFAULT_VPIN_BACKFILL_CHUNK_MS,
  backfillMode = "EXACT",
}) {
  assertAdapterHasReadTradesSince(adapter, "adapter");
  assertBackfillRange(fromTs, toTs, "runBackfill");
  const vpinState = createVpinState({ vBucket, ...engineOptions });
  const { readings, tradesApplied, pagesFetched, complete, ...rest } = await replayBackfillIntoState(vpinState, adapter, fromTs, toTs, {
    pageLimit, maxPages, sliceMs, chunkMs, backfillMode,
  });
  return { vpinState, readings, tradesApplied, pagesFetched, complete, ...rest };
}

async function seedSessionFromBackfill(session, fromTs, toTs, {
  pageLimit = DEFAULT_PAGE_LIMIT,
  maxPages = DEFAULT_MAX_BACKFILL_PAGES,
  maxHistory = DEFAULT_MAX_HISTORY,
  sliceMs = DEFAULT_VPIN_BACKFILL_SLICE_MS,
  chunkMs = DEFAULT_VPIN_BACKFILL_CHUNK_MS,
  backfillMode = "EXACT",
} = {}) {
  assertBackfillRange(fromTs, toTs, "seedSessionFromBackfill");
  const workingState = JSON.parse(JSON.stringify(session.vpinState));
  const { readings, tradesApplied, pagesFetched, complete, ...rest } = await replayBackfillIntoState(
    workingState, session.adapter, fromTs, toTs, { pageLimit, maxPages, sliceMs, chunkMs, backfillMode },
  );
  if (!complete) return { readings: [], tradesApplied, pagesFetched, complete: false, ...rest };
  session.vpinState = workingState;
  session.pollFromTs = toTs;
  session.pollCursor = null;
  session.history = readings.length > maxHistory ? readings.slice(readings.length - maxHistory) : readings.slice();
  return { readings: session.history, tradesApplied, pagesFetched, complete: true, ...rest };
}

module.exports = {
  deriveDailyVolumesUsd,
  createVpinSession,
  pollLive,
  runBackfill,
  seedSessionFromBackfill,
  currentReading,
  appendReadingsToHistory,
  applyLivePollResult,
  calibrateVBucket,
  DEFAULT_PAGE_LIMIT,
  DEFAULT_MAX_PAGES_PER_TICK,
  DEFAULT_MAX_BACKFILL_PAGES,
  DEFAULT_MAX_HISTORY,
  DEFAULT_VPIN_BACKFILL_SLICE_MS,
  DEFAULT_VPIN_BACKFILL_CHUNK_MS,
  VPIN_BACKFILL_MODES,
};
