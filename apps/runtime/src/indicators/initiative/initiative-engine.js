"use strict";

const { createExhaustionTracker, wireValue, CANDLE_MS, EXHAUSTION_RULES_VERSION } = require("../exhaustion/exhaustion-engine");

const INITIATIVE_RULES_VERSION = 1;
const FACTS = Object.freeze(["efficiency", "closes", "burst", "delta", "prints"]);
const SIDES = Object.freeze(["up", "down"]);
const DOMINANTS = Object.freeze(["buyers", "sellers"]);
const EFFICIENCY_AT = 0.7;
const STRONG_THIRD = 2 / 3;
const STRONG_SHARE = 0.5;
const BURST_AT = 2;
const QUIET_MIN = 3;
const RANK_AT = 0.8;
const TYPICAL_MS = 14_400_000;
const TYPICAL_MIN = 12;
const MAX_SCORE = FACTS.length;
const MAX_BANDS = 2_000;

function typicalCount(candleMs) {
  return Math.max(TYPICAL_MIN, Math.round(TYPICAL_MS / candleMs));
}

function rankOf(values, x) {
  let below = 0;
  for (const v of values) if (v < x) below += 1;
  return below / values.length;
}

function storedBandValid(band) {
  return band !== null && typeof band === "object" && typeof band.id === "string" && band.facts !== null && typeof band.facts === "object" && FACTS.every((key) => band.facts[key] !== null && typeof band.facts[key] === "object");
}

function bandId(candleMs, side, pivotTs) {
  return `${candleMs}|${side}|${pivotTs}`;
}

