import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseServerFrame, sizeCeilingFor } from "./frames";

// On 2026-09-29 NVDA's 16:00 ET closing cross printed 12,281,274 shares in a
// single sell (host capture, dxfeed_time_and_sales). The liquidity flow cell
// for that row carried it, the wire builder refused anything above 10 M, and
// the publisher dropped and rebuilt the stored heatmap history every few
// seconds until the column scrolled out. Equity sizes now share the equity
// trade ceiling on both sides of the wire; everything else keeps 10 M. The
// browser cannot import the runtime, so this test drives the real builders
// and the real parser together.

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const frames = require(path.join(here, "../../../runtime/src/server/frames.js"));
const l2Frames = require(path.join(here, "../../../runtime/src/server/l2-frames.js"));
const catalog = require(path.join(here, "../../../runtime/src/providers/dxfeed/dxfeed-instrument-catalog.js"));
const wireFields = require(path.join(here, "../../../runtime/src/server/wire-fields.js"));

const NVDA_CLOSING_CROSS = 12_281_274;
const TS = 1_790_712_000_000;
const futureSymbol: string = catalog.listCollectorInstruments().find((entry: { assetClass: string }) => entry.assetClass === "FUTURE").symbol;

function liquidityBody(size: number) {
  return {
    ts: TS,
    seq: 1,
    reset: true,
    rowWidth: 0.01,
    columnMs: 1_000,
    columns: [{
      ts: TS,
      lo: 22_700,
      hi: 22_730,
      bid: [[0, size]],
      ask: [[25, 300]],
      buy: [[20, 100]],
      sell: [[21, size]],
      prints: [{ ts: TS, price: 227.21, size, side: "sell", id: null }],
      printsFloor: size,
    }],
    levels: [{ side: "bid", row: 22_700, span: 1, startTs: TS, endTs: null, endedBy: null, size, peak: size, ratio: 1, chain: 0, fill: 0, eaten: 0, absorbing: false }],
    aggressive: [{ side: "sell", row: 22_721, span: 1, startTs: TS, endTs: null, volume: size, peak: size, floor: size }],
  };
}

function roundTrip(frame: unknown) {
  return parseServerFrame(JSON.parse(JSON.stringify(frame)), { nowMs: TS });
}

