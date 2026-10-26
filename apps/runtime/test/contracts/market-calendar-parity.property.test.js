"use strict";

// Block 7 W1 (report 57, GE-14): the runtime and the browser each evaluate
// the governed market calendar. Live bars (browser filter) and server-side
// studies (runtime filter) must put exactly the same equity minutes on the
// chart, so the two evaluators are compared over the whole covered range,
// with DST and early-close days weighted in.
const fc = require("fast-check");
const runtime = require("../../src/providers/shared/market-calendar");
const { loadWebModule } = require("../helpers/browser-frame-parser");

const web = loadWebModule("src/lib/chart/marketCalendar.ts");

const FROM = Date.parse("2025-09-01T00:00:00Z");
const TO = Date.parse("2028-01-01T00:00:00Z");
const EDGE_DAYS = ["2026-03-06", "2026-03-09", "2026-10-30", "2026-11-02", "2026-11-26", "2026-11-27", "2026-12-24", "2027-11-26"];

describe("market calendar parity: runtime vs browser", () => {
  test("every covered timestamp gets the same equity session on both sides", () => {
    fc.assert(fc.property(fc.integer({ min: FROM, max: TO }), (ts) => {
      expect(web.equitySessionAt(ts)).toBe(runtime.equitySessionAt(ts));
    }), { numRuns: 20_000 });
  });

  test("every minute of the DST, holiday and early-close days agrees", () => {
    let regular = 0;
    for (const day of EDGE_DAYS) {
      const start = Date.parse(`${day}T00:00:00Z`);
      for (let ts = start; ts < start + 2 * 86_400_000; ts += 60_000) {
        expect([ts, web.equitySessionAt(ts)]).toEqual([ts, runtime.equitySessionAt(ts)]);
        if (runtime.isEquityChartTime(ts)) regular += 1;
      }
    }
    expect(regular).toBeGreaterThan(0);
  });

  test("the browser filter is identity-aware: only equities are regular-session only", () => {
    const night = Date.parse("2026-09-23T02:00:00Z");
    expect(web.inChartSession({ provider: "DXFEED", assetClass: "EQUITY" }, night)).toBe(false);
    expect(web.inChartSession({ provider: "DATABENTO", assetClass: "EQUITY" }, night)).toBe(false);
    expect(web.inChartSession({ provider: "DXFEED", assetClass: "FUTURE" }, night)).toBe(true);
    expect(web.inChartSession({ provider: "BINANCE", marketKind: "PERPETUAL" }, night)).toBe(true);
  });
});
