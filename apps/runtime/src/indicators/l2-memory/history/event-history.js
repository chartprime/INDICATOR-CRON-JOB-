"use strict";

const AGGRESSORS = new Set(["buy", "sell"]);
const MODES = new Set(["absorbed", "swept"]);
const DEFAULT_TRADE_BYTES = 16 * 1024 * 1024;
const DEFAULT_WALL_TRADE_BYTES = 8 * 1024 * 1024;
const BYTES_PER_TRADE = 40;
const BYTES_PER_WALL_TRADE = 72;
const TRIM_TARGET = 0.9;
const DEFAULT_PAGE = 2_000;
const MAX_COVERED = 2_048;
const VERSION = 1;

function bucketOf(ts, widthMs) {
  return Math.floor(ts / widthMs) * widthMs;
}

function tradeKey(ts, row, aggressor, mode) {
  return `${ts}:${row}:${aggressor}:${mode}`;
}

function wallKeyOf(wall) {
  return `${wall.side}:${wall.row}:${wall.span}:${wall.startTs}`;
}

function validTrade(trade) {
  return trade && typeof trade === "object" && Number.isSafeInteger(trade.ts) && trade.ts >= 0 && Number.isSafeInteger(trade.row) && trade.row >= 0
    && AGGRESSORS.has(trade.aggressor) && MODES.has(trade.mode) && Number.isFinite(trade.size) && trade.size > 0;
}

function validWallTrade(trade) {
  return trade && typeof trade === "object" && Number.isSafeInteger(trade.ts) && trade.ts >= 0 && MODES.has(trade.mode) && Number.isFinite(trade.size) && trade.size > 0
    && trade.wall && typeof trade.wall === "object" && (trade.wall.side === "bid" || trade.wall.side === "ask")
    && Number.isSafeInteger(trade.wall.row) && Number.isSafeInteger(trade.wall.span) && trade.wall.span >= 1 && Number.isSafeInteger(trade.wall.startTs);
}

function validRange(range) {
  return Array.isArray(range) && range.length === 2 && Number.isSafeInteger(range[0]) && Number.isSafeInteger(range[1]) && range[0] < range[1];
}

// Sorted, non-overlapping [from, until) spans: adjacent or overlapping spans are joined.
function joinRanges(ranges) {
  const out = [];
  for (const [from, until] of [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = out[out.length - 1];
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], until);
    else out.push([from, until]);
  }
  return out;
}

function inRanges(ranges, ts) {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid][1] <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo < ranges.length && ranges[lo][0] <= ts;
}

function byTrade(a, b) {
  return a.ts - b.ts || a.row - b.row || (a.aggressor < b.aggressor ? -1 : a.aggressor > b.aggressor ? 1 : 0) || (a.mode < b.mode ? -1 : a.mode > b.mode ? 1 : 0);
}

function byWallTrade(a, b) {
  return a.ts - b.ts || (a.wall < b.wall ? -1 : a.wall > b.wall ? 1 : 0) || (a.mode < b.mode ? -1 : a.mode > b.mode ? 1 : 0);
}