function createInitiativeTracker({ candleMs, rowWidth }) {
  const events = [];
  const engine = createExhaustionTracker({ candleMs, rowWidth, onLeg: (event) => events.push(event) });
  const bands = new Map();
  let open = null;

  function wire(band, at) {
    const out = Object.freeze({
      id: band.id,
      candleMs,
      side: band.side,
      dominant: band.dominant,
      dominantShare: band.dominantShare,
      score: band.score,
      facts: band.facts,
      pivotTs: band.pivotTs,
      pivotPrice: band.pivotPrice,
      frozenTs: band.frozenTs,
      frozenPrice: band.frozenPrice,
      windowCandles: band.windowCandles,
      atr: band.atr,
      legExtremePrice: band.legExtremePrice,
      legExtremeTs: band.legExtremeTs,
      legEndTs: band.legEndTs,
      updatedAt: at,
    });
    bands.set(band.id, out);
    if (bands.size > MAX_BANDS) bands.delete(bands.keys().next().value);
    return out;
  }

  function freezeFacts(facts) {
    return Object.freeze(Object.fromEntries(FACTS.map((key) => [key, Object.freeze({ ...facts[key] })])));
  }

  function recordOf(band) {
    return {
      id: band.id,
      side: band.side,
      dominant: band.dominant,
      dominantShare: band.dominantShare,
      score: band.score,
      facts: freezeFacts(band.facts),
      pivotTs: band.pivotTs,
      pivotPrice: band.pivotPrice,
      frozenTs: band.frozenTs,
      frozenPrice: band.frozenPrice,
      windowCandles: band.windowCandles,
      atr: band.atr,
      legExtremePrice: band.legExtremePrice,
      legExtremeTs: band.legExtremeTs,
      legEndTs: band.legEndTs,
      updatedAt: band.updatedAt,
    };
  }

  function typicalAt(pivotIdx) {
    const typical = [];
    for (let j = pivotIdx; j > pivotIdx - typicalCount(candleMs); j -= 1) {
      const c = engine.candleAt(j);
      if (c === null) break;
      typical.push(c);
    }
    return typical.length < TYPICAL_MIN ? null : typical;
  }

  function read({ index, up, pivotIdx, pivot }) {
    const typical = typicalAt(pivotIdx);
    if (typical === null) return null;
    const n = index - pivotIdx;
    const sign = up ? 1 : -1;
    let own = 0;
    let other = 0;
    let ownPrints = 0;
    let strong = 0;
    let path = 0;
    let last = pivot;
    for (let j = pivotIdx + 1; j <= index; j += 1) {
      const c = engine.candleAt(j);
      own += up ? c.buy : c.sell;
      other += up ? c.sell : c.buy;
      ownPrints += up ? c.bigBuys : c.bigSells;
      const range = c.hi - c.lo;
      if (range > 0 && (up ? c.close - c.lo : c.hi - c.close) >= STRONG_THIRD * range) strong += 1;
      path += Math.abs(c.close - last);
      last = c.close;
    }
    const volume = own + other;
    const travel = sign * (last - pivot);
    const efficiency = Math.max(0, travel) / path;
    const quiet = typical.slice(0, Math.max(QUIET_MIN, n));
    let before = 0;
    for (const c of quiet) before += c.buy + c.sell;
    const burst = volume / n / (before / quiet.length);
    const shares = typical.map((c) => (up ? c.buy : c.sell) / (c.buy + c.sell));
    const prints = typical.map((c) => (up ? c.bigBuys : c.bigSells));
    const share = own / volume;
    const deltaRank = rankOf(shares, share);
    const perCandle = ownPrints / n;
    const printsRank = rankOf(prints, perCandle);
    const facts = Object.freeze({
      efficiency: Object.freeze({ yes: efficiency >= EFFICIENCY_AT, value: wireValue(efficiency) }),
      closes: Object.freeze({ yes: strong / n >= STRONG_SHARE, value: strong }),
      burst: Object.freeze({ yes: burst >= BURST_AT, value: wireValue(burst) }),
      delta: Object.freeze({ yes: deltaRank >= RANK_AT, rank: wireValue(deltaRank), share: wireValue(share) }),
      prints: Object.freeze({ yes: printsRank >= RANK_AT, rank: wireValue(printsRank), perCandle: wireValue(perCandle) }),
    });
    const pushing = up ? "buyers" : "sellers";
    const against = up ? "sellers" : "buyers";
    return {
      facts,
      score: FACTS.filter((key) => facts[key].yes).length,
      dominant: own >= other ? pushing : against,
      dominantShare: wireValue(Math.max(own, other) / volume),
      close: last,
      windowCandles: n,
    };
  }

  function end(ts, at, updates) {
    if (open === null) return;
    open.legEndTs = ts;
    updates.push(wire(open, at));
    open = null;
  }

  function start(flip, at, updates) {
    const reading = read(flip);
    if (reading === null) return;
    const side = flip.up ? "up" : "down";
    const pivotTs = engine.candleAt(flip.pivotIdx).ts;
    open = {
      id: bandId(candleMs, side, pivotTs),
      side,
      dominant: reading.dominant,
      dominantShare: reading.dominantShare,
      score: reading.score,
      facts: reading.facts,
      pivotTs,
      pivotPrice: flip.pivot,
      frozenTs: engine.candleAt(flip.index).ts,
      frozenPrice: reading.close,
      windowCandles: reading.windowCandles,
      atr: flip.atrRef,
      legExtremePrice: flip.ext,
      legExtremeTs: engine.candleAt(flip.extIdx).ts,
      legEndTs: null,
    };
    updates.push(wire(open, at));
  }

  function push(column) {
    engine.push(column);
    const updates = [];
    const at = column.ts;
    for (const event of events) {
      if (event.type === "extreme") {
        if (open === null) continue;
        open.legExtremePrice = event.ext;
        open.legExtremeTs = engine.candleAt(event.extIdx).ts;
        updates.push(wire(open, at));
        continue;
      }
      if (event.type === "reset" || event.type === "flip") end(engine.candleAt(event.index).ts, at, updates);
      if (event.type === "flip") start(event, at, updates);
    }
    events.length = 0;
    return updates;
  }

  function list() {
    return [...bands.values()];
  }

  function toJSON() {
    return { candleMs, rowWidth, engineRules: EXHAUSTION_RULES_VERSION, engine: engine.toJSON(), bands: open === null ? [] : [bands.get(open.id)], open: open === null ? null : open.id };
  }

  function restore(saved) {
    if (!saved || saved.candleMs !== candleMs || saved.rowWidth !== rowWidth) return null;
    if (saved.engine === undefined) return [];
    if (saved.engineRules !== EXHAUSTION_RULES_VERSION || !Array.isArray(saved.bands) || !saved.bands.every(storedBandValid)) return null;
    if (engine.restore(saved.engine) === null) return null;
    bands.clear();
    let found = null;
    for (const band of saved.bands) {
      const record = recordOf(band);
      wire(record, record.updatedAt);
      if (band.id === saved.open) found = record;
    }
    open = found;
    return open === null ? [] : [bands.get(open.id)];
  }

  function stats() {
    const inner = engine.stats();
    return Object.freeze({ candles: inner.candles, ready: inner.ready, atr: inner.atr, leg: inner.leg, bands: bands.size, open: open !== null });
  }

  return Object.freeze({ push, list, toJSON, restore, stats, get candleMs() { return candleMs; }, get rowWidth() { return rowWidth; }, get lastColumnTs() { return engine.lastColumnTs; } });
}

module.exports = {
  createInitiativeTracker,
  typicalCount,
  INITIATIVE_RULES_VERSION,
  CANDLE_MS,
  FACTS,
  SIDES,
  DOMINANTS,
  EFFICIENCY_AT,
  STRONG_THIRD,
  STRONG_SHARE,
  BURST_AT,
  QUIET_MIN,
  RANK_AT,
  TYPICAL_MS,
  TYPICAL_MIN,
  MAX_SCORE,
  MAX_BANDS,
};
