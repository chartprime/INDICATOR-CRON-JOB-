const { DAY_MS } = require("../archive-schedule");
const { listCollectorInstruments } = require("../../providers/dxfeed/dxfeed-instrument-catalog");

const TX_PENDING_BIT = 0x01;
const SNAPSHOT_BEGIN_BIT = 0x04;
const SNAPSHOT_END_BIT = 0x08;
const SNAPSHOT_SNIP_BIT = 0x10;
const DEFAULT_MAX_CONTINUATION_ROWS = 10_000;

function isTxPending(eventFlags) {
  return (eventFlags & TX_PENDING_BIT) !== 0;
}

function isSnapshotBegin(eventFlags) {
  return (eventFlags & SNAPSHOT_BEGIN_BIT) !== 0;
}

function isSnapshotEnd(eventFlags) {
  return (eventFlags & SNAPSHOT_END_BIT) !== 0;
}

function isSnapshotSnip(eventFlags) {
  return (eventFlags & SNAPSHOT_SNIP_BIT) !== 0;
}

function assertDayStartMs(dayStartMs) {
  if (
    !Number.isSafeInteger(dayStartMs) || dayStartMs < 0 || dayStartMs % DAY_MS !== 0 ||
    !Number.isSafeInteger(dayStartMs + DAY_MS)
  ) {
    throw new Error("dxfeed-gap-audit: dayStartMs must be a UTC day-start safe integer");
  }
}

function scanOrderBookDay(storageDb, {
  symbol, assetClass, source, dayStartMs, dayEndMs, maxContinuationRows = DEFAULT_MAX_CONTINUATION_ROWS,
}) {
  if (!Number.isSafeInteger(maxContinuationRows) || maxContinuationRows <= 0) {
    throw new Error("dxfeed-gap-audit: maxContinuationRows must be a positive safe integer");
  }
  if (!storageDb?.raw || typeof storageDb.raw.prepare !== "function") {
    throw new Error("dxfeed-gap-audit: storageDb does not expose the required raw query interface");
  }
  const selectDay = storageDb.raw.prepare(
    "SELECT id, event_flags FROM dxfeed_order_book_capture " +
    "WHERE symbol = ? AND asset_class = ? AND source = ? AND event_time >= ? AND event_time < ? ORDER BY id ASC",
  );
  const selectContinuation = storageDb.raw.prepare(
    "SELECT id, event_flags FROM dxfeed_order_book_capture " +
    "WHERE symbol = ? AND asset_class = ? AND source = ? AND id > ? ORDER BY id ASC LIMIT ?",
  );
  let txOpen = false;
  let snapshotOpen = false;
  let snippedSnapshots = 0;
  let rowsChecked = 0;
  let lastDayRowId = null;
  if (typeof selectDay.iterate !== "function" || typeof selectContinuation.iterate !== "function") {
    throw new Error("dxfeed-gap-audit: storage statements must expose bounded-memory iteration");
  }
  for (const row of selectDay.iterate(symbol, assetClass, source, dayStartMs, dayEndMs)) {
    rowsChecked += 1;
    lastDayRowId = row.id;
    const flags = row.event_flags;
    if (isSnapshotBegin(flags)) snapshotOpen = true;
    if (isSnapshotSnip(flags)) {
      if (snapshotOpen) snippedSnapshots += 1;
      snapshotOpen = false;
    }
    if (isSnapshotEnd(flags)) snapshotOpen = false;
    txOpen = isTxPending(flags);
  }
  const openAtDayEnd = rowsChecked > 0 && (txOpen || snapshotOpen);
  let continuationRowsChecked = 0;
  if (openAtDayEnd) {
    for (const row of selectContinuation.iterate(symbol, assetClass, source, lastDayRowId, maxContinuationRows)) {
      continuationRowsChecked += 1;
      const flags = row.event_flags;
      if (isSnapshotBegin(flags)) snapshotOpen = true;
      if (isSnapshotSnip(flags)) {
        if (snapshotOpen) snippedSnapshots += 1;
        snapshotOpen = false;
      }
      if (isSnapshotEnd(flags)) snapshotOpen = false;
      txOpen = isTxPending(flags);
      if (!txOpen && !snapshotOpen) break;
    }
  }
  return {
    rowsChecked,
    continuationRowsChecked,
    snippedSnapshots,
    danglingAtDayEnd: rowsChecked > 0 && (txOpen || snapshotOpen),
  };
}

function auditOrderBookTransactionContinuityDay(storageDb, {
  dayStartMs,
  auditedAt = Date.now(),
  maxContinuationRows = DEFAULT_MAX_CONTINUATION_ROWS,
} = {}) {
  assertDayStartMs(dayStartMs);
  if (!Number.isSafeInteger(auditedAt) || auditedAt < 0) {
    throw new Error("dxfeed-gap-audit: auditedAt must be a safe non-negative integer");
  }
  const dayEndMs = dayStartMs + DAY_MS;
  const perPair = {};
  let interruptedCount = 0;
  let noDataCount = 0;
  let snippedCount = 0;
  storageDb.transaction(() => {
    for (const { symbol, assetClass, orderSource } of listCollectorInstruments()) {
      const { rowsChecked, danglingAtDayEnd, snippedSnapshots } = scanOrderBookDay(storageDb, {
        symbol, assetClass, source: orderSource, dayStartMs, dayEndMs, maxContinuationRows,
      });
      const anchorStatus = rowsChecked === 0 ? "NO_DATA" : danglingAtDayEnd ? "INTERRUPTED" : "CLEAN";
      if (anchorStatus === "NO_DATA") noDataCount += 1;
      if (anchorStatus === "INTERRUPTED") interruptedCount += 1;
      snippedCount += snippedSnapshots;
      storageDb.recordOrderBookContinuityAudit({
        dayStart: dayStartMs, symbol, assetClass, source: orderSource,
        rowsChecked, danglingAtDayEnd, anchorStatus, auditedAt,
      });
      perPair[`${symbol}:${orderSource}`] = { rowsChecked, danglingAtDayEnd, anchorStatus, snippedSnapshots };
    }
  });
  return { dayStartMs, perPair, interruptedCount, noDataCount, snippedCount };
}

module.exports = { auditOrderBookTransactionContinuityDay, scanOrderBookDay, DEFAULT_MAX_CONTINUATION_ROWS };
