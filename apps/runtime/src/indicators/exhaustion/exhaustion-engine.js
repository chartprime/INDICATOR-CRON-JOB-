"use strict";

const EXHAUSTION_RULES_VERSION = 11;
const CANDLE_MS = Object.freeze([60_000, 120_000, 180_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 21_600_000, 43_200_000, 86_400_000]);
const GAP_MS = 120_000;
const GAP_CANDLES = 2;
const LONG_CANDLE_MS = 14_400_000;
const WEEKEND_MS = 3 * 86_400_000;
const ATR_PERIOD = 14;
const REVERSE_ATR = 3;
const ZONE_SHARE = 0.2;
const MIN_LEG_CANDLES = 2;
const WINDOW_CANDLES = 2;
const FADE_BELOW = 0.5;
const PRINTS_PRESENT_AT = 1;
const BAND_ATR = 0.5;
const MIN_ROWS = 2;
const BINS = 4;
const WALL_PULLED_BELOW = 0.9;
const BAND_GONE_BELOW = 0.75;
const FIRE_SCORE = 3;
const BEYOND_ATR = 1.5;
const BEYOND_SHARE = 0.1;
const VALUE_CAP = 1_000_000;
const RAW_CAP = 1_000_000_000;
const KEPT_CANDLES = 1_000;
const MAX_SHADES = 2_000;
const READINGS = Object.freeze(["rate", "progress", "delta", "divergence", "prints", "book"]);
const RAW_KEYS = Object.freeze(["own", "other", "legOwn", "moved", "legMoved", "big", "legBig", "extremeOwn", "extremeOther", "bookNow", "bookAt", "bookBand"]);
const BOOK_LINES = Object.freeze([WALL_PULLED_BELOW, BAND_GONE_BELOW, BAND_GONE_BELOW]);
const MAX_SCORE = READINGS.length;
const SIDES = Object.freeze(["buyers", "sellers"]);
const STATUSES = Object.freeze(["open", "pending", "held", "broke", "interrupted"]);
const FINAL = new Set(["held", "broke", "interrupted"]);

function intensityOf(score) {
  return score >= MAX_SCORE ? 3 : score >= 4 ? 2 : 1;
}

