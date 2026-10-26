import { describe, expect, it } from "vitest";
import { DEFAULT_LIVE_DELTA_PROFILE_SETTINGS } from "../liveDeltaProfileSettings";
import { DAY_PIECE_MS, HISTORY_LIMIT_MS, ROLLING_SLICE_MS, VISIBLE_PIECE_MS, dayOpenFor, sessionWindowFor, visibleWindowFor, weekOpenFor, windowFor } from "../profileWindow";

const BTC = { provider: "BINANCE", marketKind: "PERPETUAL" } as const;
const NQ = { provider: "DXFEED", assetClass: "FUTURE" } as const;
const AAPL = { provider: "DXFEED", assetClass: "EQUITY" } as const;
const T = (iso: string) => Date.parse(iso);
const M1 = 60_000;
const M5 = 300_000;
const M15 = 900_000;
const H1 = 3_600_000;
const settings = (over: Partial<typeof DEFAULT_LIVE_DELTA_PROFILE_SETTINGS> = {}) => ({ ...DEFAULT_LIVE_DELTA_PROFILE_SETTINGS, ...over });

describe("dayOpenFor", () => {
  it("crypto opens at 00:00 UTC", () => {
    expect(dayOpenFor(BTC, T("2026-09-26T15:40:00Z"))).toBe(T("2026-09-26T00:00:00Z"));
    expect(dayOpenFor(BTC, T("2026-09-26T00:00:00Z"))).toBe(T("2026-09-26T00:00:00Z"));
  });

  it("futures open at 18:00 New York, the evening before while the day session runs, across the clock change", () => {
    expect(dayOpenFor(NQ, T("2026-09-25T14:00:00Z"))).toBe(T("2026-09-24T22:00:00Z"));
    expect(dayOpenFor(NQ, T("2026-09-25T22:00:00Z"))).toBe(T("2026-09-25T22:00:00Z"));
    expect(dayOpenFor(NQ, T("2026-09-25T21:59:00Z"))).toBe(T("2026-09-24T22:00:00Z"));
    expect(dayOpenFor(NQ, T("2026-12-10T14:00:00Z"))).toBe(T("2026-12-09T23:00:00Z"));
    expect(dayOpenFor(NQ, T("2026-11-01T14:00:00Z"))).toBe(T("2026-10-31T22:00:00Z"));
    expect(dayOpenFor(NQ, T("2026-03-08T14:00:00Z"))).toBe(T("2026-03-07T23:00:00Z"));
  });

  it("stocks open at New York midnight", () => {
    expect(dayOpenFor(AAPL, T("2026-09-25T14:00:00Z"))).toBe(T("2026-09-25T04:00:00Z"));
    expect(dayOpenFor(AAPL, T("2026-09-25T03:59:00Z"))).toBe(T("2026-09-24T04:00:00Z"));
  });
});

describe("weekOpenFor", () => {
  it("crypto opens on Monday 00:00 UTC", () => {
    expect(weekOpenFor(BTC, T("2026-09-26T15:40:00Z"))).toBe(T("2026-09-21T00:00:00Z"));
    expect(weekOpenFor(BTC, T("2026-09-21T00:00:00Z"))).toBe(T("2026-09-21T00:00:00Z"));
    expect(weekOpenFor(BTC, T("2026-09-20T23:59:00Z"))).toBe(T("2026-09-14T00:00:00Z"));
    expect(weekOpenFor(BTC, T("2026-09-27T12:00:00Z"))).toBe(T("2026-09-21T00:00:00Z"));
  });

  it("futures open on Sunday 18:00 New York, across the clock change", () => {
    expect(weekOpenFor(NQ, T("2026-09-25T14:00:00Z"))).toBe(T("2026-09-20T22:00:00Z"));
    expect(weekOpenFor(NQ, T("2026-09-20T22:00:00Z"))).toBe(T("2026-09-20T22:00:00Z"));
    expect(weekOpenFor(NQ, T("2026-09-20T21:59:00Z"))).toBe(T("2026-09-13T22:00:00Z"));
    expect(weekOpenFor(NQ, T("2026-11-04T14:00:00Z"))).toBe(T("2026-11-01T23:00:00Z"));
    expect(weekOpenFor(NQ, T("2026-11-01T22:30:00Z"))).toBe(T("2026-10-25T22:00:00Z"));
    expect(weekOpenFor(NQ, T("2026-11-01T23:00:00Z"))).toBe(T("2026-11-01T23:00:00Z"));
  });

  it("stocks open on Monday midnight New York", () => {
    expect(weekOpenFor(AAPL, T("2026-09-25T14:00:00Z"))).toBe(T("2026-09-21T04:00:00Z"));
    expect(weekOpenFor(AAPL, T("2026-09-21T03:59:00Z"))).toBe(T("2026-09-14T04:00:00Z"));
  });
});

