const { createStorageDb } = require("../../../src/storage/storage-db");
const { runBackfillInProcess } = require("../../../src/indicators/l2-memory/liquidity-backfill");
const { createReplaySource } = require("../../../src/indicators/l2-memory/replay-source");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { createLiquidityPublisher } = require("../../../src/indicators/passive_liquidity/liquidity-publisher");
const { decodeColumn } = require("../../../src/indicators/passive_liquidity/liquidity-history");

const SYMBOL = "BTCUSDT";
const PERP = "PERPETUAL";
const T = 1_700_000_000_000;
const COLUMN_MS = 1_000;
const DEEP_COLUMN_MS = 10_000;
const ENGINE = { tickSize: 1, clusterTicks: 1, snapshotDepth: 1000 };

function openFixtureDb() {
  const storageDb = createStorageDb({ dbPath: ":memory:" });
  const db = storageDb.raw;
  const insertSnapshot = db.prepare(
    "INSERT INTO l2_depth_snapshots (captured_at, symbol, market_kind, last_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertEvent = db.prepare(
    "INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertTrade = db.prepare(
    "INSERT INTO trades (ts, symbol, market_kind, price, size, side, trade_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  return {
    db,
    snapshot: ({ capturedAt, lastUpdateId, bids, asks }) =>
      insertSnapshot.run(capturedAt, SYMBOL, PERP, lastUpdateId, JSON.stringify(bids), JSON.stringify(asks)),
    event: ({ ts, U, u, pu, bids = [], asks = [] }) =>
      insertEvent.run(ts, ts + 5, SYMBOL, PERP, U, u, pu, JSON.stringify(bids), JSON.stringify(asks)),
    trade: ({ ts, price, size, side, id }) => insertTrade.run(ts, SYMBOL, PERP, price, size, side, id),
    close: () => storageDb.close(),
  };
}

function seedSession(fixture) {
  fixture.snapshot({
    capturedAt: T,
    lastUpdateId: 100,
    bids: [["100", "5"], ["99", "2"], ["98", "7"], ["97", "1"]],
    asks: [["101", "3"], ["102", "4"], ["103", "9"]],
  });
  let u = 100;
  let tradeId = 1;
  fixture.event({ ts: T + 200, U: u, u: u + 1, pu: u - 1, bids: [["100", "6"]] });
  u += 1;
  for (let second = 1; second <= 34; second += 1) {
    const ts = T + second * 1_000 + 300;
    const wall = second % 10 === 2 ? [["96", "40"]] : second % 10 === 4 ? [["96", "0"]] : [];
    const bid = [["99", String(2 + (second % 4))], ...wall];
    const ask = second % 3 === 0 ? [["102", String(4 + (second % 5))]] : [["104", String(second % 6)]];
    fixture.event({ ts, U: u + 1, u: u + 1, pu: u, bids: bid, asks: ask });
    u += 1;
    if (second % 2 === 0) fixture.trade({ ts: ts + 100, price: 101, size: 0.5, side: "buy", id: tradeId++ });
    if (second === 11) {
      fixture.event({ ts: T + 12_000, U: u + 1, u: u + 1, pu: u, bids: [["98", "8"]] });
      u += 1;
    }
    if (second % 5 === 0) {
      fixture.trade({ ts: ts + 150, price: 100, size: 1, side: "sell", id: tradeId++ });
      fixture.event({ ts: ts + 200, U: u + 1, u: u + 1, pu: u, bids: [["100", String(6 - second / 5)]] });
      u += 1;
    }
  }
}

function livePath(fixture, fromTs, toTs) {
  const engine = createMemoryEngine(ENGINE);
  const source = createReplaySource({ db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs, toTs });
  let clock = fromTs;
  const publisher = createLiquidityPublisher({
    memory: { getEngine: () => engine, rowClusters: () => 1 },
    columnMs: COLUMN_MS,
    deepColumnMs: DEEP_COLUMN_MS,
    historyS: 3_600,
    deepS: 7_200,
    storeEnabled: false,
    backfillEnabled: false,
    aggressiveEnabled: false,
    now: () => clock,
    log: () => {},
  });
  const frames = [];
  let nextTs = Math.ceil(fromTs / COLUMN_MS) * COLUMN_MS;
  const tickUpTo = (limit) => {
    while (nextTs <= limit) {
      clock = nextTs;
      const out = publisher.tick(PERP, SYMBOL, nextTs);
      if (out) frames.push(...(Array.isArray(out) ? out : [out]));
      nextTs += COLUMN_MS;
    }
  };
  let lastFrameTs = null;
  try {
    for (const frame of source.frames()) {
      if (frame.ts >= nextTs) tickUpTo(Math.min(toTs, frame.ts - 1));
      engine.apply(frame);
      lastFrameTs = frame.ts;
    }
    if (lastFrameTs !== null) tickUpTo(Math.min(toTs, lastFrameTs + COLUMN_MS));
  } finally {
    source.close();
  }
  const tiers = new Map();
  for (const frame of frames) {
    const tier = tiers.get(frame.column_ms) ?? [];
    for (const wire of frame.columns) {
      const { prints_floor: printsFloor, ...rest } = wire;
      tier.push(decodeColumn(tier[tier.length - 1] ?? null, printsFloor === undefined ? rest : { ...rest, printsFloor }));
    }
    tiers.set(frame.column_ms, tier);
  }
  const geometry = publisher.activeState;
  const lanes = publisher.lanes(PERP, SYMBOL);
  publisher.stop();
  return { fine: tiers.get(COLUMN_MS) ?? [], deep: tiers.get(DEEP_COLUMN_MS) ?? [], geometry, lanes };
}