function wireValue(value) {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(Math.max(-VALUE_CAP, Math.min(VALUE_CAP, value)) * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}

function rawValue(value) {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(Math.max(-RAW_CAP, Math.min(RAW_CAP, value)) * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}

function touchRows(column) {
  let bidRow = -1;
  for (let i = column.bid.length - 1; i >= 0; i -= 1) {
    if (column.bid[i] > 0) {
      bidRow = column.lo + i;
      break;
    }
  }
  let askRow = -1;
  for (let i = 0; i < column.ask.length; i += 1) {
    if (column.ask[i] > 0) {
      askRow = column.lo + i;
      break;
    }
  }
  return { bidRow, askRow };
}

function sumRows(column, side, lo, hi) {
  let total = 0;
  const values = column[side];
  for (let row = Math.max(lo, column.lo); row <= Math.min(hi, column.hi); row += 1) total += values[row - column.lo];
  return total;
}

function flowTotal(entries) {
  let total = 0;
  if (entries !== undefined) for (const [, size] of entries) total += size;
  return total;
}

function hasTrades(column) {
  return flowTotal(column.buy) + flowTotal(column.sell) > 0;
}

function printCount(column, side) {
  let count = 0;
  for (const print of column.prints ?? []) if (print.side === side) count += 1;
  return count;
}

function ratio(value, base) {
  return base > 0 ? value / base : NaN;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function nullToNaN(value) {
  return typeof value === "number" ? value : NaN;
}

function shadeId(candleMs, side, startTs) {
  return `${candleMs}|${side}|${startTs}`;
}

function createExhaustionTracker({ candleMs, rowWidth, onLeg = null }) {
  if (!CANDLE_MS.includes(candleMs)) throw new Error(`exhaustion-engine: candleMs must be one of ${CANDLE_MS.join(", ")}`);
  if (!(rowWidth > 0) || !Number.isFinite(rowWidth)) throw new Error("exhaustion-engine: rowWidth must be a positive finite number");
  if (onLeg !== null && typeof onLeg !== "function") throw new Error("exhaustion-engine: onLeg must be a function or null");
  const candles = [];
  const shades = new Map();
  const unsettled = [];
  let current = null;
  let lastColumnTs = null;
  let lastSeenTs = null;
  let lastTradeTs = null;
  let lastCandleTs = null;
  let index = -1;
  let trSum = 0;
  let trCount = 0;
  let atr = NaN;
  let dir = 0;
  let lowest = NaN;
  let lowestIdx = -1;
  let highest = NaN;
  let highestIdx = -1;
  let pivot = NaN;
  let pivotIdx = -1;
  let atrRef = NaN;
  let ext = NaN;
  let extIdx = -1;
  let leg = null;
  let building = null;

  function candleAt(i) {
    const at = candles.length - 1 - (index - i);
    return at >= 0 && at < candles.length ? candles[at] : null;
  }

  function tell(event) {
    if (onLeg !== null) onLeg(Object.freeze(event));
  }

  function wire(shade, status, at) {
    shade.status = status;
    shade.updatedAt = at;
    if (FINAL.has(status)) shade.judgedAt = at;
    const out = Object.freeze({
      id: shade.id,
      candleMs,
      side: shade.side,
      status,
      intensity: shade.intensity,
      score: shade.score,
      readings: Object.freeze({ ...shade.readings }),
      values: Object.freeze({ ...shade.values }),
      raw: Object.freeze({ ...shade.raw }),
      startTs: shade.startTs,
      endTs: shade.endTs,
      extremeTs: shade.extremeTs,
      extremePrice: shade.extremePrice,
      legStartTs: shade.legStartTs,
      legStartPrice: shade.legStartPrice,
      legSize: shade.legSize,
      efficiency: shade.efficiency,
      atr: shade.atr,
      judgedAt: shade.judgedAt,
      updatedAt: at,
    });
    shades.set(shade.id, out);
    if (shades.size > MAX_SHADES) shades.delete(shades.keys().next().value);
    return out;
  }

  function settle(shade, status, at, updates) {
    unsettled.splice(unsettled.indexOf(shade), 1);
    if (building === shade) building = null;
    updates.push(wire(shade, status, at));
  }

  function stopBuilding(at, updates) {
    if (building === null) return;
    const shade = building;
    building = null;
    updates.push(wire(shade, "pending", at));
  }

  function judge(candle, at, updates) {
    for (const shade of [...unsettled]) {
      const sign = shade.side === "buyers" ? 1 : -1;
      const far = sign > 0 ? candle.hi : candle.lo;
      const near = sign > 0 ? candle.lo : candle.hi;
      if (sign * (far - shade.extremePrice) > Math.max(BEYOND_ATR * shade.atr, BEYOND_SHARE * shade.legSize)) settle(shade, "broke", at, updates);
      else if (sign * (far - shade.running) > 0) shade.running = far;
      else if (sign * (shade.running - near) >= REVERSE_ATR * shade.atr) settle(shade, "held", at, updates);
    }
  }

  function updateAtr(candle) {
    const prev = candleAt(index - 1);
    const tr = prev === null ? candle.hi - candle.lo : Math.max(candle.hi - candle.lo, Math.abs(candle.hi - prev.close), Math.abs(candle.lo - prev.close));
    if (trCount < ATR_PERIOD) {
      trSum += tr;
      trCount += 1;
      atr = trCount === ATR_PERIOD ? trSum / ATR_PERIOD : NaN;
    } else {
      atr = (atr * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
    }
    candle.atr = atr;
  }

  function resetStructure(candle) {
    dir = 0;
    lowest = candle.lo;
    lowestIdx = index;
    highest = candle.hi;
    highestIdx = index;
    pivot = NaN;
    pivotIdx = -1;
    atrRef = NaN;
    ext = NaN;
    extIdx = -1;
    leg = null;
    tell({ type: "reset", index });
  }

  function bandsAt(column, up) {
    if (column === null) return null;
    const rows = Math.max(MIN_ROWS, Math.round((BAND_ATR * atrRef) / rowWidth));
    const extRow = Math.round(ext / rowWidth);
    const beyond = (k) => (up ? sumRows(column, "ask", extRow + k * rows, extRow + (k + 1) * rows - 1) : sumRows(column, "bid", extRow - (k + 1) * rows + 1, extRow - k * rows));
    const behind = up ? sumRows(column, "bid", extRow - rows, extRow - 1) : sumRows(column, "ask", extRow + 1, extRow + rows);
    let bin = 0;
    let binAt = -1;
    for (let k = 0; k < BINS; k += 1) {
      const value = beyond(k);
      if (value > binAt) {
        binAt = value;
        bin = k;
      }
    }
    return { rows, extRow, up, wallAt: beyond(0), bin, binAt, behindAt: behind };
  }

  function bandsNow(column, bands) {
    if (column === null || bands === null) return null;
    const { rows, extRow, up, bin } = bands;
    const beyond = (k) => (up ? sumRows(column, "ask", extRow + k * rows, extRow + (k + 1) * rows - 1) : sumRows(column, "bid", extRow - (k + 1) * rows + 1, extRow - k * rows));
    const behind = up ? sumRows(column, "bid", extRow - rows, extRow - 1) : sumRows(column, "ask", extRow + 1, extRow + rows);
    return { wall: beyond(0), bin: beyond(bin), behind };
  }

  function windowFlow(from, to, up) {
    let own = 0;
    let other = 0;
    let big = 0;
    for (let j = from; j <= to; j += 1) {
      const c = candleAt(j);
      if (c === null) continue;
      own += up ? c.buy : c.sell;
      other += up ? c.sell : c.buy;
      big += up ? c.bigBuys : c.bigSells;
    }
    return { own, other, big, delta: (own - other) / Math.max(1e-9, own + other) };
  }

  function startLeg(up, candle) {
    const flow = windowFlow(pivotIdx + 1, index, up);
    leg = { up, own: flow.own, other: flow.other, big: flow.big, bands: null, extremeDelta: NaN, extremeOwn: NaN, extremeOther: NaN, firedExt: NaN };
    markExtreme(candle);
  }

  function markExtreme(candle) {
    leg.bands = bandsAt(candle.last, leg.up);
    const flow = windowFlow(index - WINDOW_CANDLES + 1, index, leg.up);
    leg.extremeDelta = flow.delta;
    leg.extremeOwn = flow.own;
    leg.extremeOther = flow.other;
  }

  function advance(candle) {
    if (dir === 0) {
      if (candle.lo <= lowest) {
        lowest = candle.lo;
        lowestIdx = index;
      }
      if (candle.hi >= highest) {
        highest = candle.hi;
        highestIdx = index;
      }
      const upFrom = candleAt(lowestIdx)?.atr ?? NaN;
      const downFrom = candleAt(highestIdx)?.atr ?? NaN;
      if (upFrom > 0 && candle.hi - lowest >= REVERSE_ATR * upFrom) {
        dir = 1;
        pivot = lowest;
        pivotIdx = lowestIdx;
        atrRef = upFrom;
        ext = candle.hi;
        extIdx = index;
        startLeg(true, candle);
        tell({ type: "start", index, up: true, pivotIdx, pivot, atrRef, ext, extIdx });
      } else if (downFrom > 0 && highest - candle.lo >= REVERSE_ATR * downFrom) {
        dir = -1;
        pivot = highest;
        pivotIdx = highestIdx;
        atrRef = downFrom;
        ext = candle.lo;
        extIdx = index;
        startLeg(false, candle);
        tell({ type: "start", index, up: false, pivotIdx, pivot, atrRef, ext, extIdx });
      }
      return false;
    }
    const up = dir === 1;
    leg.own += up ? candle.buy : candle.sell;
    leg.other += up ? candle.sell : candle.buy;
    leg.big += up ? candle.bigBuys : candle.bigSells;
    if (up ? candle.hi > ext : candle.lo < ext) {
      ext = up ? candle.hi : candle.lo;
      extIdx = index;
      markExtreme(candle);
      tell({ type: "extreme", index, ext, extIdx });
      return false;
    }
    if (up ? ext - candle.lo >= REVERSE_ATR * atrRef : candle.hi - ext >= REVERSE_ATR * atrRef) {
      dir = -dir;
      pivot = ext;
      pivotIdx = extIdx;
      atrRef = candleAt(pivotIdx)?.atr ?? atrRef;
      ext = up ? candle.lo : candle.hi;
      extIdx = index;
      startLeg(!up, candle);
      tell({ type: "flip", index, up: !up, pivotIdx, pivot, atrRef, ext, extIdx });
      return true;
    }
    return false;
  }

  function efficiency(size) {
    let path = 0;
    let last = pivot;
    for (let j = pivotIdx + 1; j <= extIdx; j += 1) {
      const c = candleAt(j);
      if (c === null) continue;
      path += Math.abs(c.close - last);
      last = c.close;
    }
    path += Math.abs(ext - last);
    return path > 0 ? Math.min(1, size / path) : 1;
  }

  function gauge({ window, before, legCandles, since, extreme, close, column, legOwn, legBig }) {
    const up = leg.up;
    const sign = up ? 1 : -1;
    const size = sign * (extreme - pivot);
    if (!(atrRef > 0) || size <= 0 || legCandles < 1) return null;
    let own = 0;
    let other = 0;
    let big = 0;
    for (const c of window) {
      own += up ? c.buy : c.sell;
      other += up ? c.sell : c.buy;
      big += up ? c.bigBuys : c.bigSells;
    }
    const now = { own, other, big, delta: (own - other) / Math.max(1e-9, own + other) };
    const legRate = legOwn / legCandles;
    const progress = sign * (close - (before === null ? pivot : before.close));
    const perUnitNow = now.own > 0 ? progress / now.own : 0;
    const perUnitLeg = legOwn > 0 ? size / legOwn : 0;
    const bigLeg = (legBig / legCandles) * WINDOW_CANDLES;
    const bigRatio = ratio(now.big, bigLeg);
    const bands = since >= 1 ? bandsNow(column, leg.bands) : null;
    const wallAt = leg.bands === null ? 0 : leg.bands.wallAt;
    const binAt = leg.bands === null ? 0 : leg.bands.binAt;
    const behindAt = leg.bands === null ? 0 : leg.bands.behindAt;
    const rateRatio = ratio(now.own / WINDOW_CANDLES, legRate);
    const progressRatio = ratio(perUnitNow, perUnitLeg);
    const divergence = since >= 1 && Number.isFinite(leg.extremeDelta) ? now.delta - leg.extremeDelta : NaN;
    const wallRatio = bands === null ? NaN : ratio(bands.wall, wallAt);
    const binRatio = bands === null ? NaN : ratio(bands.bin, binAt);
    const behindRatio = bands === null ? NaN : ratio(bands.behind, behindAt);
    const readings = Object.freeze({
      rate: rateRatio < FADE_BELOW,
      progress: progressRatio < FADE_BELOW,
      delta: now.delta < 0,
      divergence: divergence < 0,
      prints: now.big === 0 || bigRatio < FADE_BELOW,
      book: wallRatio < WALL_PULLED_BELOW || binRatio < BAND_GONE_BELOW || behindRatio < BAND_GONE_BELOW,
    });
    const read = bands === null ? [] : [[0, wallRatio, bands.wall, wallAt], [1, binRatio, bands.bin, binAt], [2, behindRatio, bands.behind, behindAt]].filter((band) => Number.isFinite(band[1]));
    const deciding = read.length === 0 ? null : read.reduce((best, band) => (band[1] / BOOK_LINES[band[0]] < best[1] / BOOK_LINES[best[0]] ? band : best));
    const raw = Object.freeze({
      own: rawValue(now.own),
      other: rawValue(now.other),
      legOwn: rawValue(legRate * WINDOW_CANDLES),
      moved: rawValue(progress),
      legMoved: rawValue((size / legCandles) * WINDOW_CANDLES),
      big: rawValue(now.big),
      legBig: rawValue(bigLeg),
      extremeOwn: rawValue(since >= 1 ? leg.extremeOwn : NaN),
      extremeOther: rawValue(since >= 1 ? leg.extremeOther : NaN),
      bookNow: deciding === null ? null : rawValue(deciding[2]),
      bookAt: deciding === null ? null : rawValue(deciding[3]),
      bookBand: deciding === null ? null : deciding[0],
    });
    const values = Object.freeze({
      rate: wireValue(rateRatio),
      progress: wireValue(progressRatio),
      delta: wireValue(now.delta),
      divergence: wireValue(divergence),
      prints: wireValue(bigRatio),
      book: deciding === null ? null : wireValue(deciding[1]),
    });
    const veto = bigRatio >= PRINTS_PRESENT_AT;
    const score = READINGS.filter((key) => readings[key]).length;
    return { readings, values, raw, score, veto, size, sign, efficiency: efficiency(size) };
  }

  function gaugeClosed(candle) {
    return gauge({ window: [candleAt(index - 1), candle].filter((c) => c !== null), before: candleAt(index - WINDOW_CANDLES), legCandles: index - pivotIdx, since: index - extIdx, extreme: ext, close: candle.close, column: candle.last, legOwn: leg.own, legBig: leg.big });
  }

  function read(candle) {
    const gauged = gaugeClosed(candle);
    if (gauged === null) return null;
    if (index - pivotIdx < MIN_LEG_CANDLES || gauged.sign * (ext - candle.close) > ZONE_SHARE * gauged.size) return null;
    return gauged;
  }

  function onClose(candle, at, updates) {
    index += 1;
    candle.index = index;
    candles.push(candle);
    if (candles.length > KEPT_CANDLES) candles.shift();
    updateAtr(candle);
    close(candle, at, updates);
    candle.last = null;
  }

  function close(candle, at, updates) {
    if (candle.gap || index === 0) {
      while (unsettled.length > 0) settle(unsettled[0], "interrupted", at, updates);
      resetStructure(candle);
      return;
    }
    const legEnded = advance(candle);
    judge(candle, at, updates);
    const reading = legEnded || leg === null ? null : read(candle);
    if (reading === null || reading.veto || reading.score < FIRE_SCORE) {
      stopBuilding(at, updates);
      return;
    }
    if (building === null) {
      if (Number.isFinite(leg.firedExt) && reading.sign * (ext - leg.firedExt) <= 0) return;
      leg.firedExt = ext;
      const side = leg.up ? "buyers" : "sellers";
      building = {
        id: shadeId(candleMs, side, candle.ts),
        side,
        running: ext,
        startTs: candle.ts,
        endTs: candle.ts + candleMs,
        extremeTs: candleAt(extIdx)?.ts ?? candle.ts,
        extremePrice: ext,
        legStartTs: candleAt(pivotIdx)?.ts ?? candle.ts,
        legStartPrice: pivot,
        legSize: reading.size,
        efficiency: reading.efficiency,
        atr: atrRef,
        score: -1,
        intensity: 1,
        readings: null,
        values: null,
        raw: null,
        judgedAt: null,
      };
      unsettled.push(building);
    }
    if (reading.score > building.score) {
      building.score = reading.score;
      building.intensity = intensityOf(reading.score);
      building.readings = reading.readings;
      building.values = reading.values;
      building.raw = reading.raw;
    }
    building.endTs = candle.ts + candleMs;
    updates.push(wire(building, "open", at));
  }

  function push(column) {
    const updates = [];
    if (!column || !Number.isSafeInteger(column.ts) || !(column.bid instanceof Float64Array) || !(column.ask instanceof Float64Array)) {
      throw new Error("exhaustion-engine: column must carry an integer ts and Float64Array sides");
    }
    if (lastSeenTs !== null && column.ts <= lastSeenTs) return updates;
    const { bidRow, askRow } = touchRows(column);
    if (bidRow < 0 || askRow < 0) return updates;
    const bucket = Math.floor(column.ts / candleMs) * candleMs;
    const hole = candleMs >= LONG_CANDLE_MS ? WEEKEND_MS : Math.max(GAP_MS, candleMs);
    const outage = lastSeenTs !== null && column.ts - lastSeenTs > hole;
    lastSeenTs = column.ts;
    if (current !== null && bucket !== current.ts) {
      onClose(current, column.ts, updates);
      current = null;
    }
    if (hasTrades(column)) lastTradeTs = column.ts;
    else if (current === null || column.ts - lastTradeTs > GAP_MS) return updates;
    const mid = ((bidRow + 1 + askRow) / 2) * rowWidth;
    const gap = outage || (lastCandleTs !== null && bucket !== lastCandleTs && bucket - lastCandleTs > Math.max(GAP_CANDLES * candleMs, hole));
    if (current === null) {
      current = { ts: bucket, open: mid, close: mid, hi: mid, lo: mid, buy: 0, sell: 0, bigBuys: 0, bigSells: 0, gap, last: column };
      lastCandleTs = bucket;
    }
    current.close = mid;
    if (mid > current.hi) current.hi = mid;
    if (mid < current.lo) current.lo = mid;
    current.buy += flowTotal(column.buy);
    current.sell += flowTotal(column.sell);
    current.bigBuys += printCount(column, "buy");
    current.bigSells += printCount(column, "sell");
    current.last = column;
    if (gap && !current.gap) current.gap = true;
    lastColumnTs = column.ts;
    return updates;
  }

  function list() {
    return [...shades.values()];
  }

  function toJSON() {
    const plain = (candle) => ({ ...candle, last: undefined, atr: finiteOrNull(candle.atr) });
    return {
      candleMs,
      rowWidth,
      index,
      lastColumnTs,
      lastSeenTs,
      lastTradeTs,
      trSum,
      trCount,
      atr: finiteOrNull(atr),
      candles: candles.map(plain),
      current: current === null ? null : plain(current),
      zigzag: { dir, lowest: finiteOrNull(lowest), lowestIdx, highest: finiteOrNull(highest), highestIdx, pivot: finiteOrNull(pivot), pivotIdx, atrRef: finiteOrNull(atrRef), ext: finiteOrNull(ext), extIdx },
      leg: leg === null ? null : { ...leg, extremeDelta: finiteOrNull(leg.extremeDelta), extremeOwn: finiteOrNull(leg.extremeOwn), extremeOther: finiteOrNull(leg.extremeOther), firedExt: finiteOrNull(leg.firedExt) },
      unsettled: unsettled.map((shade) => ({ ...shade })),
      building: building === null ? null : building.id,
    };
  }

  function restore(saved) {
    if (!saved || saved.candleMs !== candleMs || saved.rowWidth !== rowWidth) return null;
    if (saved.index === undefined) return [];
    if (!Number.isSafeInteger(saved.index) || !Array.isArray(saved.candles) || !Array.isArray(saved.unsettled) || !saved.zigzag || saved.candles.some((c) => !Number.isSafeInteger(c?.ts))) return null;
    candles.length = 0;
    for (const c of saved.candles) candles.push({ ...c, atr: nullToNaN(c.atr), last: null });
    current = saved.current === null || saved.current === undefined ? null : { ...saved.current, last: null };
    index = saved.index;
    lastColumnTs = Number.isSafeInteger(saved.lastColumnTs) ? saved.lastColumnTs : null;
    lastSeenTs = Number.isSafeInteger(saved.lastSeenTs) ? saved.lastSeenTs : lastColumnTs;
    lastTradeTs = Number.isSafeInteger(saved.lastTradeTs) ? saved.lastTradeTs : lastColumnTs;
    lastCandleTs = current !== null ? current.ts : candles.length > 0 ? candles[candles.length - 1].ts : null;
    trSum = Number(saved.trSum) || 0;
    trCount = Number(saved.trCount) || 0;
    atr = nullToNaN(saved.atr);
    const z = saved.zigzag;
    dir = z.dir === 1 || z.dir === -1 ? z.dir : 0;
    lowest = nullToNaN(z.lowest);
    lowestIdx = Number.isSafeInteger(z.lowestIdx) ? z.lowestIdx : -1;
    highest = nullToNaN(z.highest);
    highestIdx = Number.isSafeInteger(z.highestIdx) ? z.highestIdx : -1;
    pivot = nullToNaN(z.pivot);
    pivotIdx = Number.isSafeInteger(z.pivotIdx) ? z.pivotIdx : -1;
    atrRef = nullToNaN(z.atrRef);
    ext = nullToNaN(z.ext);
    extIdx = Number.isSafeInteger(z.extIdx) ? z.extIdx : -1;
    leg = saved.leg === null || saved.leg === undefined ? null : { ...saved.leg, bands: saved.leg.bands ?? null, extremeDelta: nullToNaN(saved.leg.extremeDelta), extremeOwn: nullToNaN(saved.leg.extremeOwn), extremeOther: nullToNaN(saved.leg.extremeOther), firedExt: nullToNaN(saved.leg.firedExt) };
    unsettled.length = 0;
    shades.clear();
    const out = [];
    for (const s of saved.unsettled) {
      const shade = { ...s, running: Number.isFinite(s.running) ? s.running : s.extremePrice };
      unsettled.push(shade);
      out.push(wire(shade, shade.status, shade.updatedAt));
    }
    building = saved.building === null || saved.building === undefined ? null : (unsettled.find((s) => s.id === saved.building) ?? null);
    return out;
  }

  function stats() {
    const size = leg === null ? null : Math.abs(ext - pivot);
    return Object.freeze({
      candles: index + 1,
      columns: candles.filter((candle) => candle.last).length,
      ready: atr > 0,
      atr: atr > 0 ? atr : null,
      leg: leg === null ? null : Object.freeze({ side: leg.up ? "buyers" : "sellers", sizeAtr: atrRef > 0 ? size / atrRef : null, candles: index - pivotIdx, efficiency: efficiency(size) }),
      open: building !== null,
      unsettled: unsettled.length,
      shades: shades.size,
    });
  }

  return Object.freeze({ push, list, toJSON, restore, stats, candleAt, get candleMs() { return candleMs; }, get rowWidth() { return rowWidth; }, get lastColumnTs() { return lastColumnTs; } });
}

module.exports = {
  createExhaustionTracker,
  intensityOf,
  wireValue,
  rawValue,
  EXHAUSTION_RULES_VERSION,
  CANDLE_MS,
  SIDES,
  STATUSES,
  READINGS,
  RAW_KEYS,
  RAW_CAP,
  MAX_SCORE,
  touchRows,
  flowTotal,
  hasTrades,
  printCount,
  GAP_MS,
  LONG_CANDLE_MS,
  WEEKEND_MS,
  ATR_PERIOD,
  REVERSE_ATR,
  ZONE_SHARE,
  WINDOW_CANDLES,
  FADE_BELOW,
  PRINTS_PRESENT_AT,
  BAND_ATR,
  WALL_PULLED_BELOW,
  BAND_GONE_BELOW,
  FIRE_SCORE,
  BEYOND_ATR,
  BEYOND_SHARE,
  VALUE_CAP,
  MAX_SHADES,
};
