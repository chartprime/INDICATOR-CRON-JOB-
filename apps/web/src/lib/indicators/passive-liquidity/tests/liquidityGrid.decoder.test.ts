import { describe, expect, it } from "vitest";
import type { L2ViewFrame, LiquidityColumnFrame, LiquidityFrame } from "../../../../types/frames";
import { LaneDecoder, LaneGrids } from "../../../l2/laneGrids";
import { LiquidityDecoder, LiquidityGrid, type DecodedLiquidity, type LiquidityColumn } from "../liquidityGrid";

// P4c.1 moves decoding off the main thread: the worker runs LiquidityDecoder
// and transfers the column buffers, the main thread only stores them. These
// tests hold the split path to the single-thread path, frame by frame, over
// every branch the grid has: resets, width changes, duplicates, gaps, a column
// that goes back in time mid-frame, and the equity session filter.

const T = Date.UTC(2026, 8, 8, 14, 0, 0);

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function wireColumn(random: () => number, ts: number, mid: number, first: boolean): LiquidityColumnFrame {
  const lo = mid - 20 + Math.floor(random() * 3);
  const hi = mid + 20 + Math.floor(random() * 3);
  const entries = (): [number, number][] => {
    const out: [number, number][] = [];
    for (let offset = 0; offset <= hi - lo; offset += 1) if (first || random() < 0.3) out.push([offset, Math.round(random() * 5_000) / 100]);
    return out;
  };
  return { ts, lo, hi, bid: entries(), ask: entries() };
}

type Identity = Pick<LiquidityFrame, "provider" | "symbol"> & ({ marketKind: "PERPETUAL" } | { assetClass: "EQUITY" });

function stream(identity: Identity, seed: number, start = T): LiquidityFrame[] {
  const random = rng(seed);
  const frames: LiquidityFrame[] = [];
  const chains = [
    { columnMs: 1_000, rowWidth: 2, seq: 0, ts: start, mid: 500 },
    { columnMs: 10_000, rowWidth: 2, seq: 0, ts: start, mid: 500 },
    { columnMs: 300_000, rowWidth: 80, seq: 0, ts: start, mid: 12 },
  ];
  const make = (chain: (typeof chains)[number], count: number, reset: boolean, patch: (columns: LiquidityColumnFrame[]) => void = () => {}): LiquidityFrame => {
    const columns: LiquidityColumnFrame[] = [];
    for (let i = 0; i < count; i += 1) {
      chain.ts += chain.columnMs;
      chain.mid += Math.floor(random() * 5) - 2;
      columns.push(wireColumn(random, chain.ts, chain.mid, reset && i === 0));
    }
    patch(columns);
    chain.seq += count;
    return { type: "liquidity", ...identity, ts: chain.ts, seq: chain.seq, reset, row_width: chain.rowWidth, column_ms: chain.columnMs, columns } as LiquidityFrame;
  };
  const [fine, deep, coarse] = chains;
  frames.push(make(coarse, 3, true), make(deep, 20, true), make(fine, 40, true));
  for (let i = 0; i < 30; i += 1) frames.push(make(fine, 1, false));
  frames.push(make(deep, 2, false), make(coarse, 1, false));
  const stale = make(fine, 1, false);
  frames.push(stale, { ...stale });
  fine.seq += 3;
  frames.push(make(fine, 1, false));
  frames.push(make(fine, 5, true));
  frames.push(make(fine, 3, false, (columns) => { columns[2] = { ...columns[2], ts: columns[0].ts - 1 }; }));
  frames.push(make(fine, 2, true));
  deep.rowWidth = 4;
  frames.push(make(deep, 4, true));
  for (let i = 0; i < 10; i += 1) frames.push(make(fine, 1, false));
  frames.push(make(fine, 2, true));
  for (let i = 0; i < 10; i += 1) frames.push(make(fine, 1, false));
  return frames;
}

function viaWorker(decoder: LiquidityDecoder, frame: LiquidityFrame): { frame: LiquidityFrame; decoded: DecodedLiquidity } {
  const decoded = decoder.decode(frame);
  const transfer = decoded.columns.flatMap((column) => [column.bid.buffer, column.ask.buffer]);
  const stripped = { ...frame, columns: frame.columns.map((column) => ({ ...column, bid: [], ask: [] })) };
  return structuredClone({ frame: stripped, decoded }, { transfer });
}

function columnsOf(columns: readonly LiquidityColumn[]): unknown[] {
  return columns.map((column) => ({ ts: column.ts, lo: column.lo, hi: column.hi, bid: Array.from(column.bid), ask: Array.from(column.ask), reference: column.reference, median: column.median }));
}

function stateOf(grid: LiquidityGrid): unknown {
  return {
    fine: columnsOf(grid.columns),
    deep: columnsOf(grid.deepColumns),
    coarse: columnsOf(grid.coarseColumns),
    rowWidth: grid.rowWidth,
    deepColumnMs: grid.deepColumnMs,
    coarseRowWidth: grid.coarseRowWidth,
    reference: grid.referenceSize,
    version: grid.version,
    epoch: grid.epoch,
    synced: grid.synced,
    rejected: grid.rejected,
  };
}

