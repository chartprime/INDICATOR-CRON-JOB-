import { describe, expect, it } from "vitest";
import { AGGRESSIVE_HISTORY_REASONS, BAND_HISTORY_REASONS, MAX_BAND_HISTORY_COLUMNS, MAX_BAND_HISTORY_ROWS, isLiquidityFrame, parseServerFrame } from "./frames";

const T = 1_700_000_000_000;
const COLUMN = { ts: T, lo: 39_800, hi: 40_200, bid: [[0, 1.5], [200, 0.5]], ask: [[201, 2]] };
const RAW = {
  type: "liquidity", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL",
  ts: T, seq: 1, reset: true, row_width: 2, column_ms: 1000, columns: [COLUMN],
};

describe("parseServerFrame -- liquidity frame", () => {
  it("accepts a well-formed frame and keeps every field", () => {
    const frame = parseServerFrame(RAW);
    expect(frame).not.toBeNull();
    expect(frame && isLiquidityFrame(frame)).toBe(true);
    if (frame && isLiquidityFrame(frame)) {
      expect(frame).toEqual({ ...RAW });
    }
  });

  it("accepts an empty column list only with reset", () => {
    expect(parseServerFrame({ ...RAW, seq: 0, columns: [] })).not.toBeNull();
    expect(parseServerFrame({ ...RAW, reset: false, columns: [] })).toBeNull();
  });

  it("rejects a seq smaller than the column count", () => {
    expect(parseServerFrame({ ...RAW, seq: 0 })).toBeNull();
  });

  it("rejects columns out of time order or after the frame ts", () => {
    expect(parseServerFrame({ ...RAW, columns: [{ ...COLUMN, ts: T + 1 }] })).toBeNull();
    expect(parseServerFrame({ ...RAW, ts: T + 5, seq: 2, columns: [{ ...COLUMN, ts: T + 1 }, COLUMN] })).toBeNull();
    expect(parseServerFrame({ ...RAW, ts: T + 5, seq: 2, columns: [COLUMN, { ...COLUMN, ts: T + 1 }] })).not.toBeNull();
  });

  it("rejects a bad window or entries", () => {
    expect(parseServerFrame({ ...RAW, columns: [{ ...COLUMN, lo: 5, hi: 4 }] })).toBeNull();
    expect(parseServerFrame({ ...RAW, columns: [{ ...COLUMN, lo: 0, hi: 2048 }] })).toBeNull();
    expect(parseServerFrame({ ...RAW, columns: [{ ...COLUMN, bid: [[401, 1]] }] })).toBeNull();
    expect(parseServerFrame({ ...RAW, columns: [{ ...COLUMN, bid: [[5, 1], [5, 2]] }] })).toBeNull();
    expect(parseServerFrame({ ...RAW, columns: [{ ...COLUMN, bid: [[5, -1]] }] })).toBeNull();
    expect(parseServerFrame({ ...RAW, columns: [{ ...COLUMN, bid: [[5]] }] })).toBeNull();
    expect(parseServerFrame({ ...RAW, columns: [{ ...COLUMN, extra: 1 }] })).toBeNull();
  });

  it("carries a column's optional flow and validates each part", () => {
    const print = { ts: T - 500, price: 80_000, size: 2.5, side: "buy", id: "123" };
    const flowed = { ...COLUMN, buy: [[0, 2.5]], sell: [[200, 1]], prints: [print], prints_floor: 2 };
    const frame = parseServerFrame({ ...RAW, columns: [flowed] });
    expect(frame && isLiquidityFrame(frame) ? frame.columns[0] : null).toEqual(flowed);
    expect(parseServerFrame({ ...RAW, columns: [{ ...COLUMN, buy: [[0, 1]] }] })).not.toBeNull();
    const bad = (patch: Record<string, unknown>) => parseServerFrame({ ...RAW, columns: [{ ...flowed, ...patch }] });
    expect(bad({ buy: [[401, 1]] })).toBeNull();
    expect(bad({ sell: [[0, -1]] })).toBeNull();
    expect(bad({ prints: Array.from({ length: 65 }, () => print) })).toBeNull();
    expect(bad({ prints: [{ ...print, ts: T + 1_001 }] })).toBeNull();
    // A print from the second before the column's own, credited late by the server (2026-09-20), is accepted; two back is not.
    // The first version of that server change left this bound alone, and every live frame then failed here, which is a
    // reconnect loop on the chart -- the browser's bound and the server's must move together.
    expect(bad({ prints: [{ ...print, ts: T - 2_000 }] })).not.toBeNull();
    expect(bad({ prints: [{ ...print, ts: T - 2_001 }] })).toBeNull();
    expect(bad({ prints: [{ ...print, ts: T }, { ...print, ts: T - 1 }] })).toBeNull();
    expect(bad({ prints: [{ ...print, side: "both" }] })).toBeNull();
    expect(bad({ prints: [{ ...print, size: 0 }] })).toBeNull();
    expect(bad({ prints: [{ ...print, id: 5 }] })).toBeNull();
    expect(bad({ prints: [{ ...print, extra: 1 }] })).toBeNull();
    expect(bad({ prints_floor: -1 })).toBeNull();
    expect(bad({ prints: [{ ...print, id: null }] })).not.toBeNull();
  });

  it("rejects a bad envelope", () => {
    expect(parseServerFrame({ ...RAW, row_width: 0 })).toBeNull();
    expect(parseServerFrame({ ...RAW, column_ms: 0 })).toBeNull();
    expect(parseServerFrame({ ...RAW, reset: "yes" })).toBeNull();
    expect(parseServerFrame({ ...RAW, seq: -1 })).toBeNull();
    expect(parseServerFrame({ ...RAW, marketKind: "MARGIN" })).toBeNull();
    expect(parseServerFrame({ ...RAW, bogus: true })).toBeNull();
    expect(parseServerFrame({ ...RAW, columns: new Array(121).fill(COLUMN), seq: 121 })).toBeNull();
  });

  it("carries optional aggressive-order clusters and validates each", () => {
    const live = { side: "buy", row: 40_000, span: 1, start_ts: T - 5_000, end_ts: null, volume: 12, peak: 12, floor: 10 };
    const done = { side: "sell", row: 40_010, span: 3, start_ts: T - 9_000, end_ts: T - 1_000, volume: 60, peak: 25, floor: 10 };
    const frame = parseServerFrame({ ...RAW, aggressive: [live, done] });
    expect(frame && isLiquidityFrame(frame) && frame.aggressive).toEqual([live, done]);
    const none = parseServerFrame(RAW);
    expect(none && isLiquidityFrame(none) && "aggressive" in none).toBe(false);
    const withEvents = (aggressive: unknown) => parseServerFrame({ ...RAW, aggressive });
    expect(withEvents([])).not.toBeNull();
    expect(withEvents("nope")).toBeNull();
    expect(withEvents(new Array(201).fill(live))).toBeNull();
    expect(withEvents([{ ...live, side: "bid" }])).toBeNull();
    expect(withEvents([{ ...live, span: 0 }])).toBeNull();
    expect(withEvents([{ ...live, start_ts: T + 1 }])).toBeNull();
    expect(withEvents([{ ...done, end_ts: T + 1 }])).toBeNull();
    expect(withEvents([{ ...done, end_ts: done.start_ts - 1 }])).toBeNull();
    expect(withEvents([{ ...live, volume: -1 }])).toBeNull();
    expect(withEvents([{ ...live, peak: 13 }])).toBeNull(); // a column never printed more than the whole
    expect(withEvents([{ ...live, floor: "10" }])).toBeNull();
    expect(withEvents([{ ...live, extra: 1 }])).toBeNull();
    const { floor: _dropped, ...withoutFloor } = live;
    expect(withEvents([withoutFloor])).toBeNull();
    // The old absorption list is not a liquidity frame field any more.
    expect(parseServerFrame({ ...RAW, absorption: [] })).toBeNull();
  });

  it("carries optional levels and validates each", () => {
    const active = { side: "bid", row: 40_000, span: 1, start_ts: T - 5_000, end_ts: null, size: 7, peak: 9, ended_by: null, ratio: 1.8, chain: 0, fill: 0, eaten: 0, absorbing: false };
    const eaten = { side: "ask", row: 40_010, span: 3, start_ts: T - 9_000, end_ts: T - 1_000, size: 0, peak: 12, ended_by: "filled", ratio: 4, chain: 0, fill: 0.9, eaten: 0.52, absorbing: false };
    const frame = parseServerFrame({ ...RAW, levels: [active, eaten] });
    expect(frame && isLiquidityFrame(frame) && frame.levels).toEqual([active, eaten]);
    const noLevels = parseServerFrame(RAW);
    expect(noLevels && isLiquidityFrame(noLevels) && "levels" in noLevels).toBe(false);
    const withLevels = (levels: unknown) => parseServerFrame({ ...RAW, levels });
    expect(withLevels([])).not.toBeNull();
    expect(withLevels("nope")).toBeNull();
    expect(withLevels(new Array(401).fill(active))).toBeNull();
    expect(withLevels([{ ...active, side: "buy" }])).toBeNull();
    expect(withLevels([{ ...active, span: 0 }])).toBeNull();
    expect(withLevels([{ ...active, start_ts: T + 1 }])).toBeNull();
    expect(withLevels([{ ...eaten, end_ts: T + 1 }])).toBeNull();
    expect(withLevels([{ ...eaten, ended_by: null }])).toBeNull();
    expect(withLevels([{ ...active, ended_by: "pulled" }])).toBeNull();
    expect(withLevels([{ ...active, peak: 6 }])).toBeNull();
    expect(withLevels([{ ...active, extra: 1 }])).toBeNull();
    expect(withLevels([{ ...active, ratio: -1 }])).toBeNull();
    expect(withLevels([{ ...active, eaten: 1.2 }])).toBeNull();
    expect(withLevels([{ ...active, eaten: -0.1 }])).toBeNull();
    const { ratio: _dropped, ...withoutRatio } = active;
    expect(withLevels([withoutRatio])).toBeNull();
    // The other verdicts, and the trace id.
    const hit = { ...eaten, ended_by: "hit", chain: 0 };
    const moved = { ...eaten, ended_by: "moved", chain: 7 };
    expect(withLevels([hit, moved, { ...active, chain: 7 }])).not.toBeNull();
    expect(withLevels([{ ...eaten, ended_by: "gone" }])).toBeNull();
    expect(withLevels([{ ...active, chain: -1 }])).toBeNull();
    expect(withLevels([{ ...active, chain: 1.5 }])).toBeNull();
    const { chain: _noChain, ...withoutChain } = active;
    expect(withLevels([withoutChain])).toBeNull();
    expect(withLevels([{ ...eaten, ended_by: "partial", fill: 0.33 }])).not.toBeNull();
    expect(withLevels([{ ...active, absorbing: true, fill: 1 }])).not.toBeNull();
    expect(withLevels([{ ...active, fill: 1.5 }])).toBeNull();
    expect(withLevels([{ ...active, fill: -1 }])).toBeNull();
    expect(withLevels([{ ...active, absorbing: "yes" }])).toBeNull();
    expect(withLevels([{ ...eaten, absorbing: true }])).toBeNull();
    const { fill: _noFill, ...withoutFill } = active;
    expect(withLevels([withoutFill])).toBeNull();
  });

  it("applies the live future-skew guard to the frame ts", () => {
    expect(parseServerFrame(RAW, { nowMs: T - 10 * 60_000 })).toBeNull();
    expect(parseServerFrame(RAW, { nowMs: T })).not.toBeNull();
  });

  it("carries an optional backfill status and validates it", () => {
    const running = { status: "RUNNING", reason: null };
    const frame = parseServerFrame({ ...RAW, backfill: running });
    expect(frame && isLiquidityFrame(frame) && frame.backfill).toEqual(running);
    const none = parseServerFrame(RAW);
    expect(none && isLiquidityFrame(none) && "backfill" in none).toBe(false);
    const withBackfill = (backfill: unknown) => parseServerFrame({ ...RAW, backfill });
    expect(withBackfill({ status: "COMPLETE", reason: null })).not.toBeNull();
    expect(withBackfill({ status: "COMPLETE", reason: "NO_DATABASE" })).not.toBeNull();
    expect(withBackfill({ status: "FAILED", reason: "WORKER_ERROR" })).not.toBeNull();
    expect(withBackfill({ status: "PENDING", reason: null })).toBeNull();
    expect(withBackfill({ status: "RUNNING", reason: 1 })).toBeNull();
    expect(withBackfill({ status: "RUNNING" })).toBeNull();
    expect(withBackfill({ ...running, extra: 1 })).toBeNull();
    expect(withBackfill("nope")).toBeNull();
    expect(withBackfill(null)).toBeNull();
  });
});

