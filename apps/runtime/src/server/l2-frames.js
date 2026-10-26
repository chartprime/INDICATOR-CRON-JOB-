"use strict";

const { liquidityWireBody, liquidityLevels, selectionFrame, dxfeedSelectionFrame, MAX_LIQUIDITY_LEVELS } = require("./frames");
const { MAX_VALID_EPOCH_MS, MAX_WIRE_MAGNITUDE, decimalToFiniteNumber, sizeCeilingFor } = require("./wire-fields");

const MAX_L2_LANE = 6;
const MAX_L2_LANE_WALLS = 100;
const MAX_L2_WALLS = 1_000;
const MAX_L2_REMOVED = 1_000;
const MAX_L2_LEGACY_WALLS = MAX_LIQUIDITY_LEVELS;
const MAX_L2_EVENTS = 500;
const MAX_L2_LADDER_LEVELS = 50;
const MAX_L2_SEGMENT_ID_LENGTH = 160;
const L2_VIEW_TIERS = Object.freeze(["recent", "deep"]);
const L2_SEGMENT_STATES = Object.freeze(["LIVE", "GAP"]);
const L2_EVENT_KINDS = Object.freeze(["wall_born", "wall_shrink", "wall_trade", "wall_hidden", "wall_end", "trade", "hidden", "segment"]);
const L2_WALL_VERDICTS = Object.freeze(["filled", "partial", "hit", "pulled", "moved"]);
const CAPABILITY_FLAGS = Object.freeze(["marker_history", "l2_view", "l2_walls", "l2_walls_lanes", "l2_events", "l2_ladder", "iceberg_orders", "exhaustion_shades", "initiative_bands"]);
const L2_CHANNELS = Object.freeze(["l2_view", "l2_walls", "l2_events", "l2_ladder"]);

function identityFields(identity, field) {
  if (identity?.provider === "BINANCE") return selectionFrame(identity.symbol, identity.marketKind);
  if (identity?.provider === "DXFEED") return dxfeedSelectionFrame(identity.symbol, identity.assetClass);
  throw new Error(`${field}: invalid provider`);
}

function epochMs(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_VALID_EPOCH_MS) throw new Error(`${field}: must be a non-negative epoch-ms integer`);
  return value;
}

function nullableEpochMs(value, field) {
  return value === null || value === undefined ? null : epochMs(value, field);
}

function counter(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field}: must be a non-negative integer`);
  return value;
}

function share(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${field}: must be a number from 0 to 1`);
  return value;
}

function amount(value, field, ceiling = MAX_WIRE_MAGNITUDE) {
  return decimalToFiniteNumber(value, field, { allowZero: true, ceiling });
}

function nullableAmount(value, field) {
  return value === null || value === undefined ? null : amount(value, field);
}

function flag(value, field) {
  if (typeof value !== "boolean") throw new Error(`${field}: must be a boolean`);
  return value;
}

function nullableFlag(value, field) {
  return value === null || value === undefined ? null : flag(value, field);
}

