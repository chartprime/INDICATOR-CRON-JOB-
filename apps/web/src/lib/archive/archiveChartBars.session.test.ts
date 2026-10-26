import { describe, expect, it } from "vitest";
import type { ArchivePage, ArchiveRow } from "./archiveClient";
import { archivePageBars } from "./archiveChartBars";
import { HISTORICAL_INSTRUMENTS, type HistoricalQueryableInstrument } from "./historicalCatalog";

// Report 57 W1, GE-14: Historical Mode equity minute candles are regular
// session only, the same minutes the live chart shows. Hourly and daily
// equity candles are rolled up by the archive producer and are not filtered
// here (tracked separately in report 57).
function instrument(id: string): HistoricalQueryableInstrument {
  const candidate = HISTORICAL_INSTRUMENTS.find((entry) => entry.id === id);
  if (candidate?.availability !== "ready" || candidate.kind !== "single") throw new Error(`missing queryable ${id}`);
  return candidate;
}

const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);

function minute(ms: number): ArchiveRow {
  return {
    open_ns: ns(ms), close_ns: ns(ms + 60_000), open: "100", high: "101", low: "99", close: "100.5", volume: "10", buy_volume: null,
    quote_volume: null, taker_buy_quote_volume: null, taker_sell_base_volume: null, taker_sell_quote_volume: null, trade_count: "3", closed: true,
  };
}

function page(rows: readonly ArchiveRow[]): ArchivePage {
  return {
    outcome: "page", rows, nextCursor: null, pointerToken: "token", queryFingerprint: "f".repeat(64), family: "candle_1m",
    coverage: { requested: { from: String(rows[0].open_ns), to: String(rows.at(-1)!.close_ns) }, served: null, partitions: 1, states: { PUBLISHED: 1 }, corrupt: [] },
    scan: {},
  };
}

const LAST_PRE = Date.parse("2026-09-23T13:29:00Z");
const OPEN = Date.parse("2026-09-23T13:30:00Z");
const LAST_RTH = Date.parse("2026-09-23T19:59:00Z");
const FIRST_POST = Date.parse("2026-09-23T20:00:00Z");

describe("Historical Mode equity minute candles are regular-session only (GE-14)", () => {
  it("drops pre-market and after-hours minutes for an equity", () => {
    const bars = archivePageBars(instrument("aapl"), "1m", page([minute(LAST_PRE), minute(OPEN), minute(LAST_RTH), minute(FIRST_POST)]));
    expect(bars.map((bar) => bar.ts_open)).toEqual([OPEN, LAST_RTH]);
  });

  it("keeps every minute for a non-equity", () => {
    const bars = archivePageBars(instrument("btc-spot"), "1m", page([minute(LAST_PRE), minute(OPEN), minute(FIRST_POST)]));
    expect(bars).toHaveLength(3);
  });
});

function hour(ms: number): ArchiveRow {
  return { ...minute(ms), close_ns: ns(ms + 3_600_000) };
}

describe("Historical Mode equity hourly candles open at 09:30 (report 57 GE-14b)", () => {
  const hourly = (rows: readonly ArchiveRow[]): ArchivePage => ({ ...page(rows), family: "candle_1h" });

  it("accepts an equity hour that starts at the session open and every hour after it", () => {
    const bars = archivePageBars(instrument("aapl"), "1h", hourly([hour(OPEN), hour(OPEN + 6 * 3_600_000)]));
    expect(bars.map((bar) => bar.ts_open)).toEqual([OPEN, OPEN + 6 * 3_600_000]);
  });

  it("still reads the UTC-hour equity bars published before the 09:30 republish (report 58), exactly as before W3", () => {
    const utcHours = [hour(OPEN - 30 * 60_000), hour(OPEN + 30 * 60_000)];
    expect(() => archivePageBars(instrument("aapl"), "1h", hourly(utcHours))).not.toThrow();
    expect(archivePageBars(instrument("aapl"), "1h", hourly(utcHours)).map((bar) => bar.ts_open)).toEqual([OPEN - 30 * 60_000, OPEN + 30 * 60_000]);
  });

  it("still refuses an equity hour on neither grid", () => {
    expect(() => archivePageBars(instrument("aapl"), "1h", hourly([hour(OPEN + 15 * 60_000)]))).toThrow(/not aligned/);
  });

  it("keeps UTC hours for a non-equity", () => {
    expect(() => archivePageBars(instrument("btc-spot"), "1h", hourly([hour(OPEN)]))).toThrow(/not aligned/);
    expect(archivePageBars(instrument("btc-spot"), "1h", hourly([hour(OPEN - 30 * 60_000)]))).toHaveLength(1);
  });
});