describe("aggressive_history frame", () => {
  const trade = (ts_exchange: number, trade_id = String(ts_exchange)) => ({
    type: "trade", symbol: "/NQU26:XCME", provider: "DXFEED", assetClass: "FUTURE", ts_exchange, price: 29100.25, size: 7, side: "sell", trade_id,
  });
  const frame = (over: Record<string, unknown> = {}) => ({
    type: "aggressive_history", symbol: "/NQU26:XCME", provider: "DXFEED", assetClass: "FUTURE",
    request_id: 3, from_ts: 1_000, to_ts: 900_000_000_000, min_size: 5, complete: true, reason: null, next_cursor: null, retry_after_ms: null, trades: [trade(1_000), trade(2_000)], ...over,
  });

  it("parses the reply with its old trades, which the live-window clock must not reject", () => {
    const parsed = parseServerFrame(frame(), { nowMs: 1_789_050_000_000 });
    expect(parsed).toMatchObject({ type: "aggressive_history", symbol: "/NQU26:XCME", provider: "DXFEED", assetClass: "FUTURE", request_id: 3, min_size: 5, complete: true, reason: null });
    expect(parsed && parsed.type === "aggressive_history" ? parsed.trades.map((t) => t.ts_exchange) : null).toEqual([1_000, 2_000]);
  });

  it("carries the reason of an incomplete reply, and only a known one", () => {
    for (const reason of AGGRESSIVE_HISTORY_REASONS) {
      expect(parseServerFrame(frame({ complete: false, reason, next_cursor: reason === "CAP_REACHED" ? "eyJ2IjoxfQ" : null, retry_after_ms: null, trades: [] }))).toMatchObject({ complete: false, reason });
    }
    expect(parseServerFrame(frame({ complete: false, reason: null, trades: [] }))).toBeNull();
    expect(parseServerFrame(frame({ complete: false, reason: "NOPE", trades: [] }))).toBeNull();
    expect(parseServerFrame(frame({ complete: true, reason: "CAP_REACHED" }))).toBeNull();
    expect(parseServerFrame(frame({ complete: false, reason: "CAP_REACHED", next_cursor: null }))).toBeNull();
    expect(parseServerFrame(frame({ complete: false, reason: "READ_FAILED", next_cursor: "eyJ2IjoxfQ" }))).toBeNull();
    expect(parseServerFrame(frame({ complete: false, reason: "OVERLOADED", retry_after_ms: 5 }))).toMatchObject({ retry_after_ms: 5 });
    expect(parseServerFrame(frame({ complete: false, reason: "READ_FAILED", retry_after_ms: 5 }))).toBeNull();
    expect(parseServerFrame(frame({ complete: false, reason: "OVERLOADED", retry_after_ms: 0 }))).toBeNull();
    const { reason: _dropped, ...withoutReason } = frame();
    expect(parseServerFrame(withoutReason)).toBeNull();
  });

  it("rejects extra fields, bad numbers, a foreign trade, a non-trade entry and trades out of order", () => {
    expect(parseServerFrame(frame({ extra: 1 }))).toBeNull();
    expect(parseServerFrame(frame({ request_id: -1 }))).toBeNull();
    expect(parseServerFrame(frame({ to_ts: 1_000 }))).toBeNull();
    expect(parseServerFrame(frame({ min_size: -1 }))).toBeNull();
    expect(parseServerFrame(frame({ complete: "yes" }))).toBeNull();
    expect(parseServerFrame(frame({ trades: [{ ...trade(1_000), symbol: "/ESU26:XCME" }] }))).toBeNull();
    expect(parseServerFrame(frame({ trades: [{ type: "bar" }] }))).toBeNull();
    expect(parseServerFrame(frame({ trades: [trade(2_000), trade(1_000)] }))).toBeNull();
  });
});

