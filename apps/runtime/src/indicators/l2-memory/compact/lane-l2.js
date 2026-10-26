"use strict";

const { MAX_LIQUIDITY_COLUMNS } = require("../../../server/frames");
const { MAX_L2_EVENTS, MAX_L2_WALLS, MAX_L2_REMOVED, MAX_L2_LEGACY_WALLS, MAX_L2_LADDER_LEVELS } = require("../../../server/l2-frames");
const { encodeAfter } = require("../../passive_liquidity/liquidity-history");
const { rowOf } = require("../../passive_liquidity/liquidity-sampler");
const { createHeavyReader } = require("../heavy-reader");

const RECENT_EVENTS = MAX_L2_EVENTS;
const PRIORITY = Object.freeze({ segment: 0, wall_born: 1, wall_shrink: 1, wall_trade: 1, wall_hidden: 1, wall_end: 1, trade: 2, hidden: 2 });

function laneColumn(column) {
  if (column.prints === undefined && column.printsFloor === undefined) return column;
  const rest = { ...column };
  delete rest.prints;
  delete rest.printsFloor;
  return rest;
}

const WALL_FIELDS = Object.freeze(["lane", "side", "row", "span", "startTs", "endTs", "size", "peak", "endedBy", "ratio", "chain", "fill", "eaten", "absorbing"]);
const DETAIL_FIELDS = Object.freeze([
  "firstShrinkTs", "firstShrinkExact", "reachedAtFirstShrink", "traded", "absorbed", "swept", "hidden", "cleared", "fillRatio",
  "endDistanceRows", "endDistancePct", "clearedByTrades", "repeats", "repeatsComplete", "evidenceGap",
]);
const CROSS_SIDE_REFRESH_MS = 10_000;
const SAME = 0;
const CROSS_SIDE_ONLY = 1;
const CHANGED = 2;

function sameDetail(a, b, ended) {
  if (a === null || b === null) return a === b;
  for (const field of DETAIL_FIELDS) if (a[field] !== b[field]) return false;
  if (ended && a.lifeMs !== b.lifeMs) return false;
  if (a.continuity === null || b.continuity === null) return a.continuity === b.continuity;
  return a.continuity.gapMs === b.continuity.gapMs;
}

function compareWall(a, b) {
  if (a === undefined) return CHANGED;
  for (const field of WALL_FIELDS) if (a[field] !== b[field]) return CHANGED;
  const ended = b.endTs !== null && b.endTs !== undefined;
  const before = a.detail ?? null;
  const after = b.detail ?? null;
  if (!sameDetail(before, after, ended)) return CHANGED;
  if (before === null || (before.crossSide === after.crossSide && before.crossSideShare === after.crossSideShare)) return SAME;
  return ended ? CHANGED : CROSS_SIDE_ONLY;
}

