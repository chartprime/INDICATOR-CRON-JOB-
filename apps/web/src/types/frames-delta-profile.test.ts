import { describe, expect, it } from "vitest";
import { DELTA_PROFILE_REASONS, MAX_DELTA_PROFILE_ROWS, parseServerFrame } from "./frames";

describe("delta_profile frame", () => {
  const frame = (over: Record<string, unknown> = {}) => ({
    type: "delta_profile", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL",
    request_id: 9, from_ts: 1_790_006_400_000, to_ts: 1_790_013_600_000, row_width: 1, complete: true, reason: null, retry_after_ms: null, pending: 3,
    rows: [[84_610, 12.4, 3.1], [84_611, 0, 7.75]], ...over,
  });

  it("parses a complete piece with its rows ascending, on either provider", () => {
    expect(parseServerFrame(frame())).toEqual({
      type: "delta_profile", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL",
      request_id: 9, from_ts: 1_790_006_400_000, to_ts: 1_790_013_600_000, row_width: 1, complete: true, reason: null, retry_after_ms: null, pending: 3,
      rows: [[84_610, 12.4, 3.1], [84_611, 0, 7.75]],
    });
    const { marketKind: _marketKind, ...binance } = frame();
    expect(parseServerFrame({ ...binance, symbol: "/NQZ26:XCME", provider: "DXFEED", assetClass: "FUTURE", row_width: 0.25, rows: [] }))
      .toMatchObject({ symbol: "/NQZ26:XCME", provider: "DXFEED", assetClass: "FUTURE", row_width: 0.25, rows: [] });
  });

  it("carries the reason of an incomplete piece, and only a known one, with no rows", () => {
    for (const reason of DELTA_PROFILE_REASONS) {
      expect(parseServerFrame(frame({ complete: false, reason, rows: [] }))).toMatchObject({ complete: false, reason });
    }
    expect(parseServerFrame(frame({ complete: false, reason: null, rows: [] }))).toBeNull();
    expect(parseServerFrame(frame({ complete: false, reason: "NOPE", rows: [] }))).toBeNull();
    expect(parseServerFrame(frame({ complete: true, reason: "READ_FAILED" }))).toBeNull();
    expect(parseServerFrame(frame({ complete: false, reason: "READ_FAILED" }))).toBeNull();
    expect(parseServerFrame(frame({ complete: false, reason: "OVERLOADED", retry_after_ms: 5, rows: [] }))).toMatchObject({ retry_after_ms: 5 });
    expect(parseServerFrame(frame({ complete: false, reason: "READ_FAILED", retry_after_ms: 5, rows: [] }))).toBeNull();
    expect(parseServerFrame(frame({ retry_after_ms: 5 }))).toBeNull();
  });

  it("refuses an extra or missing field, bad numbers, a bad row, a non-ascending price, a volume off the ceiling, too many rows", () => {
    expect(parseServerFrame({ ...frame(), next_cursor: null })).toBeNull();
    const { pending: _pending, ...missing } = frame();
    expect(parseServerFrame(missing)).toBeNull();
    expect(parseServerFrame(frame({ request_id: -1 }))).toBeNull();
    expect(parseServerFrame(frame({ to_ts: 1_790_006_400_000 }))).toBeNull();
    expect(parseServerFrame(frame({ row_width: 0 }))).toBeNull();
    expect(parseServerFrame(frame({ pending: 1.5 }))).toBeNull();
    expect(parseServerFrame(frame({ rows: [[84_610, 1]] }))).toBeNull();
    expect(parseServerFrame(frame({ rows: [[0, 1, 1]] }))).toBeNull();
    expect(parseServerFrame(frame({ rows: [[2, 1, 1], [2, 1, 1]] }))).toBeNull();
    expect(parseServerFrame(frame({ rows: [[1, -1, 1]] }))).toBeNull();
    expect(parseServerFrame(frame({ rows: [[1, 1, 1e13]] }))).toBeNull();
    expect(parseServerFrame(frame({ rows: [[1, "1", 1]] }))).toBeNull();
    expect(parseServerFrame(frame({ rows: Array.from({ length: MAX_DELTA_PROFILE_ROWS + 1 }, (_unused, i) => [i + 1, 0, 0]) }))).toBeNull();
    expect(parseServerFrame(frame({ rows: Array.from({ length: MAX_DELTA_PROFILE_ROWS }, (_unused, i) => [i + 1, 0, 0]) }))).not.toBeNull();
  });
});
