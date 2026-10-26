"use strict";

const { evictionRank } = require("../../passive_liquidity/large-level-tracker");

const VERSION = 1;
const DEFAULT_MAX_WALLS = 20_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_PAGE = 400;
const TRIM_TARGET = 0.9;
const VERDICTS = new Set(["filled", "partial", "hit", "pulled", "moved"]);
const AMOUNT_FIELDS = Object.freeze(["traded", "absorbed", "swept", "hidden", "cleared", "crossSide"]);

function keyOf(wall) {
  return `${wall.side}:${wall.row}:${wall.span}:${wall.startTs}`;
}

function finiteOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function detailOf(detail) {
  if (!detail || typeof detail !== "object") return null;
  const out = {};
  for (const field of AMOUNT_FIELDS) out[field] = Math.max(0, finiteOr(detail[field], 0));
  out.fillRatio = Math.min(1, Math.max(0, finiteOr(detail.fillRatio, 0)));
  out.firstShrinkTs = Number.isSafeInteger(detail.firstShrinkTs) ? detail.firstShrinkTs : null;
  out.reachedAtFirstShrink = typeof detail.reachedAtFirstShrink === "boolean" ? detail.reachedAtFirstShrink : null;
  out.endDistanceRows = Number.isFinite(detail.endDistanceRows) ? detail.endDistanceRows : null;
  out.clearedByTrades = detail.clearedByTrades === true;
  out.repeats = Number.isSafeInteger(detail.repeats) && detail.repeats > 0 ? detail.repeats : 1;
  out.evidenceGap = detail.evidenceGap !== false;
  return Object.freeze(out);
}

function validEnded(wall) {
  if (!wall || typeof wall !== "object") return false;
  if (wall.side !== "bid" && wall.side !== "ask") return false;
  if (!Number.isSafeInteger(wall.row) || wall.row < 0 || !Number.isSafeInteger(wall.span) || wall.span < 1) return false;
  if (!Number.isSafeInteger(wall.startTs) || wall.startTs < 0) return false;
  if (!Number.isSafeInteger(wall.endTs) || wall.endTs < wall.startTs) return false;
  if (!VERDICTS.has(wall.endedBy)) return false;
  if (!Number.isFinite(wall.size) || wall.size < 0 || !Number.isFinite(wall.peak) || wall.peak < wall.size) return false;
  return true;
}

function recordOf(wall, hid) {
  return {
    hid,
    side: wall.side,
    row: wall.row,
    span: wall.span,
    startTs: wall.startTs,
    endTs: wall.endTs,
    size: wall.size,
    peak: wall.peak,
    endedBy: wall.endedBy,
    ratio: Math.max(0, finiteOr(wall.ratio, 0)),
    chain: Number.isSafeInteger(wall.chain) && wall.chain > 0 ? wall.chain : 0,
    fill: Math.min(1, Math.max(0, finiteOr(wall.fill, 0))),
    eaten: Math.min(1, Math.max(0, finiteOr(wall.eaten, 0))),
    detail: detailOf(wall.detail),
  };
}

function overlapsRows(wall, rowLo, rowHi) {
  return wall.row <= rowHi && wall.row + wall.span - 1 >= rowLo;
}

function byEnd(a, b) {
  return a.endTs - b.endTs || a.hid - b.hid;
}

