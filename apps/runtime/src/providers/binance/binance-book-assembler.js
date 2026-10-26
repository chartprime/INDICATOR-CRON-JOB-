const { types: utilTypes } = require("node:util");
const { MARKET_KINDS } = require("./binance-config");
const {
  snapshotTupleArray,
  snapshotFlatFields,
  MAX_DEPTH_ENTRIES,
  compareDecimalStrings,
  canonicalizeDecimalString,
} = require("./binance-event-normalizer");

const DEPTH_SNAPSHOT_ALLOWED_KEYS = ["lastUpdateId", "E", "T", "bids", "asks"];

const MAX_BUFFERED_DEPTH_EVENTS = 1000;
const MAX_SNAPSHOT_DEPTH_LEVELS = Object.freeze({
  [MARKET_KINDS.SPOT]: 5000,
  [MARKET_KINDS.PERPETUAL]: 1000,
});
const MAX_RETAINED_DEPTH_LEVELS = Object.freeze({
  [MARKET_KINDS.SPOT]: 10_000,
  [MARKET_KINDS.PERPETUAL]: 5_000,
});
const DEPTH_REFRESH_LEVELS = Object.freeze({
  [MARKET_KINDS.SPOT]: 8_000,
  [MARKET_KINDS.PERPETUAL]: 4_000,
});

function snapshotDepthBody(body, marketKind) {
  const snapshot = snapshotFlatFields(body, DEPTH_SNAPSHOT_ALLOWED_KEYS, ["bids", "asks"]);
  if (!snapshot) {
    return null;
  }
  const { lastUpdateId, bids, asks } = snapshot;
  if (!Number.isSafeInteger(lastUpdateId) || lastUpdateId < 0) {
    return null;
  }
  const maxSnapshotLevels = MAX_SNAPSHOT_DEPTH_LEVELS[marketKind];
  const validBids = snapshotTupleArray(bids, maxSnapshotLevels, { requirePositivePrice: true });
  const validAsks = snapshotTupleArray(asks, maxSnapshotLevels, { requirePositivePrice: true });
  if (!validBids || !validAsks) {
    return null;
  }
  return { lastUpdateId, bids: validBids, asks: validAsks };
}

function ownDataValue(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function sanitizeDeltaEnvelope(input, marketKind) {
  if (input === null || typeof input !== "object" || utilTypes.isProxy(input)) {
    return null;
  }
  if (ownDataValue(input, "state") === "UNAVAILABLE") {
    return null;
  }
  const payload = ownDataValue(input, "payload");
  if (payload === null || typeof payload !== "object" || utilTypes.isProxy(payload)) {
    return null;
  }
  const firstUpdateId = ownDataValue(payload, "firstUpdateId");
  const lastUpdateId = ownDataValue(payload, "lastUpdateId");
  const previousUpdateId = ownDataValue(payload, "previousUpdateId");
  if (
    !Number.isSafeInteger(firstUpdateId) ||
    firstUpdateId < 0 ||
    !Number.isSafeInteger(lastUpdateId) ||
    lastUpdateId < firstUpdateId ||
    (marketKind === MARKET_KINDS.PERPETUAL
      ? !Number.isSafeInteger(previousUpdateId) || previousUpdateId < 0
      : previousUpdateId !== null)
  ) {
    return null;
  }
  const bids = snapshotTupleArray(ownDataValue(payload, "bids"), MAX_DEPTH_ENTRIES, { requirePositivePrice: true });
  const asks = snapshotTupleArray(ownDataValue(payload, "asks"), MAX_DEPTH_ENTRIES, { requirePositivePrice: true });
  if (!bids || !asks) {
    return null;
  }
  return Object.freeze({
    payload: Object.freeze({ firstUpdateId, lastUpdateId, previousUpdateId, bids, asks }),
  });
}

function isCoveredBySnapshot(event, lastUpdateId, marketKind) {
  return marketKind === MARKET_KINDS.PERPETUAL
    ? event.payload.lastUpdateId < lastUpdateId
    : event.payload.lastUpdateId <= lastUpdateId;
}

function bridgesFromSnapshot(event, lastUpdateId, marketKind) {
  return marketKind === MARKET_KINDS.PERPETUAL
    ? event.payload.firstUpdateId <= lastUpdateId && event.payload.lastUpdateId >= lastUpdateId
    : event.payload.firstUpdateId <= lastUpdateId + 1;
}

function checkContinuity(event, localUpdateId, marketKind) {
  if (event.payload.lastUpdateId <= localUpdateId) {
    return "STALE";
  }
  if (marketKind === MARKET_KINDS.PERPETUAL) {
    return event.payload.previousUpdateId === localUpdateId ? "APPLY" : "GAP";
  }
  return event.payload.firstUpdateId <= localUpdateId + 1 ? "APPLY" : "GAP";
}

function comparePrices(a, b) {
  const difference = Number(a) - Number(b);
  if (difference !== 0) return difference > 0 ? 1 : -1;
  return compareDecimalStrings(a, b);
}

function createSide() {
  const levels = new Map();
  const keys = [];

  function position(key) {
    let low = 0;
    let high = keys.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const order = comparePrices(keys[middle], key);
      if (order === 0) return { index: middle, found: true };
      if (order < 0) low = middle + 1;
      else high = middle;
    }
    return { index: low, found: false };
  }

  function set(key, tuple) {
    if (!levels.has(key)) {
      const { index } = position(key);
      keys.splice(index, 0, key);
    }
    levels.set(key, tuple);
  }

  function remove(key) {
    if (!levels.delete(key)) return;
    const { index, found } = position(key);
    if (found) keys.splice(index, 1);
  }

  return {
    levels,
    set,
    remove,
    get size() { return levels.size; },
    lowest() { return keys.length > 0 ? keys[0] : null; },
    highest() { return keys.length > 0 ? keys[keys.length - 1] : null; },
    tuples(direction) {
      const out = new Array(keys.length);
      for (let index = 0; index < keys.length; index += 1) {
        out[index] = levels.get(direction > 0 ? keys[index] : keys[keys.length - 1 - index]);
      }
      return Object.freeze(out);
    },
  };
}