describe("the worker's decoder feeds the grid exactly as the grid feeds itself", () => {
  const OPEN = Date.UTC(2026, 8, 8, 13, 30, 0);
  it.each([
    ["a Binance perpetual", { provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL" } as Identity, 7, T],
    ["a dxFeed equity starting a minute before the open, whose pre-open columns the grid drops", { provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" } as Identity, 11, OPEN - 60_000],
  ])("%s: every frame, every tier, every counter", (_label, identity, seed, start) => {
    const frames = stream(identity, seed, start);
    const single = new LiquidityGrid();
    const split = new LiquidityGrid();
    const decoder = new LiquidityDecoder();
    const outcomes: boolean[] = [];
    frames.forEach((frame, index) => {
      const expected = single.apply(frame);
      const shipped = viaWorker(decoder, frame);
      expect([index, split.applyDecoded(shipped.frame, shipped.decoded)]).toEqual([index, expected]);
      expect(stateOf(split)).toEqual(stateOf(single));
      outcomes.push(expected);
    });
    expect(outcomes).toContain(false);
    expect(single.rejected).toBeGreaterThanOrEqual(3);
    expect(single.columns.length).toBeGreaterThan(0);
    if (start < OPEN) {
      const sent = frames.filter((frame) => frame.column_ms === 1_000).flatMap((frame) => frame.columns).filter((column) => column.ts < OPEN);
      expect(sent.length).toBeGreaterThan(0);
      expect(single.columns.every((column) => column.ts >= OPEN)).toBe(true);
    }
  });

  it("the transferred buffers leave the worker, and the decoder still decodes the next delta from its own copy", () => {
    const frames = stream({ provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL" }, 3);
    const decoder = new LiquidityDecoder();
    const first = decoder.decode(frames[2]);
    const buffer = first.columns[first.columns.length - 1].bid.buffer;
    structuredClone(first, { transfer: first.columns.flatMap((column) => [column.bid.buffer, column.ask.buffer]) });
    expect(buffer.byteLength).toBe(0);
    const next = decoder.decode(frames[3]);
    expect(next.accepted).toBe(true);
    expect(Array.from(next.columns[0].bid).some((size) => size > 0)).toBe(true);
  });
});

describe("the worker's lane decoder feeds the lanes exactly as the lanes feed themselves", () => {
  it("duplicates, gaps, resets and recovery per tier match", () => {
    const random = rng(5);
    const frames: L2ViewFrame[] = [];
    const chains = new Map<string, { seq: number; ts: number }>();
    const make = (lane: number, tier: "recent" | "deep", count: number, reset: boolean, seqSkip = 0): L2ViewFrame => {
      const columnMs = (tier === "recent" ? 1_000 : 10_000) * 2 ** lane;
      const key = `${lane}:${tier}`;
      const chain = chains.get(key) ?? { seq: 0, ts: T };
      const columns: LiquidityColumnFrame[] = [];
      for (let i = 0; i < count; i += 1) {
        chain.ts += columnMs;
        columns.push(wireColumn(random, chain.ts, 300, reset && i === 0));
      }
      chain.seq += count + seqSkip;
      chains.set(key, chain);
      return { type: "l2_view", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL", lane, tier, ts: chain.ts, seq: chain.seq, reset, row_width: 8 * 2 ** lane, column_ms: columnMs, columns, segment: { id: "PERPETUAL:BTCUSDT:1:LIVE", state: "LIVE" } };
    };
    frames.push(make(1, "deep", 5, true), make(1, "recent", 10, true));
    for (let i = 0; i < 5; i += 1) frames.push(make(1, "recent", 1, false));
    const dup = make(1, "recent", 1, false);
    frames.push(dup, { ...dup });
    frames.push(make(1, "deep", 1, false, 4));
    frames.push(make(1, "recent", 3, true));
    frames.push(make(1, "recent", 1, false));
    frames.push(make(1, "deep", 3, true));
    frames.push(make(2, "recent", 4, true));
    for (let i = 0; i < 4; i += 1) frames.push(make(2, "recent", 1, false));

    const single = new LaneGrids();
    const split = new LaneGrids();
    const decoder = new LaneDecoder();
    const outcomes: string[] = [];
    frames.forEach((frame, index) => {
      const expected = single.apply(frame);
      const result = decoder.decode(frame);
      const transfer = result.decoded === null ? [] : result.decoded.columns.flatMap((column) => [column.bid.buffer, column.ask.buffer]);
      const shipped = structuredClone({ frame: { ...frame, columns: frame.columns.map((column) => ({ ...column, bid: [], ask: [] })) }, result }, { transfer });
      expect([index, split.applyDecoded(shipped.frame, shipped.result)]).toEqual([index, expected]);
      expect([index, split.synced, split.seq, split.lastTs, split.lanes()]).toEqual([index, single.synced, single.seq, single.lastTs, single.lanes()]);
      for (const lane of [1, 2]) {
        expect([index, lane, split.laneSynced(lane)]).toEqual([index, lane, single.laneSynced(lane)]);
        const a = single.view(lane);
        const b = split.view(lane);
        expect(b === null ? null : { fine: columnsOf(b.fine.columns), deep: b.deep === null ? null : columnsOf(b.deep.columns) })
          .toEqual(a === null ? null : { fine: columnsOf(a.fine.columns), deep: a.deep === null ? null : columnsOf(a.deep.columns) });
      }
      outcomes.push(expected);
    });
    expect(outcomes).toEqual(expect.arrayContaining(["applied", "duplicate", "gap"]));
  });
});
