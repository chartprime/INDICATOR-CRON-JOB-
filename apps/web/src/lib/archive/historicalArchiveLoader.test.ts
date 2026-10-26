import { describe, expect, it, vi } from "vitest";
import type { ArchivePage, ArchiveQuery } from "./archiveClient";
import { createArchiveClient } from "./archiveClient";
import { loadHistoricalArchiveWindow } from "./historicalArchiveLoader";
import { HISTORICAL_INSTRUMENTS } from "./historicalCatalog";
import { initialHistoricalWindow } from "./historicalRetention";
import { historicalTimeframeById } from "./historicalTimeframes";

function btc() {
  const value = HISTORICAL_INSTRUMENTS.find((candidate) => candidate.id === "btc-spot");
  if (value?.kind !== "single") throw new Error("missing BTC spot");
  return value;
}

function page(
  request: ArchiveQuery,
  rows: ArchivePage["rows"],
  nextCursor: string | null = null,
): ArchivePage {
  return {
    outcome: "page",
    rows,
    nextCursor,
    pointerToken: "snapshot",
    queryFingerprint: "f".repeat(64),
    family: "candle_1m",
    coverage: {
      requested: { from: request.from, to: request.to }, served: null, partitions: 1, states: { PUBLISHED: 1 }, corrupt: [],
    },
    scan: { bytesRead: 10, cacheHits: 1, queryMs: 0.5 },
  };
}

function candleRow(openMs: number) {
  return {
    open_ns: (BigInt(openMs) * 1_000_000n).toString(),
    close_ns: (BigInt(openMs + 60_000) * 1_000_000n).toString(),
    open: "100.00",
    high: "101.00",
    low: "99.00",
    close: "100.50",
    volume: "10.00",
    buy_volume: null,
    quote_volume: null,
    taker_buy_quote_volume: null,
    taker_sell_base_volume: null,
    taker_sell_quote_volume: null,
    trade_count: null,
    closed: true,
  };
}

describe("historical archive loader", () => {
  it("validates source candles before it emits one display-timeframe series", async () => {
    const timeframe = historicalTimeframeById("5m");
    const window = initialHistoricalWindow(btc(), timeframe);
    const rows = Array.from({ length: 5 }, (_, index) => candleRow(window.fromMs + index * 60_000));
    rows.forEach((row, index) => Object.assign(row, {
      open: `${100 + index}.00`, high: `${101 + index}.00`, low: `${99 + index}.00`, close: (100.5 + index).toFixed(2),
    }));
    const query = vi.fn(async (request: ArchiveQuery) => page(request, rows));
    const client = { query } as unknown as ReturnType<typeof createArchiveClient>;

    const result = await loadHistoricalArchiveWindow(client, btc(), timeframe, window);

    expect(result).toMatchObject({ outcome: "page" });
    if (result.outcome !== "page") throw new Error("unreachable");
    expect(result.series.bars).toEqual([
      expect.objectContaining({ interval_ms: 300_000, ts_open: window.fromMs, open: 100, close: 104.5, trade_count: null }),
    ]);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ family: "candle_1m", limit: 10_000 }), expect.anything());
  });

  it("refuses an otherwise valid candle that falls outside the requested archive window", async () => {
    const timeframe = historicalTimeframeById("5m");
    const window = initialHistoricalWindow(btc(), timeframe);
    const query = vi.fn(async (request: ArchiveQuery) => page(request, [candleRow(window.toMs)]));
    const client = { query } as unknown as ReturnType<typeof createArchiveClient>;

    await expect(loadHistoricalArchiveWindow(client, btc(), timeframe, window))
      .rejects.toThrow("outside the requested historical window");
  });

  it("follows a short full-row cursor page sequence instead of assuming the requested row limit", async () => {
    const timeframe = historicalTimeframeById("30m");
    const window = initialHistoricalWindow(btc(), timeframe);
    const query = vi.fn(async (request: ArchiveQuery) => {
      if (request.cursor === undefined) return page(request, [candleRow(window.fromMs)], "cursor-2");
      if (request.cursor === "cursor-2") return page(request, [candleRow(window.fromMs + 60_000)], "cursor-3");
      return page(request, [candleRow(window.fromMs + 120_000)]);
    });
    const client = { query } as unknown as ReturnType<typeof createArchiveClient>;

    await expect(loadHistoricalArchiveWindow(client, btc(), timeframe, window))
      .resolves.toMatchObject({ outcome: "page" });
    expect(query).toHaveBeenCalledTimes(3);
  });
});
