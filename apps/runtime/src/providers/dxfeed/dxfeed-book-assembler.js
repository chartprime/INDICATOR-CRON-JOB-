const { types: utilTypes } = require("node:util");

const TX_PENDING_BIT = 0x01;
const REMOVE_EVENT_BIT = 0x02;
const SNAPSHOT_BEGIN_BIT = 0x04;
const SNAPSHOT_END_BIT = 0x08;
const SNAPSHOT_SNIP_BIT = 0x10;

const VALID_SIDES = new Set(["BUY", "SELL"]);
const ZERO_PRICE_ACTIONS = new Set(["TRADE", "BUST"]);
const UPSERT_ACTIONS = new Set(["NEW", "REPLACE", "MODIFY", "PARTIAL"]);
const REMOVE_ACTIONS = new Set(["DELETE", "EXECUTE"]);
const NOOP_ACTIONS = new Set(["TRADE", "BUST"]);
const DEFAULT_MAX_PENDING_EVENTS = 250_000;
const DEFAULT_MAX_RETAINED_ORDERS = 250_000;
const DEFAULT_CROSSED_GRACE_MS = 30_000;

function isSnapshotBegin(eventFlags) {
  return (eventFlags & SNAPSHOT_BEGIN_BIT) !== 0;
}

function isSnapshotEnd(eventFlags) {
  return (eventFlags & SNAPSHOT_END_BIT) !== 0;
}

function isSnapshotSnip(eventFlags) {
  return (eventFlags & SNAPSHOT_SNIP_BIT) !== 0;
}

function isTxPending(eventFlags) {
  return (eventFlags & TX_PENDING_BIT) !== 0;
}

function isRemoveEventFlag(eventFlags) {
  return (eventFlags & REMOVE_EVENT_BIT) !== 0;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFiniteNumber(value) {
  return isFiniteNumber(value) && value > 0;
}

function isNonNegativeFiniteNumber(value) {
  return isFiniteNumber(value) && value >= 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isBigIntIndexString(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value) || value.length > 20) {
    return false;
  }
  try {
    BigInt(value);
  } catch {
    return false;
  }
  return true;
}

function isValidOrderV2Price(price, action) {
  return isPositiveFiniteNumber(price) || (price === 0 && ZERO_PRICE_ACTIONS.has(action));
}