describe("the size ceiling on both sides of the wire", () => {
  it("carries the measured NVDA closing cross through every liquidity size field for an equity", () => {
    const parsed = roundTrip(frames.dxfeedLiquidityFrame("NVDA", "EQUITY", liquidityBody(NVDA_CLOSING_CROSS)));

    expect(parsed?.type).toBe("liquidity");
    if (parsed?.type !== "liquidity") throw new Error("rejected");
    const [column] = parsed.columns;
    expect(column.bid).toEqual([[0, NVDA_CLOSING_CROSS]]);
    expect(column.sell).toEqual([[21, NVDA_CLOSING_CROSS]]);
    expect(column.prints?.[0].size).toBe(NVDA_CLOSING_CROSS);
    expect(column.prints_floor).toBe(NVDA_CLOSING_CROSS);
    expect(parsed.levels?.[0]).toMatchObject({ size: NVDA_CLOSING_CROSS, peak: NVDA_CLOSING_CROSS });
    expect(parsed.aggressive?.[0]).toMatchObject({ volume: NVDA_CLOSING_CROSS, peak: NVDA_CLOSING_CROSS, floor: NVDA_CLOSING_CROSS });
  });

  it("keeps the 10 M ceiling for futures and crypto on the server, and the parser refuses what the server would", () => {
    expect(() => frames.dxfeedLiquidityFrame(futureSymbol, "FUTURE", liquidityBody(NVDA_CLOSING_CROSS))).toThrow(/value 12281274, ceiling 10000000/);
    expect(() => frames.liquidityFrame("BTCUSDT", "PERPETUAL", liquidityBody(NVDA_CLOSING_CROSS))).toThrow(/value 12281274, ceiling 10000000/);

    const equity = JSON.parse(JSON.stringify(frames.dxfeedLiquidityFrame("NVDA", "EQUITY", liquidityBody(NVDA_CLOSING_CROSS))));
    const relabelled = { ...equity, symbol: frames.dxfeedLiquidityFrame(futureSymbol, "FUTURE", liquidityBody(100)).symbol, assetClass: "FUTURE" };
    expect(parseServerFrame(relabelled, { nowMs: TS })).toBeNull();
  });

  it("names the same ceiling in both places", () => {
    for (const identity of [
      { provider: "DXFEED" as const, assetClass: "EQUITY" as const },
      { provider: "DXFEED" as const, assetClass: "FUTURE" as const },
      { provider: "BINANCE" as const, marketKind: "SPOT" as const },
    ]) {
      expect(sizeCeilingFor(identity)).toBe(wireFields.sizeCeilingFor(identity));
    }
    expect(sizeCeilingFor({ provider: "DXFEED", assetClass: "EQUITY" })).toBe(1_000_000_000_000);
    expect(sizeCeilingFor({ provider: "DXFEED", assetClass: "FUTURE" })).toBe(10_000_000);
  });

  it("accepts a snapshot whose aggressive-print pool floor sits just above the closing cross, and a deep equity book", () => {
    const cross = frames.dxfeedTradeFrame({ symbol: "NVDA", assetClass: "EQUITY", tsExchange: TS, price: 227.21, size: NVDA_CLOSING_CROSS, side: "sell", tradeId: "close-1" });
    const floor = NVDA_CLOSING_CROSS + Number.EPSILON * NVDA_CLOSING_CROSS;
    const snapshot = roundTrip(frames.dxfeedSnapshotFrame([], [cross], "NVDA", "EQUITY", [], undefined, undefined, undefined, { prints: [cross], floor, from: TS - 60_000 }));
    expect(snapshot?.type).toBe("snapshot");
    if (snapshot?.type !== "snapshot") throw new Error("rejected");
    expect(snapshot.aggressive_prints_floor).toBe(floor);

    expect(() => frames.dxfeedSnapshotFrame([], [], futureSymbol, "FUTURE", [], undefined, undefined, undefined, { prints: [], floor, from: TS - 60_000 }))
      .toThrow(/aggressivePrints\.floor.*ceiling 10000000/);

    const atCeiling = 10_000_000 + Number.EPSILON * 10_000_000;
    const futureSnapshot = roundTrip(frames.dxfeedSnapshotFrame([], [], futureSymbol, "FUTURE", [], undefined, undefined, undefined, { prints: [], floor: atCeiling, from: TS - 60_000 }));
    expect(futureSnapshot).toMatchObject({ type: "snapshot", aggressive_prints_floor: atCeiling });

    const book = roundTrip(frames.dxfeedBookFrame("NVDA", "EQUITY", { status: "READY", book: { bids: [["227.2", String(NVDA_CLOSING_CROSS)]], asks: [["227.22", "300"]], lastUpdateId: 1 } }));
    expect(book).toMatchObject({ type: "book", status: "READY", bids: [{ price: 227.2, size: NVDA_CLOSING_CROSS }] });
  });

  it("carries the closing cross through a band_history reply for an equity and refuses it for a future", () => {
    const band = (symbol: string, assetClass: string) => frames.bandHistoryFrame({ provider: "DXFEED", symbol, assetClass }, {
      requestId: 1, fromTs: TS - 60_000, toTs: TS + 1_000, priceLo: 227.2, priceHi: 227.22, columnMs: 1_000,
      rowWidth: 0.01, rowLo: 22_720, rowHi: 22_722, complete: true,
      columns: [{ ts: TS, bid: [0, 0, 0], ask: [0, 0, 0], buy: [0, 0, 0], sell: [0, NVDA_CLOSING_CROSS, 0] }],
    });
    const parsed = roundTrip(band("NVDA", "EQUITY"));
    expect(parsed?.type).toBe("band_history");
    if (parsed?.type !== "band_history") throw new Error("rejected");
    expect(parsed.columns[0].sell).toEqual([0, NVDA_CLOSING_CROSS, 0]);
    expect(() => band(futureSymbol, "FUTURE")).toThrow(/value 12281274, ceiling 10000000/);
  });

  it("carries an equity size above 10 M through the lane, walls, events and ladder frames", () => {
    const identity = { provider: "DXFEED", symbol: "NVDA", assetClass: "EQUITY" };
    const view = roundTrip(l2Frames.l2ViewFrame(identity, {
      lane: 1, tier: "recent", ts: TS, seq: 1, reset: true, rowWidth: 0.01, columnMs: 1_000,
      columns: [{ ts: TS, lo: 22_700, hi: 22_730, bid: [[0, NVDA_CLOSING_CROSS]], ask: [[25, 300]], sell: [[21, NVDA_CLOSING_CROSS]] }],
    }));
    expect(view?.type).toBe("l2_view");

    const detail = {
      lifeMs: 1_000, firstShrinkTs: null, firstShrinkExact: false, reachedAtFirstShrink: null,
      traded: NVDA_CLOSING_CROSS, absorbed: NVDA_CLOSING_CROSS, swept: 0, hidden: 0, cleared: NVDA_CLOSING_CROSS,
      fillRatio: 1, crossSide: NVDA_CLOSING_CROSS, crossSideShare: 0.5, endDistanceRows: null, endDistancePct: null,
      clearedByTrades: true, continuity: null, repeats: 1, repeatsComplete: true, evidenceGap: false,
    };
    const walls = roundTrip(l2Frames.l2WallsFrame(identity, {
      ts: TS, seq: 1, reset: true, rowWidth: 0.01,
      walls: [{ id: 1, side: "bid", row: 22_700, span: 1, startTs: TS - 1_000, endTs: TS, endedBy: "filled", size: NVDA_CLOSING_CROSS, peak: NVDA_CLOSING_CROSS, detail }],
    }));
    expect(walls?.type).toBe("l2_walls");

    const events = roundTrip(l2Frames.l2EventsFrame(identity, {
      ts: TS, seq: 3, reset: true,
      events: [
        { event: "wall_born", ts: TS, wall: 1, side: "bid", row: 22_700, span: 1, size: NVDA_CLOSING_CROSS },
        { event: "trade", ts: TS, side: "bid", aggressor: "sell", mode: "absorbed", price: 227.21, size: NVDA_CLOSING_CROSS, late: false },
        { event: "hidden", ts: TS, side: "bid", price: 227.21, volume: NVDA_CLOSING_CROSS },
      ],
    }));
    expect(events?.type).toBe("l2_events");

    const ladder = roundTrip(l2Frames.l2LadderFrame(identity, { ts: TS, depth: 1, bids: [[227.2, NVDA_CLOSING_CROSS]], asks: [[227.22, 300]] }));
    expect(ladder?.type).toBe("l2_ladder");
  });
});