function createLaneL2(ctx) {
  const { pairKey, laneWalls = null } = ctx;

  function allWalls(state, own = state.tracker.walls()) {
    if (laneWalls === null) return own;
    const wider = laneWalls.wallsOf(state.key);
    return wider.length === 0 ? own : [...own, ...wider];
  }

  function ensure(state, engine) {
    if (state.l2 && state.l2.engine === engine) return state.l2;
    state.l2 = {
      engine,
      reader: createHeavyReader({ engine }),
      walls: { seq: 0, prints: new Map(), sentAt: new Map() },
      lanedWalls: { seq: 0, prints: new Map(), sentAt: new Map() },
      collected: false,
      eventSeq: 0,
      recent: [],
      segment: segmentOf(state, engine.segment ?? null),
      chainBroken: new Set(),
      fresh: true,
    };
    return state.l2;
  }

  function markChainBroken(state, laneK) {
    if (state.l2) state.l2.chainBroken.add(laneK);
  }

  function segmentId(state, startTs, segmentState) {
    return `${pairKey(state.marketKind, state.symbol)}:${startTs}:${segmentState}`;
  }

  function segmentOf(state, current) {
    return current === null ? null : Object.freeze({ id: segmentId(state, current.startTs, current.state), state: current.state });
  }

  function segmentEvent(state, event) {
    return { event: "segment", ts: event.ts, segment: segmentId(state, event.ts, event.state), state: event.state, cause: event.cause ?? null };
  }

  function nearPriceEvents(state, engine, batch, column) {
    const mid = (column.lo + column.hi) / 2;
    const band = state.referenceRows;
    const out = [];
    for (const event of batch.events) {
      if (event.type === "segment") {
        out.push(segmentEvent(state, event));
        continue;
      }
      if (event.type !== "trade" && event.type !== "hidden") continue;
      const row = rowOf(event.key, state.rowClusters);
      if (Math.abs(row - mid) > band) continue;
      if (event.type === "trade") {
        out.push({ event: "trade", ts: event.ts, side: event.side, aggressor: event.aggressor, mode: event.kind, price: event.price, size: event.size, late: event.late === true });
      } else {
        out.push({ event: "hidden", ts: event.ts, side: event.side, price: engine.priceFor(event.key), volume: event.volume });
      }
    }
    return out;
  }

  function lifecycleEvents(records) {
    return records.map((record) => {
      if (record.kind === "wall_trade") return { event: "wall_trade", ts: record.ts, wall: record.wall, mode: record.trade, price: record.price, size: record.size };
      if (record.kind === "wall_end") return { event: "wall_end", ts: record.ts, wall: record.wall, endedBy: record.endedBy, distanceRows: record.distanceRows };
      if (record.kind === "wall_born") return { event: "wall_born", ts: record.ts, wall: record.wall, side: record.side, row: record.row, span: record.span, size: record.size };
      if (record.kind === "wall_shrink") return { event: "wall_shrink", ts: record.ts, wall: record.wall, exact: record.exact, reached: record.reached };
      return { event: "wall_hidden", ts: record.ts, wall: record.wall, volume: record.volume };
    });
  }

  function capEvents(events) {
    if (events.length <= MAX_L2_EVENTS) return { kept: events, dropped: 0 };
    const byPriority = [[], [], []];
    events.forEach((event, index) => byPriority[PRIORITY[event.event]].push(index));
    byPriority[PRIORITY.segment].reverse();
    const keep = new Uint8Array(events.length);
    let room = MAX_L2_EVENTS;
    for (const indices of byPriority) {
      const take = Math.min(room, indices.length);
      for (let i = 0; i < take; i += 1) keep[indices[i]] = 1;
      room -= take;
    }
    const kept = events.filter((_event, index) => keep[index] === 1);
    return { kept, dropped: events.length - kept.length };
  }

  function wallDiff(chain, walls, ts) {
    const next = new Map();
    const sentAt = new Map();
    const upserts = [];
    for (const wall of walls) {
      const sent = chain.prints.get(wall.id);
      const change = compareWall(sent, wall);
      const lastSent = chain.sentAt.get(wall.id) ?? ts;
      if (change === CHANGED || (change === CROSS_SIDE_ONLY && ts - lastSent >= CROSS_SIDE_REFRESH_MS)) {
        upserts.push(wall);
        next.set(wall.id, wall);
        sentAt.set(wall.id, ts);
      } else {
        next.set(wall.id, sent);
        sentAt.set(wall.id, lastSent);
      }
    }
    const removed = [];
    for (const id of chain.prints.keys()) if (!next.has(id)) removed.push(id);
    chain.prints = next;
    chain.sentAt = sentAt;
    return { upserts, removed };
  }

  function wallsOut(chain, walls, ts, maxWalls, maxRemoved) {
    const { upserts, removed } = wallDiff(chain, walls, ts);
    if (upserts.length === 0 && removed.length === 0) return null;
    chain.seq += 1;
    if (upserts.length > maxWalls || removed.length > maxRemoved) return { seq: chain.seq, reset: true, walls: [...chain.prints.values()], removed: [] };
    return { seq: chain.seq, reset: false, walls: upserts, removed };
  }

  function ladderOf(engine) {
    if (typeof engine.ladder !== "function") return null;
    return {
      depth: MAX_L2_LADDER_LEVELS,
      bids: engine.ladder({ side: "bid", depth: MAX_L2_LADDER_LEVELS }),
      asks: engine.ladder({ side: "ask", depth: MAX_L2_LADDER_LEVELS }),
    };
  }

  function collect(state, engine, ts, column, landed) {
    const l2 = ensure(state, engine);
    const batch = l2.reader.read();
    const life = state.tracker.drainLifecycle();
    const merged = [...lifecycleEvents(life.records), ...nearPriceEvents(state, engine, batch, column)];
    const { kept, dropped } = capEvents(merged);
    const events = kept.map((event, index) => ({ event, index })).sort((a, b) => a.event.ts - b.event.ts || a.index - b.index).map((entry) => entry.event);
    l2.segment = segmentOf(state, engine.segment ?? null);
    const missed = dropped + life.dropped + batch.missed;
    let eventsOut = null;
    if (events.length > 0 || missed > 0) {
      l2.eventSeq += events.length;
      l2.recent.push(...events);
      if (l2.recent.length > RECENT_EVENTS) l2.recent.splice(0, l2.recent.length - RECENT_EVENTS);
      eventsOut = { seq: l2.eventSeq, events, missed };
    }
    const laneZero = state.tracker.walls();
    const legacyOut = wallsOut(l2.walls, laneZero, ts, MAX_L2_LEGACY_WALLS, MAX_L2_LEGACY_WALLS);
    const lanedOut = wallsOut(l2.lanedWalls, allWalls(state, laneZero), ts, MAX_L2_WALLS, MAX_L2_REMOVED);
    l2.collected = true;
    const view = [];
    for (const entry of landed) {
      view.push({ lane: entry.lane, tier: entry.tier, seq: entry.seq, reset: entry.reset, rowWidth: entry.rowWidth, columnMs: entry.columnMs, columns: [laneColumn(entry.column)] });
    }
    const viewReset = l2.chainBroken.size > 0;
    l2.chainBroken.clear();
    const fresh = l2.fresh;
    l2.fresh = false;
    return Object.freeze({
      ts: Math.max(ts, ...events.map((event) => event.ts)),
      rowWidth: state.rowWidth,
      fresh,
      view: Object.freeze(view),
      viewReset,
      walls: legacyOut,
      lanedWalls: lanedOut,
      events: eventsOut,
      ladder: ladderOf(engine),
      segment: l2.segment,
    });
  }

  function viewSnapshot(state) {
    const out = [];
    for (const entry of state.lanes) {
      const tiers = [];
      if (entry.deep && entry.deep.length > 0) tiers.push({ tier: "deep", history: entry.deep, columnMs: entry.deepColumnMs });
      if (entry.history.length > 0) tiers.push({ tier: "recent", history: entry.history, columnMs: entry.columnMs });
      for (const { tier, history, columnMs } of tiers) {
        history.rebase();
        history.snapshotChunks(MAX_LIQUIDITY_COLUMNS).forEach((chunk, index) => {
          if (chunk.columns.length === 0) return;
          out.push({ lane: entry.k, tier, seq: chunk.seq, reset: index === 0, rowWidth: entry.rowWidth, columnMs, columns: chunk.columns.map(laneColumn) });
        });
      }
    }
    return out;
  }

  function snapshot(state, engine, ts) {
    const l2 = ensure(state, engine);
    if (!l2.collected) {
      const laneZero = state.tracker.walls();
      for (const [chain, current] of [[l2.walls, laneZero], [l2.lanedWalls, allWalls(state, laneZero)]]) {
        chain.prints = new Map(current.map((wall) => [wall.id, wall]));
        chain.sentAt = new Map(current.map((wall) => [wall.id, ts]));
      }
    }
    let lastEventTs = ts;
    for (const event of l2.recent) if (event.ts > lastEventTs) lastEventTs = event.ts;
    return Object.freeze({
      ts: lastEventTs,
      rowWidth: state.rowWidth,
      view: Object.freeze(viewSnapshot(state)),
      walls: { seq: l2.walls.seq, reset: true, walls: [...l2.walls.prints.values()], removed: [] },
      lanedWalls: { seq: l2.lanedWalls.seq, reset: true, walls: [...l2.lanedWalls.prints.values()], removed: [] },
      events: { seq: l2.eventSeq, reset: true, events: [...l2.recent].sort((a, b) => a.ts - b.ts), missed: 0 },
      ladder: ladderOf(engine),
      segment: l2.segment,
    });
  }

  function landedColumn(entry, tier, prev, column, seq) {
    return { lane: entry.k, tier, seq, reset: prev === null, rowWidth: entry.rowWidth, columnMs: tier === "deep" ? entry.deepColumnMs : entry.columnMs, column: encodeAfter(prev, column) };
  }

  return Object.freeze({ collect, snapshot, markChainBroken, landedColumn });
}

module.exports = { createLaneL2 };
