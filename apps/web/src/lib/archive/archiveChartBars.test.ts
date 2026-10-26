import { describe, expect, it } from "vitest";
import type { ArchivePage, ArchiveRow } from "./archiveClient";
import { ArchiveChartBarError, archivePageBars } from "./archiveChartBars";
import { HISTORICAL_INSTRUMENTS, type HistoricalQueryableInstrument } from "./historicalCatalog";

function instrument(id: string): HistoricalQueryableInstrument {
  const candidate = HISTORICAL_INSTRUMENTS.find((entry) => entry.id === id);
  if (candidate?.availability !== "ready" || candidate.kind !== "single") {
    throw new Error(`missing queryable ${id}`);
  }
  return candidate;
}

function row(overrides: Partial<ArchiveRow> = {}): ArchiveRow {
  return {
    open_ns: "1756684800000000000",
    close_ns: "1756771200000000000",
    open: "100.25",
    high: "101.50",
    low: "99.75",
    close: "100.75",
    volume: "42.50",
    buy_volume: "23.00",
    quote_volume: null,
    taker_buy_quote_volume: null,
    taker_sell_base_volume: null,
    taker_sell_quote_volume: null,
    trade_count: "318",
    closed: true,
    ...overrides,
  };
}

function page(rows: readonly ArchiveRow[], family: ArchivePage["family"] = "candle_1d"): ArchivePage {
  return {
    outcome: "page",
    rows,
    nextCursor: null,
    pointerToken: "token",
    queryFingerprint: "f".repeat(64),
    family,
    coverage: {
      requested: { from: "1756684800000000000", to: "1756771200000000000" },
      served: null,
      partitions: 1,
      states: { PUBLISHED: 1 },
      corrupt: [],
    },
    scan: {},
  };
}

describe("archivePageBars", () => {
  it("maps verified Binance candle fields without changing their observed values", () => {
    const [bar] = archivePageBars(instrument("btc-spot"), "1d", page([row()]));

    expect(bar).toEqual({
      provider: "BINANCE",
      marketKind: "SPOT",
      type: "bar",
      symbol: "BTCUSDT",
      interval_ms: 86_400_000,
      ts_open: 1_756_684_800_000,
      open: 100.25,
      high: 101.5,
      low: 99.75,
      close: 100.75,
      volume: 42.5,
      buy_volume: 23,
      trade_count: 318,
      closed: true,
    });
  });

  it("preserves unavailable Databento flow fields as unavailable and retains its provider", () => {
    const [bar] = archivePageBars(
      instrument("aapl"),
      "1d",
      page([row({ buy_volume: null, trade_count: null })]),
    );

    expect(bar).toMatchObject({ provider: "DATABENTO", assetClass: "EQUITY", symbol: "AAPL", trade_count: null });
    expect(Object.hasOwn(bar, "buy_volume")).toBe(false);
  });

  it("carries internally reconciled Binance quote and taker metrics beside chart bars", async () => {
    const { archivePageCandleSeries } = await import("./archiveChartBars");
    const series = archivePageCandleSeries(
      instrument("btc-spot"),
      "1d",
      page([row({
        quote_volume: "2500.00",
        taker_buy_quote_volume: "1300.00",
        taker_sell_base_volume: "19.50",
        taker_sell_quote_volume: "1200.00",
      })]),
    );
    expect(series.metrics).toEqual([{
      tsOpen: 1_756_684_800_000,
      quoteVolume: 2500,
      takerBuyQuoteVolume: 1300,
      takerSellBaseVolume: 19.5,
      takerSellQuoteVolume: 1200,
    }]);
    expect(series.capabilities).toEqual(expect.arrayContaining([
      "ohlcv", "buy_volume", "quote_volume", "taker_buy_quote_volume",
      "taker_sell_base_volume", "taker_sell_quote_volume", "trade_count",
    ]));
  });

  it("derives missing seller metrics but refuses contradictory Binance flow metrics", async () => {
    const { archivePageCandleSeries } = await import("./archiveChartBars");
    expect(archivePageCandleSeries(
      instrument("btc-spot"), "1d", page([row({ quote_volume: "2500.00" })]),
    ).metrics[0]).toMatchObject({ takerSellBaseVolume: 19.5, quoteVolume: 2500 });
    expect(() => archivePageCandleSeries(
      instrument("btc-spot"),
      "1d",
      page([row({
        quote_volume: "2500.00",
        taker_buy_quote_volume: "1300.00",
        taker_sell_base_volume: "20.00",
        taker_sell_quote_volume: "1200.00",
      })]),
    )).toThrow("base volumes do not equal");
  });

  it("refuses a page whose declared family cannot represent the selected resolution", () => {
    expect(() => archivePageBars(instrument("btc-spot"), "1d", page([row()], "candle_1h")))
      .toThrow("family does not match");
  });

  it("refuses unclosed, unaligned, and unsafe-count rows instead of manufacturing chart bars", () => {
    expect(() => archivePageBars(instrument("btc-spot"), "1d", page([row({ closed: false })])))
      .toThrow(ArchiveChartBarError);
    expect(() => archivePageBars(instrument("btc-spot"), "1d", page([row({ close_ns: "1756684860000000000" })])))
      .toThrow("not aligned");
    expect(() => archivePageBars(instrument("btc-spot"), "1d", page([row({ trade_count: "9007199254740992" })])))
      .toThrow("outside display range");
  });
});