describe("band_history frame", () => {
  const column = (ts: number, rows = 3) => ({ ts, bid: new Array(rows).fill(1.5), ask: new Array(rows).fill(0), buy: new Array(rows).fill(0), sell: new Array(rows).fill(0.25) });
  const frame = (over: Record<string, unknown> = {}) => ({
    type: "band_history", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
    request_id: 3, from_ts: 1_000, to_ts: 61_000, price_lo: 80_000, price_hi: 80_008, column_ms: 10_000, row_width: 4, row_lo: 20_000, row_hi: 20_002,
    complete: true, reason: null, retry_after_ms: null, columns: [column(11_000), column(21_000)], ...over,
  });

  it("parses a complete reply with its band rows and columns, old timestamps included", () => {
    const parsed = parseServerFrame(frame(), { nowMs: 1_789_050_000_000 });
    expect(parsed).toMatchObject({ type: "band_history", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", request_id: 3, row_width: 4, row_lo: 20_000, row_hi: 20_002, complete: true, reason: null });
    expect(parsed && parsed.type === "band_history" ? parsed.columns.map((c) => c.ts) : null).toEqual([11_000, 21_000]);
  });

  it("carries the reason of an incomplete reply, only a known one, with no columns, and null geometry only when the rows could not be worked out", () => {
    for (const reason of BAND_HISTORY_REASONS) {
      const rowless = reason === "GEOMETRY_UNAVAILABLE" || reason === "BAND_TOO_WIDE" || reason === "BAD_REQUEST";
      const geometry = rowless ? { row_width: null, row_lo: null, row_hi: null } : {};
      if (rowless) expect(parseServerFrame(frame({ complete: false, reason, columns: [] }))).toBeNull();
      expect(parseServerFrame(frame({ complete: false, reason, columns: [], ...geometry }))).toMatchObject({ complete: false, reason });
    }
    expect(parseServerFrame(frame({ complete: false, reason: null, columns: [] }))).toBeNull();
    expect(parseServerFrame(frame({ complete: false, reason: "NOPE", columns: [] }))).toBeNull();
    expect(parseServerFrame(frame({ complete: true, reason: "READ_FAILED" }))).toBeNull();
    expect(parseServerFrame(frame({ complete: false, reason: "READ_FAILED" }))).toBeNull();
    expect(parseServerFrame(frame({ complete: false, reason: "OVERLOADED", retry_after_ms: 5, columns: [] }))).toMatchObject({ retry_after_ms: 5 });
    expect(parseServerFrame(frame({ complete: false, reason: "READ_FAILED", retry_after_ms: 5, columns: [] }))).toBeNull();
    expect(parseServerFrame(frame({ row_width: null, row_lo: null, row_hi: null, columns: [] }))).toBeNull();
    expect(parseServerFrame(frame({ complete: false, reason: "GEOMETRY_UNAVAILABLE", columns: [] }))).toBeNull();
  });

  it("rejects a column of the wrong width, a negative value, columns out of order, a band over the row cap, too many columns, and unknown fields", () => {
    expect(parseServerFrame(frame({ columns: [column(11_000, 2)] }))).toBeNull();
    expect(parseServerFrame(frame({ columns: [{ ...column(11_000), bid: [1, -1, 1] }] }))).toBeNull();
    expect(parseServerFrame(frame({ columns: [column(21_000), column(11_000)] }))).toBeNull();
    expect(parseServerFrame(frame({ row_hi: 20_000 + MAX_BAND_HISTORY_ROWS, columns: [] }))).toBeNull();
    expect(parseServerFrame(frame({ columns: Array.from({ length: MAX_BAND_HISTORY_COLUMNS + 1 }, (_unused, i) => column(i + 1)) }))).toBeNull();
    expect(parseServerFrame(frame({ extra: 1 }))).toBeNull();
    expect(parseServerFrame(frame({ price_hi: 79_000 }))).toBeNull();
  });
});