function ownDataValue(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function matchesExpectedIdentity(envelope, expectedIdentity) {
  if (expectedIdentity === null) return true;
  if (envelope === null || typeof envelope !== "object" || utilTypes.isProxy(envelope)) return false;
  return (
    ownDataValue(envelope, "provider") === "DXFEED" &&
    ownDataValue(envelope, "eventType") === "ORDER" &&
    ownDataValue(envelope, "providerSymbol") === expectedIdentity.symbol &&
    ownDataValue(envelope, "assetClass") === expectedIdentity.assetClass
  );
}

function sanitizeOrderV2Envelope(envelope) {
  if (envelope === null || typeof envelope !== "object" || utilTypes.isProxy(envelope)) {
    return null;
  }
  if (ownDataValue(envelope, "state") === "UNAVAILABLE") {
    return null;
  }
  const payload = ownDataValue(envelope, "payload");
  if (payload === null || typeof payload !== "object" || utilTypes.isProxy(payload)) {
    return null;
  }
  const index = ownDataValue(payload, "index");
  const eventFlags = ownDataValue(payload, "eventFlags");
  const action = ownDataValue(payload, "action");
  const price = ownDataValue(payload, "price");
  const size = ownDataValue(payload, "size");
  const side = ownDataValue(payload, "side");
  const scope = ownDataValue(payload, "scope");
  const source = ownDataValue(payload, "source");
  if (
    !isBigIntIndexString(index) ||
    !Number.isSafeInteger(eventFlags) || eventFlags < 0 ||
    !isNonEmptyString(source)
  ) {
    return null;
  }
  if (isRemoveEventFlag(eventFlags)) {
    return Object.freeze({ index, eventFlags, action, price, size, side, source });
  }
  // TRADE and BUST are the feed's trade bookkeeping on the order stream, not
  // orders: GLBX sends them with price 0, no size and side UNDEFINED, and NQ's
  // snapshot carries one. They never touch the book (mutateOrder returns
  // before looking at them), so their price, size, side and scope are not
  // judged here. Rejecting one threw the whole snapshot away and the book
  // stayed UNAVAILABLE until the next session, where the same record came back.
  if (NOOP_ACTIONS.has(action)) {
    return Object.freeze({ index, eventFlags, action, price, size, side, source });
  }
  if (
    !isNonEmptyString(action) ||
    !isValidOrderV2Price(price, action) ||
    !(size === null || size === undefined || isNonNegativeFiniteNumber(size)) ||
    !VALID_SIDES.has(side) ||
    scope !== "ORDER"
  ) {
    return null;
  }
  return Object.freeze({ index, eventFlags, action, price, size, side, source });
}

function extremePrice(levels, direction) {
  let extreme = null;
  for (const price of levels.keys()) {
    if (extreme === null || direction * (price - extreme) > 0) {
      extreme = price;
    }
  }
  return extreme;
}

function topLevels(levels, direction, depth) {
  const top = []; // [price, size], best first
  for (const [price, level] of levels) {
    let at = top.length;
    while (at > 0 && direction * (price - top[at - 1][0]) < 0) at -= 1;
    if (at >= depth) continue;
    top.splice(at, 0, [price, level.size]);
    if (top.length > depth) top.pop();
  }
  return Object.freeze(top.map((entry) => Object.freeze(entry)));
}

function sortedLevels(levels, direction) {
  return Object.freeze(
    [...levels.entries()]
      .sort((a, b) => direction * (a[0] - b[0]))
      .map(([price, level]) => Object.freeze([price, level.size])),
  );
}

function createDxFeedOrderBookAssembler({
  maxPendingEvents = DEFAULT_MAX_PENDING_EVENTS,
  maxRetainedOrders = DEFAULT_MAX_RETAINED_ORDERS,
  crossedGraceMs = DEFAULT_CROSSED_GRACE_MS,
  now = () => Date.now(),
  expectedSymbol,
  expectedAssetClass,
  expectedSource,
  onApplied = null,
} = {}) {
  if (!Number.isSafeInteger(maxPendingEvents) || maxPendingEvents <= 0) {
    throw new Error("dxfeed-book-assembler: maxPendingEvents must be a positive safe integer");
  }
  if (onApplied !== null && typeof onApplied !== "function") {
    throw new Error("dxfeed-book-assembler: onApplied must be a function when provided");
  }
  if (!Number.isSafeInteger(crossedGraceMs) || crossedGraceMs < 0) {
    throw new Error("dxfeed-book-assembler: crossedGraceMs must be a non-negative safe integer");
  }
  if (typeof now !== "function") {
    throw new Error("dxfeed-book-assembler: now must be a function");
  }
  if (!Number.isSafeInteger(maxRetainedOrders) || maxRetainedOrders <= 0) {
    throw new Error("dxfeed-book-assembler: maxRetainedOrders must be a positive safe integer");
  }
  const identityValues = [expectedSymbol, expectedAssetClass, expectedSource];
  const suppliedIdentityValues = identityValues.filter((value) => value !== undefined).length;
  if (suppliedIdentityValues !== 0 && suppliedIdentityValues !== identityValues.length) {
    throw new Error("dxfeed-book-assembler: expectedSymbol, expectedAssetClass, and expectedSource must be supplied together");
  }
  if (
    suppliedIdentityValues === identityValues.length &&
    (!isNonEmptyString(expectedSymbol) || !["FUTURE", "EQUITY"].includes(expectedAssetClass) || !isNonEmptyString(expectedSource))
  ) {
    throw new Error("dxfeed-book-assembler: expected identity is invalid");
  }
  const expectedIdentity = suppliedIdentityValues === 0
    ? null
    : Object.freeze({ symbol: expectedSymbol, assetClass: expectedAssetClass, source: expectedSource });
  let source = null;
  let pendingEvents = [];
  let isPartialSnapshot = false;
  let isCompleteSnapshot = false;
  let hasSnapshot = false;
  let unavailableReason = null;
  let crossedSinceMs = null; // when the book first crossed, while it is being given the grace

  let orders = new Map();
  let bidLevels = new Map();
  let askLevels = new Map();
  let bestBid = null;
  let bestAsk = null;

  let localSequence = 0;
  let cachedBook = null;
  let cachedBookVersion = -1;
  let changedBids = new Map();
  let changedAsks = new Map();
  let snapshotCount = 0; // completed snapshot cycles: a reader resyncs when this moves

  function markBookChanged() {
    localSequence += 1;
  }

  function resetToUnavailable(reason) {
    source = null;
    crossedSinceMs = null;
    changedBids = new Map();
    changedAsks = new Map();
    pendingEvents = [];
    isPartialSnapshot = false;
    isCompleteSnapshot = false;
    hasSnapshot = false;
    unavailableReason = reason;
    orders = new Map();
    bidLevels = new Map();
    askLevels = new Map();
    bestBid = null;
    bestAsk = null;
    markBookChanged();
  }

  function invalidate(reason) {
    if (!isNonEmptyString(reason)) {
      throw new Error("dxfeed-book-assembler: invalidate requires a non-empty reason");
    }
    resetToUnavailable(reason);
    return getStatus();
  }

  function bookIsCrossed() {
    return bestBid !== null && bestAsk !== null && bestBid >= bestAsk;
  }

  function levelsFor(side) {
    return side === "BUY" ? bidLevels : askLevels;
  }

  function addToLevel(price, size, side) {
    const levels = levelsFor(side);
    (side === "BUY" ? changedBids : changedAsks).set(price, true);
    const current = levels.get(price);
    if (current === undefined) levels.set(price, { size, orderCount: 1 });
    else levels.set(price, { size: current.size + size, orderCount: current.orderCount + 1 });
    if (side === "BUY") {
      if (bestBid === null || price > bestBid) bestBid = price;
    } else if (bestAsk === null || price < bestAsk) {
      bestAsk = price;
    }
  }

  function removeFromLevel(price, size, side) {
    const levels = levelsFor(side);
    const current = levels.get(price);
    if (current === undefined) return;
    (side === "BUY" ? changedBids : changedAsks).set(price, true);
    const orderCount = current.orderCount - 1;
    if (orderCount <= 0) {
      levels.delete(price);
      if (side === "BUY" && price === bestBid) bestBid = extremePrice(bidLevels, 1);
      if (side === "SELL" && price === bestAsk) bestAsk = extremePrice(askLevels, -1);
      return;
    }
    levels.set(price, { size: current.size - size, orderCount });
  }

  function upsertOrder(index, price, size, side) {
    const existing = orders.get(index);
    if (existing) {
      removeFromLevel(existing.price, existing.size, existing.side);
    }
    orders.set(index, { price, size, side });
    addToLevel(price, size, side);
  }

  function removeOrder(index) {
    const existing = orders.get(index);
    if (!existing) return;
    removeFromLevel(existing.price, existing.size, existing.side);
    orders.delete(index);
  }

  function mutateOrder(sanitized) {
    const { index, eventFlags, action, price, size, side } = sanitized;
    if (isRemoveEventFlag(eventFlags)) {
      removeOrder(index);
      return;
    }
    if (NOOP_ACTIONS.has(action)) return;
    if (REMOVE_ACTIONS.has(action)) {
      removeOrder(index);
      return;
    }
    if (size === null || size === 0) {
      removeOrder(index);
      return;
    }
    if (UPSERT_ACTIONS.has(action)) {
      upsertOrder(index, price, size, side);
      return;
    }
    upsertOrder(index, price, size, side);
  }

  function applySnapshotReplace(events) {
    orders = new Map();
    bidLevels = new Map();
    askLevels = new Map();
    bestBid = null;
    bestAsk = null;
    changedBids = new Map();
    changedAsks = new Map();
    snapshotCount += 1;
    for (const event of events) {
      mutateOrder(event);
      if (orders.size > maxRetainedOrders) {
        resetToUnavailable("ORDER_CAP_EXCEEDED");
        return false;
      }
    }
    hasSnapshot = true;
    return true;
  }

  function applyIncrementalUpdates(events) {
    for (const event of events) {
      mutateOrder(event);
      if (orders.size > maxRetainedOrders) {
        resetToUnavailable("ORDER_CAP_EXCEEDED");
        return false;
      }
    }
    return true;
  }

  function applyEventStatus(envelope) {
    if (!matchesExpectedIdentity(envelope, expectedIdentity)) {
      resetToUnavailable("IDENTITY_MISMATCH");
      return getStatus();
    }
    const sanitized = sanitizeOrderV2Envelope(envelope);
    if (!sanitized) {
      resetToUnavailable("UPSTREAM_EVENT_UNAVAILABLE");
      return getStatus();
    }
    if (expectedIdentity !== null && sanitized.source !== expectedIdentity.source) {
      resetToUnavailable("IDENTITY_MISMATCH");
      return getStatus();
    }
    if (source === null) {
      source = sanitized.source;
    } else if (source !== sanitized.source) {
      resetToUnavailable("SOURCE_MISMATCH");
      return getStatus();
    }

    if (isSnapshotBegin(sanitized.eventFlags)) {
      isPartialSnapshot = true;
      isCompleteSnapshot = false;
      pendingEvents = [];
    }
    const snapshotWasSnipped = isPartialSnapshot && isSnapshotSnip(sanitized.eventFlags);
    const completingSnapshot = isPartialSnapshot && isSnapshotEnd(sanitized.eventFlags);
    if (snapshotWasSnipped) {
      resetToUnavailable("SNIPPED_SNAPSHOT");
      return getStatus();
    }

    if (completingSnapshot) {
      isPartialSnapshot = false;
      isCompleteSnapshot = true;
    }
    pendingEvents.push(sanitized);

    if (pendingEvents.length > maxPendingEvents) {
      resetToUnavailable("PENDING_EVENT_LIMIT_EXCEEDED");
      return getStatus();
    }

    if (isPartialSnapshot || isTxPending(sanitized.eventFlags)) {
      return getStatus();
    }

    const eventsToApply = pendingEvents;
    pendingEvents = [];

    if (isCompleteSnapshot) {
      isCompleteSnapshot = false;
      if (!applySnapshotReplace(eventsToApply)) return getStatus();
      if (onApplied !== null) onApplied(eventsToApply, { snapshot: true });
    } else if (hasSnapshot) {
      if (!applyIncrementalUpdates(eventsToApply)) return getStatus();
      if (onApplied !== null) onApplied(eventsToApply, { snapshot: false });
    } else {
      return getStatus();
    }

    if (bookIsCrossed()) {
      const at = now();
      if (crossedSinceMs === null) crossedSinceMs = at;
      if (at - crossedSinceMs >= crossedGraceMs) {
        resetToUnavailable("CROSSED_BOOK");
        return getStatus();
      }
      unavailableReason = "CROSSED_BOOK";
      markBookChanged();
      return getStatus();
    }
    crossedSinceMs = null;
    unavailableReason = null;
    markBookChanged();
    return getStatus();
  }

  function drainLevelChanges() {
    const pick = (changed, levels) => Object.freeze([...changed.keys()].map((price) => Object.freeze([price, levels.get(price)?.size ?? 0])));
    const result = Object.freeze({ bids: pick(changedBids, bidLevels), asks: pick(changedAsks, askLevels) });
    changedBids = new Map();
    changedAsks = new Map();
    return result;
  }

  function getSnapshotCount() {
    return snapshotCount;
  }

  function getBestPrices() {
    return Object.freeze({ bestBid, bestAsk });
  }

  function getTopOfBook(depth) {
    if (!Number.isSafeInteger(depth) || depth < 0) throw new Error("dxfeed-book-assembler: depth must be a non-negative safe integer");
    if (unavailableReason !== null) return Object.freeze({ status: "UNAVAILABLE", reason: unavailableReason });
    if (!hasSnapshot || isPartialSnapshot) return Object.freeze({ status: "BUFFERING" });
    return Object.freeze({
      status: "READY",
      book: Object.freeze({ bids: topLevels(bidLevels, -1, depth), asks: topLevels(askLevels, 1, depth), lastUpdateId: localSequence, bestBid, bestAsk }),
    });
  }

  function needsSnapshot() {
    return !hasSnapshot;
  }

  function getVersion() {
    return localSequence;
  }

  function applyEvent(envelope) {
    applyEventStatus(envelope);
    return getState();
  }

  function getStatus() {
    if (unavailableReason !== null) {
      return Object.freeze({ status: "UNAVAILABLE", reason: unavailableReason });
    }
    if (!hasSnapshot || isPartialSnapshot) {
      return Object.freeze({ status: "BUFFERING" });
    }
    return Object.freeze({ status: "READY" });
  }

  function getState() {
    if (unavailableReason !== null) {
      return Object.freeze({ status: "UNAVAILABLE", reason: unavailableReason });
    }
    if (!hasSnapshot || isPartialSnapshot) {
      return Object.freeze({ status: "BUFFERING" });
    }
    if (cachedBook === null || cachedBookVersion !== localSequence) {
      cachedBook = Object.freeze({
        bids: sortedLevels(bidLevels, -1),
        asks: sortedLevels(askLevels, 1),
        lastUpdateId: localSequence,
      });
      cachedBookVersion = localSequence;
    }
    return Object.freeze({ status: "READY", book: cachedBook });
  }

  return Object.freeze({ applyEvent, applyEventStatus, getState, getStatus, getTopOfBook, getBestPrices, drainLevelChanges, getSnapshotCount, getVersion, needsSnapshot, invalidate });
}

module.exports = {
  createDxFeedOrderBookAssembler,
  DEFAULT_MAX_PENDING_EVENTS,
  DEFAULT_MAX_RETAINED_ORDERS,
  DEFAULT_CROSSED_GRACE_MS,
};
