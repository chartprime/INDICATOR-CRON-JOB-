// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BarFrame } from "../../types/frames";
import { createHistoricalIndicatorSeries } from "./historicalIndicatorSeries";
import { HISTORICAL_INSTRUMENTS } from "./historicalCatalog";
import type { HistoricalTimeframe } from "./historicalTimeframes";
import { historicalTimeframeById } from "./historicalTimeframes";
import type { HistoricalWindow } from "./historicalRetention";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  windows: [] as HistoricalWindow[],
}));

vi.mock("./historicalArchiveLoader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./historicalArchiveLoader")>()),
  loadHistoricalArchiveWindow: mocks.load,
}));

vi.stubEnv("VITE_ARCHIVE_CLIENT_TOKEN", "archive-browser-token-for-test");
const { useArchivePage } = await import("./useArchivePage");

const matchedInstrument = HISTORICAL_INSTRUMENTS.find((candidate) => candidate.id === "btc-spot");
if (matchedInstrument === undefined) throw new Error("missing BTC spot historical instrument");
const instrument = matchedInstrument;
const timeframe = historicalTimeframeById("1m");

let latest: ReturnType<typeof useArchivePage>;
let root: Root;
let container: HTMLDivElement;

function bar(openMs: number): BarFrame {
  return {
    type: "bar",
    symbol: "BTCUSDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    interval_ms: 60_000,
    ts_open: openMs,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 10,
    buy_volume: 5,
    trade_count: 1,
    closed: true,
  };
}

function pageFor(window: HistoricalWindow) {
  const bars = Array.from({ length: (window.toMs - window.fromMs) / 60_000 }, (_, index) =>
    bar(window.fromMs + index * 60_000));
  return {
    outcome: "page" as const,
    page: {
      rows: [],
      pointerToken: "pinned-snapshot",
      family: "candle_1m" as const,
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
    },
    series: createHistoricalIndicatorSeries(
      bars,
      bars.map((value) => ({ tsOpen: value.ts_open })),
    ),
  };
}

function Harness({ selected, selectedTimeframe, initialRange = null }: {
  selected: typeof instrument | null;
  selectedTimeframe: HistoricalTimeframe;
  initialRange?: Readonly<{ fromMs: number; toMs: number }> | null;
}) {
  const state = useArchivePage(selected, selectedTimeframe, 0, initialRange);
  useEffect(() => { latest = state; }, [state]);
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.windows = [];
  mocks.load.mockImplementation(async (_client: unknown, _instrument: unknown, _timeframe: unknown, window: HistoricalWindow) => {
    mocks.windows.push(window);
    return pageFor(window);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness selected={instrument} selectedTimeframe={timeframe} />));
  await flush();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("useArchivePage", () => {
  it("loads the explicit sample range and refuses oversized or unavailable ranges before transport", async () => {
    const fromMs = Date.parse(instrument.availableFrom) + 3600000;
    const range = { fromMs, toMs: fromMs + 900000 };
    await act(async () => root.render(<Harness selected={instrument} selectedTimeframe={timeframe} initialRange={range} />));
    await flush();
    expect(mocks.windows.at(-1)).toEqual({ ...range, maximumPages: 4 });
    const count = mocks.load.mock.calls.length;
    for (const invalid of [{ fromMs, toMs: fromMs + 3600001 }, { fromMs: -1, toMs: range.toMs }]) {
      await act(async () => root.render(<Harness selected={instrument} selectedTimeframe={timeframe} initialRange={invalid} />));
      await flush();
      expect(latest.state).toBe("error");
    }
    expect(mocks.load).toHaveBeenCalledTimes(count);
  });
  it("keeps the verified chart visible when an adjacent window is refused", async () => {
    if (latest.state !== "ready") throw new Error("archive did not become ready");
    const retained = latest.series;
    mocks.load.mockResolvedValueOnce({
      outcome: "refused",
      code: "OVERLOADED",
      detail: null,
      status: 429,
      retryAfterMs: 1_000,
    });

    await act(async () => latest.state === "ready" && latest.onVisibleLogicalRangeChange(0, 1_000));
    await flush();

    expect(latest).toMatchObject({
      state: "ready",
      series: retained,
      loadingDirection: null,
      extensionIssue: { kind: "refused", detail: "OVERLOADED" },
    });
  });

  it("keeps the verified chart visible when an adjacent page cannot merge", async () => {
    if (latest.state !== "ready") throw new Error("archive did not become ready");
    const retained = latest.series;
    mocks.load.mockImplementationOnce(async (_client: unknown, _instrument: unknown, _timeframe: unknown, window: HistoricalWindow) => {
      const incompatible = bar(window.fromMs);
      incompatible.interval_ms = 300_000;
      return {
        ...pageFor(window),
        series: createHistoricalIndicatorSeries([incompatible], [{ tsOpen: incompatible.ts_open }]),
      };
    });

    await act(async () => latest.state === "ready" && latest.onVisibleLogicalRangeChange(0, 1_000));
    await flush();

    expect(latest).toMatchObject({
      state: "ready",
      series: retained,
      loadingDirection: null,
      extensionIssue: { kind: "error", detail: "historical pages use incompatible display intervals" },
    });
  });

  it("extends from the retained edge after older history causes eviction", async () => {
    for (let index = 0; index < 10; index += 1) {
      if (latest.state !== "ready") throw new Error("archive did not become ready");
      await act(async () => latest.state === "ready" && latest.onVisibleLogicalRangeChange(0, 1_000));
      await flush();
    }
    if (latest.state !== "ready") throw new Error("archive did not remain ready");
    expect(latest.series.bars).toHaveLength(5_000);
    const retainedLastCloseMs = latest.series.bars.at(-1)!.ts_open + latest.series.bars.at(-1)!.interval_ms;

    await act(async () => latest.state === "ready" && latest.onVisibleLogicalRangeChange(1_000, 0));
    await flush();

    expect(mocks.windows).toHaveLength(12);
    expect(mocks.windows.at(-1)?.fromMs).toBe(retainedLastCloseMs);
  });
});
