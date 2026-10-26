"use strict";

const { createHash } = require("node:crypto");

const SCHEMA = "historical-l2-second/1";
const SECOND = 1_000_000_000n;
const MAX_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

function integer(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) {
    throw new Error("historical-second-sampler: exact unsigned integer string required");
  }
  return BigInt(value);
}
function key(value) {
  if (!Array.isArray(value) || value.length !== 4) throw new Error("historical-second-sampler: four-field cursor required");
  return value.map(integer);
}
function compare(a, b) {
  for (let index = 0; index < 4; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}
function decimal(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d{1,12})?$/.test(value)) {
    throw new Error("historical-second-sampler: exact source decimal required");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(12, "0"));
}
function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function emptyFlow() { return { BUY: 0, SELL: 0, UNKNOWN: 0, count: 0 }; }

function createHistoricalSecondSampler({ derivationId, instrumentId, tickSize, fromNs, toNs,
  depthLimit = 10, maxPriceKeysPerSecond = 4096 } = {}) {
  const start = integer(fromNs);
  const end = integer(toNs);
  const tick = decimal(tickSize);
  if (typeof derivationId !== "string" || !/^[a-f0-9]{64}$/.test(derivationId) || typeof instrumentId !== "string" || !instrumentId
      || instrumentId.length > 128 || !tick || start >= end || end - start > 86_400n * SECOND
      || !Number.isSafeInteger(depthLimit) || depthLimit < 1 || depthLimit > 10
      || !Number.isSafeInteger(maxPriceKeysPerSecond) || maxPriceKeysPerSecond < 20 || maxPriceKeysPerSecond > 4096) {
    throw new Error("historical-second-sampler: invalid identity, geometry or window admission");
  }
  let cursor = null;
  let lastKnown = null;
  let active = null;
  let segmentStart = start;
  let reason = "NO_SOURCE_SEED";
  let book = { bids: [], asks: [] };
  let pending = new Map();
  let flow = emptyFlow();
  let outside = emptyFlow();
  let secondOpen = start / SECOND * SECOND;
  let coveredFrom = start;
  let finished = false;
  let failed = false;
  let busy = false;
  let outputSeq = 0;
  let rows = 0;

  function priceKey(price) {
    const scaled = decimal(price);
    if (scaled <= 0n || scaled % tick || scaled / tick > MAX_INTEGER) {
      throw new Error("historical-second-sampler: price is off grid or outside exact range");
    }
    return Number(scaled / tick);
  }
  function size(value) {
    const scaled = decimal(value);
    if (scaled <= 0n || scaled % 1_000_000_000_000n || scaled / 1_000_000_000_000n > MAX_INTEGER) {
      throw new Error("historical-second-sampler: this profile requires positive exact integer quantities");
    }
    return Number(scaled / 1_000_000_000_000n);
  }
  function normalize(values, descending) {
    if (!Array.isArray(values) || !values.length || values.length > depthLimit) {
      throw new Error("historical-second-sampler: complete bounded two-sided book required");
    }
    let previous = null;
    return values.map((level) => {
      const price = priceKey(level.price);
      const quantity = size(level.size);
      if (previous !== null && (descending ? price >= previous : price <= previous)) {
        throw new Error("historical-second-sampler: book must be strictly best first");
      }
      previous = price;
      return { price, quantity };
    });
  }
  function envelope(family, payload, known, trigger = cursor) {
    const seq = outputSeq++;
    rows += 1;
    return Object.freeze({ schema: SCHEMA, family, derivation_id: derivationId, instrument_id: instrumentId,
      record_id: hash([SCHEMA, derivationId, instrumentId, seq]), append_position: seq,
      known_ns: String(known), known_key: trigger === null ? null : trigger.map(String), payload });
  }
  function knownAt(at) { return lastKnown === null || lastKnown < at ? at : lastKnown; }
  function segment(action, at, known, trigger, segmentId = active, cause = reason) {
    return envelope("l2_book_segment", { action, segment_id: segmentId, trusted: segmentId !== null,
      open_ns: String(segmentStart), boundary_ns: String(at), reason: cause, depth_limit: depthLimit }, known, trigger);
  }
  function* flush(close, complete, cause = reason) {
    if (close < coveredFrom || close === coveredFrom && flow.count === 0 && outside.count === 0) return;
    const base = { open_ns: String(secondOpen), close_ns: String(close), covered_from_ns: String(coveredFrom),
      complete, point_prefix: close === coveredFrom, segment_id: active, trusted: active !== null,
      reason: cause, depth_limit: depthLimit };
    const known = knownAt(close);
    const bounds = (levels) => levels.length ? [Math.min(...levels.map((l) => l.price)), Math.max(...levels.map((l) => l.price))] : null;
    const bidRange = active ? bounds(book.bids) : null;
    const askRange = active ? bounds(book.asks) : null;
    const emptyLevel = (price) => ({ price_key: price,
      bid_size: bidRange && price >= bidRange[0] && price <= bidRange[1] ? 0 : null,
      ask_size: askRange && price >= askRange[0] && price <= askRange[1] ? 0 : null,
      buy_volume: 0, sell_volume: 0 });
    yield envelope("l2_level_state_1s", { ...base, row_kind: "coverage", tick_size: tickSize,
      bid_range: bidRange, ask_range: askRange,
      flow: { ...flow }, outside_trust: { ...outside } }, known);
    const prices = new Map();
    if (active) {
      for (const [side, values] of [["bid_size", book.bids], ["ask_size", book.asks]]) {
        for (const level of values) {
          const row = prices.get(level.price) ?? emptyLevel(level.price);
          row[side] = level.quantity;
          prices.set(level.price, row);
        }
      }
      for (const [price, value] of pending) {
        const row = prices.get(price) ?? emptyLevel(price);
        row.buy_volume = value.BUY;
        row.sell_volume = value.SELL;
        prices.set(price, row);
      }
    }
    for (const price of [...prices.keys()].sort((a, b) => a - b)) {
      const row = prices.get(price);
      yield envelope("l2_level_state_1s", { ...base, row_kind: "level", ...row }, known);
    }
    pending.clear();
    flow = emptyFlow();
    outside = emptyFlow();
    coveredFrom = close;
  }
  function* advance(at) {
    while (secondOpen + SECOND <= at) {
      const close = secondOpen + SECOND;
      yield* flush(close, coveredFrom === secondOpen);
      secondOpen = close;
      coveredFrom = close;
    }
  }
  function add(total, side, quantity) {
    total[side] += quantity;
    total.count += 1;
    if (!Number.isSafeInteger(total[side]) || !Number.isSafeInteger(total.count)) {
      throw new Error("historical-second-sampler: flow exceeds exact integer range");
    }
  }
  function* observe({ sourceKey, knownNs, segmentId, bids, asks, unavailableReason, boundaryReason, trade = null } = {}) {
    if (failed || finished || busy) throw new Error("historical-second-sampler: closed, failed or busy sampler");
    busy = true;
    let completed = false;
    try {
      const current = key(sourceKey);
      const at = current[0];
      const known = integer(knownNs);
      if (at < start || at >= end || cursor && compare(current, cursor) <= 0 || known < at
          || lastKnown !== null && known < lastKnown) throw new Error("historical-second-sampler: source/knowledge order or bounds invalid");
      const ready = segmentId !== null;
      if (ready ? !/^[a-f0-9]{64}$/.test(segmentId ?? "") : typeof unavailableReason !== "string" || !unavailableReason) {
        throw new Error("historical-second-sampler: trusted identity or unavailable reason required");
      }
      const nextBook = ready ? { bids: normalize(bids, true), asks: normalize(asks, false) } : { bids: [], asks: [] };
      if (ready && nextBook.bids[0].price >= nextBook.asks[0].price) throw new Error("historical-second-sampler: crossed book cannot be trusted");
      let print = null;
      if (trade !== null) {
        if (!trade || !["BUY", "SELL", "UNKNOWN"].includes(trade.side) || integer(trade.event_ns) !== at) {
          throw new Error("historical-second-sampler: trade side/time invalid");
        }
        if (decimal(trade.price) <= 0n) throw new Error("historical-second-sampler: positive trade price required");
        print = { side: trade.side, price: trade.side === "UNKNOWN" ? null : priceKey(trade.price), quantity: size(trade.size) };
      }
      if (cursor === null) yield segment("open", start, start, null, null, "NO_SOURCE_SEED");
      const uncertain = active !== null && segmentId !== active &&
        ["SOURCE_GAP_SUSPECTED", "SOURCE_BOUNDARY_UNKNOWN", "SESSION_BOUNDARY"].includes(boundaryReason ?? unavailableReason);
      if (uncertain) {
        const through = cursor[0] + 1n;
        yield* advance(through);
        yield* flush(through, false, "LAST_VERIFIED_PREFIX");
        yield segment("close", through, known, current);
        active = null;
        reason = "SOURCE_INTERVAL_UNVERIFIED";
        segmentStart = through;
        book = { bids: [], asks: [] };
        cursor = current;
        lastKnown = known;
        yield segment("open", through, known, current);
      }
      yield* advance(at);
      if (segmentId !== active || !ready && unavailableReason !== reason) {
        yield* flush(at, false, "SEGMENT_BOUNDARY");
        yield segment("close", at, known, current, active, reason);
        active = segmentId;
        segmentStart = at;
        coveredFrom = at;
        reason = ready ? "TRUSTED_SOURCE" : unavailableReason;
        yield segment("open", at, known, current);
      }
      cursor = current;
      lastKnown = known;
      book = nextBook;
      if (print) {
        add(ready ? flow : outside, print.side, print.quantity);
        if (ready && print.side !== "UNKNOWN") {
          if (!pending.has(print.price) && pending.size >= maxPriceKeysPerSecond) {
            throw new Error("historical-second-sampler: per-second price budget exceeded");
          }
          const value = pending.get(print.price) ?? emptyFlow();
          add(value, print.side, print.quantity);
          pending.set(print.price, value);
        }
      }
      completed = true;
    } finally {
      busy = false;
      if (!completed) failed = true;
    }
  }
  function* finish() {
    if (failed || finished || busy) throw new Error("historical-second-sampler: closed, failed or busy sampler");
    busy = true;
    let completed = false;
    try {
      if (cursor !== null) {
        const through = cursor[0] + 1n;
        yield* advance(through);
        yield* flush(through, false, "FINAL_SOURCE_PREFIX");
        if (through < end) {
          yield segment("close", through, knownAt(through), cursor);
          active = null;
          reason = "TAIL_NOT_VERIFIED";
          book = { bids: [], asks: [] };
          segmentStart = through;
          coveredFrom = through;
          yield segment("open", through, knownAt(through), cursor);
        }
      } else yield segment("open", start, knownAt(start), null);
      yield* advance(end);
      yield* flush(end, false);
      yield envelope("l2_book_segment", { action: "close", segment_id: active, trusted: active !== null,
        open_ns: String(segmentStart), boundary_ns: String(end), reason, depth_limit: depthLimit,
        final: true, window_from_ns: fromNs, window_to_ns: toNs }, knownAt(end));
      completed = true;
      finished = true;
    } finally {
      busy = false;
      if (!completed) failed = true;
    }
  }
  return Object.freeze({ observe, finish, priceKey, get rows() { return rows; } });
}

module.exports = { SCHEMA, createHistoricalSecondSampler };