describe("sessionWindowFor", () => {
  it("is the Killzones session the clock is in, with its close, on the New York clock", () => {
    expect(sessionWindowFor(T("2026-09-25T14:00:00Z"))).toEqual({ from: T("2026-09-25T13:30:00Z"), to: T("2026-09-25T15:00:00Z"), pieceMs: DAY_PIECE_MS, label: "NY AM" });
    expect(sessionWindowFor(T("2026-09-25T18:00:00Z"))).toEqual({ from: T("2026-09-25T17:30:00Z"), to: T("2026-09-25T20:00:00Z"), pieceMs: DAY_PIECE_MS, label: "NY PM" });
    expect(sessionWindowFor(T("2026-09-25T07:00:00Z"))).toMatchObject({ from: T("2026-09-25T06:00:00Z"), to: T("2026-09-25T09:00:00Z"), label: "London" });
    expect(sessionWindowFor(T("2026-09-26T01:00:00Z"))).toMatchObject({ from: T("2026-09-26T00:00:00Z"), to: T("2026-09-26T04:00:00Z"), label: "Asia" });
  });

  it("between sessions it is the last one that finished, frozen", () => {
    expect(sessionWindowFor(T("2026-09-25T16:00:00Z"))).toMatchObject({ from: T("2026-09-25T13:30:00Z"), to: T("2026-09-25T15:00:00Z"), label: "NY AM · frozen" });
    expect(sessionWindowFor(T("2026-09-25T12:00:00Z"))).toMatchObject({ from: T("2026-09-25T06:00:00Z"), to: T("2026-09-25T09:00:00Z"), label: "London · frozen" });
    expect(sessionWindowFor(T("2026-09-25T05:00:00Z"))).toMatchObject({ from: T("2026-09-25T00:00:00Z"), to: T("2026-09-25T04:00:00Z"), label: "Asia · frozen" });
    expect(sessionWindowFor(T("2026-09-25T22:00:00Z"))).toMatchObject({ from: T("2026-09-25T17:30:00Z"), to: T("2026-09-25T20:00:00Z"), label: "NY PM · frozen" });
    expect(sessionWindowFor(T("2026-09-25T15:00:00Z"))).toMatchObject({ label: "NY AM · frozen" });
  });
});

describe("visibleWindowFor", () => {
  const now = T("2026-09-26T15:40:30Z");

  it("is the candles on screen to the minute: open ended while the newest candle is in view, closed when the chart is back in history", () => {
    expect(visibleWindowFor({ fromMs: T("2026-09-26T13:12:20Z"), toMs: T("2026-09-26T15:40:00Z"), liveEdge: true }, now))
      .toEqual({ from: T("2026-09-26T13:12:00Z"), to: null, pieceMs: VISIBLE_PIECE_MS, label: "on screen" });
    expect(visibleWindowFor({ fromMs: T("2026-09-25T13:12:20Z"), toMs: T("2026-09-25T15:40:10Z"), liveEdge: false }, now))
      .toEqual({ from: T("2026-09-25T13:12:00Z"), to: T("2026-09-25T15:41:00Z"), pieceMs: VISIBLE_PIECE_MS, label: "on screen" });
    expect(visibleWindowFor({ fromMs: T("2026-09-25T13:12:00Z"), toMs: T("2026-09-25T13:12:00Z"), liveEdge: false }, now).to).toBe(T("2026-09-25T13:13:00Z"));
  });

  it("goes no further back than the host keeps trades, and says so", () => {
    const limit = now - HISTORY_LIMIT_MS;
    const window = visibleWindowFor({ fromMs: limit - 3 * 86_400_000, toMs: limit + 3_600_000, liveEdge: false }, now);
    expect(window.from).toBe(Math.floor(limit / 60_000) * 60_000);
    expect(window.label).toMatch(/^on screen · nothing before /);
    expect(visibleWindowFor({ fromMs: limit + 60_000, toMs: limit + 3_600_000, liveEdge: false }, now).label).toBe("on screen");
    expect(visibleWindowFor({ fromMs: Math.floor(limit / 60_000) * 60_000, toMs: limit + 3_600_000, liveEdge: false }, now).label).toBe("on screen");
  });
});

