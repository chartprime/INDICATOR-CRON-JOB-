import catalog from "../../../../config/market-instruments.json";
import { INSTRUMENTS } from "../lib/chart/instruments";
import { describe, expect, it } from "vitest";
import {
  isBarFrame,
  isBookFrame,
  isHealthFrame,
  isMarkerFrame,
  isProfileFrame,
  isSelectionFrame,
  isSnapshotFrame,
  isTradeFrame,
  isVpinFrame,
  parseServerFrame,
} from "./frames";

const RAW_MARKER = {
  type: "marker",
  symbol: "BTC-USDT",
  provider: "BINANCE",
  marketKind: "SPOT",
  ts_exchange: 1,
  price: 100,
  size: 5,
  side: "buy",
  trade_id: "m1",
};

describe("parseServerFrame", () => {
  it("accepts the recorded equity size on trades, markers and history, but not on prices or futures", () => {
    const raw = {
      type: "trade",
      provider: "DXFEED",
      symbol: "NVDA",
      assetClass: "EQUITY",
      ts_exchange: 1790366400407,
      price: 225.07,
      size: 12140109,
      side: "buy",
      trade_id: "close-print",
    };
    expect(parseServerFrame(raw)).toEqual(raw);
    expect(parseServerFrame({ ...raw, type: "marker" })).not.toBeNull();
    expect(parseServerFrame({ ...raw, size: 1_000_000_000_001 })).toBeNull();
    expect(parseServerFrame({ ...raw, price: 10_000_001 })).toBeNull();
    expect(
      parseServerFrame({ ...raw, symbol: "ESZ26", assetClass: "FUTURE" }),
    ).toBeNull();
    const history = {
      type: "marker_history",
      provider: "DXFEED",
      symbol: "NVDA",
      assetClass: "EQUITY",
      reset: true,
      seq: 0,
      rows: [[raw.ts_exchange, raw.price, raw.size, "b", raw.trade_id]],
    };
    expect(parseServerFrame(history)).not.toBeNull();
    expect(
      parseServerFrame({ ...history, symbol: "ESZ26", assetClass: "FUTURE" }),
    ).toBeNull();
  });
  it.each([
    { provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT" },
    { provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" },
  ])(
    "validates analytics availability independently of transport health: $provider",
    (identity) => {
      const raw = {
        type: "analytics_status",
        ...identity,
        indicator: "PROFILE",
        status: "UNAVAILABLE",
      };
      expect(parseServerFrame(raw)).toEqual(raw);
      for (const status of ["CLOSED", "EMPTY", "WARMING", "READY"]) {
        expect(parseServerFrame({ ...raw, status })).toEqual({
          ...raw,
          status,
        });
      }
      expect(
        parseServerFrame({ ...raw, indicator: "VPIN", status: "READY" }),
      ).not.toBeNull();
      expect(parseServerFrame({ ...raw, indicator: "BOOK" })).toBeNull();
      expect(parseServerFrame({ ...raw, status: "COMPLETE" })).toBeNull();
      expect(parseServerFrame({ ...raw, extra: true })).toBeNull();
      expect(
        parseServerFrame({ ...raw, marketKind: "SPOT", assetClass: "EQUITY" }),
      ).toBeNull();
    },
  );
  it("accepts a well-formed trade frame", () => {
    const raw = {
      type: "trade",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      ts_exchange: 1,
      price: 100,
      size: 1,
      side: "buy",
      trade_id: "1",
    };
    const frame = parseServerFrame(raw);
    expect(frame).not.toBeNull();
    expect(frame && isTradeFrame(frame)).toBe(true);
  });

  it("rejects control characters in trade identifiers before they reach logs, keys, or chart state", () => {
    const raw = {
      type: "trade",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      ts_exchange: 1,
      price: 100,
      size: 1,
      side: "buy",
      trade_id: "safe\nforged",
    };
    expect(parseServerFrame(raw)).toBeNull();
    expect(
      parseServerFrame({ ...RAW_MARKER, trade_id: "marker\u0000id" }),
    ).toBeNull();
  });

  it("accepts a well-formed marker frame", () => {
    const frame = parseServerFrame(RAW_MARKER);
    expect(frame).not.toBeNull();
    expect(frame && isMarkerFrame(frame) && frame.trade_id).toBe("m1");
  });

  it("rejects a marker frame with a negative price", () => {
    expect(parseServerFrame({ ...RAW_MARKER, price: -1 })).toBeNull();
  });

  it("accepts a marker frame carrying the optional baseline fields", () => {
    const frame = parseServerFrame({
      ...RAW_MARKER,
      baseline_log_median: 4.2,
      baseline_log_mad: 0.3,
    });
    expect(
      frame && isMarkerFrame(frame) ? frame.baseline_log_median : undefined,
    ).toBe(4.2);
    expect(
      frame && isMarkerFrame(frame) ? frame.baseline_log_mad : undefined,
    ).toBe(0.3);
  });

  it("accepts a marker frame with neither baseline field, omitting them rather than defaulting to null", () => {
    const frame = parseServerFrame(RAW_MARKER);
    expect(
      frame &&
        isMarkerFrame(frame) &&
        Object.hasOwn(frame, "baseline_log_median"),
    ).toBe(false);
  });

  it("rejects a marker frame carrying only one of the two baseline fields -- they arrive together or not at all", () => {
    expect(
      parseServerFrame({ ...RAW_MARKER, baseline_log_median: 4.2 }),
    ).toBeNull();
    expect(
      parseServerFrame({ ...RAW_MARKER, baseline_log_mad: 0.3 }),
    ).toBeNull();
  });

  it("rejects a marker frame with a negative baseline_log_mad -- a deviation can't be negative", () => {
    expect(
      parseServerFrame({
        ...RAW_MARKER,
        baseline_log_median: 4.2,
        baseline_log_mad: -0.1,
      }),
    ).toBeNull();
  });

  it("accepts a negative baseline_log_median -- log of a sub-1 magnitude is legitimately negative", () => {
    const frame = parseServerFrame({
      ...RAW_MARKER,
      baseline_log_median: -0.5,
      baseline_log_mad: 0.2,
    });
    expect(
      frame && isMarkerFrame(frame) ? frame.baseline_log_median : undefined,
    ).toBe(-0.5);
  });

  it("accepts a marker far older than the live-frame age ceiling -- markers are a permanent historical record, not a live-only concept", () => {
    const nowMs = 1_800_000_000_000;
    const ancientMarker = {
      ...RAW_MARKER,
      ts_exchange: nowMs - 365 * 24 * 60 * 60 * 1000,
    };
    expect(parseServerFrame(ancientMarker, { nowMs })).not.toBeNull();
  });

  it("still rejects a marker timestamped too far in the future -- the future-skew clock-sanity guard still applies", () => {
    const nowMs = 1_800_000_000_000;
    const futureMarker = { ...RAW_MARKER, ts_exchange: nowMs + 10 * 60 * 1000 };
    expect(parseServerFrame(futureMarker, { nowMs })).toBeNull();
  });

  it("rejects a trade frame with no marketKind -- ambiguous between SPOT and PERPETUAL once both can be selected", () => {
    const raw = {
      type: "trade",
      symbol: "BTC-USDT",
      ts_exchange: 1,
      price: 100,
      size: 1,
      side: "buy",
      trade_id: "1",
    };
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("rejects a trade frame with an unrecognized marketKind", () => {
    const raw = {
      type: "trade",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "MARGIN",
      ts_exchange: 1,
      price: 100,
      size: 1,
      side: "buy",
      trade_id: "1",
    };
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("rejects mixed provider identities even when the selected branch is otherwise valid", () => {
    const common = {
      type: "trade",
      ts_exchange: 1,
      price: 100,
      size: 1,
      side: "buy",
      trade_id: "1",
    };
    expect(
      parseServerFrame({
        ...common,
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        assetClass: "EQUITY",
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        ...common,
        symbol: "AAPL",
        provider: "DXFEED",
        assetClass: "EQUITY",
        marketKind: "SPOT",
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        ...common,
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        assetClass: undefined,
      }),
    ).toBeNull();
  });

  it("accepts a well-formed bar frame", () => {
    const raw = {
      type: "bar",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      interval_ms: 60000,
      ts_open: 0,
      open: 1,
      high: 2,
      low: 1,
      close: 1,
      volume: 1,
      trade_count: 1,
      closed: true,
    };
    const frame = parseServerFrame(raw);
    expect(frame && isBarFrame(frame)).toBe(true);
  });

  it("rejects a syntactically valid far-future bar when the live worker supplies its clock", () => {
    const nowMs = 1_800_000_000_000;
    const raw = {
      type: "bar",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      interval_ms: 60000,
      ts_open: nowMs + 180_000,
      open: 1,
      high: 2,
      low: 1,
      close: 1,
      volume: 1,
      trade_count: 1,
      closed: true,
    };
    expect(parseServerFrame(raw, { nowMs })).toBeNull();
  });

  it("accepts a bar frame for PERPETUAL, not just SPOT", () => {
    const raw = {
      type: "bar",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "PERPETUAL",
      interval_ms: 60000,
      ts_open: 0,
      open: 1,
      high: 2,
      low: 1,
      close: 1,
      volume: 1,
      trade_count: 1,
      closed: true,
    };
    const frame = parseServerFrame(raw);
    expect(
      frame &&
        isBarFrame(frame) &&
        frame.provider === "BINANCE" &&
        frame.marketKind,
    ).toBe("PERPETUAL");
  });

  it("accepts a bar frame with buy_volume present", () => {
    const raw = {
      type: "bar",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      interval_ms: 60000,
      ts_open: 0,
      open: 1,
      high: 2,
      low: 1,
      close: 1,
      volume: 10,
      buy_volume: 6,
      trade_count: 1,
      closed: true,
    };
    const frame = parseServerFrame(raw);
    expect(frame && isBarFrame(frame) && frame.buy_volume).toBe(6);
  });

  it("accepts a bar frame with buy_volume omitted -- pre-migration history has no taker-buy data", () => {
    const raw = {
      type: "bar",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      interval_ms: 60000,
      ts_open: 0,
      open: 1,
      high: 2,
      low: 1,
      close: 1,
      volume: 10,
      trade_count: 1,
      closed: true,
    };
    const frame = parseServerFrame(raw);
    expect(frame && isBarFrame(frame)).toBe(true);
    expect(frame && "buy_volume" in frame).toBe(false);
  });

  it("accepts buy_volume exactly equal to volume -- the all-buy boundary", () => {
    const raw = {
      type: "bar",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      interval_ms: 60000,
      ts_open: 0,
      open: 1,
      high: 2,
      low: 1,
      close: 1,
      volume: 10,
      buy_volume: 10,
      trade_count: 1,
      closed: true,
    };
    expect(parseServerFrame(raw)).not.toBeNull();
  });

  it("accepts institutional equity share volume above the generic magnitude ceiling", () => {
    const raw = {
      type: "bar",
      symbol: "/NQU26:XCME",
      provider: "DXFEED",
      assetClass: "FUTURE",
      interval_ms: 60000,
      ts_open: 0,
      open: 340,
      high: 341,
      low: 339,
      close: 340.5,
      volume: 25_000_000,
      buy_volume: 12_000_000,
      trade_count: 100_000,
      closed: true,
    };
    expect(parseServerFrame(raw)).not.toBeNull();
  });

  it("rejects volume above the explicit bar-volume contract ceiling", () => {
    const raw = {
      type: "bar",
      symbol: "/NQU26:XCME",
      provider: "DXFEED",
      assetClass: "FUTURE",
      interval_ms: 60000,
      ts_open: 0,
      open: 340,
      high: 341,
      low: 339,
      close: 340.5,
      volume: 1_000_000_000_001,
      trade_count: 1,
      closed: true,
    };
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("rejects buy_volume greater than volume", () => {
    const raw = {
      type: "bar",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      interval_ms: 60000,
      ts_open: 0,
      open: 1,
      high: 2,
      low: 1,
      close: 1,
      volume: 10,
      buy_volume: 10.1,
      trade_count: 1,
      closed: true,
    };
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("rejects a negative buy_volume", () => {
    const raw = {
      type: "bar",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      interval_ms: 60000,
      ts_open: 0,
      open: 1,
      high: 2,
      low: 1,
      close: 1,
      volume: 10,
      buy_volume: -1,
      trade_count: 1,
      closed: true,
    };
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("accepts a bar frame with reconstructed: true -- a REST-backfilled bar, not genuinely captured", () => {
    const raw = {
      type: "bar",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      interval_ms: 60000,
      ts_open: 0,
      open: 1,
      high: 2,
      low: 1,
      close: 1,
      volume: 10,
      trade_count: 1,
      closed: true,
      reconstructed: true,
    };
    const frame = parseServerFrame(raw);
    expect(frame && isBarFrame(frame) && frame.reconstructed).toBe(true);
  });

  it("accepts a bar frame with reconstructed omitted -- a genuine live/stored bar carries no such flag", () => {
    const raw = {
      type: "bar",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      interval_ms: 60000,
      ts_open: 0,
      open: 1,
      high: 2,
      low: 1,
      close: 1,
      volume: 10,
      trade_count: 1,
      closed: true,
    };
    const frame = parseServerFrame(raw);
    expect(frame && isBarFrame(frame)).toBe(true);
    expect(frame && "reconstructed" in frame).toBe(false);
  });

  it("rejects a bar frame whose reconstructed field is present but not a boolean", () => {
    const raw = {
      type: "bar",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      interval_ms: 60000,
      ts_open: 0,
      open: 1,
      high: 2,
      low: 1,
      close: 1,
      volume: 10,
      trade_count: 1,
      closed: true,
      reconstructed: "yes",
    };
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("accepts a well-formed snapshot frame", () => {
    const raw = {
      type: "snapshot",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      bars: [],
      trades: [],
      markers: [],
    };
    const frame = parseServerFrame(raw);
    expect(frame && isSnapshotFrame(frame)).toBe(true);
  });

  it("preserves the observed-bar coverage disclosure and rejects a forged one", () => {
    const raw = {
      type: "snapshot",
      symbol: "AAPL",
      provider: "DXFEED",
      assetClass: "EQUITY",
      bars: [],
      trades: [],
      markers: [],
      bar_history: {
        availability: "AVAILABLE",
        requestedStartTsOpen: 1_800_000_000_000,
        earliestObservedTsOpen: 1_800_086_400_000,
        coverage: "START_NOT_COVERED",
        interpretation: "OBSERVED_NONEMPTY_BARS_ONLY",
      },
    };
    const frame = parseServerFrame(raw);
    expect(frame && isSnapshotFrame(frame) && frame.bar_history?.coverage).toBe(
      "START_NOT_COVERED",
    );
    expect(
      parseServerFrame({
        ...raw,
        bar_history: {
          ...raw.bar_history,
          interpretation: "FULL_CONTINUOUS_SERIES",
        },
      }),
    ).toBeNull();
  });

  it("rejects internally contradictory bar-history descriptors", () => {
    const base = {
      type: "snapshot",
      symbol: "AAPL",
      provider: "DXFEED",
      assetClass: "EQUITY",
      bars: [],
      trades: [],
      markers: [],
      bar_history: {
        availability: "AVAILABLE",
        requestedStartTsOpen: 1_000,
        earliestObservedTsOpen: 2_000,
        coverage: "START_NOT_COVERED",
        interpretation: "OBSERVED_NONEMPTY_BARS_ONLY",
      },
    };

    expect(
      parseServerFrame({
        ...base,
        bar_history: { ...base.bar_history, coverage: "NO_ROWS" },
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        ...base,
        bar_history: { ...base.bar_history, earliestObservedTsOpen: null },
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        ...base,
        bar_history: { ...base.bar_history, earliestObservedTsOpen: 999 },
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        ...base,
        bar_history: {
          ...base.bar_history,
          availability: "UNAVAILABLE",
          coverage: "START_NOT_COVERED",
        },
      }),
    ).toBeNull();
  });

  it("carries the server's pool of big prints, old as they are, and rejects a pool that is incomplete, mismatched or out of order", () => {
    const print = (id: string, ts: number) => ({
      type: "trade",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      trade_id: id,
      ts_exchange: ts,
      price: 80_000,
      size: 3,
      side: "buy",
    });
    const base = {
      type: "snapshot",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      bars: [],
      trades: [],
      markers: [],
    };
    const now = 1_800_000_000_000;
    const raw = {
      ...base,
      aggressive_prints: [
        print("a", now - 4 * 3_600_000),
        print("b", now - 1_000),
      ],
      aggressive_prints_floor: 2,
      aggressive_prints_from: now - 4 * 3_600_000,
    };
    const frame = parseServerFrame(raw, { nowMs: now });
    expect(
      frame && isSnapshotFrame(frame)
        ? frame.aggressive_prints?.map((t) => t.trade_id)
        : null,
    ).toEqual(["a", "b"]);
    expect(
      frame && isSnapshotFrame(frame)
        ? [frame.aggressive_prints_floor, frame.aggressive_prints_from]
        : null,
    ).toEqual([2, now - 4 * 3_600_000]);
    expect(
      parseServerFrame(
        { ...raw, aggressive_prints_floor: undefined },
        { nowMs: now },
      ),
    ).toBeNull();
    expect(
      parseServerFrame(
        { ...raw, aggressive_prints: [print("b", now), print("a", now - 1)] },
        { nowMs: now },
      ),
    ).toBeNull();
    expect(
      parseServerFrame(
        { ...raw, aggressive_prints: [print("a", now), print("a", now)] },
        { nowMs: now },
      ),
    ).toBeNull();
    expect(
      parseServerFrame(
        {
          ...raw,
          aggressive_prints: [{ ...print("a", now), marketKind: "PERPETUAL" }],
        },
        { nowMs: now },
      ),
    ).toBeNull();
    expect(
      parseServerFrame({ ...raw, aggressive_prints_floor: -1 }, { nowMs: now }),
    ).toBeNull();
    expect(
      parseServerFrame(
        {
          ...raw,
          aggressive_prints: Array.from({ length: 20_001 }, (_u, i) =>
            print(String(i), now),
          ),
        },
        { nowMs: now },
      ),
    ).toBeNull();
  });

  it("rejects a snapshot with no pair tag -- otherwise a double-switch cannot tell whose history it is", () => {
    expect(
      parseServerFrame({ type: "snapshot", bars: [], trades: [] }),
    ).toBeNull();
  });

  it("accepts a snapshot carrying real markers, rejects one with a mismatched pair, and rejects a duplicate trade_id", () => {
    const ok = parseServerFrame({
      type: "snapshot",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      bars: [],
      trades: [],
      markers: [RAW_MARKER],
    });
    expect(ok).not.toBeNull();
    expect(ok && isSnapshotFrame(ok) && ok.markers).toHaveLength(1);

    expect(
      parseServerFrame({
        type: "snapshot",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        bars: [],
        trades: [],
        markers: [{ ...RAW_MARKER, symbol: "ETH-USDT" }],
      }),
    ).toBeNull();

    expect(
      parseServerFrame({
        type: "snapshot",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        bars: [],
        trades: [],
        markers: [RAW_MARKER, RAW_MARKER],
      }),
    ).toBeNull();
  });

  it("accepts a well-formed health frame -- the new P3.01 fourth frame kind", () => {
    const raw = {
      type: "health",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      recoveryState: "READY",
      stale: false,
    };
    const frame = parseServerFrame(raw);
    expect(frame).not.toBeNull();
    expect(frame && isHealthFrame(frame)).toBe(true);
  });

  it("accepts a health frame carrying an optional reason", () => {
    const raw = {
      type: "health",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      recoveryState: "UNAVAILABLE",
      stale: true,
      reason: "CONNECTION_DOWN",
    };
    const frame = parseServerFrame(raw);
    expect(frame && isHealthFrame(frame) && frame.reason).toBe(
      "CONNECTION_DOWN",
    );
  });

  it("accepts a dxFeed health frame carrying the optional printsQuiet field -- market-quiet-vs-broken-connection signal", () => {
    const raw = {
      type: "health",
      symbol: "/NQU26:XCME",
      provider: "DXFEED",
      assetClass: "FUTURE",
      recoveryState: "RECOVERING",
      stale: true,
      printsQuiet: true,
    };
    const frame = parseServerFrame(raw);
    expect(frame && isHealthFrame(frame) && frame.printsQuiet).toBe(true);
  });

  it("a health frame with no printsQuiet key parses with it left undefined, not defaulted to false", () => {
    const raw = {
      type: "health",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      recoveryState: "READY",
      stale: false,
    };
    const frame = parseServerFrame(raw);
    expect(frame && isHealthFrame(frame) && frame.printsQuiet).toBeUndefined();
  });

  it("rejects a health frame whose printsQuiet is present but not a boolean", () => {
    const raw = {
      type: "health",
      symbol: "/NQU26:XCME",
      provider: "DXFEED",
      assetClass: "FUTURE",
      recoveryState: "READY",
      stale: false,
      printsQuiet: "true",
    };
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("accepts a Binance health frame carrying the collector's recording state -- a dead collector is not a broken feed", () => {
    const raw = {
      type: "health",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      recoveryState: "READY",
      stale: false,
      recordingStale: true,
      recordingLatestTs: 1_700_000_000_000,
    };
    const frame = parseServerFrame(raw);
    expect(frame && isHealthFrame(frame) && frame.recordingStale).toBe(true);
    expect(frame && isHealthFrame(frame) && frame.recordingLatestTs).toBe(
      1_700_000_000_000,
    );
    const withoutTs = parseServerFrame({
      ...raw,
      recordingLatestTs: undefined,
    });
    expect(
      withoutTs && isHealthFrame(withoutTs) && withoutTs.recordingLatestTs,
    ).toBeUndefined();
  });

  it("rejects a recording state that is not a boolean, a timestamp that is not a non-negative integer, or a timestamp with no flag beside it", () => {
    const base = {
      type: "health",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      recoveryState: "READY",
      stale: false,
    };
    expect(parseServerFrame({ ...base, recordingStale: "true" })).toBeNull();
    expect(
      parseServerFrame({
        ...base,
        recordingStale: true,
        recordingLatestTs: -1,
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        ...base,
        recordingStale: true,
        recordingLatestTs: 1.5,
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        ...base,
        recordingStale: true,
        recordingLatestTs: "5",
      }),
    ).toBeNull();
    expect(parseServerFrame({ ...base, recordingLatestTs: 5 })).toBeNull();
    // dxFeed frames never carry it.
    expect(
      parseServerFrame({
        type: "health",
        symbol: "/NQU26:XCME",
        provider: "DXFEED",
        assetClass: "FUTURE",
        recoveryState: "READY",
        stale: false,
        recordingStale: true,
      }),
    ).toBeNull();
  });

  it("rejects a health frame with no marketKind", () => {
    const raw = {
      type: "health",
      symbol: "BTC-USDT",
      recoveryState: "READY",
      stale: false,
    };
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("accepts a well-formed READY book frame -- the new P3.02 fifth frame kind", () => {
    const raw = {
      type: "book",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      status: "READY",
      bids: [{ price: 100, size: 1 }],
      asks: [{ price: 101, size: 2 }],
      lastUpdateId: 5,
      stale: false,
    };
    const frame = parseServerFrame(raw);
    expect(frame).not.toBeNull();
    expect(frame && isBookFrame(frame) && frame.bids).toEqual([
      { price: 100, size: 1 },
    ]);
    expect(frame && isBookFrame(frame) && frame.stale).toBe(false);
  });

  it("accepts a READY book frame marked stale -- a silent DEPTH feed must still parse, not be dropped", () => {
    const raw = {
      type: "book",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      status: "READY",
      bids: [{ price: 100, size: 1 }],
      asks: [{ price: 101, size: 2 }],
      lastUpdateId: 5,
      stale: true,
    };
    const frame = parseServerFrame(raw);
    expect(frame && isBookFrame(frame) && frame.stale).toBe(true);
  });

  it("accepts a well-formed UNAVAILABLE book frame carrying only a reason, no bids/asks/lastUpdateId", () => {
    const raw = {
      type: "book",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      status: "UNAVAILABLE",
      reason: "CONNECTION_DOWN",
    };
    const frame = parseServerFrame(raw);
    expect(frame && isBookFrame(frame) && frame.reason).toBe("CONNECTION_DOWN");
    expect(frame && isBookFrame(frame) && frame.bids).toBeUndefined();
  });

  it("rejects an UNAVAILABLE book frame with no reason", () => {
    expect(
      parseServerFrame({
        type: "book",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        status: "UNAVAILABLE",
      }),
    ).toBeNull();
  });

  it("rejects a book frame with no marketKind, READY or UNAVAILABLE alike", () => {
    expect(
      parseServerFrame({
        type: "book",
        symbol: "BTC-USDT",
        status: "UNAVAILABLE",
        reason: "CONNECTION_DOWN",
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        type: "book",
        symbol: "BTC-USDT",
        status: "READY",
        bids: [],
        asks: [],
        lastUpdateId: 5,
        stale: false,
      }),
    ).toBeNull();
  });

  it("rejects a READY book frame with a malformed level -- a partial level would crash the DOM panel", () => {
    const raw = {
      type: "book",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      status: "READY",
      bids: [{ price: 100 }],
      asks: [],
      lastUpdateId: 5,
      stale: false,
    };
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("rejects a READY book frame with no stale bit -- omitting it would paint a silent book as live", () => {
    const raw = {
      type: "book",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      status: "READY",
      bids: [],
      asks: [],
      lastUpdateId: 5,
    };
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("rejects unsorted, duplicate, or crossed book levels before they reach the DOM ladder", () => {
    const base = {
      type: "book",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      status: "READY",
      lastUpdateId: 5,
      stale: false,
    };
    expect(
      parseServerFrame({
        ...base,
        bids: [
          { price: 99, size: 1 },
          { price: 100, size: 1 },
        ],
        asks: [],
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        ...base,
        bids: [],
        asks: [
          { price: 101, size: 1 },
          { price: 101, size: 2 },
        ],
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        ...base,
        bids: [{ price: 101, size: 1 }],
        asks: [{ price: 100, size: 1 }],
      }),
    ).toBeNull();
  });

  it("accepts a well-formed selection frame -- the new P3.03 sixth frame kind, announcing the server's active pair", () => {
    const raw = {
      type: "selection",
      symbol: "ETH-USDT",
      provider: "BINANCE",
      marketKind: "PERPETUAL",
    };
    const frame = parseServerFrame(raw);
    expect(frame).not.toBeNull();
    expect(frame && isSelectionFrame(frame) && frame.symbol).toBe("ETH-USDT");
    expect(
      frame &&
        isSelectionFrame(frame) &&
        frame.provider === "BINANCE" &&
        frame.marketKind,
    ).toBe("PERPETUAL");
  });

  it("rejects a selection frame missing symbol or marketKind", () => {
    expect(
      parseServerFrame({
        type: "selection",
        provider: "BINANCE",
        marketKind: "SPOT",
      }),
    ).toBeNull();
    expect(
      parseServerFrame({ type: "selection", symbol: "BTC-USDT" }),
    ).toBeNull();
    expect(
      parseServerFrame({
        type: "selection",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "MARGIN",
      }),
    ).toBeNull();
  });

  it("rejects null, non-objects, and objects without a type", () => {
    expect(parseServerFrame(null)).toBeNull();
    expect(parseServerFrame("trade")).toBeNull();
    expect(parseServerFrame(42)).toBeNull();
    expect(parseServerFrame({})).toBeNull();
  });

  it("rejects an unrecognized type value", () => {
    expect(parseServerFrame({ type: "book_delta" })).toBeNull();
  });

  it("rejects a trade/bar/health object that only has type -- a partial frame would crash toFixed in the tape", () => {
    expect(parseServerFrame({ type: "trade" })).toBeNull();
    expect(parseServerFrame({ type: "bar", symbol: "BTC-USDT" })).toBeNull();
    expect(parseServerFrame({ type: "health", symbol: "BTC-USDT" })).toBeNull();
    expect(
      parseServerFrame({
        type: "snapshot",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        bars: [{ type: "bar" }],
        trades: [],
        markers: [],
      }),
    ).toBeNull();
  });

  it("rejects impossible numeric market data and unsupported symbols before it reaches a renderer", () => {
    expect(
      parseServerFrame({
        type: "trade",
        symbol: "SOL-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        ts_exchange: 1,
        price: 100,
        size: 1,
        side: "buy",
        trade_id: "1",
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        type: "trade",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        ts_exchange: 1.5,
        price: 100,
        size: 1,
        side: "buy",
        trade_id: "1",
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        type: "trade",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        ts_exchange: 1,
        price: 0,
        size: 1,
        side: "buy",
        trade_id: "1",
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        type: "bar",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        interval_ms: 300_000,
        ts_open: 0,
        open: 100,
        high: 99,
        low: 98,
        close: 100,
        volume: 1,
        trade_count: 1,
        closed: true,
      }),
    ).toBeNull();
  });

  it("rejects an incoherent or oversized snapshot rather than passing an unbounded payload to the chart", () => {
    const bar = {
      type: "bar",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      interval_ms: 60_000,
      ts_open: 0,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
      trade_count: 1,
      closed: true,
    };
    expect(
      parseServerFrame({
        type: "snapshot",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        bars: [bar, bar],
        trades: [],
        markers: [],
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        type: "snapshot",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        bars: [{ ...bar, symbol: "ETH-USDT" }],
        trades: [],
        markers: [],
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        type: "snapshot",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        bars: Array.from({ length: 10_081 }, () => bar),
        trades: [],
        markers: [],
      }),
    ).toBeNull();
  });

  it("accepts the inline snapshot marker cap exactly and rejects one more: the rest of the history arrives as marker_history pages", () => {
    const markers = Array.from({ length: 5_001 }, (_, index) => ({
      ...RAW_MARKER,
      trade_id: `marker-${index}`,
    }));
    const snapshot = {
      type: "snapshot",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      bars: [],
      trades: [],
      markers,
    };
    const frame = parseServerFrame({
      ...snapshot,
      markers: markers.slice(0, 5_000),
    });
    expect(frame && isSnapshotFrame(frame) && frame.markers).toHaveLength(
      5_000,
    );
    expect(parseServerFrame(snapshot)).toBeNull();
  });

  it("parses a marker_history page into marker frames, and rejects a malformed or oversized one", () => {
    const rows = Array.from({ length: 5_000 }, (_, index) => [
      1_000 + index,
      100,
      2,
      index % 2 ? "b" : "s",
      `page-${index}`,
    ]);
    const page = {
      type: "marker_history",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      reset: true,
      seq: 0,
      rows,
    };
    const parsed = parseServerFrame(page);
    expect(parsed?.type).toBe("marker_history");
    if (parsed?.type !== "marker_history") return;
    expect(parsed.markers).toHaveLength(5_000);
    expect(parsed.markers[1]).toEqual({
      type: "marker",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      ts_exchange: 1_001,
      price: 100,
      size: 2,
      side: "buy",
      trade_id: "page-1",
    });
    expect(
      parseServerFrame({
        ...page,
        rows: [...rows, [6_000, 100, 2, "b", "one-too-many"]],
      }),
    ).toBeNull();
    expect(
      parseServerFrame({ ...page, rows: [[1, 100, 2, "buy", "long-side"]] }),
    ).toBeNull();
    expect(
      parseServerFrame({
        ...page,
        rows: [
          [2, 100, 2, "b", "later"],
          [1, 100, 2, "b", "earlier"],
        ],
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        ...page,
        rows: [
          [1, 100, 2, "b", "dup"],
          [2, 100, 2, "s", "dup"],
        ],
      }),
    ).toBeNull();
    expect(
      parseServerFrame({ ...page, rows: [[1, 0, 2, "b", "zero-price"]] }),
    ).toBeNull();
    expect(parseServerFrame({ ...page, seq: -1 })).toBeNull();
    expect(parseServerFrame({ ...page, reset: "yes" })).toBeNull();
    expect(parseServerFrame({ ...page, extra: 1 })).toBeNull();
    expect(parseServerFrame({ ...page, rows: [] })?.type).toBe(
      "marker_history",
    );
  });

  it("rejects duplicate snapshot trade IDs and nested records whose declared type is wrong", () => {
    const trade = {
      type: "trade",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      ts_exchange: 1,
      price: 100,
      size: 1,
      side: "buy",
      trade_id: "same-id",
    };
    const bar = {
      type: "bar",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      interval_ms: 60_000,
      ts_open: 0,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
      trade_count: 1,
      closed: true,
    };
    expect(
      parseServerFrame({
        type: "snapshot",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        bars: [],
        trades: [trade, trade],
        markers: [],
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        type: "snapshot",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        bars: [{ ...bar, type: "trade" }],
        trades: [],
        markers: [],
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        type: "snapshot",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        bars: [],
        trades: [{ ...trade, type: "bar" }],
        markers: [],
      }),
    ).toBeNull();
  });

  it("rejects timestamps outside JavaScript's representable Date range", () => {
    expect(
      parseServerFrame({
        type: "trade",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        ts_exchange: 8_640_000_000_000_001,
        price: 100,
        size: 1,
        side: "buy",
        trade_id: "1",
      }),
    ).toBeNull();
  });

  it("requires every non-ready health state to be stale", () => {
    expect(
      parseServerFrame({
        type: "health",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        recoveryState: "RECOVERING",
        stale: false,
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        type: "health",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        recoveryState: "UNAVAILABLE",
        stale: false,
      }),
    ).toBeNull();
  });

  it("rejects unsafe book levels and a malformed optional health reason", () => {
    expect(
      parseServerFrame({
        type: "book",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        status: "READY",
        bids: [{ price: 100, size: 0 }],
        asks: [],
        lastUpdateId: 5,
        stale: false,
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        type: "book",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        status: "READY",
        bids: Array.from({ length: 21 }, () => ({ price: 100, size: 1 })),
        asks: [],
        lastUpdateId: 5,
        stale: false,
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        type: "health",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        recoveryState: "READY",
        stale: false,
        reason: " ",
      }),
    ).toBeNull();
  });

  it("rejects a finite but absurdly large numeric field -- shape/sign alone doesn't stop a corrupted magnitude from reaching the chart", () => {
    expect(
      parseServerFrame({
        type: "trade",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        ts_exchange: 1,
        price: 1e20,
        size: 1,
        side: "buy",
        trade_id: "1",
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        type: "trade",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        ts_exchange: 1,
        price: 100,
        size: 1e20,
        side: "buy",
        trade_id: "1",
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        type: "bar",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        interval_ms: 60_000,
        ts_open: 0,
        open: 1e20,
        high: 1e20,
        low: 1e20,
        close: 1e20,
        volume: 1,
        trade_count: 1,
        closed: true,
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        type: "bar",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        interval_ms: 60_000,
        ts_open: 0,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1e20,
        trade_count: 1,
        closed: true,
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        type: "book",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        status: "READY",
        bids: [{ price: 1e20, size: 1 }],
        asks: [],
        lastUpdateId: 5,
        stale: false,
      }),
    ).toBeNull();
  });
});

describe("parseServerFrame -- dxFeed provider (DX3.01)", () => {
  it("accepts a well-formed dxFeed trade frame for a futures symbol", () => {
    const raw = {
      type: "trade",
      symbol: "/NQU26:XCME",
      provider: "DXFEED",
      assetClass: "FUTURE",
      ts_exchange: 1,
      price: 100,
      size: 1,
      side: "buy",
      trade_id: "1",
    };
    const frame = parseServerFrame(raw);
    expect(frame).not.toBeNull();
    expect(frame && isTradeFrame(frame)).toBe(true);
  });

  it("accepts a well-formed dxFeed trade frame for an equity symbol", () => {
    const raw = {
      type: "trade",
      symbol: "AAPL",
      provider: "DXFEED",
      assetClass: "EQUITY",
      ts_exchange: 1,
      price: 100,
      size: 1,
      side: "buy",
      trade_id: "1",
    };
    const frame = parseServerFrame(raw);
    expect(frame).not.toBeNull();
  });

  it("rejects a dxFeed futures symbol whose root is not on the allowlist", () => {
    const raw = {
      type: "trade",
      symbol: "/CLU26:XNYM",
      provider: "DXFEED",
      assetClass: "FUTURE",
      ts_exchange: 1,
      price: 100,
      size: 1,
      side: "buy",
      trade_id: "1",
    };
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("rejects a dxFeed frame with no assetClass -- ambiguous between FUTURE and EQUITY", () => {
    const raw = {
      type: "trade",
      symbol: "AAPL",
      provider: "DXFEED",
      ts_exchange: 1,
      price: 100,
      size: 1,
      side: "buy",
      trade_id: "1",
    };
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("rejects a real dxFeed symbol spoofing provider BINANCE", () => {
    const raw = {
      type: "trade",
      symbol: "/NQU26:XCME",
      provider: "BINANCE",
      marketKind: "SPOT",
      ts_exchange: 1,
      price: 100,
      size: 1,
      side: "buy",
      trade_id: "1",
    };
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("rejects a real Binance symbol spoofing provider DXFEED", () => {
    const raw = {
      type: "trade",
      symbol: "BTC-USDT",
      provider: "DXFEED",
      assetClass: "EQUITY",
      ts_exchange: 1,
      price: 100,
      size: 1,
      side: "buy",
      trade_id: "1",
    };
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("accepts a well-formed dxFeed selection frame", () => {
    const raw = {
      type: "selection",
      symbol: "AAPL",
      provider: "DXFEED",
      assetClass: "EQUITY",
    };
    const frame = parseServerFrame(raw);
    expect(frame).not.toBeNull();
    expect(
      frame &&
        isSelectionFrame(frame) &&
        frame.provider === "DXFEED" &&
        frame.assetClass,
    ).toBe("EQUITY");
  });

  it("accepts a dxFeed snapshot whose nested trade shares the outer identity", () => {
    const raw = {
      type: "snapshot",
      symbol: "AAPL",
      provider: "DXFEED",
      assetClass: "EQUITY",
      bars: [],
      markers: [],
      trades: [
        {
          type: "trade",
          symbol: "AAPL",
          provider: "DXFEED",
          assetClass: "EQUITY",
          ts_exchange: 1,
          price: 100,
          size: 1,
          side: "buy",
          trade_id: "1",
        },
      ],
    };
    const frame = parseServerFrame(raw);
    expect(frame).not.toBeNull();
    expect(frame && isSnapshotFrame(frame) && frame.trades).toHaveLength(1);
  });

  it("rejects a dxFeed snapshot whose nested trade claims a different provider than the outer frame", () => {
    const raw = {
      type: "snapshot",
      symbol: "AAPL",
      provider: "DXFEED",
      assetClass: "EQUITY",
      bars: [],
      markers: [],
      trades: [
        {
          type: "trade",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          ts_exchange: 1,
          price: 100,
          size: 1,
          side: "buy",
          trade_id: "1",
        },
      ],
    };
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("accepts a well-formed READY dxFeed book frame and carries assetClass, not marketKind", () => {
    const raw = {
      type: "book",
      symbol: "AAPL",
      provider: "DXFEED",
      assetClass: "EQUITY",
      status: "READY",
      bids: [{ price: 100, size: 1 }],
      asks: [{ price: 101, size: 2 }],
      lastUpdateId: 5,
      stale: false,
    };
    const frame = parseServerFrame(raw);
    expect(frame).not.toBeNull();
    expect(
      frame &&
        isBookFrame(frame) &&
        frame.provider === "DXFEED" &&
        frame.assetClass,
    ).toBe("EQUITY");
    expect(frame && "marketKind" in frame).toBe(false);
  });

  it("accepts a well-formed UNAVAILABLE dxFeed book frame", () => {
    const raw = {
      type: "book",
      symbol: "/ESU26:XCME",
      provider: "DXFEED",
      assetClass: "FUTURE",
      status: "UNAVAILABLE",
      reason: "CONNECTION_DOWN",
    };
    const frame = parseServerFrame(raw);
    expect(frame).not.toBeNull();
    expect(frame && isBookFrame(frame) && frame.reason).toBe("CONNECTION_DOWN");
  });

  it.each(["ORDER_CAP_EXCEEDED", "ORDER_CAPTURE_ERROR"])(
    "preserves dxFeed L2 integrity reason %s",
    (reason) => {
      const frame = parseServerFrame({
        type: "book",
        symbol: "AAPL",
        provider: "DXFEED",
        assetClass: "EQUITY",
        status: "UNAVAILABLE",
        reason,
      });
      expect(frame && isBookFrame(frame) && frame.reason).toBe(reason);
    },
  );

  it("accepts a well-formed dxFeed health frame", () => {
    const raw = {
      type: "health",
      symbol: "AAPL",
      provider: "DXFEED",
      assetClass: "EQUITY",
      recoveryState: "READY",
      stale: false,
    };
    const frame = parseServerFrame(raw);
    expect(frame).not.toBeNull();
    expect(
      frame &&
        isHealthFrame(frame) &&
        frame.provider === "DXFEED" &&
        frame.assetClass,
    ).toBe("EQUITY");
  });

  it("accepts a well-formed dxFeed bar frame", () => {
    const raw = {
      type: "bar",
      symbol: "/NQU26:XCME",
      provider: "DXFEED",
      assetClass: "FUTURE",
      interval_ms: 60_000,
      ts_open: 0,
      open: 1,
      high: 2,
      low: 1,
      close: 1,
      volume: 1,
      trade_count: 1,
      closed: true,
    };
    const frame = parseServerFrame(raw);
    expect(frame).not.toBeNull();
    expect(
      frame &&
        isBarFrame(frame) &&
        frame.provider === "DXFEED" &&
        frame.assetClass,
    ).toBe("FUTURE");
  });
});

const RAW_PROFILE = {
  type: "profile",
  symbol: "BTC-USDT",
  provider: "BINANCE",
  marketKind: "SPOT",
  mode: "continuous",
  period_start_ts: 1000,
  period_end_ts: null,
  row_width: 1,
  delivery_scope: "LIVE",
  history_request_id: null,
  buckets: [
    {
      price: 100,
      volume: 5,
      buy_volume: 3,
      sell_volume: 2,
      single_print: false,
    },
    {
      price: 101,
      volume: 2,
      buy_volume: 2,
      sell_volume: 0,
      single_print: false,
    },
  ],
  poc_price: 100,
  vah_price: 100,
  val_price: 100,
};

describe("parseServerFrame -- profile frame (P4.09)", () => {
  it("accepts a well-formed, developing (open) profile frame", () => {
    const frame = parseServerFrame(RAW_PROFILE);
    expect(frame).not.toBeNull();
    expect(frame && isProfileFrame(frame) && frame.buckets.length).toBe(2);
  });

  it("accepts an equity row of tens of millions of shares and refuses one above the profile volume ceiling", () => {
    const busy = {
      ...RAW_PROFILE,
      buckets: [
        {
          price: 100,
          volume: 52_000_000,
          buy_volume: 30_000_000,
          sell_volume: 22_000_000,
          single_print: false,
        },
      ],
    };
    const frame = parseServerFrame(busy);
    expect(frame && isProfileFrame(frame) && frame.buckets[0].volume).toBe(
      52_000_000,
    );
    const absurd = {
      ...RAW_PROFILE,
      buckets: [
        {
          price: 100,
          volume: 2_000_000_000_000,
          buy_volume: 1,
          sell_volume: 0,
          single_print: false,
        },
      ],
    };
    expect(parseServerFrame(absurd)).toBeNull();
  });

  it("accepts a closed profile frame with a non-null period_end_ts", () => {
    const frame = parseServerFrame({ ...RAW_PROFILE, period_end_ts: 2000 });
    expect(frame).not.toBeNull();
    expect(frame && isProfileFrame(frame) && frame.period_end_ts).toBe(2000);
  });

  it("accepts a well-formed dxFeed profile frame", () => {
    const { marketKind: _marketKind, ...rest } = RAW_PROFILE;
    const raw = {
      ...rest,
      symbol: "/NQU26:XCME",
      provider: "DXFEED",
      assetClass: "FUTURE",
    };
    const frame = parseServerFrame(raw);
    expect(frame).not.toBeNull();
    expect(
      frame &&
        isProfileFrame(frame) &&
        frame.provider === "DXFEED" &&
        frame.assetClass,
    ).toBe("FUTURE");
  });

  it("preserves per-candle calculation mode on a historical delivery", () => {
    const frame = parseServerFrame({
      ...RAW_PROFILE,
      mode: "per_candle",
      delivery_scope: "HISTORICAL",
      history_request_id: 9,
      period_end_ts: 2000,
    });
    expect(frame).not.toBeNull();
    expect(frame && isProfileFrame(frame) && frame.mode).toBe("per_candle");
    expect(frame && isProfileFrame(frame) && frame.delivery_scope).toBe(
      "HISTORICAL",
    );
  });

  it("rejects history-delivery metadata that cannot prove its request generation", () => {
    expect(
      parseServerFrame({
        ...RAW_PROFILE,
        delivery_scope: "HISTORICAL",
        history_request_id: null,
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        ...RAW_PROFILE,
        delivery_scope: "LIVE",
        history_request_id: 1,
      }),
    ).toBeNull();
  });

  it("rejects an unrecognized mode", () => {
    expect(parseServerFrame({ ...RAW_PROFILE, mode: "bogus" })).toBeNull();
  });

  it("rejects periodEndTs preceding periodStartTs", () => {
    expect(
      parseServerFrame({
        ...RAW_PROFILE,
        period_start_ts: 2000,
        period_end_ts: 1000,
      }),
    ).toBeNull();
  });

  it("rejects an empty buckets array", () => {
    expect(parseServerFrame({ ...RAW_PROFILE, buckets: [] })).toBeNull();
  });

  it("rejects buckets not strictly ascending by price", () => {
    const raw = {
      ...RAW_PROFILE,
      buckets: [RAW_PROFILE.buckets[1], RAW_PROFILE.buckets[0]],
    };
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("rejects a bucket where buy_volume + sell_volume exceeds volume", () => {
    const raw = {
      ...RAW_PROFILE,
      buckets: [
        {
          price: 100,
          volume: 5,
          buy_volume: 4,
          sell_volume: 4,
          single_print: false,
        },
      ],
    };
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("rejects a bucket with a non-boolean single_print", () => {
    const raw = {
      ...RAW_PROFILE,
      buckets: [
        {
          price: 100,
          volume: 5,
          buy_volume: 3,
          sell_volume: 2,
          single_print: "no",
        },
      ],
    };
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("rejects a POC price that does not match any bucket's price", () => {
    expect(parseServerFrame({ ...RAW_PROFILE, poc_price: 999 })).toBeNull();
  });

  it("rejects a VAH or VAL price that does not match any bucket's price, even when nesting would otherwise hold", () => {
    const raw = {
      ...RAW_PROFILE,
      buckets: [
        {
          price: 100,
          volume: 1,
          buy_volume: 1,
          sell_volume: 0,
          single_print: false,
        },
        {
          price: 101,
          volume: 5,
          buy_volume: 5,
          sell_volume: 0,
          single_print: false,
        },
        {
          price: 102,
          volume: 1,
          buy_volume: 1,
          sell_volume: 0,
          single_print: false,
        },
      ],
      poc_price: 101,
      val_price: 101,
    };
    expect(parseServerFrame({ ...raw, vah_price: 105 })).toBeNull();
    expect(
      parseServerFrame({ ...raw, vah_price: 101, val_price: 95 }),
    ).toBeNull();
  });

  it("rejects a Value Area that does not nest around the POC", () => {
    const raw = {
      ...RAW_PROFILE,
      buckets: [
        {
          price: 100,
          volume: 1,
          buy_volume: 1,
          sell_volume: 0,
          single_print: false,
        },
        {
          price: 101,
          volume: 5,
          buy_volume: 5,
          sell_volume: 0,
          single_print: false,
        },
        {
          price: 102,
          volume: 1,
          buy_volume: 1,
          sell_volume: 0,
          single_print: false,
        },
      ],
      poc_price: 101,
      vah_price: 100,
      val_price: 100,
    };
    expect(parseServerFrame(raw)).toBeNull();
  });

  it("rejects more buckets than the wire cap allows", () => {
    // The cap was raised 1000 -> 4000 on 2026-09-28 alongside the bin-size
    // multiplier floor; the runtime contract test asserts this parser limit,
    // the engine constant and the frame schema all agree.
    const buckets = Array.from({ length: 4001 }, (_, i) => ({
      price: 100 + i,
      volume: 1,
      buy_volume: 1,
      sell_volume: 0,
      single_print: false,
    }));
    expect(
      parseServerFrame({
        ...RAW_PROFILE,
        buckets,
        poc_price: 100,
        vah_price: 100,
        val_price: 100,
      }),
    ).toBeNull();
  });

  it("accepts a profile right at the wire cap, so the 4000-bucket ceiling is inclusive", () => {
    const buckets = Array.from({ length: 4000 }, (_, i) => ({
      price: 100 + i,
      volume: 1,
      buy_volume: 1,
      sell_volume: 0,
      single_print: false,
    }));
    expect(
      parseServerFrame({
        ...RAW_PROFILE,
        buckets,
        poc_price: 100,
        vah_price: 100,
        val_price: 100,
      }),
    ).not.toBeNull();
  });

  it("rejects a row_width that is not a positive finite number", () => {
    expect(parseServerFrame({ ...RAW_PROFILE, row_width: 0 })).toBeNull();
    expect(parseServerFrame({ ...RAW_PROFILE, row_width: -1 })).toBeNull();
  });
});

const RAW_VPIN_ACTIVE = {
  type: "vpin",
  symbol: "BTC-USDT",
  provider: "BINANCE",
  marketKind: "SPOT",
  seal_ts: 1_000,
  active: true,
  direction: "buy",
  strength: 0.5,
  z_vpin: 1.2,
  z_velocity: 0.1,
  z_acceleration: 0.01,
  activated_at_ts: 900,
};

const RAW_VPIN_INACTIVE = {
  type: "vpin",
  symbol: "BTC-USDT",
  provider: "BINANCE",
  marketKind: "SPOT",
  seal_ts: 1_000,
  active: false,
  direction: null,
  strength: 0,
  z_vpin: null,
  z_velocity: null,
  z_acceleration: null,
  activated_at_ts: null,
};

describe("parseServerFrame -- vpin frame (P4.12)", () => {
  it("accepts a well-formed active vpin frame", () => {
    const frame = parseServerFrame(RAW_VPIN_ACTIVE);
    expect(frame).not.toBeNull();
    expect(frame && isVpinFrame(frame) && frame.direction).toBe("buy");
    expect(frame && isVpinFrame(frame) && frame.strength).toBe(0.5);
  });

  it("accepts a well-formed inactive vpin frame -- direction/strength/activated_at_ts all null/zero together", () => {
    const frame = parseServerFrame(RAW_VPIN_INACTIVE);
    expect(frame).not.toBeNull();
    expect(frame && isVpinFrame(frame) && frame.active).toBe(false);
  });

  it("accepts a well-formed dxFeed vpin frame", () => {
    const { marketKind: _marketKind, ...rest } = RAW_VPIN_ACTIVE;
    const raw = {
      ...rest,
      symbol: "/NQU26:XCME",
      provider: "DXFEED",
      assetClass: "FUTURE",
    };
    const frame = parseServerFrame(raw);
    expect(frame).not.toBeNull();
    expect(
      frame &&
        isVpinFrame(frame) &&
        frame.provider === "DXFEED" &&
        frame.assetClass,
    ).toBe("FUTURE");
  });

  it("rejects active with a null direction, and inactive with a non-null direction", () => {
    expect(
      parseServerFrame({ ...RAW_VPIN_ACTIVE, direction: null }),
    ).toBeNull();
    expect(
      parseServerFrame({ ...RAW_VPIN_INACTIVE, direction: "buy" }),
    ).toBeNull();
  });

  it("rejects active with zero strength, and inactive with non-zero strength", () => {
    expect(parseServerFrame({ ...RAW_VPIN_ACTIVE, strength: 0 })).toBeNull();
    expect(
      parseServerFrame({ ...RAW_VPIN_INACTIVE, strength: 0.1 }),
    ).toBeNull();
  });

  it("rejects a strength outside [0, 1]", () => {
    expect(parseServerFrame({ ...RAW_VPIN_ACTIVE, strength: 1.1 })).toBeNull();
    expect(parseServerFrame({ ...RAW_VPIN_ACTIVE, strength: -0.1 })).toBeNull();
  });

  it("rejects active with a null activated_at_ts, and inactive with a non-null activated_at_ts", () => {
    expect(
      parseServerFrame({ ...RAW_VPIN_ACTIVE, activated_at_ts: null }),
    ).toBeNull();
    expect(
      parseServerFrame({ ...RAW_VPIN_INACTIVE, activated_at_ts: 900 }),
    ).toBeNull();
  });

  it("rejects an activated_at_ts after seal_ts", () => {
    expect(
      parseServerFrame({ ...RAW_VPIN_ACTIVE, activated_at_ts: 1_001 }),
    ).toBeNull();
  });

  it("rejects a non-finite z_vpin/z_velocity/z_acceleration that isn't null", () => {
    expect(
      parseServerFrame({ ...RAW_VPIN_ACTIVE, z_vpin: Number.NaN }),
    ).toBeNull();
    expect(
      parseServerFrame({
        ...RAW_VPIN_ACTIVE,
        z_velocity: Number.POSITIVE_INFINITY,
      }),
    ).toBeNull();
    expect(
      parseServerFrame({ ...RAW_VPIN_ACTIVE, z_acceleration: "0.5" }),
    ).toBeNull();
  });

  it("rejects a direction other than buy/sell/null", () => {
    expect(
      parseServerFrame({ ...RAW_VPIN_ACTIVE, direction: "hold" }),
    ).toBeNull();
  });
});

describe("parseServerFrame -- snapshot vpin_readings (P4.12)", () => {
  const baseSnapshot = {
    type: "snapshot",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    bars: [],
    trades: [],
    markers: [],
  };

  it("accepts a Binance snapshot carrying vpin_readings -- not a dxFeed-only field like bar_history", () => {
    const {
      type: _t,
      symbol: _s,
      provider: _p,
      marketKind: _mk,
      ...reading
    } = RAW_VPIN_ACTIVE;
    const frame = parseServerFrame({
      ...baseSnapshot,
      vpin_readings: [reading],
    });
    expect(frame).not.toBeNull();
    expect(frame && isSnapshotFrame(frame) && frame.vpin_readings?.length).toBe(
      1,
    );
  });

  it("accepts only the explicit VPIN lifecycle statuses", () => {
    const ready = parseServerFrame({ ...baseSnapshot, vpin_status: "READY" });
    expect(ready && isSnapshotFrame(ready) && ready.vpin_status).toBe("READY");
    const disabled = parseServerFrame({
      ...baseSnapshot,
      vpin_status: "DISABLED",
    });
    expect(disabled && isSnapshotFrame(disabled) && disabled.vpin_status).toBe(
      "DISABLED",
    );
    expect(
      parseServerFrame({ ...baseSnapshot, vpin_status: "UNKNOWN" }),
    ).toBeNull();
  });

  it("accepts a dxFeed snapshot carrying vpin_readings", () => {
    const {
      type: _t,
      symbol: _s,
      provider: _p,
      marketKind: _mk,
      ...reading
    } = RAW_VPIN_ACTIVE;
    const frame = parseServerFrame({
      type: "snapshot",
      symbol: "/NQU26:XCME",
      provider: "DXFEED",
      assetClass: "FUTURE",
      bars: [],
      trades: [],
      markers: [],
      vpin_readings: [reading],
    });
    expect(frame).not.toBeNull();
    expect(frame && isSnapshotFrame(frame) && frame.vpin_readings?.length).toBe(
      1,
    );
  });

  it("accepts consecutive readings sharing the same seal_ts -- a real burst can seal more than one bucket in the same millisecond", () => {
    const {
      type: _t,
      symbol: _s,
      provider: _p,
      marketKind: _mk,
      ...reading
    } = RAW_VPIN_ACTIVE;
    const frame = parseServerFrame({
      ...baseSnapshot,
      vpin_readings: [reading, reading],
    });
    expect(frame).not.toBeNull();
  });

  it("rejects readings that go backward in time", () => {
    const {
      type: _t,
      symbol: _s,
      provider: _p,
      marketKind: _mk,
      ...reading
    } = RAW_VPIN_ACTIVE;
    const earlier = {
      ...reading,
      seal_ts: reading.seal_ts - 1,
      activated_at_ts: null,
      active: false,
      direction: null,
      strength: 0,
    };
    expect(
      parseServerFrame({ ...baseSnapshot, vpin_readings: [reading, earlier] }),
    ).toBeNull();
  });

  it("rejects a malformed reading inside the array", () => {
    const {
      type: _t,
      symbol: _s,
      provider: _p,
      marketKind: _mk,
      ...reading
    } = RAW_VPIN_ACTIVE;
    expect(
      parseServerFrame({
        ...baseSnapshot,
        vpin_readings: [{ ...reading, strength: 2 }],
      }),
    ).toBeNull();
  });

  it("omits vpin_readings from the parsed frame when absent from the wire", () => {
    const frame = parseServerFrame(baseSnapshot);
    expect(frame && isSnapshotFrame(frame) && "vpin_readings" in frame).toBe(
      false,
    );
  });
});

describe("parseServerFrame -- exact institutional wire contracts", () => {
  const exactFrames = [
    {
      type: "trade",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      ts_exchange: 1,
      price: 100,
      size: 1,
      side: "buy",
      trade_id: "t1",
    },
    RAW_MARKER,
    {
      type: "bar",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      interval_ms: 60_000,
      ts_open: 0,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 2,
      buy_volume: 1,
      trade_count: 2,
      closed: true,
    },
    {
      type: "snapshot",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      bars: [],
      trades: [],
      markers: [],
    },
    {
      type: "health",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      recoveryState: "READY",
      stale: false,
    },
    {
      type: "book",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      status: "READY",
      bids: [{ price: 99, size: 1 }],
      asks: [{ price: 101, size: 1 }],
      lastUpdateId: 1,
      stale: false,
    },
    {
      type: "selection",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
    },
    RAW_PROFILE,
    RAW_VPIN_ACTIVE,
  ];

  it.each(exactFrames)(
    "rejects a surplus top-level property on $type",
    (frame) => {
      expect(
        parseServerFrame({
          ...frame,
          unexpected: "must-not-cross-the-boundary",
        }),
      ).toBeNull();
    },
  );

  it("rejects surplus properties inside nested book, profile, snapshot, and history records", () => {
    const book = exactFrames[5] as Record<string, unknown>;
    expect(
      parseServerFrame({
        ...book,
        bids: [{ price: 99, size: 1, orderCount: 3 }],
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        ...RAW_PROFILE,
        buckets: [{ ...RAW_PROFILE.buckets[0], unexpected: true }],
      }),
    ).toBeNull();

    const nestedTrade = { ...exactFrames[0], unexpected: true };
    expect(
      parseServerFrame({
        type: "snapshot",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        bars: [],
        trades: [nestedTrade],
        markers: [],
      }),
    ).toBeNull();

    const history = {
      availability: "AVAILABLE",
      requestedStartTsOpen: 1_800_000_000_000,
      earliestObservedTsOpen: 1_800_086_400_000,
      coverage: "START_NOT_COVERED",
      interpretation: "OBSERVED_NONEMPTY_BARS_ONLY",
      unexpected: true,
    };
    expect(
      parseServerFrame({
        type: "snapshot",
        symbol: "AAPL",
        provider: "DXFEED",
        assetClass: "EQUITY",
        bars: [],
        trades: [],
        markers: [],
        bar_history: history,
      }),
    ).toBeNull();

    const {
      type: _t,
      symbol: _s,
      provider: _p,
      marketKind: _mk,
      ...reading
    } = RAW_VPIN_ACTIVE;
    expect(
      parseServerFrame({
        type: "snapshot",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        bars: [],
        trades: [],
        markers: [],
        vpin_readings: [{ ...reading, unexpected: true }],
      }),
    ).toBeNull();
  });

  it("enforces provider-specific optional fields", () => {
    expect(
      parseServerFrame({ ...exactFrames[4], printsQuiet: true }),
    ).toBeNull();
    expect(
      parseServerFrame({
        type: "bar",
        symbol: "/NQU26:XCME",
        provider: "DXFEED",
        assetClass: "FUTURE",
        interval_ms: 60_000,
        ts_open: 0,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 2,
        trade_count: 2,
        closed: true,
        reconstructed: true,
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        type: "snapshot",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        bars: [],
        trades: [],
        markers: [],
        bar_history: {
          availability: "UNAVAILABLE",
          requestedStartTsOpen: 0,
          coverage: "NO_ROWS",
          interpretation: "OBSERVED_NONEMPTY_BARS_ONLY",
        },
      }),
    ).toBeNull();
  });

  it("verifies bar-history coverage labels against the actual one-minute boundary", () => {
    const snapshot = {
      type: "snapshot",
      symbol: "AAPL",
      provider: "DXFEED",
      assetClass: "EQUITY",
      bars: [],
      trades: [],
      markers: [],
    };
    const history = {
      availability: "AVAILABLE",
      requestedStartTsOpen: 1_800_000_000_000,
      earliestObservedTsOpen: 1_800_000_060_000,
      coverage: "START_COVERED",
      interpretation: "OBSERVED_NONEMPTY_BARS_ONLY",
    };
    expect(parseServerFrame({ ...snapshot, bar_history: history })).toBeNull();
    expect(
      parseServerFrame({
        ...snapshot,
        bar_history: { ...history, coverage: "START_NOT_COVERED" },
      }),
    ).not.toBeNull();
  });
});

// A2.21 / L1L2-V2-059. The picker read config/market-instruments.json while
// this file kept its own hardcoded copy of the same allow-lists. Adding one
// catalog entry made the instrument selectable in the UI while every frame for
// it failed parseFrameIdentity -- a permanent reconnect loop, capped at the
// 15s backoff, triggered by an entry the app itself offered, with a
// console.warn as the only diagnostic. Both sides now read one source.
describe("frame validation is driven by the governed instrument catalog", () => {
  it("accepts every Binance symbol the catalog lists", () => {
    for (const entry of catalog.binance) {
      const frame = parseServerFrame({
        type: "selection",
        provider: "BINANCE",
        symbol: entry.symbol,
        marketKind: entry.marketKind,
      });
      expect(frame).not.toBeNull();
    }
  });

  it("accepts every dxFeed instrument the catalog lists, on its own asset class", () => {
    for (const entry of catalog.dxfeed) {
      const frame = parseServerFrame({
        type: "selection",
        provider: "DXFEED",
        symbol: entry.symbol,
        assetClass: entry.assetClass,
      });
      expect(frame).not.toBeNull();
    }
  });

  // The picker offers exactly what the catalog holds, so anything it can offer
  // must parse. This is the assertion that would have caught the loop.
  it("has no instrument the picker can offer that frame validation would reject", () => {
    const offered = INSTRUMENTS;
    expect(offered.length).toBeGreaterThan(0);
    for (const option of offered) {
      const frame = parseServerFrame({
        type: "selection",
        symbol: option.symbol,
        ...option.identity,
      });
      expect(frame).not.toBeNull();
    }
  });
});
