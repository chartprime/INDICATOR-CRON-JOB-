"use strict";

const { bookFrame, gapFrame } = require("./input-frames");

const CONTINUITY = new Set(["OK", "UNKNOWN", "RESET", "GAP_SUSPECTED"]);
const SORT_FIELDS = ["event_ns", "source_rank", "stable_position", "ordinal"];

function decimal(value, field, zeroAllowed = false) {
  const text = String(value);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) throw new Error(`historical-topn-frames: invalid ${field}`);
  const number = Number(text);
  if (!Number.isFinite(number) || (zeroAllowed ? number < 0 : number <= 0)) {
    throw new Error(`historical-topn-frames: invalid ${field}`);
  }
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

function integer(value, field) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error(`historical-topn-frames: ${field} must retain exact integer precision`);
  }
  const text = String(value);
  if (!/^(?:0|[1-9]\d*)$/.test(text)) throw new Error(`historical-topn-frames: invalid ${field}`);
  return BigInt(text);
}

function side(levels, name, descending, limit) {
  if (!Array.isArray(levels) || levels.length > limit) throw new Error(`historical-topn-frames: invalid ${name}`);
  let previous = null;
  return levels.map((level) => {
    if (!level || typeof level !== "object") throw new Error(`historical-topn-frames: invalid ${name} level`);
    const price = decimal(level.price, `${name} price`);
    const size = decimal(level.size, `${name} size`);
    const number = Number(price);
    if (previous !== null && (descending ? number >= previous : number <= previous)) {
      throw new Error(`historical-topn-frames: ${name} must be strictly best-first`);
    }
    previous = number;
    return [price, size];
  });
}

function normalize(row, depthLimit) {
  if (!row || typeof row !== "object" || typeof row.instrument_id !== "string" || !row.instrument_id) {
    throw new Error("historical-topn-frames: instrument_id is required");
  }
  if (row.depth_action !== "SNAPSHOT" || row.depth_model !== "TOP_N" || Number(row.depth_limit) !== depthLimit) {
    throw new Error("historical-topn-frames: expected a matching TOP_N snapshot");
  }
  if (!CONTINUITY.has(row.continuity)) throw new Error("historical-topn-frames: invalid continuity");
  const order = SORT_FIELDS.map((field) => integer(row[field], field));
  const ts = Number(order[0] / 1_000_000n);
  if (!Number.isSafeInteger(ts)) throw new Error("historical-topn-frames: timestamp exceeds engine range");
  const bids = side(row.bids, "bids", true, depthLimit);
  const asks = side(row.asks, "asks", false, depthLimit);
  const crossed = bids.length > 0 && asks.length > 0 && Number(bids[0][0]) >= Number(asks[0][0]);
  return { instrumentId: row.instrument_id, order, ts, bids, asks, crossed, continuity: row.continuity,
    bookEpoch: integer(row.book_epoch, "book_epoch"), date: row.date ?? null };
}

function compareOrder(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function delta(before, after, descending, limit) {
  const prior = new Map(before.map(([price, size]) => [price, size]));
  const current = new Map(after.map(([price, size]) => [price, size]));
  const out = [];
  const unobserved = [];
  const preexisting = [];
  const priorEdge = before.length ? Number(before.at(-1)[0]) : null;
  const currentEdge = after.length ? Number(after.at(-1)[0]) : null;
  for (const [price] of before) {
    if (current.has(price)) continue;
    if (after.length === limit && (descending ? Number(price) < currentEdge : Number(price) > currentEdge)) {
      unobserved.push(price);
    } else out.push([price, "0"]);
  }
  for (const [price, size] of after) {
    if (prior.get(price) === size) continue;
    if (!prior.has(price) && before.length === limit
        && (descending ? Number(price) < priorEdge : Number(price) > priorEdge)) {
      preexisting.push([price, size]);
    } else out.push([price, size]);
  }
  return { levels: out, unobserved, preexisting };
}

function createHistoricalTopNFrames({ depthLimit = 10 } = {}) {
  if (!Number.isSafeInteger(depthLimit) || depthLimit <= 0) throw new Error("historical-topn-frames: invalid depthLimit");
  let previous = null;
  let suspended = false;
  let activeTrusted = false;

  function push(row, { observationOnly = false } = {}) {
    if (typeof observationOnly !== "boolean") throw new Error("historical-topn-frames: observationOnly must be boolean");
    const current = normalize(row, depthLimit);
    if (previous && current.instrumentId !== previous.instrumentId) {
      throw new Error("historical-topn-frames: instrument changed; use a separate source");
    }
    if (previous && compareOrder(previous.order, current.order) >= 0) {
      throw new Error("historical-topn-frames: source order must increase");
    }
    let reason = null;
    if (current.continuity === "GAP_SUSPECTED") {
      suspended = true;
      activeTrusted = false;
      reason = "SOURCE_GAP_SUSPECTED";
    } else if (suspended && (current.continuity !== "RESET" || !current.bids.length || !current.asks.length || current.crossed)) {
      activeTrusted = false;
      reason = "AWAITING_SOURCE_RESET";
    } else if (!current.bids.length || !current.asks.length) {
      activeTrusted = false;
      reason = "INCOMPLETE_BOOK";
    } else if (current.crossed) {
      activeTrusted = false;
      reason = "CROSSED_BOOK";
    } else {
      if (suspended) suspended = false;
      if (!previous) reason = "INITIAL";
      else if (current.continuity === "RESET") reason = "SOURCE_RESET";
      else if (!activeTrusted) reason = "REESTABLISHED_BOOK";
      else if (current.continuity === "UNKNOWN" || current.bookEpoch !== previous.bookEpoch) reason = "SOURCE_BOUNDARY_UNKNOWN";
      else if (current.date !== null && previous.date !== null && current.date !== previous.date) reason = "SESSION_BOUNDARY";
      else {
        const bids = delta(previous.bids, current.bids, true, depthLimit);
        const asks = delta(previous.asks, current.asks, false, depthLimit);
        if (observationOnly && (JSON.stringify(previous.bids) !== JSON.stringify(current.bids)
            || JSON.stringify(previous.asks) !== JSON.stringify(current.asks))) {
          throw new Error("historical-topn-frames: an observation-only book must not change levels");
        }
        previous = current;
        activeTrusted = true;
        if (observationOnly) {
          return { restartEngine: false, reason: null,
            frames: [bookFrame(current.ts, "READY", { bids: current.bids, asks: current.asks }, null)] };
        }
        return { restartEngine: false, reason: null,
          frames: [bookFrame(current.ts, "READY", { bids: current.bids, asks: current.asks },
            { bids: bids.levels, asks: asks.levels },
            { unobserved: { bids: bids.unobserved, asks: asks.unobserved },
              preexisting: { bids: bids.preexisting, asks: asks.preexisting } })] };
      }
    }
    previous = current;
    if (suspended || !current.bids.length || !current.asks.length || current.crossed) {
      return { restartEngine: true, reason, frames: [gapFrame(reason, current.ts)] };
    }
    activeTrusted = true;
    return { restartEngine: true, reason,
      frames: [gapFrame(reason, current.ts), bookFrame(current.ts, "READY", { bids: current.bids, asks: current.asks }, null)] };
  }

  return Object.freeze({ push });
}

module.exports = { createHistoricalTopNFrames };