function applyPriceLevels(side, tuples) {
  for (const [price, quantity] of tuples) {
    const key = canonicalizeDecimalString(price);
    if (compareDecimalStrings(quantity, "0") === 0) {
      side.remove(key);
      continue;
    }
    side.set(key, Object.freeze([price, quantity]));
  }
}

function sideFromTuples(tuples) {
  const side = createSide();
  applyPriceLevels(side, tuples);
  return side;
}

function isCrossedBook(bidSide, askSide) {
  if (bidSide.size === 0 || askSide.size === 0) return false;
  return comparePrices(bidSide.highest(), askSide.lowest()) >= 0;
}

function createBinanceBookAssembler({ marketKind }) {
  if (marketKind !== MARKET_KINDS.SPOT && marketKind !== MARKET_KINDS.PERPETUAL) {
    throw new Error("createBinanceBookAssembler: marketKind must be SPOT or PERPETUAL");
  }
  let buffer = [];
  let bids = createSide();
  let asks = createSide();
  let bestBid = null;
  let bestAsk = null;
  let localUpdateId = null;
  let hasSnapshot = false;
  let unavailableReason = null;
  let needsBridgeCheck = false;

  let bookVersion = 0;
  let cachedBook = null;
  let cachedBookVersion = -1;

  function markBookChanged() {
    bookVersion += 1;
  }

  function invalidateBook(reason) {
    hasSnapshot = false;
    localUpdateId = null;
    unavailableReason = reason;
    needsBridgeCheck = false;
    bids = createSide();
    asks = createSide();
    bestBid = null;
    bestAsk = null;
    markBookChanged();
  }

  function invalidateCrossedBook() {
    invalidateBook("CROSSED_BOOK");
  }

  function invalidateBookKeepingFirstReason(reason) {
    const firstReason = unavailableReason ?? reason;
    invalidateBook(firstReason);
  }

  function exceedsRetainedLevelCap() {
    const cap = MAX_RETAINED_DEPTH_LEVELS[marketKind];
    return bids.size > cap || asks.size > cap;
  }

  function shouldRefreshSnapshot() {
    if (!hasSnapshot || needsBridgeCheck || unavailableReason !== null) return false;
    const threshold = DEPTH_REFRESH_LEVELS[marketKind];
    return bids.size >= threshold || asks.size >= threshold;
  }

  function applyBookLevels(levels, tuples, side) {
    applyPriceLevels(levels, tuples);
    if (side === "bid") bestBid = levels.highest();
    else bestAsk = levels.lowest();
  }

  function bookIsCrossed() {
    return bestBid !== null && bestAsk !== null && compareDecimalStrings(bestBid, bestAsk) >= 0;
  }

  function pushToBuffer(event) {
    buffer.push(event);
    if (buffer.length > MAX_BUFFERED_DEPTH_EVENTS) {
      buffer.shift();
      if (!hasSnapshot && unavailableReason === null) {
        unavailableReason = "BUFFER_OVERFLOW_BEFORE_SNAPSHOT";
      }
    }
  }

  function drainBuffer() {
    if (localUpdateId === null) {
      return;
    }
    while (buffer.length > 0) {
      const event = buffer[0];

      if (needsBridgeCheck) {
        if (isCoveredBySnapshot(event, localUpdateId, marketKind)) {
          buffer.shift();
          continue;
        }
        if (!bridgesFromSnapshot(event, localUpdateId, marketKind)) {
          invalidateBook("SEQUENCE_GAP");
          return;
        }
        applyBookLevels(bids, event.payload.bids, "bid");
        applyBookLevels(asks, event.payload.asks, "ask");
        localUpdateId = event.payload.lastUpdateId;
        needsBridgeCheck = false;
        buffer.shift();
        if (exceedsRetainedLevelCap()) {
          invalidateBook("BOOK_LEVEL_CAP_EXCEEDED");
          return;
        }
        if (bookIsCrossed()) {
          invalidateCrossedBook();
          return;
        }
        markBookChanged();
        continue;
      }

      const verdict = checkContinuity(event, localUpdateId, marketKind);
      if (verdict === "STALE") {
        buffer.shift();
        continue;
      }
      if (verdict === "GAP") {
        invalidateBook("SEQUENCE_GAP");
        return;
      }
      applyBookLevels(bids, event.payload.bids, "bid");
      applyBookLevels(asks, event.payload.asks, "ask");
      localUpdateId = event.payload.lastUpdateId;
      hasSnapshot = true;
      unavailableReason = null;
      buffer.shift();
      if (exceedsRetainedLevelCap()) {
        invalidateBook("BOOK_LEVEL_CAP_EXCEEDED");
        return;
      }
      if (bookIsCrossed()) {
        invalidateCrossedBook();
        return;
      }
      markBookChanged();
    }
  }

  function applySnapshotStatus(body) {
    const validated = snapshotDepthBody(body, marketKind);
    if (!validated) {
      if (!hasSnapshot && unavailableReason === null) {
        unavailableReason = "SNAPSHOT_MALFORMED";
      }
      return getStatus();
    }

    const remainingBuffer = buffer.filter(
      (event) => !isCoveredBySnapshot(event, validated.lastUpdateId, marketKind),
    );

    if (remainingBuffer.length > 0 && !bridgesFromSnapshot(remainingBuffer[0], validated.lastUpdateId, marketKind)) {
      if (!hasSnapshot && unavailableReason === null) {
        unavailableReason = "SNAPSHOT_TOO_OLD";
      }
      return getStatus();
    }

    const snapshotBids = sideFromTuples(validated.bids);
    const snapshotAsks = sideFromTuples(validated.asks);
    if (isCrossedBook(snapshotBids, snapshotAsks)) {
      if (!hasSnapshot && unavailableReason === null) {
        unavailableReason = "CROSSED_BOOK";
      }
      return getStatus();
    }
    bids = snapshotBids;
    asks = snapshotAsks;
    bestBid = bids.highest();
    bestAsk = asks.lowest();
    localUpdateId = validated.lastUpdateId;
    hasSnapshot = true;
    unavailableReason = null;
    needsBridgeCheck = true;
    buffer = remainingBuffer;
    markBookChanged();

    drainBuffer();
    return getStatus();
  }

  function applySnapshot(body) {
    applySnapshotStatus(body);
    return getState();
  }

  function applyDeltaEventStatus(input) {
    const sanitized = sanitizeDeltaEnvelope(input, marketKind);
    if (!sanitized) {
      invalidateBookKeepingFirstReason("UPSTREAM_EVENT_UNAVAILABLE");
      return getStatus();
    }
    pushToBuffer(sanitized);
    drainBuffer();
    return getStatus();
  }

  function applyDeltaEvent(input) {
    applyDeltaEventStatus(input);
    return getState();
  }

  function getStatus() {
    if (hasSnapshot && !needsBridgeCheck) {
      // The best prices ride along non-enumerably, so a reader that only needs
      // the top of the book (the L2 ledger, for a pair kept live off screen)
      // gets it without the sorted sides getState() builds: sorting thousands
      // of decimal-string prices per event per pair is what pinned the process.
      const status = { status: "READY" };
      Object.defineProperties(status, {
        bestBid: { enumerable: false, value: bestBid },
        bestAsk: { enumerable: false, value: bestAsk },
      });
      return Object.freeze(status);
    }
    if (unavailableReason) {
      return Object.freeze({ status: "UNAVAILABLE", reason: unavailableReason });
    }
    return Object.freeze({ status: "BUFFERING" });
  }

  function getState() {
    if (hasSnapshot && !needsBridgeCheck) {
      if (cachedBook === null || cachedBookVersion !== bookVersion) {
        cachedBook = Object.freeze({
          bids: bids.tuples(-1),
          asks: asks.tuples(1),
          lastUpdateId: localUpdateId,
        });
        cachedBookVersion = bookVersion;
      }
      return Object.freeze({ status: "READY", book: cachedBook });
    }
    if (unavailableReason) {
      return Object.freeze({ status: "UNAVAILABLE", reason: unavailableReason });
    }
    return Object.freeze({ status: "BUFFERING" });
  }

  return Object.freeze({
    applySnapshot,
    applySnapshotStatus,
    applyDeltaEvent,
    applyDeltaEventStatus,
    getState,
    getStatus,
    shouldRefreshSnapshot,
  });
}

module.exports = {
  createBinanceBookAssembler,
  MAX_RETAINED_DEPTH_LEVELS,
  DEPTH_REFRESH_LEVELS,
};