function wallId(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field}: must be a positive integer`);
  return value;
}

function segment(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") throw new Error(`${field}: must be a segment or null`);
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > MAX_L2_SEGMENT_ID_LENGTH) {
    throw new Error(`${field}.id: must be a non-empty string of at most ${MAX_L2_SEGMENT_ID_LENGTH} characters`);
  }
  if (!L2_SEGMENT_STATES.includes(value.state)) throw new Error(`${field}.state: must be LIVE or GAP`);
  return Object.freeze({ id: value.id, state: value.state });
}

function l2ViewFrame(identity, { lane, tier, ts, seq, reset, rowWidth, columnMs, columns, segment: current = null }) {
  const wire = identityFields(identity, "l2ViewFrame");
  if (!Number.isSafeInteger(lane) || lane < 1 || lane > MAX_L2_LANE) throw new Error(`l2ViewFrame.lane: must be an integer from 1 to ${MAX_L2_LANE}`);
  if (!L2_VIEW_TIERS.includes(tier)) throw new Error("l2ViewFrame.tier: must be recent or deep");
  const body = liquidityWireBody({ ts, seq, reset, rowWidth, columnMs, columns }, sizeCeilingFor(identity));
  for (const column of body.columns) {
    if (column.prints !== undefined || column.prints_floor !== undefined) throw new Error("l2ViewFrame.columns: lane columns carry no prints");
  }
  return Object.freeze({ ...wire, type: "l2_view", lane, tier, ...body, segment: segment(current, "l2ViewFrame.segment") });
}

function wallDetail(detail, ended, field, ceiling) {
  if (detail === null || detail === undefined) return null;
  if (typeof detail !== "object") throw new Error(`${field}: must be an object or null`);
  const continuity = detail.continuity === null || detail.continuity === undefined
    ? null
    : Object.freeze({ gap_ms: counter(detail.continuity.gapMs, `${field}.continuity.gapMs`) });
  const repeats = detail.repeats;
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error(`${field}.repeats: must be a positive integer`);
  return Object.freeze({
    life_ms: ended ? counter(detail.lifeMs, `${field}.lifeMs`) : null,
    first_shrink_ts: nullableEpochMs(detail.firstShrinkTs, `${field}.firstShrinkTs`),
    first_shrink_exact: flag(detail.firstShrinkExact, `${field}.firstShrinkExact`),
    reached_at_first_shrink: nullableFlag(detail.reachedAtFirstShrink, `${field}.reachedAtFirstShrink`),
    traded: amount(detail.traded, `${field}.traded`, ceiling),
    absorbed: amount(detail.absorbed, `${field}.absorbed`, ceiling),
    swept: amount(detail.swept, `${field}.swept`, ceiling),
    hidden: amount(detail.hidden, `${field}.hidden`, ceiling),
    cleared: amount(detail.cleared, `${field}.cleared`, ceiling),
    fill_ratio: share(detail.fillRatio, `${field}.fillRatio`),
    cross_side: amount(detail.crossSide, `${field}.crossSide`, ceiling),
    cross_side_share: amount(detail.crossSideShare, `${field}.crossSideShare`),
    end_distance_rows: nullableAmount(detail.endDistanceRows, `${field}.endDistanceRows`),
    end_distance_pct: nullableAmount(detail.endDistancePct, `${field}.endDistancePct`),
    cleared_by_trades: flag(detail.clearedByTrades, `${field}.clearedByTrades`),
    continuity,
    repeats,
    repeats_complete: flag(detail.repeatsComplete, `${field}.repeatsComplete`),
    evidence_gap: flag(detail.evidenceGap, `${field}.evidenceGap`),
  });
}

function l2WallsFrame(identity, { ts, seq, reset, rowWidth, walls, removed = [], segment: current = null, lanes = false }) {
  const wire = identityFields(identity, "l2WallsFrame");
  epochMs(ts, "l2WallsFrame.ts");
  counter(seq, "l2WallsFrame.seq");
  flag(reset, "l2WallsFrame.reset");
  flag(lanes, "l2WallsFrame.lanes");
  const maxWalls = lanes ? MAX_L2_WALLS : MAX_L2_LEGACY_WALLS;
  const maxRemoved = lanes ? MAX_L2_REMOVED : MAX_L2_LEGACY_WALLS;
  if (!Array.isArray(walls) || walls.length > maxWalls) throw new Error(`l2WallsFrame.walls: must be an array of at most ${maxWalls} walls`);
  if (!Array.isArray(removed) || removed.length > maxRemoved) throw new Error(`l2WallsFrame.removed: must be an array of at most ${maxRemoved} ids`);
  if (reset && removed.length > 0) throw new Error("l2WallsFrame.removed: a reset carries the whole set and removes nothing");
  if (!reset && walls.length === 0 && removed.length === 0) throw new Error("l2WallsFrame: an increment must change something");
  const ceiling = sizeCeilingFor(identity);
  const base = [];
  for (let from = 0; from < walls.length; from += MAX_LIQUIDITY_LEVELS) base.push(...liquidityLevels(walls.slice(from, from + MAX_LIQUIDITY_LEVELS), ts, ceiling));
  const seen = new Set();
  const wireWalls = walls.map((wall, index) => {
    const field = `l2WallsFrame.walls[${index}]`;
    const id = wallId(wall.id, `${field}.id`);
    if (seen.has(id)) throw new Error(`${field}.id: ids must be unique`);
    seen.add(id);
    const ended = wall.endTs !== null && wall.endTs !== undefined;
    const lane = wall.lane ?? 0;
    if (!Number.isSafeInteger(lane) || lane < 0 || lane > MAX_L2_LANE) throw new Error(`${field}.lane: must be an integer from 0 to ${MAX_L2_LANE}`);
    if (!lanes && lane !== 0) throw new Error(`${field}.lane: a client that did not declare l2_walls_lanes gets lane 0 only`);
    const detail = wallDetail(wall.detail, ended, `${field}.detail`, ceiling);
    return Object.freeze(lanes ? { id, lane, ...base[index], detail } : { id, ...base[index], detail });
  });
  const wireRemoved = removed.map((id, index) => {
    const checked = wallId(id, `l2WallsFrame.removed[${index}]`);
    if (seen.has(checked)) throw new Error(`l2WallsFrame.removed[${index}]: a removed id cannot also be upserted`);
    seen.add(checked);
    return checked;
  });
  return Object.freeze({
    ...wire,
    type: "l2_walls",
    ts,
    seq,
    reset,
    row_width: decimalToFiniteNumber(rowWidth, "l2WallsFrame.rowWidth"),
    walls: Object.freeze(wireWalls),
    removed: Object.freeze(wireRemoved),
    segment: segment(current, "l2WallsFrame.segment"),
  });
}

function wireEvent(event, frameTs, field, ceiling) {
  if (!event || typeof event !== "object" || !L2_EVENT_KINDS.includes(event.event)) {
    throw new Error(`${field}.event: must be one of ${L2_EVENT_KINDS.join(", ")}`);
  }
  const ts = epochMs(event.ts, `${field}.ts`);
  if (ts > frameTs) throw new Error(`${field}.ts: must be no later than the frame ts`);
  switch (event.event) {
    case "wall_born": {
      if (event.side !== "bid" && event.side !== "ask") throw new Error(`${field}.side: must be bid or ask`);
      if (!Number.isSafeInteger(event.row) || event.row < 0) throw new Error(`${field}.row: must be a non-negative integer`);
      if (!Number.isSafeInteger(event.span) || event.span < 1) throw new Error(`${field}.span: must be a positive integer`);
      return Object.freeze({ event: event.event, ts, wall: wallId(event.wall, `${field}.wall`), side: event.side, row: event.row, span: event.span, size: amount(event.size, `${field}.size`, ceiling) });
    }
    case "wall_shrink":
      return Object.freeze({ event: event.event, ts, wall: wallId(event.wall, `${field}.wall`), exact: flag(event.exact, `${field}.exact`), reached: nullableFlag(event.reached, `${field}.reached`) });
    case "wall_trade":
      if (event.mode !== "absorbed" && event.mode !== "swept") throw new Error(`${field}.mode: must be absorbed or swept`);
      return Object.freeze({ event: event.event, ts, wall: wallId(event.wall, `${field}.wall`), mode: event.mode, price: decimalToFiniteNumber(event.price, `${field}.price`), size: amount(event.size, `${field}.size`, ceiling) });
    case "wall_hidden":
      return Object.freeze({ event: event.event, ts, wall: wallId(event.wall, `${field}.wall`), volume: amount(event.volume, `${field}.volume`, ceiling) });
    case "wall_end":
      if (!L2_WALL_VERDICTS.includes(event.endedBy)) throw new Error(`${field}.endedBy: must be one of ${L2_WALL_VERDICTS.join(", ")}`);
      return Object.freeze({ event: event.event, ts, wall: wallId(event.wall, `${field}.wall`), ended_by: event.endedBy, distance_rows: nullableAmount(event.distanceRows, `${field}.distanceRows`) });
    case "trade":
      if (event.side !== "bid" && event.side !== "ask") throw new Error(`${field}.side: must be bid or ask`);
      if (event.aggressor !== "buy" && event.aggressor !== "sell") throw new Error(`${field}.aggressor: must be buy or sell`);
      if (event.mode !== "absorbed" && event.mode !== "swept") throw new Error(`${field}.mode: must be absorbed or swept`);
      return Object.freeze({ event: event.event, ts, side: event.side, aggressor: event.aggressor, mode: event.mode, price: decimalToFiniteNumber(event.price, `${field}.price`), size: amount(event.size, `${field}.size`, ceiling), late: flag(event.late, `${field}.late`) });
    case "hidden":
      if (event.side !== "bid" && event.side !== "ask") throw new Error(`${field}.side: must be bid or ask`);
      return Object.freeze({ event: event.event, ts, side: event.side, price: decimalToFiniteNumber(event.price, `${field}.price`), volume: amount(event.volume, `${field}.volume`, ceiling) });
    default: {
      const checked = segment({ id: event.segment, state: event.state }, `${field}.segment`);
      if (event.cause !== null && event.cause !== undefined && (typeof event.cause !== "string" || event.cause.length > MAX_L2_SEGMENT_ID_LENGTH)) {
        throw new Error(`${field}.cause: must be a short string or null`);
      }
      return Object.freeze({ event: "segment", ts, segment: checked.id, state: checked.state, cause: event.cause ?? null });
    }
  }
}

function l2EventsFrame(identity, { ts, seq, reset, events, missed = 0 }) {
  const wire = identityFields(identity, "l2EventsFrame");
  epochMs(ts, "l2EventsFrame.ts");
  counter(seq, "l2EventsFrame.seq");
  flag(reset, "l2EventsFrame.reset");
  counter(missed, "l2EventsFrame.missed");
  if (!Array.isArray(events) || events.length > MAX_L2_EVENTS) throw new Error(`l2EventsFrame.events: must be an array of at most ${MAX_L2_EVENTS} events`);
  if (seq < events.length) throw new Error("l2EventsFrame.seq: must count at least this frame's events");
  if (!reset && events.length === 0 && missed === 0) throw new Error("l2EventsFrame: an increment must carry events or a missed count");
  let previousTs = -1;
  const ceiling = sizeCeilingFor(identity);
  const wireEvents = events.map((event, index) => {
    const checked = wireEvent(event, ts, `l2EventsFrame.events[${index}]`, ceiling);
    if (checked.ts < previousTs) throw new Error(`l2EventsFrame.events[${index}].ts: events must be in time order`);
    previousTs = checked.ts;
    return checked;
  });
  return Object.freeze({ ...wire, type: "l2_events", ts, seq, reset, missed, events: Object.freeze(wireEvents) });
}

function ladderSide(levels, descending, field, ceiling) {
  if (!Array.isArray(levels) || levels.length > MAX_L2_LADDER_LEVELS) throw new Error(`${field}: must be an array of at most ${MAX_L2_LADDER_LEVELS} levels`);
  let previous = null;
  return Object.freeze(levels.map((level, index) => {
    if (!Array.isArray(level) || level.length !== 2) throw new Error(`${field}[${index}]: must be a [price, size] pair`);
    const price = decimalToFiniteNumber(level[0], `${field}[${index}].price`);
    const size = decimalToFiniteNumber(level[1], `${field}[${index}].size`, { ceiling });
    if (previous !== null && (descending ? price >= previous : price <= previous)) {
      throw new Error(`${field}[${index}].price: must be strictly ${descending ? "decreasing" : "increasing"}`);
    }
    previous = price;
    return Object.freeze([price, size]);
  }));
}

function l2LadderFrame(identity, { ts, depth, bids, asks, segment: current = null }) {
  const wire = identityFields(identity, "l2LadderFrame");
  epochMs(ts, "l2LadderFrame.ts");
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > MAX_L2_LADDER_LEVELS) throw new Error(`l2LadderFrame.depth: must be an integer from 1 to ${MAX_L2_LADDER_LEVELS}`);
  const wireBids = ladderSide(bids, true, "l2LadderFrame.bids", sizeCeilingFor(identity));
  const wireAsks = ladderSide(asks, false, "l2LadderFrame.asks", sizeCeilingFor(identity));
  if (wireBids.length > depth || wireAsks.length > depth) throw new Error("l2LadderFrame: a side holds more levels than its depth");
  if (wireBids.length > 0 && wireAsks.length > 0 && wireBids[0][0] >= wireAsks[0][0]) throw new Error("l2LadderFrame: the best bid must be below the best ask");
  return Object.freeze({ ...wire, type: "l2_ladder", ts, depth, bids: wireBids, asks: wireAsks, segment: segment(current, "l2LadderFrame.segment") });
}

function parseCapabilities(message) {
  if (!message || typeof message !== "object" || message.type !== "capabilities") return null;
  const flags = Object.keys(message).filter((key) => key !== "type");
  for (const key of flags) {
    if (!CAPABILITY_FLAGS.includes(key) || message[key] !== true) return null;
  }
  return new Set(flags);
}

function capabilitiesMessage(flags) {
  const message = { type: "capabilities" };
  for (const key of CAPABILITY_FLAGS) if (flags.has(key)) message[key] = true;
  return message;
}

module.exports = {
  l2ViewFrame,
  l2WallsFrame,
  l2EventsFrame,
  l2LadderFrame,
  parseCapabilities,
  capabilitiesMessage,
  CAPABILITY_FLAGS,
  L2_CHANNELS,
  L2_EVENT_KINDS,
  L2_VIEW_TIERS,
  MAX_L2_LANE,
  MAX_L2_WALLS,
  MAX_L2_LEGACY_WALLS,
  MAX_L2_LANE_WALLS,
  MAX_L2_REMOVED,
  MAX_L2_EVENTS,
  MAX_L2_LADDER_LEVELS,
  MAX_L2_SEGMENT_ID_LENGTH,
};