function plain(column) {
  return { ts: column.ts, lo: column.lo, hi: column.hi, bid: Array.from(column.bid), ask: Array.from(column.ask), buy: column.buy, sell: column.sell, prints: column.prints, printsFloor: column.printsFloor };
}

describe("backfill equivalence", () => {
  test("the backfill produces exactly the columns the live publisher samples from the same recording, on both tiers", async () => {
    const fixture = openFixtureDb();
    seedSession(fixture);
    const fromTs = T;
    const toTs = T + 36_000;
    const live = livePath(fixture, fromTs, toTs);
    expect(live.fine.length).toBeGreaterThan(30);
    expect(live.deep.length).toBeGreaterThanOrEqual(3);

    const request = {
      ...ENGINE, db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs, toTs, columnMs: COLUMN_MS,
      rowClusters: live.geometry.rowClusters, windowRows: live.geometry.windowRows,
    };
    const fine = [];
    const fineResult = await runBackfillInProcess({ ...request, onColumn: (column) => fine.push(column) });
    const deep = [];
    const deepResult = await runBackfillInProcess({ ...request, foldMs: DEEP_COLUMN_MS, onColumn: (column) => deep.push(column) });
    fixture.close();

    expect(fineResult.reason).toBeNull();
    expect(deepResult.reason).toBeNull();
    expect(fine.map(plain)).toEqual(live.fine.map(plain));
    expect(deep.map(plain)).toEqual(live.deep.map(plain));
    const wallWindow = live.deep.find((column) => column.bid[96 - column.lo] === 40);
    expect(wallWindow).toBeDefined();
    expect(live.fine.filter((column) => column.buy.length + column.sell.length > 0).length).toBeGreaterThan(10);
    expect(live.fine.flatMap((column) => column.prints).length).toBeGreaterThan(10);
    expect(live.deep.some((column) => column.sell.length > 0)).toBe(true);
  });

  test("one replay pass gives every lane exactly the columns the live publisher folds for it, on both tiers (report 61 P3c)", async () => {
    const fixture = openFixtureDb();
    seedSession(fixture);
    const fromTs = T;
    const toTs = T + 36_000;
    const live = livePath(fixture, fromTs, toTs);
    expect(live.lanes.lanes).toHaveLength(1);
    const [lane] = live.lanes.lanes;
    expect(lane).toMatchObject({ k: 1, columnMs: 2 * COLUMN_MS, deepColumnMs: 2 * DEEP_COLUMN_MS });
    expect(lane.recent.length).toBeGreaterThan(12);
    expect(lane.deep.length).toBeGreaterThanOrEqual(1);

    const request = {
      ...ENGINE, db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs, toTs, columnMs: COLUMN_MS,
      rowClusters: live.geometry.rowClusters, windowRows: live.geometry.windowRows,
      lanes: [{ rowClusters: lane.rowClusters, windowRows: lane.windowRows, factor: 2 }],
    };
    const fine = [];
    await runBackfillInProcess({ ...request, onColumn: () => {}, onLaneColumn: (index, column) => fine.push([index, column]) });
    const deep = [];
    await runBackfillInProcess({ ...request, foldMs: DEEP_COLUMN_MS, onColumn: () => {}, onLaneColumn: (index, column) => deep.push([index, column]) });
    fixture.close();

    expect(fine.every(([index]) => index === 0)).toBe(true);
    expect(fine.map(([, column]) => plain(column))).toEqual(lane.recent.map(plain));
    expect(deep.map(([, column]) => plain(column))).toEqual(lane.deep.map(plain));
    expect(lane.recent.some((column) => column.buy.length + column.sell.length > 0)).toBe(true);
    expect(lane.recent.every((column) => column.hi - column.lo + 1 === 2 * lane.windowRows + 1 || column.lo === 0)).toBe(true);
  });
});