function createWallHistory({ maxAgeMs, maxWalls = DEFAULT_MAX_WALLS, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw new Error("wall-history: maxAgeMs must be a positive safe integer");
  if (!Number.isSafeInteger(maxWalls) || maxWalls <= 0) throw new Error("wall-history: maxWalls must be a positive safe integer");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("wall-history: maxBytes must be a positive safe integer");
  let walls = new Map();
  let sorted = null;
  let nextId = 1;
  let dirty = false;
  const counters = { added: 0, updated: 0, pruned: 0, trimmed: 0 };

  function ordered() {
    if (sorted === null) sorted = [...walls.values()].sort(byEnd);
    return sorted;
  }

  function record(list) {
    if (!Array.isArray(list)) throw new Error("wall-history: record expects an array of walls");
    let added = 0;
    let updated = 0;
    for (const wall of list) {
      if (!validEnded(wall)) continue;
      const key = keyOf(wall);
      const known = walls.get(key);
      if (known === undefined) {
        walls.set(key, recordOf(wall, nextId));
        nextId += 1;
        added += 1;
        continue;
      }
      const next = recordOf(wall, known.hid);
      if (next.endTs === known.endTs && next.endedBy === known.endedBy && next.size === known.size && next.peak === known.peak && next.fill === known.fill && next.eaten === known.eaten
        && JSON.stringify(next.detail) === JSON.stringify(known.detail)) continue;
      walls.set(key, next);
      updated += 1;
    }
    if (added > 0 || updated > 0) {
      sorted = null;
      dirty = true;
      counters.added += added;
      counters.updated += updated;
    }
    return { added, updated };
  }

  function dropMany(count) {
    if (count <= 0) return 0;
    const victims = [...walls.values()].sort((a, b) => evictionRank(a) - evictionRank(b) || a.endTs - b.endTs).slice(0, count);
    for (const victim of victims) walls.delete(keyOf(victim));
    if (victims.length > 0) {
      sorted = null;
      dirty = true;
      counters.trimmed += victims.length;
    }
    return victims.length;
  }

  function prune(at) {
    const cutoff = at - maxAgeMs;
    let pruned = 0;
    for (const [key, wall] of walls) {
      if (wall.endTs >= cutoff) continue;
      walls.delete(key);
      pruned += 1;
    }
    if (pruned > 0) {
      sorted = null;
      dirty = true;
      counters.pruned += pruned;
    }
    return pruned;
  }

  function trim() {
    return dropMany(walls.size - maxWalls);
  }

  function trimToBytes(bytes) {
    if (!(bytes > maxBytes) || walls.size === 0) return 0;
    const perWall = bytes / walls.size;
    return dropMany(Math.min(walls.size, Math.ceil((bytes - TRIM_TARGET * maxBytes) / perWall)));
  }

  function query({ fromTs, toTs, rowLo = 0, rowHi = Number.MAX_SAFE_INTEGER, side = null, limit = DEFAULT_PAGE, cursor = null } = {}) {
    if (!Number.isSafeInteger(fromTs) || !Number.isSafeInteger(toTs) || toTs < fromTs) throw new Error("wall-history: query needs fromTs <= toTs");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("wall-history: limit must be a positive safe integer");
    const out = [];
    let next = null;
    for (const wall of ordered()) {
      if (cursor !== null && (wall.endTs < cursor.endTs || (wall.endTs === cursor.endTs && wall.hid <= cursor.hid))) continue;
      if (wall.endTs < fromTs || wall.startTs > toTs) continue;
      if (side !== null && wall.side !== side) continue;
      if (!overlapsRows(wall, rowLo, rowHi)) continue;
      if (out.length === limit) {
        next = { endTs: out[out.length - 1].endTs, hid: out[out.length - 1].hid };
        break;
      }
      out.push(Object.freeze({ ...wall, historical: true }));
    }
    return Object.freeze({ walls: Object.freeze(out), next });
  }

  function toJSON() {
    return { version: VERSION, nextId, walls: ordered().map((wall) => ({ ...wall })) };
  }

  function load(saved) {
    if (!saved || typeof saved !== "object" || saved.version !== VERSION || !Array.isArray(saved.walls)) return false;
    if (!Number.isSafeInteger(saved.nextId) || saved.nextId < 1) return false;
    const next = new Map();
    let maxHid = 0;
    for (const wall of saved.walls) {
      if (!validEnded(wall) || !Number.isSafeInteger(wall.hid) || wall.hid < 1 || wall.hid >= saved.nextId) return false;
      const key = keyOf(wall);
      if (next.has(key)) return false;
      next.set(key, recordOf(wall, wall.hid));
      if (wall.hid > maxHid) maxHid = wall.hid;
    }
    walls = next;
    sorted = null;
    nextId = Math.max(saved.nextId, maxHid + 1);
    dirty = false;
    return true;
  }

  function markSaved() {
    dirty = false;
  }

  function extend(standing, { until, toleranceMs } = {}) {
    if (!Array.isArray(standing)) throw new Error("wall-history: extend expects an array of standing walls");
    if (!Number.isSafeInteger(until) || until < 0) throw new Error("wall-history: extend needs the window's end as until");
    if (!Number.isSafeInteger(toleranceMs) || toleranceMs < 0) throw new Error("wall-history: toleranceMs must be a non-negative safe integer");
    const extended = [];
    for (const candidate of standing) {
      if (!candidate || (candidate.side !== "bid" && candidate.side !== "ask") || !Number.isSafeInteger(candidate.startTs) || !Number.isSafeInteger(candidate.row) || !Number.isSafeInteger(candidate.span)) continue;
      let best = null;
      for (const wall of walls.values()) {
        if (wall.side !== candidate.side || !overlapsRows(wall, candidate.row, candidate.row + candidate.span - 1) || wall.startTs <= candidate.startTs) continue;
        if (Math.abs(wall.startTs - until) > toleranceMs) continue;
        if (best === null || Math.abs(wall.startTs - until) < Math.abs(best.startTs - until)) best = wall;
      }
      if (best === null) continue;
      walls.delete(keyOf(best));
      const from = best.startTs;
      best.startTs = candidate.startTs;
      const peak = Math.max(finiteOr(candidate.peak, 0), finiteOr(candidate.size, 0));
      if (peak > best.peak) best.peak = peak;
      walls.set(keyOf(best), best);
      extended.push(Object.freeze({ hid: best.hid, from, startTs: best.startTs }));
    }
    if (extended.length > 0) {
      sorted = null;
      dirty = true;
    }
    return extended;
  }

  function clear() {
    walls = new Map();
    sorted = null;
    dirty = false;
  }

  return Object.freeze({
    record,
    extend,
    prune,
    trim,
    trimToBytes,
    query,
    toJSON,
    load,
    markSaved,
    clear,
    get size() {
      return walls.size;
    },
    get dirty() {
      return dirty;
    },
    get nextId() {
      return nextId;
    },
    stats() {
      return Object.freeze({ ...counters, walls: walls.size });
    },
  });
}

module.exports = { createWallHistory, keyOf, validEnded, VERSION, DEFAULT_MAX_WALLS, DEFAULT_MAX_BYTES, DEFAULT_PAGE };
