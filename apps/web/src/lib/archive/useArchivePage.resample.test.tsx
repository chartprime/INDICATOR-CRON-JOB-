// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HISTORICAL_INSTRUMENTS } from "./historicalCatalog";
import { historicalTimeframeById } from "./historicalTimeframes";
import type { HistoricalWindow } from "./historicalRetention";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("./historicalArchiveLoader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./historicalArchiveLoader")>()),
  loadHistoricalArchiveWindow: mocks.load,
}));

vi.stubEnv("VITE_ARCHIVE_CLIENT_TOKEN", "archive-browser-token-for-test");
const { useArchivePage } = await import("./useArchivePage");
const { toSeries } = await import("./historicalArchiveLoader");

const DAY_MS = 24 * 60 * 60_000;

function btcSpot() {
  const value = HISTORICAL_INSTRUMENTS.find((candidate) => candidate.id === "btc-spot");
  if (value === undefined) throw new Error("missing BTC spot historical instrument");
  return value;
}

function ethSpot() {
  const value = HISTORICAL_INSTRUMENTS.find((candidate) => candidate.id === "eth-spot");
  if (value === undefined) throw new Error("missing ETH spot historical instrument");
  return value;
}

function candleRow(openMs: number, index: number) {
  return {
    open_ns: (BigInt(openMs) * 1_000_000n).toString(),
    close_ns: (BigInt(openMs + DAY_MS) * 1_000_000n).toString(),
    open: `${100 + index}.00`,
    high: `${101 + index}.00`,
    low: `${99 + index}.00`,
    close: `${(100.5 + index).toFixed(2)}`,
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

function dailyPage(window: HistoricalWindow, days: number) {
  const rows = Array.from({ length: days }, (_, index) => candleRow(window.fromMs + index * DAY_MS, index));
  return {
    rows,
    pointerToken: "1d-snapshot",
    family: "candle_1d" as const,
    coverage: {
      requested: {
        from: (BigInt(window.fromMs) * 1_000_000n).toString(),
        to: (BigInt(window.toMs) * 1_000_000n).toString(),
      },
      served: null,
      partitions: 1,
      states: { PUBLISHED: 1 },
      corrupt: [],
    },
    scan: {},
    rollMarkers: [],
  };
}

function Harness({ selected, selectedTimeframe, requestToken }: {
  selected: ReturnType<typeof btcSpot> | null;
  selectedTimeframe: ReturnType<typeof historicalTimeframeById>;
  requestToken?: number;
}) {
  const state = useArchivePage(selected, selectedTimeframe, requestToken);
  useEffect(() => { latest = state; }, [state]);
  return null;
}

let latest: ReturnType<typeof useArchivePage>;
let root: Root;
let container: HTMLDivElement;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockImplementation(async (
    _client: unknown,
    instrument: Parameters<typeof toSeries>[0],
    timeframe: Parameters<typeof toSeries>[1],
    window: HistoricalWindow,
  ) => {
    const page = dailyPage(window, 10);
    return { outcome: "page" as const, page, series: toSeries(instrument, timeframe, page, window) };
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("useArchivePage - 1D/1W/1M resample without refetch", () => {
  it("switches from 1D to 1W by resampling the already-held page, without a second network fetch", async () => {
    const dayTimeframe = historicalTimeframeById("1D");
    await act(async () => root.render(<Harness selected={btcSpot()} selectedTimeframe={dayTimeframe} />));
    await flush();
    if (latest.state !== "ready") throw new Error("1D archive did not become ready");
    expect(latest.series.bars).toHaveLength(10);
    expect(mocks.load).toHaveBeenCalledTimes(1);

    const weekTimeframe = historicalTimeframeById("1W");
    await act(async () => root.render(<Harness selected={btcSpot()} selectedTimeframe={weekTimeframe} />));
    await flush();

    expect(mocks.load).toHaveBeenCalledTimes(1);
    if (latest.state !== "ready") throw new Error("1W archive did not stay ready");
    expect(latest.timeframeId).toBe("1W");
    expect(latest.resolution).toBe("1d");
    expect(latest.series.bars.every((bar) => bar.interval_ms === 7 * DAY_MS)).toBe(true);
    expect(latest.series.bars.length).toBeLessThan(10);

    const monthTimeframe = historicalTimeframeById("1M");
    await act(async () => root.render(<Harness selected={btcSpot()} selectedTimeframe={monthTimeframe} />));
    await flush();

    expect(mocks.load).toHaveBeenCalledTimes(1);
    if (latest.state !== "ready") throw new Error("1M archive did not stay ready");
    expect(latest.timeframeId).toBe("1M");
    expect(latest.series.bars).toHaveLength(1);
  });

  it("still refetches over the network when the instrument changes", async () => {
    const dayTimeframe = historicalTimeframeById("1D");
    await act(async () => root.render(<Harness selected={btcSpot()} selectedTimeframe={dayTimeframe} />));
    await flush();
    if (latest.state !== "ready") throw new Error("1D archive did not become ready");
    expect(mocks.load).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<Harness selected={ethSpot()} selectedTimeframe={dayTimeframe} />));
    await flush();

    expect(mocks.load).toHaveBeenCalledTimes(2);
    if (latest.state !== "ready") throw new Error("switched-instrument archive did not become ready");
    expect(latest.instrumentId).toBe(ethSpot().id);
  });

  it("still refetches over the network when the same instrument is explicitly re-selected", async () => {
    const dayTimeframe = historicalTimeframeById("1D");
    await act(async () => root.render(<Harness selected={btcSpot()} selectedTimeframe={dayTimeframe} requestToken={0} />));
    await flush();
    if (latest.state !== "ready") throw new Error("1D archive did not become ready");
    expect(mocks.load).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<Harness selected={btcSpot()} selectedTimeframe={dayTimeframe} requestToken={1} />));
    await flush();

    expect(mocks.load).toHaveBeenCalledTimes(2);
  });
});