function createEventHistory({
  columnMs,
  deepColumnMs,
  recentMs,
  maxAgeMs,
  maxTradeBytes = DEFAULT_TRADE_BYTES,
  maxWallTradeBytes = DEFAULT_WALL_TRADE_BYTES,
} = {}) {
  if (!Number.isSafeInteger(columnMs) || columnMs <= 0) throw new Error("event-history: columnMs must be a positive safe integer");
  if (!Number.isSafeInteger(deepColumnMs) || deepColumnMs <= 0 || deepColumnMs % columnMs !== 0) throw new Error("event-history: deepColumnMs must be a positive multiple of columnMs");
  if (!Number.isSafeInteger(recentMs) || recentMs < 0) throw new Error("event-history: recentMs must be a non-negative safe integer");
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw new Error("event-history: maxAgeMs must be a positive safe integer");
  if (!Number.isSafeInteger(maxTradeBytes) || maxTradeBytes <= 0) throw new Error("event-history: maxTradeBytes must be a positive safe integer");
  if (!Number.isSafeInteger(maxWallTradeBytes) || maxWallTradeBytes <= 0) throw new Error("event-history: maxWallTradeBytes must be a positive safe integer");
  let fine = new Map();
  let deep = new Map();
  let wallTrades = new Map();
  let sortedTrades = null;
  let sortedWallTrades = null;
  let dirty = false;
  let fill = null;
  // The spans whose events this history already holds, whatever brought them in: the live tracker, a replay pass, the
  // fill or the host. A merge never adds an event again inside one, so a restart that asks again cannot count twice.
  let covered = [];
  let lostBefore = null;
  const counters = { trades: 0, wallTrades: 0, folded: 0, evicted: 0, pruned: 0, merged: 0, skipped: 0 };

  function touch() {
    sortedTrades = null;
    sortedWallTrades = null;
    dirty = true;
  }

  function add(map, key, record) {
    const known = map.get(key);
    if (known === undefined) {
      map.set(key, record);
      return;
    }
    known.size += record.size;
    known.count += record.count;
  }

  function recordTrades(list) {
    if (!Array.isArray(list)) throw new Error("event-history: recordTrades expects an array");
    let added = 0;
    for (const trade of list) {
      if (!validTrade(trade)) continue;
      const ts = bucketOf(trade.ts, columnMs);
      add(fine, tradeKey(ts, trade.row, trade.aggressor, trade.mode), { ts, columnMs, row: trade.row, aggressor: trade.aggressor, mode: trade.mode, size: trade.size, count: 1 });
      added += 1;
    }
    if (added > 0) {
      counters.trades += added;
      touch();
    }
    return added;
  }

  function recordWallTrades(list) {
    if (!Array.isArray(list)) throw new Error("event-history: recordWallTrades expects an array");
    let added = 0;
    for (const trade of list) {
      if (!validWallTrade(trade)) continue;
      const ts = bucketOf(trade.ts, columnMs);
      const wall = wallKeyOf(trade.wall);
      add(wallTrades, `${wall}:${ts}:${trade.mode}`, { ts, wall, mode: trade.mode, size: trade.size, count: 1 });
      added += 1;
    }
    if (added > 0) {
      counters.wallTrades += added;
      touch();
    }
    return added;
  }

  function fold(at) {
    const cutoff = at - recentMs;
    let folded = 0;
    for (const [key, record] of fine) {
      if (record.ts + columnMs > cutoff) continue;
      fine.delete(key);
      const ts = bucketOf(record.ts, deepColumnMs);
      add(deep, tradeKey(ts, record.row, record.aggressor, record.mode), { ...record, ts, columnMs: deepColumnMs });
      folded += 1;
    }
    return folded;
  }

  function lose(before) {
    if (lostBefore === null || before > lostBefore) lostBefore = before;
  }

  function evictOldest(map, over, lost = null) {
    if (over <= 0) return 0;
    const victims = [...map.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, over);
    for (const [key, record] of victims) {
      map.delete(key);
      if (lost !== null) lost(record.ts + record.columnMs);
    }
    return victims.length;
  }

  function capTrades(maxBytes) {
    const cap = Math.max(1, Math.floor(maxBytes / BYTES_PER_TRADE));
    let over = fine.size + deep.size - cap;
    let evicted = evictOldest(deep, Math.min(over, deep.size), lose);
    over -= evicted;
    evicted += evictOldest(fine, over, lose);
    return evicted;
  }

  function capWallTrades(maxBytes) {
    return evictOldest(wallTrades, wallTrades.size - Math.max(1, Math.floor(maxBytes / BYTES_PER_WALL_TRADE)));
  }

  function prune(at) {
    const cutoff = at - maxAgeMs;
    const kept = covered.filter(([, until]) => until > cutoff).map(([from, until]) => [Math.max(from, cutoff), until]);
    covered = kept;
    lose(cutoff);
    let pruned = 0;
    for (const map of [fine, deep, wallTrades]) {
      for (const [key, record] of map) {
        if (record.ts >= cutoff) continue;
        map.delete(key);
        pruned += 1;
      }
    }
    return pruned;
  }

  function advance(at) {
    if (!Number.isSafeInteger(at)) throw new Error("event-history: advance needs a time");
    const folded = fold(at);
    const pruned = prune(at);
    const evicted = capTrades(maxTradeBytes) + capWallTrades(maxWallTradeBytes);
    if (folded > 0 || pruned > 0 || evicted > 0) {
      counters.folded += folded;
      counters.pruned += pruned;
      counters.evicted += evicted;
      touch();
    }
    return { folded, pruned, evicted };
  }

  function trimToBytes(bytes) {
    const total = maxTradeBytes + maxWallTradeBytes;
    if (!(bytes > total) || (fine.size + deep.size + wallTrades.size) === 0) return 0;
    const share = (TRIM_TARGET * total) / bytes;
    const evicted = capTrades(Math.floor(maxTradeBytes * share)) + capWallTrades(Math.floor(maxWallTradeBytes * share));
    if (evicted > 0) {
      counters.evicted += evicted;
      touch();
    }
    return evicted;
  }

  function trades() {
    if (sortedTrades === null) sortedTrades = [...deep.values(), ...fine.values()].sort(byTrade);
    return sortedTrades;
  }

  function walls() {
    if (sortedWallTrades === null) sortedWallTrades = [...wallTrades.values()].sort(byWallTrade);
    return sortedWallTrades;
  }

  function page(list, compare, keep, limit, cursor) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("event-history: limit must be a positive safe integer");
    const out = [];
    let next = null;
    for (const record of list) {
      if (cursor !== null && compare(record, cursor) <= 0) continue;
      if (!keep(record)) continue;
      if (out.length === limit) {
        next = { ...out[out.length - 1] };
        break;
      }
      out.push(Object.freeze({ ...record }));
    }
    return Object.freeze({ records: Object.freeze(out), next });
  }

  function queryTrades({ fromTs, toTs, rowLo = 0, rowHi = Number.MAX_SAFE_INTEGER, limit = DEFAULT_PAGE, cursor = null } = {}) {
    if (!Number.isSafeInteger(fromTs) || !Number.isSafeInteger(toTs) || toTs < fromTs) throw new Error("event-history: query needs fromTs <= toTs");
    return page(trades(), byTrade, (record) => record.ts + record.columnMs > fromTs && record.ts <= toTs && record.row >= rowLo && record.row <= rowHi, limit, cursor);
  }

  function queryWallTrades({ fromTs, toTs, wall = null, limit = DEFAULT_PAGE, cursor = null } = {}) {
    if (!Number.isSafeInteger(fromTs) || !Number.isSafeInteger(toTs) || toTs < fromTs) throw new Error("event-history: query needs fromTs <= toTs");
    return page(walls(), byWallTrade, (record) => record.ts + columnMs > fromTs && record.ts <= toTs && (wall === null || record.wall === wall), limit, cursor);
  }

  function validFill(range) {
    return range === null || (range && typeof range === "object" && Number.isSafeInteger(range.from) && Number.isSafeInteger(range.until) && range.from <= range.until);
  }

  function setFill(range) {
    if (!validFill(range)) throw new Error("event-history: fill must be null or { from <= until }");
    fill = range === null ? null : Object.freeze({ from: range.from, until: range.until });
    dirty = true;
  }

  function spans() {
    return fill === null ? covered : joinRanges([...covered, [fill.from, fill.until]].filter(validRange));
  }

  function cover(from, until) {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(until)) throw new Error("event-history: cover needs integer from and until");
    if (from >= until) return;
    const next = joinRanges([...covered, [from, until]]);
    covered = next.length > MAX_COVERED ? next.slice(next.length - MAX_COVERED) : next;
  }


  function uncovered(from, until) {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(until)) throw new Error("event-history: uncovered needs integer from and until");
    const out = [];
    let cursor = from;
    for (const [lo, hi] of spans()) {
      if (hi <= cursor) continue;
      if (lo >= until) break;
      if (lo > cursor) out.push([cursor, lo]);
      cursor = Math.max(cursor, hi);
      if (cursor >= until) break;
    }
    if (cursor < until) out.push([cursor, until]);
    return out;
  }

  function heldFrom(fromTs, toTs) {
    if (!Number.isSafeInteger(fromTs) || !Number.isSafeInteger(toTs) || toTs < fromTs) throw new Error("event-history: heldFrom needs integer fromTs <= toTs");
    for (const [lo, hi] of covered) {
      if (lo >= toTs) break;
      if (hi < toTs) continue;
      const whole = Math.ceil(Math.max(lo, lostBefore ?? lo) / deepColumnMs) * deepColumnMs;
      return Math.min(toTs, Math.max(fromTs, whole));
    }
    return toTs;
  }

  function toJSON() {
    return {
      version: VERSION,
      columnMs,
      deepColumnMs,
      fill,
      covered: covered.map((range) => [...range]),
      lostBefore,
      trades: trades().map((record) => [record.ts, record.columnMs, record.row, record.aggressor, record.mode, record.size, record.count]),
      wallTrades: walls().map((record) => [record.ts, record.wall, record.mode, record.size, record.count]),
    };
  }

  function parse(saved) {
    if (!saved || typeof saved !== "object" || saved.version !== VERSION || saved.columnMs !== columnMs || (saved.deepColumnMs !== deepColumnMs && saved.deepColumnMs !== columnMs)) return null;
    if (!Array.isArray(saved.trades) || !Array.isArray(saved.wallTrades) || (saved.fill !== undefined && !validFill(saved.fill))) return null;
    if (saved.covered !== undefined && (!Array.isArray(saved.covered) || !saved.covered.every(validRange))) return null;
    if (saved.lostBefore !== undefined && saved.lostBefore !== null && !Number.isSafeInteger(saved.lostBefore)) return null;
    const nextFine = new Map();
    const nextDeep = new Map();
    const nextWalls = new Map();
    for (const entry of saved.trades) {
      if (!Array.isArray(entry) || entry.length !== 7) return null;
      const [ts, width, row, aggressor, mode, size, count] = entry;
      if (!validTrade({ ts, row, aggressor, mode, size }) || (width !== columnMs && width !== deepColumnMs) || !Number.isSafeInteger(count) || count < 1) return null;
      const key = tradeKey(ts, row, aggressor, mode);
      const map = width === columnMs ? nextFine : nextDeep;
      if (map.has(key)) return null;
      map.set(key, { ts, columnMs: width, row, aggressor, mode, size, count });
    }
    for (const entry of saved.wallTrades) {
      if (!Array.isArray(entry) || entry.length !== 5) return null;
      const [ts, wall, mode, size, count] = entry;
      if (!Number.isSafeInteger(ts) || typeof wall !== "string" || wall.length === 0 || !MODES.has(mode) || !Number.isFinite(size) || size <= 0 || !Number.isSafeInteger(count) || count < 1) return null;
      const key = `${wall}:${ts}:${mode}`;
      if (nextWalls.has(key)) return null;
      nextWalls.set(key, { ts, wall, mode, size, count });
    }
    let oldest = null;
    for (const map of [nextFine, nextDeep]) for (const record of map.values()) if (oldest === null || record.ts < oldest) oldest = record.ts;
    return { fine: nextFine, deep: nextDeep, walls: nextWalls, fill: saved.fill ?? null, covered: joinRanges((saved.covered ?? []).map((range) => [...range])), lostBefore: saved.lostBefore === undefined ? oldest : saved.lostBefore };
  }

  function load(saved) {
    const parsed = parse(saved);
    if (parsed === null) return false;
    fine = parsed.fine;
    deep = parsed.deep;
    wallTrades = parsed.walls;
    fill = parsed.fill === null ? null : Object.freeze({ ...parsed.fill });
    covered = parsed.covered;
    lostBefore = parsed.lostBefore;
    sortedTrades = null;
    sortedWallTrades = null;
    dirty = false;
    return true;
  }

  /**
   * Adds a batch's buckets. With `{ from, until }`, the batch is what a replay or the host saw over that span: buckets
   * inside a span this history already holds are skipped, and the span is held from then on. Without it every bucket
   * is added, as before.
   */
  function merge(saved, { from = null, until = null } = {}) {
    const parsed = parse(saved);
    if (parsed === null) return false;
    const spanned = from !== null || until !== null;
    if (spanned && (!Number.isSafeInteger(from) || !Number.isSafeInteger(until) || from > until)) throw new Error("event-history: merge needs integer from <= until");
    const held = spanned ? spans() : [];
    const keep = (record) => !inRanges(held, record.ts);
    let merged = 0;
    let skipped = 0;
    for (const [target, source] of [[fine, parsed.fine], [deep, parsed.deep], [wallTrades, parsed.walls]]) {
      for (const [key, record] of source) {
        if (!keep(record)) {
          skipped += 1;
          continue;
        }
        add(target, key, record);
        merged += 1;
      }
    }
    counters.skipped += skipped;
    if (merged > 0) {
      counters.merged += merged;
      touch();
    }
    if (spanned) cover(from, until);
    return true;
  }

  function markSaved() {
    dirty = false;
  }

  function clear() {
    fine = new Map();
    deep = new Map();
    wallTrades = new Map();
    sortedTrades = null;
    sortedWallTrades = null;
    fill = null;
    covered = [];
    lostBefore = null;
    dirty = false;
  }

  return Object.freeze({
    recordTrades,
    recordWallTrades,
    advance,
    trimToBytes,
    queryTrades,
    queryWallTrades,
    toJSON,
    load,
    merge,
    cover,
    uncovered,
    heldFrom,
    setFill,
    markSaved,
    clear,
    get fill() {
      return fill;
    },
    get covered() {
      return covered.map((range) => Object.freeze([...range]));
    },
    get size() {
      return fine.size + deep.size + wallTrades.size;
    },
    get tradeBuckets() {
      return fine.size + deep.size;
    },
    get wallTradeBuckets() {
      return wallTrades.size;
    },
    get dirty() {
      return dirty;
    },
    stats() {
      return Object.freeze({ ...counters, fine: fine.size, deep: deep.size, walls: wallTrades.size });
    },
  });
}

module.exports = { createEventHistory, wallKeyOf, VERSION, DEFAULT_TRADE_BYTES, DEFAULT_WALL_TRADE_BYTES, DEFAULT_PAGE, BYTES_PER_TRADE, BYTES_PER_WALL_TRADE };