describe("windowFor", () => {
  it("auto is the last half hour on 1m and 5m and the trading day above, whatever N hours says", () => {
    const now = T("2026-09-26T15:40:00Z");
    expect(settings().windowMode).toBe("auto");
    expect(windowFor(BTC, settings(), now, M1)).toEqual({ from: T("2026-09-26T15:00:00Z"), to: null, pieceMs: ROLLING_SLICE_MS, label: "last 0.5 h" });
    expect(windowFor(BTC, settings({ rollingHours: 6 }), now, M5)).toMatchObject({ from: T("2026-09-26T15:00:00Z"), label: "last 0.5 h" });
    expect(windowFor(BTC, settings(), now, M15)).toEqual({ from: T("2026-09-26T00:00:00Z"), to: null, pieceMs: DAY_PIECE_MS, label: "today" });
    expect(windowFor(NQ, settings(), T("2026-09-25T14:00:00Z"), H1).from).toBe(T("2026-09-24T22:00:00Z"));
  });

  it("day mode is the trading day, open ended, on any timeframe", () => {
    expect(windowFor(BTC, settings({ windowMode: "day" }), T("2026-09-26T15:40:00Z"), M1)).toEqual({ from: T("2026-09-26T00:00:00Z"), to: null, pieceMs: DAY_PIECE_MS, label: "today" });
    expect(windowFor(NQ, settings({ windowMode: "day" }), T("2026-09-25T14:00:00Z"), H1).from).toBe(T("2026-09-24T22:00:00Z"));
  });

  it("week mode is the trading week, open ended", () => {
    expect(windowFor(BTC, settings({ windowMode: "week" }), T("2026-09-26T15:40:00Z"), H1)).toEqual({ from: T("2026-09-21T00:00:00Z"), to: null, pieceMs: DAY_PIECE_MS, label: "this week" });
    expect(windowFor(NQ, settings({ windowMode: "week" }), T("2026-09-25T14:00:00Z"), H1).from).toBe(T("2026-09-20T22:00:00Z"));
  });

  it("session mode is the Killzones session, on crypto too", () => {
    expect(windowFor(BTC, settings({ windowMode: "session" }), T("2026-09-25T14:00:00Z"), H1)).toMatchObject({ label: "NY AM", to: T("2026-09-25T15:00:00Z") });
  });

  it("rolling mode slides in half-hour steps, N hours back, in whole half hours between 0.5 and 24", () => {
    const now = T("2026-09-26T15:40:00Z");
    expect(windowFor(BTC, settings({ windowMode: "rolling", rollingHours: 4 }), now, H1)).toEqual({ from: T("2026-09-26T11:30:00Z"), to: null, pieceMs: ROLLING_SLICE_MS, label: "last 4 h" });
    expect(windowFor(BTC, settings({ windowMode: "rolling", rollingHours: 4 }), T("2026-09-26T15:59:00Z"), H1).from).toBe(T("2026-09-26T11:30:00Z"));
    expect(windowFor(BTC, settings({ windowMode: "rolling", rollingHours: 4 }), T("2026-09-26T16:00:00Z"), H1).from).toBe(T("2026-09-26T12:00:00Z"));
    expect(windowFor(BTC, settings({ windowMode: "rolling", rollingHours: 0.5 }), now, H1)).toMatchObject({ from: T("2026-09-26T15:00:00Z"), label: "last 0.5 h" });
    expect(windowFor(BTC, settings({ windowMode: "rolling", rollingHours: 0.2 }), now, H1)).toMatchObject({ from: T("2026-09-26T15:00:00Z"), label: "last 0.5 h" });
    expect(windowFor(BTC, settings({ windowMode: "rolling", rollingHours: 1.74 }), now, H1)).toMatchObject({ from: T("2026-09-26T14:00:00Z"), label: "last 1.5 h" });
    expect(windowFor(BTC, settings({ windowMode: "rolling", rollingHours: 99 }), now, H1)).toMatchObject({ label: "last 24 h" });
  });

  it("visible mode follows the chart's view, and falls back to the day until the chart has said what is on screen", () => {
    const now = T("2026-09-26T15:40:00Z");
    expect(windowFor(BTC, settings({ windowMode: "visible" }), now, H1, { fromMs: T("2026-09-26T13:00:00Z"), toMs: now, liveEdge: true })).toMatchObject({ from: T("2026-09-26T13:00:00Z"), to: null, label: "on screen" });
    expect(windowFor(BTC, settings({ windowMode: "visible" }), now, H1)).toMatchObject({ from: T("2026-09-26T00:00:00Z"), label: "today" });
  });
});
