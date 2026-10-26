"use strict";

const { createLargeLevelTracker, RELINK_ROWS } = require("../passive_liquidity/large-level-tracker");
const { rowOf } = require("../passive_liquidity/liquidity-sampler");
const { createHeavyReader } = require("./heavy-reader");

const CONTINUITY_MS = 20_000;
const REPEAT_WINDOW_MS = 3_600_000;
const CLEARED_BY_TRADES_SHARE = 0.5;
const CROSS_SIDE_BAND = 0.002;
const MID_KEEP_MS = 600_000;
const LIFECYCLE_CAP = 4_096;

function topRow(wall) {
  return wall.row + wall.span - 1;
}

function contains(wall, row) {
  return row >= wall.row && row <= topRow(wall);
}

function overlapsRows(a, b) {
  return a.row <= topRow(b) && b.row <= topRow(a);
}

function reachedDuring(wall, fromMid, toMid) {
  return wall.side === "bid" ? Math.min(fromMid, toMid) <= topRow(wall) : Math.max(fromMid, toMid) >= wall.row;
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function freshEvidence(entry, evidenceGap) {
  return {
    id: entry.id,
    side: entry.side,
    startTs: entry.startTs,
    endTs: entry.endTs ?? null,
    row: entry.row,
    span: entry.span,
    traded: 0,
    absorbed: 0,
    swept: 0,
    hidden: 0,
    crossSide: 0,
    cleared: 0,
    firstShrinkTs: null,
    firstShrinkExact: false,
    reachedAtFirstShrink: null,
    endDistanceRows: null,
    endDistancePct: null,
    continuity: null,
    repeats: 1,
    repeatsComplete: false,
    evidenceGap,
  };
}

function restoredEvidence(entry, detail) {
  const evidence = freshEvidence(entry, true);
  if (!detail || typeof detail !== "object") return evidence;
  for (const field of ["traded", "absorbed", "swept", "hidden", "crossSide", "cleared"]) evidence[field] = Math.max(0, finiteOr(detail[field], 0));
  evidence.firstShrinkTs = Number.isSafeInteger(detail.firstShrinkTs) ? detail.firstShrinkTs : null;
  evidence.firstShrinkExact = detail.firstShrinkExact === true;
  evidence.reachedAtFirstShrink = typeof detail.reachedAtFirstShrink === "boolean" ? detail.reachedAtFirstShrink : null;
  evidence.endDistanceRows = Number.isFinite(detail.endDistanceRows) ? detail.endDistanceRows : null;
  evidence.endDistancePct = Number.isFinite(detail.endDistancePct) ? detail.endDistancePct : null;
  evidence.repeats = Number.isSafeInteger(detail.repeats) && detail.repeats > 0 ? detail.repeats : 1;
  evidence.repeatsComplete = detail.repeatsComplete === true;
  evidence.continuity = detail.continuity && Number.isSafeInteger(detail.continuity.gapMs) ? { prevId: null, gapMs: detail.continuity.gapMs } : null;
  evidence.evidenceGap = entry.endTs === null || detail.evidenceGap !== false;
  return evidence;
}

function mergeInto(target, source) {
  for (const field of ["traded", "absorbed", "swept", "hidden", "crossSide", "cleared"]) target[field] += source[field];
  if (source.firstShrinkTs !== null && (target.firstShrinkTs === null || source.firstShrinkTs < target.firstShrinkTs)) {
    target.firstShrinkTs = source.firstShrinkTs;
    target.firstShrinkExact = source.firstShrinkExact;
    target.reachedAtFirstShrink = source.reachedAtFirstShrink;
  }
  target.evidenceGap = target.evidenceGap || source.evidenceGap;
}

function createWallService({ engine, onEnded = null, onTrades = null, onWallTrade = null, ...trackerOptions } = {}) {
  if (!engine || typeof engine.priceFor !== "function") throw new Error("wall-service: an engine with priceFor() is required");
  for (const [name, hook] of [["onEnded", onEnded], ["onTrades", onTrades], ["onWallTrade", onWallTrade]]) {
    if (hook !== null && typeof hook !== "function") throw new Error(`wall-service: ${name} must be a function or null`);
  }
  const tracker = createLargeLevelTracker(trackerOptions);
  const reader = createHeavyReader({ engine });
  const evidence = new Map();
  let known = new Map();
  let starts = [];
  let mids = [];
  let lastMidRow = null;
  let lastTs = null;
  let observingSince = null;
  let lifecycle = [];
  let lifecycleDropped = 0;

  function note(record) {
    if (lifecycle.length >= LIFECYCLE_CAP) {
      lifecycleDropped += 1;
      return;
    }
    lifecycle.push(Object.freeze(record));
  }

  function priceOfRow(row, rowClusters) {
    return engine.priceFor(row * rowClusters);
  }

  function activeBySide(entries) {
    const sides = { bid: [], ask: [] };
    for (const entry of entries) {
      if (entry.endedBy !== null) continue;
      const own = evidence.get(entry.id);
      if (own) sides[entry.side].push({ entry, own });
    }
    return sides;
  }

  function attribute(sides, gap, events, rowClusters, fromMid, toMid, { volumeOnly = false } = {}) {
    if (gap) for (const list of Object.values(sides)) for (const { own } of list) own.evidenceGap = true;
    const midPrice = priceOfRow((fromMid + toMid) / 2, rowClusters);
    for (const event of events) {
      if (event.type === "coverage_exit" && !volumeOnly) {
        const row = rowOf(event.key, rowClusters);
        const removed = tracker.invalidateObservedRow({ side: event.side, row });
        const ids = new Set(removed.map((entry) => entry.id));
        for (const entry of removed) {
          const own = evidence.get(entry.id);
          if (own) own.evidenceGap = true;
          note({ kind: "wall_unobserved", ts: event.ts, wall: entry.id, side: event.side, row });
        }
        starts = starts.filter((entry) => !ids.has(entry.id));
        sides[event.side] = sides[event.side].filter(({ entry }) => !ids.has(entry.id));
        continue;
      }
      const walls = sides[event.side];
      if (!walls || walls.length === 0) continue;
      const row = rowOf(event.key, rowClusters);
      if (event.type === "trade") {
        const nearMid = midPrice > 0 && Math.abs(event.price - midPrice) <= CROSS_SIDE_BAND * midPrice;
        for (const { entry, own } of walls) {
          if (contains(entry, row)) {
            own.traded += event.size;
            const mode = event.kind === "swept" ? "swept" : "absorbed";
            if (mode === "swept") own.swept += event.size;
            else own.absorbed += event.size;
            note({ kind: "wall_trade", ts: event.ts, wall: entry.id, trade: mode, price: event.price, size: event.size });
            if (onWallTrade !== null) onWallTrade({ ts: event.ts, wall: { side: entry.side, row: entry.row, span: entry.span, startTs: entry.startTs }, mode, price: event.price, size: event.size });
          } else if (nearMid) {
            own.crossSide += event.size;
          }
        }
        continue;
      }
      if (volumeOnly && event.type !== "hidden") continue;
      for (const { entry, own } of walls) {
        if (!contains(entry, row)) continue;
        if (event.type === "hidden") {
          own.hidden += event.volume;
          note({ kind: "wall_hidden", ts: event.ts, wall: entry.id, volume: event.volume });
        } else if (event.type === "emptied") own.cleared += event.lastSlice;
        else if (event.type === "shrank" && own.firstShrinkTs === null) {
          own.firstShrinkTs = event.ts;
          own.firstShrinkExact = true;
          own.reachedAtFirstShrink = reachedDuring(entry, fromMid, toMid);
          note({ kind: "wall_shrink", ts: event.ts, wall: entry.id, exact: true, reached: own.reachedAtFirstShrink });
        }
      }
    }
  }

  function midAt(ts, fallback) {
    let found = fallback;
    for (const mid of mids) {
      if (mid.ts > ts) break;
      found = mid.midRow;
    }
    return found;
  }

  function startEvidence(entry) {
    const own = freshEvidence(entry, false);
    let best = null;
    for (const other of evidence.values()) {
      if (other.side !== entry.side || other.endTs === null || other.endTs > entry.startTs) continue;
      if (entry.startTs - other.endTs > CONTINUITY_MS || Math.abs(other.row - entry.row) > RELINK_ROWS) continue;
      if (best === null || other.endTs > best.endTs) best = other;
    }
    if (best !== null) own.continuity = { prevId: best.id, gapMs: entry.startTs - best.endTs };
    let repeats = 1;
    for (const start of starts) {
      if (start.side === entry.side && entry.startTs - start.startTs <= REPEAT_WINDOW_MS && overlapsRows(start, entry)) repeats += 1;
    }
    own.repeats = repeats;
    own.repeatsComplete = observingSince !== null && entry.startTs - observingSince >= REPEAT_WINDOW_MS;
    starts.push({ id: entry.id, side: entry.side, row: entry.row, span: entry.span, startTs: entry.startTs });
    evidence.set(entry.id, own);
    return own;
  }

  function finish(own, entry, rowClusters, fallbackMid) {
    own.endTs = entry.endTs;
    const mid = midAt(entry.endTs, fallbackMid);
    const rows = Math.max(0, entry.side === "bid" ? mid - topRow(entry) : entry.row - mid);
    own.endDistanceRows = rows;
    const midPrice = priceOfRow(mid, rowClusters);
    const rowWidth = priceOfRow(1, rowClusters) - priceOfRow(0, rowClusters);
    own.endDistancePct = midPrice > 0 ? (rows * rowWidth * 100) / midPrice : null;
  }

  function reconcile(ts, rowClusters, fromMid, toMid) {
    const next = new Map();
    const born = [];
    for (const entry of tracker.entries()) next.set(entry.id, entry);
    for (const [id, entry] of next) {
      const previous = known.get(id);
      let own = evidence.get(id);
      if (!own) {
        own = startEvidence(entry);
        born.push(entry);
        note({ kind: "wall_born", ts: entry.startTs, wall: id, side: entry.side, row: entry.row, span: entry.span, size: entry.size });
      }
      own.row = entry.row;
      own.span = entry.span;
      if (own.firstShrinkTs === null && entry.endedBy === null && previous && previous.endedBy === null
        && entry.size < previous.size && entry.row === previous.row && entry.span === previous.span) {
        own.firstShrinkTs = ts;
        own.firstShrinkExact = false;
        own.reachedAtFirstShrink = reachedDuring(entry, fromMid, toMid);
        note({ kind: "wall_shrink", ts, wall: id, exact: false, reached: own.reachedAtFirstShrink });
      }
      if (entry.endedBy !== null && own.endTs === null) {
        finish(own, entry, rowClusters, toMid);
        note({ kind: "wall_end", ts: entry.endTs, wall: id, endedBy: entry.endedBy, distanceRows: own.endDistanceRows });
        if (onEnded !== null) {
          const level = tracker.levels({ withId: true }).find((candidate) => candidate.id === id);
          if (level !== undefined) onEnded(Object.freeze({ ...level, detail: detailOf(own, level) }));
        }
      }
    }
    for (const [id, previous] of known) {
      if (next.has(id)) continue;
      const own = evidence.get(id);
      evidence.delete(id);
      if (!own || previous.endedBy !== null) continue;
      let survivor = null;
      for (const entry of next.values()) {
        if (entry.endedBy !== null || entry.side !== previous.side || !overlapsRows(entry, previous)) continue;
        if (survivor === null || entry.startTs < survivor.startTs) survivor = entry;
      }
      if (survivor !== null) mergeInto(evidence.get(survivor.id), own);
    }
    for (const id of [...evidence.keys()]) if (!next.has(id)) evidence.delete(id);
    known = next;
    mids.push({ ts, midRow: toMid });
    if (mids.length > 0 && mids[0].ts < ts - MID_KEEP_MS) mids = mids.filter((mid) => mid.ts >= ts - MID_KEEP_MS);
    if (starts.length > 0 && starts[0].startTs < ts - 2 * REPEAT_WINDOW_MS) starts = starts.filter((start) => start.startTs >= ts - REPEAT_WINDOW_MS);
    return born;
  }

  function update({ ts, column, snapshot, rowClusters, referenceRows }) {
    const toMid = (column.lo + column.hi) / 2;
    const fromMid = lastMidRow ?? toMid;
    if (observingSince === null) observingSince = ts;
    const batch = reader.read();
    if (onTrades !== null) {
      const band = Number.isFinite(referenceRows) ? referenceRows : Infinity;
      const trades = [];
      for (const event of batch.events) {
        if (event.type !== "trade") continue;
        const row = rowOf(event.key, rowClusters);
        if (Math.abs(row - toMid) > band) continue;
        trades.push({ ts: event.ts, row, aggressor: event.aggressor, mode: event.kind === "swept" ? "swept" : "absorbed", size: event.size });
      }
      if (trades.length > 0) onTrades(trades);
    }
    attribute(activeBySide(known.values()), batch.gap, batch.events, rowClusters, fromMid, toMid);
    const changed = tracker.update({ ts, column, snapshot, rowClusters, referenceRows });
    const born = reconcile(ts, rowClusters, fromMid, toMid);
    if (born.length > 0) attribute(activeBySide(born), batch.gap, batch.events, rowClusters, fromMid, toMid, { volumeOnly: true });
    lastMidRow = toMid;
    lastTs = ts;
    return changed;
  }

  function detailOf(own, level) {
    if (!own) return null;
    const reduced = level.peak - level.size;
    const endTs = own.endTs ?? lastTs ?? own.startTs;
    return Object.freeze({
      lifeMs: Math.max(0, endTs - own.startTs),
      firstShrinkTs: own.firstShrinkTs,
      firstShrinkExact: own.firstShrinkExact,
      reachedAtFirstShrink: own.reachedAtFirstShrink,
      traded: own.traded,
      absorbed: own.absorbed,
      swept: own.swept,
      hidden: own.hidden,
      cleared: own.cleared,
      fillRatio: reduced > 0 ? Math.min(1, own.traded / reduced) : 0,
      crossSide: own.crossSide,
      crossSideShare: level.peak > 0 ? own.crossSide / level.peak : 0,
      endDistanceRows: own.endDistanceRows,
      endDistancePct: own.endDistancePct,
      clearedByTrades: own.endTs !== null && own.cleared > 0 && own.traded >= CLEARED_BY_TRADES_SHARE * own.cleared,
      continuity: own.continuity === null ? null : Object.freeze({ ...own.continuity }),
      repeats: own.repeats,
      repeatsComplete: own.repeatsComplete,
      evidenceGap: own.evidenceGap,
    });
  }

  function levels() {
    return tracker.levels({ withId: true }).map((level) => {
      const { id, ...wire } = level;
      return Object.freeze({ ...wire, detail: detailOf(evidence.get(id), level) });
    });
  }

  function walls() {
    return tracker.levels({ withId: true }).map((level) => Object.freeze({ ...level, detail: detailOf(evidence.get(level.id), level) }));
  }

  function drainLifecycle() {
    const records = lifecycle;
    const dropped = lifecycleDropped;
    lifecycle = [];
    lifecycleDropped = 0;
    return Object.freeze({ records: Object.freeze(records), dropped });
  }

  function adopt(adopted) {
    const ids = tracker.adopt(adopted);
    ids.forEach((id, index) => {
      const level = adopted[index];
      const entry = { id, side: level.side, row: level.row, span: level.span ?? 1, startTs: level.startTs, endTs: level.endTs ?? null };
      evidence.set(id, restoredEvidence(entry, level.detail));
      starts.push({ id: entry.id, side: entry.side, row: entry.row, span: entry.span, startTs: entry.startTs });
    });
    starts.sort((a, b) => a.startTs - b.startTs);
    for (const entry of tracker.entries()) known.set(entry.id, entry);
    return ids;
  }

  function extend(standing, options) {
    const extended = tracker.extend(standing, options);
    for (const { id, from, startTs } of extended) {
      const own = evidence.get(id);
      if (!own) continue;
      const start = starts.find((entry) => entry.side === own.side && entry.startTs === from && entry.row === own.row && entry.span === own.span);
      if (start) start.startTs = startTs;
      own.startTs = startTs;
      own.evidenceGap = true;
      let repeats = 1;
      for (const entry of starts) {
        if (entry !== start && entry.side === own.side && entry.startTs < startTs && startTs - entry.startTs <= REPEAT_WINDOW_MS && overlapsRows(entry, own)) repeats += 1;
      }
      own.repeats = repeats;
      own.repeatsComplete = observingSince !== null && startTs - observingSince >= REPEAT_WINDOW_MS;
    }
    if (extended.length > 0) {
      starts.sort((a, b) => a.startTs - b.startTs);
      for (const entry of tracker.entries()) known.set(entry.id, entry);
    }
    return extended;
  }

  function clear() {
    tracker.clear();
    evidence.clear();
    known = new Map();
    starts = [];
    mids = [];
    lastMidRow = null;
    lastTs = null;
    observingSince = null;
    lifecycle = [];
    lifecycleDropped = 0;
  }

  return Object.freeze({
    update,
    levels,
    walls,
    drainLifecycle,
    adopt,
    extend,
    clear,
    threshold: tracker.threshold,
    get minSize() {
      return tracker.minSize;
    },
    get reference() {
      return tracker.reference;
    },
    get activeCount() {
      return tracker.activeCount;
    },
  });
}

module.exports = {
  createWallService,
  CONTINUITY_MS,
  REPEAT_WINDOW_MS,
  CLEARED_BY_TRADES_SHARE,
  CROSS_SIDE_BAND,
  LIFECYCLE_CAP,
};
