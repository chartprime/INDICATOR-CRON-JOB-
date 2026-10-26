"use strict";

const { liquidityFrame } = require("../../src/server/frames");

const MINUTE_MS = 60_000;
const SYMBOL = "BTCUSDT";
const MARKET_KIND = "PERPETUAL";
const IDENTITY = Object.freeze({ provider: "BINANCE", symbol: "BTC-USDT", marketKind: MARKET_KIND });
const MAX_FRAME_COLUMNS = 120;

function seeded(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function priceWalk({ nowMs, bars, startPrice, seed }) {
  const random = seeded(seed);
  const lastOpen = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
  const out = [];
  let price = startPrice;
  let drift = 0;
  for (let index = 0; index < bars; index += 1) {
    if (index % 90 === 0) drift = (random() - 0.5) * 6;
    const open = price;
    const close = Math.max(1, open + drift + (random() - 0.5) * 40);
    const high = Math.max(open, close) + random() * 15;
    const low = Math.min(open, close) - random() * 15;
    const volume = Math.round(50 + random() * 450);
    const buy = Math.round(volume * (0.3 + random() * 0.4));
    out.push({
      type: "bar", ...IDENTITY, ts_open: lastOpen - (bars - index) * MINUTE_MS, interval_ms: MINUTE_MS,
      open: round2(open), high: round2(high), low: round2(low), close: round2(close),
      volume, buy_volume: buy, trade_count: Math.round(volume / 3), closed: true,
    });
    price = close;
  }
  return out;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function bookColumn({ ts, mid, rows, rowWidth, random, walls, withFlow }) {
  const midRow = Math.round(mid / rowWidth);
  const lo = Math.max(0, midRow - Math.floor(rows / 2));
  const hi = lo + rows - 1;
  const bid = [];
  const ask = [];
  for (let row = lo; row <= hi; row += 1) {
    const distance = Math.abs(row - midRow);
    const wall = walls.get(row);
    const size = round2((wall ?? 0) + 0.5 + random() * 4 + distance * 0.01);
    if (row < midRow) bid.push([row - lo, size]);
    else if (row > midRow) ask.push([row - lo, size]);
  }
  const column = { ts, lo, hi, bid, ask };
  if (!withFlow) return column;
  const buy = [];
  const sell = [];
  const prints = [];
  for (let n = 0; n < 6; n += 1) {
    const offset = midRow - lo + Math.round((random() - 0.5) * 20);
    if (offset < 0 || offset > hi - lo) continue;
    const size = round2(0.1 + random() * 3);
    (random() < 0.5 ? buy : sell).push([offset, size]);
  }
  const merge = (entries) => [...entries.reduce((map, [offset, size]) => map.set(offset, round2((map.get(offset) ?? 0) + size)), new Map())]
    .sort((a, b) => a[0] - b[0]);
  for (let n = 0; n < 4; n += 1) {
    prints.push({ ts: ts - 900 + n * 200, price: round2((midRow + Math.round((random() - 0.5) * 10)) * rowWidth), size: round2(1 + random() * 5), side: random() < 0.5 ? "buy" : "sell", id: `p-${ts}-${n}` });
  }
  return { ...column, buy: merge(buy), sell: merge(sell), prints, printsFloor: 1 };
}

function wallsFor(midRow, random) {
  const walls = new Map();
  for (let n = 0; n < 12; n += 1) {
    const side = n % 2 === 0 ? -1 : 1;
    walls.set(midRow + side * (5 + Math.floor(random() * 150)), 40 + random() * 160);
  }
  return walls;
}

function tierFrames({ columns, columnMs, rowWidth, nowMs }) {
  const frames = [];
  let seq = 0;
  for (let start = 0; start < columns.length; start += MAX_FRAME_COLUMNS) {
    const chunk = columns.slice(start, start + MAX_FRAME_COLUMNS);
    seq += chunk.length;
    frames.push(liquidityFrame(SYMBOL, MARKET_KIND, {
      ts: Math.max(nowMs, chunk[chunk.length - 1].ts), seq, reset: start === 0, rowWidth, columnMs, columns: chunk, levels: [],
    }));
  }
  return { frames, seq };
}

function densityHistory({ nowMs, bars = 10_080, rows = 400, rowWidth = 1, deepColumns = 1_440, fineColumns = 600, seed = 7 }) {
  if (!Number.isSafeInteger(nowMs) || !(rows >= 8 && rows <= 2_048) || !(rowWidth > 0)) throw new Error("indicator-density: invalid history options");
  const random = seeded(seed);
  const barFrames = priceWalk({ nowMs, bars, startPrice: 60_000, seed });
  const mid = barFrames[barFrames.length - 1].close;
  const midRow = Math.round(mid / rowWidth);
  const walls = wallsFor(midRow, random);
  const fineMs = 1_000;
  const deepMs = 10_000;
  const fineStart = Math.floor(nowMs / fineMs) * fineMs - (fineColumns - 1) * fineMs;
  const deepEnd = Math.floor(fineStart / deepMs) * deepMs;
  const deep = Array.from({ length: deepColumns }, (_, index) => bookColumn({ ts: deepEnd - (deepColumns - index) * deepMs, mid, rows, rowWidth, random, walls, withFlow: true }));
  const fine = Array.from({ length: fineColumns }, (_, index) => bookColumn({ ts: fineStart + index * fineMs, mid, rows, rowWidth, random, walls, withFlow: true }));
  const deepTier = tierFrames({ columns: deep, columnMs: deepMs, rowWidth, nowMs });
  const fineTier = tierFrames({ columns: fine, columnMs: fineMs, rowWidth, nowMs });
  return {
    identity: IDENTITY,
    nowMs,
    rows,
    rowWidth,
    bars: barFrames,
    mid,
    walls,
    liquidityFrames: [...deepTier.frames, ...fineTier.frames],
    fineSeq: fineTier.seq,
    lastFineTs: fine[fine.length - 1].ts,
  };
}

function liveColumnFrame({ history, ts, seq, rows = 400, rowWidth = 1, random }) {
  return liquidityFrame(SYMBOL, MARKET_KIND, {
    ts, seq, reset: false, rowWidth, columnMs: 1_000, levels: [],
    columns: [bookColumn({ ts, mid: history.mid, rows, rowWidth, random, walls: history.walls, withFlow: true })],
  });
}

function liveBarFrame({ history, previous, nowMs, random }) {
  const openMs = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
  const frames = [];
  let current = previous;
  if (current !== null && current.ts_open < openMs) {
    frames.push({ ...current, closed: true });
    current = null;
  }
  if (current === null) {
    const open = previous?.close ?? history.bars[history.bars.length - 1].close;
    current = {
      type: "bar", ...IDENTITY, ts_open: openMs, interval_ms: MINUTE_MS,
      open, high: open, low: open, close: open, volume: 0, buy_volume: 0, trade_count: 0, closed: false,
    };
  }
  const close = round2(Math.max(1, current.close + (random() - 0.5) * 4));
  const size = Math.round(1 + random() * 5);
  const next = {
    ...current,
    high: Math.max(current.high, close),
    low: Math.min(current.low, close),
    close,
    volume: current.volume + size,
    buy_volume: current.buy_volume + (random() < 0.5 ? size : 0),
    trade_count: current.trade_count + 1,
  };
  frames.push(next);
  return { next, frames };
}

const HISTORY_WINDOW_MS = 300_000;
const HISTORY_PAGE_BYTES = 2_000_000;
const HISTORY_CACHE_WINDOWS = 300;
const HISTORY_SPAN_MS = 7 * 24 * 60 * MINUTE_MS;
const WALL_VERDICTS = Object.freeze(["filled", "partial", "hit", "pulled", "moved"]);
const wallCache = new WeakMap();
const windowCache = new WeakMap();

function historyColumnsPage({ history, levelMs, fromTs, toTs }) {
  const horizon = Math.min(toTs, history.nowMs);
  const oldest = Math.floor((history.nowMs - HISTORY_SPAN_MS) / HISTORY_WINDOW_MS) * HISTORY_WINDOW_MS;
  const windows = [];
  let bytes = 0;
  let next = null;
  for (let windowTs = Math.max(Math.floor(fromTs / HISTORY_WINDOW_MS) * HISTORY_WINDOW_MS, oldest); windowTs < horizon; windowTs += HISTORY_WINDOW_MS) {
    let all = windowCache.get(history)?.get(`${levelMs}:${windowTs}`);
    if (all === undefined) {
      all = [];
      for (let ts = windowTs; ts < windowTs + HISTORY_WINDOW_MS; ts += levelMs) {
        all.push(bookColumn({ ts, mid: history.mid, rows: history.rows, rowWidth: history.rowWidth, random: seeded(ts), walls: history.walls, withFlow: true }));
      }
      if (!windowCache.has(history)) windowCache.set(history, new Map());
      const held = windowCache.get(history);
      held.set(`${levelMs}:${windowTs}`, all);
      if (held.size > HISTORY_CACHE_WINDOWS) held.delete(held.keys().next().value);
    }
    const columns = all.filter((column) => column.ts >= fromTs && column.ts < horizon);
    if (columns.length === 0) continue;
    const size = JSON.stringify(columns).length;
    if (windows.length > 0 && bytes + size > HISTORY_PAGE_BYTES) {
      next = windowTs;
      break;
    }
    bytes += size;
    windows.push({ ts: windowTs, state: "COVERED", columns });
  }
  return {
    available: true,
    generation: "density",
    geometry: { rowWidth: history.rowWidth, rowClusters: 1 },
    levelMs,
    rowFactor: 1,
    span: { oldest, newest: windows.length > 0 ? windows[windows.length - 1].ts : null },
    windows,
    next,
  };
}

function endedWalls(history) {
  const cached = wallCache.get(history);
  if (cached) return cached;
  const random = seeded(23);
  const midRow = Math.round(history.mid / history.rowWidth);
  const walls = [];
  for (const [row, size] of history.walls) {
    for (let startTs = history.nowMs - HISTORY_SPAN_MS; startTs < history.nowMs - 600_000; startTs += 10_800_000 + Math.floor(random() * 3_600_000)) {
      const endTs = Math.min(history.nowMs - 1_000, startTs + 300_000 + Math.floor(random() * 7_200_000));
      const peak = round2(size * (0.8 + random() * 0.6));
      const endedBy = WALL_VERDICTS[Math.floor(random() * WALL_VERDICTS.length)];
      walls.push({
        side: row < midRow ? "bid" : "ask", row, span: 1 + Math.floor(random() * 3), startTs, endTs,
        size: round2(peak * random() * 0.3), peak, endedBy, ratio: round2(2 + random() * 6), chain: 0,
        fill: round2(random()), eaten: round2(random()), absorbing: false,
        detail: {
          lifeMs: endTs - startTs, firstShrinkTs: endTs - 5_000, firstShrinkExact: random() < 0.7, reachedAtFirstShrink: random() < 0.5,
          traded: round2(peak * random()), absorbed: round2(peak * random() * 0.5), swept: round2(peak * random() * 0.5), hidden: 0, cleared: round2(peak * random()),
          fillRatio: round2(random()), crossSide: round2(random() * 10), crossSideShare: round2(random()), endDistanceRows: Math.floor(random() * 30), endDistancePct: round2(random() * 0.5),
          clearedByTrades: random() < 0.5, continuityGapMs: null, repeats: Math.floor(random() * 3), repeatsComplete: true, evidenceGap: false,
        },
      });
    }
  }
  walls.sort((a, b) => a.endTs - b.endTs);
  walls.forEach((wall, index) => {
    wall.id = index + 1;
  });
  wallCache.set(history, walls);
  return walls;
}

const WHALE_WALL_COUNT = 1_500;
const WHALE_SPAN_MS = 48 * 60 * MINUTE_MS;
const whaleCache = new WeakMap();

function whaleWalls(history) {
  const cached = whaleCache.get(history);
  if (cached) return cached;
  const random = seeded(31);
  const midRow = Math.round(history.mid / history.rowWidth);
  const walls = [];
  for (let n = 0; n < WHALE_WALL_COUNT; n += 1) {
    const side = n % 2 === 0 ? "bid" : "ask";
    const offset = 5 + Math.floor(random() * 150);
    const startTs = history.nowMs - 600_000 - Math.floor(random() * (WHALE_SPAN_MS - 600_000)) + n;
    const endTs = Math.min(history.nowMs - 1_000, startTs + 300_000 + Math.floor(random() * 14_400_000));
    const peak = round2(330 + random() * 600);
    const endedBy = WALL_VERDICTS[Math.min(WALL_VERDICTS.length - 1, Math.floor(random() ** 0.6 * WALL_VERDICTS.length))];
    walls.push({
      side, row: side === "bid" ? midRow - offset : midRow + offset, span: 1 + Math.floor(random() * 3), startTs, endTs,
      size: round2(peak * random() * 0.3), peak, endedBy, ratio: round2(2 + random() * 6), chain: 0,
      fill: round2(random()), eaten: round2(random()), absorbing: false,
      detail: {
        lifeMs: endTs - startTs, firstShrinkTs: endTs - 5_000, firstShrinkExact: random() < 0.7, reachedAtFirstShrink: random() < 0.5,
        traded: round2(peak * random()), absorbed: round2(peak * random() * 0.5), swept: round2(peak * random() * 0.5), hidden: 0, cleared: round2(peak * random()),
        fillRatio: round2(random()), crossSide: round2(random() * 10), crossSideShare: round2(random()), endDistanceRows: Math.floor(random() * 30), endDistancePct: round2(random() * 0.5),
        clearedByTrades: random() < 0.5, continuityGapMs: null, repeats: Math.floor(random() * 3), repeatsComplete: true, evidenceGap: false,
      },
    });
  }
  walls.sort((a, b) => a.endTs - b.endTs);
  walls.forEach((wall, index) => {
    wall.id = index + 1;
  });
  whaleCache.set(history, walls);
  return walls;
}

function wallUsd(wall, rowWidth) {
  return wall.peak * (wall.row + wall.span / 2) * rowWidth;
}

function historyWallsPage({ history, fromTs, toTs, limit = 200, after = null, minUsd, alwaysOutcomes = [] }) {
  const filtered = minUsd !== undefined;
  const source = filtered ? whaleWalls(history) : endedWalls(history);
  const inRange = source.filter((wall) => wall.endTs >= fromTs && wall.endTs < toTs
    && (!filtered || wallUsd(wall, history.rowWidth) >= minUsd || alwaysOutcomes.includes(wall.endedBy))
    && (after === null || wall.endTs > after.endTs || (wall.endTs === after.endTs && wall.id > after.id)));
  const page = inRange.slice(0, limit);
  const last = page[page.length - 1];
  return {
    available: true,
    generation: "density",
    geometry: { rowWidth: history.rowWidth },
    walls: page,
    next: inRange.length > page.length ? { endTs: last.endTs, id: last.id } : null,
  };
}

module.exports = { densityHistory, liveBarFrame, liveColumnFrame, historyColumnsPage, historyWallsPage, seeded, IDENTITY, MAX_FRAME_COLUMNS, HISTORY_WINDOW_MS, WHALE_WALL_COUNT };
