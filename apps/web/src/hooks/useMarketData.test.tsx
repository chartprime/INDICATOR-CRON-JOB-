// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { StrictMode } from "react";
import {
  HISTORY_RETRY_BASE_MS,
  RANGE_REQUEST_IDS_KEPT,
  createBoundedIdTracker,
  useMarketData,
  type UseMarketDataResult,
} from "./useMarketData";
import { HISTORY_ASK_MAX_MS, HISTORY_GIVE_UP_MS } from "../lib/indicators/aggressive-orders/aggressiveTape";
import { RANGE_ASK_BUDGET, RANGE_ASK_BUDGET_MS, RANGE_ASK_DELAY_MS } from "../lib/indicators/aggressive-orders-profile/rangePrintStore";
import { BAND_COLUMN_MAX_PER_MINUTE, ownsBandColumnId } from "../lib/chart/bandHistory";
import { STREAM_MAX_REQUESTS_PER_MINUTE } from "../lib/indicators/passive-liquidity/columnHistoryStream";
import { COLUMN_HISTORY_MAX_PER_MINUTE } from "../lib/indicators/passive-liquidity/requestBudget";
import type {
  BarFrame,
  MarketKind,
  MarkerFrame,
  ServerFrame,
  TradeFrame,
} from "../types/frames";
import type { WorkerToMainMessage } from "../workers/marketDataWorker";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Regression test for a real bug found by fresh-eyes audit + direct
// reproduction (2026-07-14): the rAF flush() closure read a shared
// mutable buffer (pendingTrades/pendingTradeCount) INSIDE a setState
// functional updater, then cleared that same buffer synchronously right
// after calling setState. React only takes the eager-synchronous-updater
// path for the FIRST update since the last render -- every update after
// that has its updater invoked later, by which point the buffer was
// already wiped, silently dropping every trade/stat from that flush.
// Verified by reproduction before fixing: cycle 1 lost 100% of its data.

class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerToMainMessage>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: Event) => void) | null = null;
  posted: unknown[] = [];
  throwOnPost = false;
  terminated = false;
  postMessage(message: unknown): void {
    if (this.throwOnPost)
      throw new DOMException("worker channel unavailable", "InvalidStateError");
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(msg: WorkerToMainMessage): void {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerToMainMessage>);
  }
}

let lastWorker: FakeWorker;
let workerInstances: FakeWorker[] = [];
let rafCallbacks: FrameRequestCallback[] = [];

function flushRaf(): void {
  const cbs = rafCallbacks;
  rafCallbacks = [];
  for (const cb of cbs) cb(0);
}

function makeTrade(overrides: Partial<TradeFrame> = {}): TradeFrame {
  return {
    type: "trade",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    ts_exchange: 1,
    price: 100,
    size: 1,
    side: "buy",
    trade_id: "1",
    ...overrides,
  } as TradeFrame;
}

function makeMarker(overrides: Partial<MarkerFrame> = {}): MarkerFrame {
  return {
    type: "marker",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    ts_exchange: 1,
    price: 100,
    size: 5,
    side: "buy",
    trade_id: "m1",
    ...overrides,
  } as MarkerFrame;
}

function selectionFrame(symbol = "BTC-USDT", marketKind: MarketKind = "SPOT") {
  return {
    type: "selection" as const,
    symbol,
    provider: "BINANCE" as const,
    marketKind,
  };
}

// Every trade/bar/health/book frame is discarded unless it matches the
// server-confirmed active selection -- emit that selection first, the
// same order the real server always sends (selection before anything
// else), so tests not specifically about the switch/discard mechanism
// itself aren't tripped up by it.
function confirmBaseSelection(): void {
  lastWorker.emit({ kind: "frame", frame: selectionFrame() });
}

beforeEach(() => {
  rafCallbacks = [];
  workerInstances = [];
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        lastWorker = new FakeWorker();
        workerInstances.push(lastWorker);
        return lastWorker as unknown as Worker;
      }
    },
  );
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

function Harness({ onReady }: { onReady: (r: UseMarketDataResult) => void }) {
  const result = useMarketData({ url: "ws://test" });
  onReady(result);
  return null;
}

describe("suspended rendering analytics bounds", () => {
  it.each(["vpin", "history"])(
    "withdraws %s overflow until a deliberate fresh selection",
    async (family) => {
      const root = createRoot(document.createElement("div"));
      let latest!: UseMarketDataResult;
      try {
        await act(async () =>
          root.render(
            <Harness
              onReady={(value) => {
                latest = value;
              }}
            />,
          ),
        );
        await act(async () => {
          confirmBaseSelection();
          for (let i = 0; i < (family === "vpin" ? 10_000 : 256); i++) {
            lastWorker.emit({
              kind: "frame",
              frame: (family === "vpin"
                ? makeVpin({ seal_ts: i + 1 })
                : makeProfile({
                    mode: "fixed_range",
                    period_start_ts: i + 1,
                  })) as never,
            });
          }
        });
        expect(latest.analyticsIncomplete).toBe(true);
        await act(async () => flushRaf());
        expect(latest.vpinHistory).toEqual([]);
        expect(latest.historicalProfiles).toEqual([]);
        await act(async () => {
          lastWorker.emit({
            kind: "frame",
            frame: {
              ...selectionFrame(),
              type: "health",
              recoveryState: "READY",
              stale: false,
              printsQuiet: false,
            } as never,
          });
          lastWorker.emit({ kind: "frame", frame: makeVpin() as never });
          flushRaf();
        });
        expect(latest.analyticsIncomplete).toBe(true);
        expect(latest.vpinHistory).toEqual([]);
        await act(async () =>
          lastWorker.emit({ kind: "frame", frame: selectionFrame("ETH-USDT") }),
        );
        expect(latest.analyticsIncomplete).toBe(false);
      } finally {
        await act(async () => root.unmount());
      }
    },
  );
});

describe("useMarketData -- worker startup failure", () => {
  it.each(["error", "messageerror"] as const)(
    "fails closed on worker %s before the first socket message",
    async (failure) => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const root = createRoot(document.createElement("div"));
      let latest!: UseMarketDataResult;
      try {
        await act(async () =>
          root.render(
            <Harness
              onReady={(result) => {
                latest = result;
              }}
            />,
          ),
        );
        expect(latest.status).toBe("connecting");
        await act(async () => {
          lastWorker[failure === "error" ? "onerror" : "onmessageerror"]?.(
            new Event(failure),
          );
        });
        expect(latest.status).toBe("closed");
        expect(latest.activeSelection).toBeNull();
        expect(lastWorker.terminated).toBe(true);
      } finally {
        await act(async () => root.unmount());
        consoleError.mockRestore();
      }
    },
  );

  it.each(["error", "messageerror"] as const)(
    "withdraws established market state on worker %s and ignores late work",
    async (failure) => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const root = createRoot(document.createElement("div"));
      let latest!: UseMarketDataResult;
      const snapshots: BarFrame[][] = [];
      function FailureHarness() {
        latest = useMarketData({
          url: "ws://test",
          onSnapshotBars: (bars) => snapshots.push(bars),
        });
        return null;
      }
      try {
        await act(async () => root.render(<FailureHarness />));
        await act(async () => {
          lastWorker.emit({ kind: "status", status: "open" });
          confirmBaseSelection();
          lastWorker.emit({
            kind: "frame",
            frame: {
              type: "health",
              symbol: "BTC-USDT",
              provider: "BINANCE",
              marketKind: "SPOT",
              recoveryState: "READY",
              stale: false,
              printsQuiet: false,
              recordingStale: true,
              recordingLatestTs: 5,
            },
          });
          lastWorker.emit({
            kind: "frame",
            frame: {
              type: "book",
              symbol: "BTC-USDT",
              provider: "BINANCE",
              marketKind: "SPOT",
              status: "READY",
              bids: [{ price: 100, size: 1 }],
              asks: [{ price: 101, size: 1 }],
              stale: false,
            },
          });
          lastWorker.emit({ kind: "frame", frame: makeTrade() });
          lastWorker.emit({ kind: "frame", frame: makeMarker() });
          flushRaf();
        });
        expect(latest.status).toBe("open");
        expect(latest.feedHealth?.recoveryState).toBe("READY");
        expect(latest.feedHealth?.recordingStale).toBe(true);
        expect(latest.feedHealth?.recordingLatestTs).toBe(5);
        expect(latest.book?.status).toBe("READY");
        expect(latest.trades).toHaveLength(1);
        expect(latest.markerView.snapshot()).toHaveLength(1);
        const lateMessage = lastWorker.onmessage;
        const terminate = vi.spyOn(lastWorker, "terminate");
        await act(async () => {
          lastWorker.emit({
            kind: "frame",
            frame: makeTrade({ trade_id: "queued" }),
          });
          lastWorker[failure === "error" ? "onerror" : "onmessageerror"]?.(
            new Event(failure),
          );
        });
        expect(latest.status).toBe("closed");
        expect(latest.feedHealth).toBeNull();
        expect(latest.book).toBeNull();
        expect(latest.activeSelection).toBeNull();
        expect(latest.trades).toEqual([]);
        expect(latest.markerView.snapshot()).toEqual([]);
        expect(snapshots.at(-1)).toEqual([]);
        expect(terminate).toHaveBeenCalledTimes(1);
        const postedCount = lastWorker.posted.length;
        await act(async () => {
          lateMessage?.({
            data: { kind: "status", status: "open" },
          } as MessageEvent<WorkerToMainMessage>);
          lateMessage?.({
            data: { kind: "frame", frame: selectionFrame() },
          } as MessageEvent<WorkerToMainMessage>);
          latest.selectPair("ETH-USDT", {
            provider: "BINANCE",
            marketKind: "SPOT",
          });
          flushRaf();
        });
        expect(latest.status).toBe("closed");
        expect(latest.activeSelection).toBeNull();
        expect(latest.trades).toEqual([]);
        expect(lastWorker.posted).toHaveLength(postedCount);
        await act(async () => root.unmount());
        expect(terminate).toHaveBeenCalledTimes(1);
      } finally {
        await act(async () => root.unmount());
        consoleError.mockRestore();
      }
    },
  );

  it("withdraws previous tape, markers, stats and chart when replacement worker construction fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const root = createRoot(document.createElement("div"));
    let latest!: UseMarketDataResult;
    const snapshots: BarFrame[][] = [];
    const bar: BarFrame = {
      type: "bar",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      ts_open: 0,
      interval_ms: 60_000,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      trade_count: 1,
      closed: true,
    };
    function UrlHarness({ url }: { url: string }) {
      latest = useMarketData({
        url,
        onSnapshotBars: (bars) => snapshots.push(bars),
      });
      return null;
    }
    try {
      await act(async () => root.render(<UrlHarness url="ws://first" />));
      await act(async () => {
        confirmBaseSelection();
        lastWorker.emit({
          kind: "frame",
          frame: {
            type: "snapshot",
            symbol: "BTC-USDT",
            provider: "BINANCE",
            marketKind: "SPOT",
            bars: [bar],
            trades: [makeTrade()],
            markers: [makeMarker()],
          },
        });
        lastWorker.emit({
          kind: "frame",
          frame: makeTrade({ trade_id: "next" }),
        });
        flushRaf();
      });
      expect(latest.trades.length).toBeGreaterThan(0);
      expect(latest.markerView.snapshot()).toHaveLength(1);
      expect(latest.stats.tradesReceived).toBe(1);
      expect(snapshots.at(-1)).toEqual([bar]);
      vi.stubGlobal(
        "Worker",
        class {
          constructor() {
            throw new Error("fixture construction failure");
          }
        },
      );
      await act(async () => root.render(<UrlHarness url="ws://replacement" />));
      expect(latest.status).toBe("closed");
      expect(latest.trades).toEqual([]);
      expect(latest.markerView.snapshot()).toEqual([]);
      expect(latest.stats.tradesReceived).toBe(0);
      expect(snapshots.at(-1)).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      consoleError.mockRestore();
    }
  });

  it("asks the server to resync the heatmap when a liquidity frame does not chain, debounced", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = createRoot(document.createElement("div"));
    function LiquidityHarness() {
      useMarketData({ url: "ws://test", onSnapshotBars: () => {} });
      return null;
    }
    try {
      await act(async () => root.render(<LiquidityHarness />));
      const nonChaining = {
        type: "liquidity",
        symbol: "BTC-USDT",
        provider: "BINANCE",
        marketKind: "SPOT",
        seq: 9,
        columns: [],
        reset: false,
        column_ms: 1_000,
        row_width: 2,
      };
      await act(async () => {
        lastWorker.emit({ kind: "status", status: "open" });
        confirmBaseSelection();
        lastWorker.emit({ kind: "frame", frame: nonChaining as never });
        lastWorker.emit({ kind: "frame", frame: nonChaining as never });
      });
      const resyncs = lastWorker.posted.filter(
        (m) => (m as { kind?: string }).kind === "liquidity_resync",
      );
      expect(resyncs).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      consoleWarn.mockRestore();
    }
  });

  it("a candle_monitor frame for the live pair becomes the hook's candleMonitor with the time it reached the tab, the newest by ts; another pair's is ignored", async () => {
    const stampedFrom = Date.now();
    const root = createRoot(document.createElement("div"));
    let latest!: UseMarketDataResult;
    function MonitorHarness() {
      latest = useMarketData({ url: "ws://test" });
      return null;
    }
    const monitor = (ts: number, symbol = "BTC-USDT") => ({
      type: "candle_monitor", symbol, provider: "BINANCE", marketKind: "SPOT", ts,
      entries: [{ candleMs: 60_000, candleTs: 1_700_000_220_000, buy: 3, sell: 7, biggestBuy: { price: 105, size: 2 }, biggestSell: null }],
    });
    try {
      await act(async () => root.render(<MonitorHarness />));
      await act(async () => {
        lastWorker.emit({ kind: "status", status: "open" });
        confirmBaseSelection();
        lastWorker.emit({ kind: "frame", frame: monitor(1_700_000_240_000) as never });
        flushRaf();
      });
      expect(latest.candleMonitor?.frame.ts).toBe(1_700_000_240_000);
      expect(latest.candleMonitor!.receivedAt).toBeGreaterThanOrEqual(stampedFrom);
      expect(latest.candleMonitor!.receivedAt).toBeLessThanOrEqual(Date.now());
      await act(async () => {
        lastWorker.emit({ kind: "frame", frame: monitor(1_700_000_235_000) as never });
        lastWorker.emit({ kind: "frame", frame: monitor(1_700_000_250_000, "ETH-USDT") as never });
        flushRaf();
      });
      expect(latest.candleMonitor?.frame.ts).toBe(1_700_000_240_000);
      await act(async () => {
        lastWorker.emit({ kind: "frame", frame: monitor(1_700_000_260_000) as never });
        flushRaf();
      });
      expect(latest.candleMonitor?.frame.ts).toBe(1_700_000_260_000);
      expect(latest.candleMonitor?.frame.entries[0].sell).toBe(7);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("requestExhaustionHistory posts an exhaustion_history control message with the asked start to the worker", async () => {
    const root = createRoot(document.createElement("div"));
    let latest!: UseMarketDataResult;
    function AskHarness() {
      latest = useMarketData({ url: "ws://test" });
      return null;
    }
    try {
      await act(async () => root.render(<AskHarness />));
      await act(async () => {
        lastWorker.emit({ kind: "status", status: "open" });
        latest.requestExhaustionHistory(1_700_000_000_000);
      });
      expect(lastWorker.posted.filter((m) => (m as { kind?: string }).kind === "exhaustion_history")).toEqual([{ kind: "exhaustion_history", from_ts: 1_700_000_000_000 }]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("fails closed without crashing the terminal when the browser cannot construct a worker", async () => {
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new DOMException("blocked by policy", "SecurityError");
        }
      },
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(
        <Harness
          onReady={(result) => {
            latest = result;
          }}
        />,
      );
    });

    expect(latest.status).toBe("closed");
    expect(latest.activeSelection).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("worker construction failed"),
      expect.anything(),
    );
    await act(async () => root.unmount());
    consoleError.mockRestore();
  });

  it("fails closed instead of throwing through React when an established worker control channel breaks", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(
        <Harness
          onReady={(result) => {
            latest = result;
          }}
        />,
      );
    });
    await act(async () => {
      confirmBaseSelection();
    });
    lastWorker.throwOnPost = true;
    await act(async () => {
      expect(() =>
        latest.selectPair("ETH-USDT", {
          provider: "BINANCE",
          marketKind: "PERPETUAL",
        }),
      ).not.toThrow();
    });

    expect(latest.status).toBe("closed");
    expect(latest.activeSelection).toBeNull();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("selection request failed"),
      expect.anything(),
    );
    lastWorker.throwOnPost = false;
    await act(async () => root.unmount());
    consoleError.mockRestore();
  });
});

describe("useMarketData -- React Strict Mode ownership", () => {
  it("terminates the probe worker and ignores its late messages while the committed worker remains authoritative", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(
        <StrictMode>
          <Harness
            onReady={(result) => {
              latest = result;
            }}
          />
        </StrictMode>,
      );
    });

    expect(workerInstances).toHaveLength(2);
    expect(workerInstances[0].terminated).toBe(true);
    expect(workerInstances[1].terminated).toBe(false);

    await act(async () => {
      workerInstances[0].emit({
        kind: "frame",
        frame: selectionFrame("ETH-USDT", "PERPETUAL"),
      });
    });
    expect(latest.activeSelection).toBeNull();

    await act(async () => {
      workerInstances[1].emit({ kind: "frame", frame: selectionFrame() });
    });
    expect(latest.activeSelection).toEqual({
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
    });

    await act(async () => root.unmount());
    expect(workerInstances[1].terminated).toBe(true);
    container.remove();
  });
});

describe("useMarketData -- multi-cycle trade accumulation", () => {
  it("accumulates trades and stats correctly across multiple rAF flush cycles, not just the first", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    // Cycle 1: two trades, one rAF flush.
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: makeTrade({ trade_id: "1" }) });
      lastWorker.emit({ kind: "frame", frame: makeTrade({ trade_id: "2" }) });
      flushRaf();
    });
    expect(latest.trades.map((t) => t.trade_id)).toEqual(["2", "1"]);
    expect(latest.stats.tradesReceived).toBe(2);

    // Cycle 2 -- the exact case that was broken: a SECOND flush cycle
    // after the component has already re-rendered once.
    await act(async () => {
      lastWorker.emit({ kind: "frame", frame: makeTrade({ trade_id: "3" }) });
      flushRaf();
    });
    expect(latest.trades.map((t) => t.trade_id)).toEqual(["3", "2", "1"]);
    expect(latest.stats.tradesReceived).toBe(3);

    // Cycle 3 -- confirm it keeps working, not just "recovers once".
    await act(async () => {
      lastWorker.emit({ kind: "frame", frame: makeTrade({ trade_id: "4" }) });
      lastWorker.emit({ kind: "frame", frame: makeTrade({ trade_id: "5" }) });
      flushRaf();
    });
    expect(latest.trades.map((t) => t.trade_id)).toEqual([
      "5",
      "4",
      "3",
      "2",
      "1",
    ]);
    expect(latest.stats.tradesReceived).toBe(5);
  });

  it("bar-update and bars-closed counters also accumulate across multiple cycles", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    const bar = (closed: boolean) => ({
      type: "bar" as const,
      symbol: "BTC-USDT",
      provider: "BINANCE" as const,
      marketKind: "SPOT" as const,
      interval_ms: 60_000,
      ts_open: 0,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      trade_count: 1,
      closed,
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: bar(false) });
      flushRaf();
    });
    expect(latest.stats.barUpdatesReceived).toBe(1);
    expect(latest.stats.barsClosed).toBe(0);

    await act(async () => {
      lastWorker.emit({ kind: "frame", frame: bar(true) });
      flushRaf();
    });
    expect(latest.stats.barUpdatesReceived).toBe(2);
    expect(latest.stats.barsClosed).toBe(1);
  });
});

describe("useMarketData -- TA.03.5 trade-to-bar correlation for onBar's second argument", () => {
  it("reconciles observed prints to source count and volume before reporting complete", async () => {
    const root = createRoot(document.createElement("div"));
    const deliveries: [readonly TradeFrame[], string | undefined][] = [];
    function CorrelationHarness() {
      useMarketData({
        url: "ws://test",
        onBar: (_bar, trades, availability) =>
          deliveries.push([[...trades], availability]),
      });
      return null;
    }
    try {
      await act(async () => root.render(<CorrelationHarness />));
      await act(async () => {
        confirmBaseSelection();
        lastWorker.emit({
          kind: "frame",
          frame: makeTrade({ trade_id: "a", size: 2 }),
        });
        lastWorker.emit({
          kind: "frame",
          frame: bar(0, { volume: 5, trade_count: 2, closed: false }),
        });
        flushRaf();
      });
      expect(deliveries.at(-1)?.[1]).toBe("LIVE_PARTIAL");
      await act(async () => {
        lastWorker.emit({
          kind: "frame",
          frame: makeTrade({ trade_id: "b", size: 3 }),
        });
        lastWorker.emit({
          kind: "frame",
          frame: makeTrade({ trade_id: "b", size: 3 }),
        });
        lastWorker.emit({
          kind: "frame",
          frame: bar(0, { volume: 5, trade_count: 2 }),
        });
        flushRaf();
      });
      expect(deliveries.at(-1)?.[0].map((trade) => trade.trade_id)).toEqual([
        "a",
        "b",
      ]);
      expect(deliveries.at(-1)?.[1]).toBe("LIVE_COMPLETE");
      await act(async () => {
        lastWorker.emit({
          kind: "frame",
          frame: bar(0, { volume: 6, trade_count: 2 }),
        });
        flushRaf();
      });
      expect(deliveries.at(-1)?.[1]).toBe("LIVE_PARTIAL");
    } finally {
      await act(async () => root.unmount());
    }
  });
  function bar(ts_open: number, overrides: Partial<BarFrame> = {}): BarFrame {
    return {
      type: "bar",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      interval_ms: 60_000,
      ts_open,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      trade_count: 1,
      closed: true,
      ...overrides,
    } as BarFrame;
  }

  it("hands onBar only the trades whose ts_exchange falls inside this bar's window", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const deliveries: [BarFrame, readonly TradeFrame[]][] = [];

    function BarHarness() {
      useMarketData({
        url: "ws://test",
        onBar: (b, trades) => deliveries.push([b, trades]),
      });
      return null;
    }

    await act(async () => {
      root.render(<BarHarness />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "in-window-1", ts_exchange: 0 }),
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "in-window-2", ts_exchange: 59_999 }),
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "out-of-window", ts_exchange: 60_000 }),
      });
      lastWorker.emit({ kind: "frame", frame: bar(0) });
      flushRaf();
    });

    expect(deliveries).toHaveLength(1);
    const [deliveredBar, tradesForBar] = deliveries[0];
    expect(deliveredBar.ts_open).toBe(0);
    expect(tradesForBar.map((t) => t.trade_id)).toEqual([
      "in-window-1",
      "in-window-2",
    ]);

    await act(async () => root.unmount());
    container.remove();
  });

  it("re-delivers the complete observed source-bar set when a live bar is updated again", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const deliveries: [BarFrame, readonly TradeFrame[]][] = [];

    function BarHarness() {
      useMarketData({
        url: "ws://test",
        onBar: (b, trades) => deliveries.push([b, trades]),
      });
      return null;
    }

    await act(async () => {
      root.render(<BarHarness />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "first", ts_exchange: 1 }),
      });
      lastWorker.emit({ kind: "frame", frame: bar(0, { closed: false }) });
      flushRaf();
    });
    expect(deliveries[0][1].map((trade) => trade.trade_id)).toEqual(["first"]);

    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "second", ts_exchange: 2 }),
      });
      lastWorker.emit({ kind: "frame", frame: bar(0, { closed: true }) });
      flushRaf();
    });
    expect(deliveries[1][1].map((trade) => trade.trade_id)).toEqual([
      "first",
      "second",
    ]);

    await act(async () => root.unmount());
    container.remove();
  });

  it("attributes a trade landing exactly on the next bar's open time to the new bar, not the old one", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const deliveries: [BarFrame, readonly TradeFrame[]][] = [];

    function BarHarness() {
      useMarketData({
        url: "ws://test",
        onBar: (b, trades) => deliveries.push([b, trades]),
      });
      return null;
    }

    await act(async () => {
      root.render(<BarHarness />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "boundary", ts_exchange: 60_000 }),
      });
      lastWorker.emit({ kind: "frame", frame: bar(0) });
      lastWorker.emit({ kind: "frame", frame: bar(60_000) });
      flushRaf();
    });

    expect(deliveries).toHaveLength(2);
    expect(deliveries[0][1]).toEqual([]);
    expect(deliveries[1][1].map((t) => t.trade_id)).toEqual(["boundary"]);

    await act(async () => root.unmount());
    container.remove();
  });

  it("gives an empty array to a bar with no trades in its window, and does not fault", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const deliveries: [BarFrame, readonly TradeFrame[]][] = [];

    function BarHarness() {
      useMarketData({
        url: "ws://test",
        onBar: (b, trades) => deliveries.push([b, trades]),
      });
      return null;
    }

    await act(async () => {
      root.render(<BarHarness />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: bar(0) });
      flushRaf();
    });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0][1]).toEqual([]);

    await act(async () => root.unmount());
    container.remove();
  });

  it("does not drop trades from a burst larger than the unrelated tape widget's own 500-row cap", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const deliveries: [BarFrame, readonly TradeFrame[]][] = [];

    function BarHarness() {
      useMarketData({
        url: "ws://test",
        onBar: (b, trades) => deliveries.push([b, trades]),
      });
      return null;
    }

    await act(async () => {
      root.render(<BarHarness />);
    });

    await act(async () => {
      confirmBaseSelection();
      for (let index = 0; index < 600; index += 1) {
        lastWorker.emit({
          kind: "frame",
          frame: makeTrade({ trade_id: String(index), ts_exchange: index }),
        });
      }
      lastWorker.emit({ kind: "frame", frame: bar(0) });
      flushRaf();
    });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0][1]).toHaveLength(600);

    await act(async () => root.unmount());
    container.remove();
  });

  it("carries an unconsumed trade over to the next flush when no matching bar has arrived yet", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const deliveries: [BarFrame, readonly TradeFrame[]][] = [];

    function BarHarness() {
      useMarketData({
        url: "ws://test",
        onBar: (b, trades) => deliveries.push([b, trades]),
      });
      return null;
    }

    await act(async () => {
      root.render(<BarHarness />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "early", ts_exchange: 0 }),
      });
      flushRaf();
    });
    expect(deliveries).toHaveLength(0);

    await act(async () => {
      lastWorker.emit({ kind: "frame", frame: bar(0) });
      flushRaf();
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0][1].map((t) => t.trade_id)).toEqual(["early"]);

    await act(async () => root.unmount());
    container.remove();
  });

  it("drains production-density late prints into retained closed bars instead of overflowing the global backlog", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    function BarHarness() {
      useMarketData({ url: "ws://test", onBar: () => {} });
      return null;
    }

    await act(async () => root.render(<BarHarness />));
    await act(async () => {
      confirmBaseSelection();
      for (let minute = 0; minute < 7; minute += 1) {
        const open = minute * 60_000;
        lastWorker.emit({
          kind: "frame",
          frame: bar(open, { volume: 2_000, trade_count: 2_000 }),
        });
        flushRaf();
        for (let index = 0; index < 2_000; index += 1) {
          lastWorker.emit({
            kind: "frame",
            frame: makeTrade({
              trade_id: `${minute}:${index}`,
              ts_exchange: open + index,
            }),
          });
        }
        flushRaf();
      }
      lastWorker.emit({
        kind: "frame",
        frame: bar(7 * 60_000, { volume: 0, trade_count: 1 }),
      });
      flushRaf();
    });

    expect(warn).not.toHaveBeenCalledWith(
      "useMarketData: live trade correlation backlog reached its bounded capacity",
      expect.anything(),
    );
    warn.mockRestore();
    await act(async () => root.unmount());
    container.remove();
  });

  it("clears the pending correlation buffer when the pair switches, so a stale trade cannot attribute to the new pair's bar", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const deliveries: [BarFrame, readonly TradeFrame[]][] = [];
    let latest!: UseMarketDataResult;

    function BarHarness() {
      latest = useMarketData({
        url: "ws://test",
        onBar: (b, trades) => deliveries.push([b, trades]),
      });
      return null;
    }

    await act(async () => {
      root.render(<BarHarness />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "stale", ts_exchange: 0 }),
      });
    });

    act(() => {
      latest.selectPair("ETH-USDT", {
        provider: "BINANCE",
        marketKind: "SPOT",
      });
    });

    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: selectionFrame("ETH-USDT", "SPOT"),
      });
      lastWorker.emit({ kind: "frame", frame: bar(0, { symbol: "ETH-USDT" }) });
      flushRaf();
    });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0][1]).toEqual([]);

    await act(async () => root.unmount());
    container.remove();
  });

  it("marks a duplicate close for an already-evicted bar LIVE_PARTIAL rather than a false LIVE_COMPLETE zero", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const deliveries: [BarFrame, readonly TradeFrame[], string | undefined][] =
      [];

    function BarHarness() {
      useMarketData({
        url: "ws://test",
        onBar: (b, trades, availability) =>
          deliveries.push([b, trades, availability]),
      });
      return null;
    }

    await act(async () => {
      root.render(<BarHarness />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "orig", ts_exchange: 0 }),
      });
      lastWorker.emit({ kind: "frame", frame: bar(0) });
      flushRaf();
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0][1].map((t) => t.trade_id)).toEqual(["orig"]);
    expect(deliveries[0][2]).toBe("LIVE_COMPLETE");

    // Close 5 more bars with no trades of their own -- enough to push bar 0's
    // trade record past MAX_RECENT_CLOSED_TRADE_SOURCE_BARS and evict it.
    await act(async () => {
      for (let index = 1; index <= 5; index += 1) {
        lastWorker.emit({ kind: "frame", frame: bar(index * 60_000) });
      }
      flushRaf();
    });
    deliveries.length = 0;

    // A late duplicate close for the now-evicted bar 0 arrives with no new
    // trades attached (as a transport repeat legitimately would).
    await act(async () => {
      lastWorker.emit({ kind: "frame", frame: bar(0) });
      flushRaf();
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0][0].ts_open).toBe(0);
    expect(deliveries[0][1]).toEqual([]);
    expect(deliveries[0][2]).toBe("LIVE_PARTIAL");

    await act(async () => root.unmount());
    container.remove();
  });
});

describe("useMarketData -- feed health, the P3.01 fourth frame kind", () => {
  it("starts as null -- honestly unknown before any health frame has arrived", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    expect(latest.feedHealth).toBeNull();
  });

  it("updates from a health frame, applied immediately (no rAF flush needed)", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "health",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          recoveryState: "RECOVERING",
          stale: true,
        },
      });
    });

    expect(latest.feedHealth).toEqual({
      recoveryState: "RECOVERING",
      stale: true,
      reason: undefined,
    });
  });

  it("carries an optional reason through when the backend supplies one", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "health",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          recoveryState: "UNAVAILABLE",
          stale: true,
          reason: "CONNECTION_DOWN",
        },
      });
    });

    expect(latest.feedHealth?.reason).toBe("CONNECTION_DOWN");
  });

  it("resets to null when the browser's own connection to the server closes -- a stale last-known value would be dishonest", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "health",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          recoveryState: "READY",
          stale: false,
        },
      });
    });
    expect(latest.feedHealth).not.toBeNull();

    Reflect.deleteProperty(window, "__ttConnectionCloses");
    await act(async () => {
      lastWorker.emit({ kind: "status", status: "closed", reason: "server-close:1013:slow" });
    });

    expect(latest.feedHealth).toBeNull();
    expect(window.__ttConnectionCloses?.counts).toEqual({ "server-close": 1 });
    expect(window.__ttConnectionCloses?.recent.at(-1)?.reason).toBe("server-close:1013:slow");
  });

  it("a health frame for a different pair than the confirmed selection is discarded", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection(); // BTC-USDT / SPOT
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "health",
          symbol: "ETH-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          recoveryState: "READY",
          stale: false,
        },
      });
    });

    expect(latest.feedHealth).toBeNull();
  });
});

describe("useMarketData -- order book, the P3.02 fifth frame kind", () => {
  it("starts as null -- honestly unknown before any book frame has arrived", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    expect(latest.book).toBeNull();
  });

  it("updates from a book frame after the rAF flush -- DEPTH is hot enough that per-message setState is the wrong throttle", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "book",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          status: "READY",
          bids: [{ price: 100, size: 1 }],
          asks: [{ price: 101, size: 2 }],
          lastUpdateId: 5,
          stale: false,
        },
      });
    });
    expect(latest.book).toBeNull();

    await act(async () => {
      flushRaf();
    });

    expect(latest.book?.status).toBe("READY");
    expect(latest.book?.bids).toEqual([{ price: 100, size: 1 }]);
  });

  it("a burst of book frames in one animation frame keeps only the latest -- the DOM does not need intermediate ladders", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    const book = (lastUpdateId: number) => ({
      type: "book" as const,
      symbol: "BTC-USDT",
      provider: "BINANCE" as const,
      marketKind: "SPOT" as const,
      status: "READY" as const,
      bids: [{ price: 100, size: 1 }],
      asks: [{ price: 101, size: 2 }],
      lastUpdateId,
      stale: false,
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: book(1) });
      lastWorker.emit({ kind: "frame", frame: book(2) });
      lastWorker.emit({ kind: "frame", frame: book(3) });
      flushRaf();
    });

    expect(latest.book?.lastUpdateId).toBe(3);
  });

  it("resets to null when the browser's own connection to the server closes -- a stale last-known book would be dishonest", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "book",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          status: "UNAVAILABLE",
          reason: "BUFFERING",
        },
      });
      flushRaf();
    });
    expect(latest.book).not.toBeNull();

    await act(async () => {
      lastWorker.emit({ kind: "status", status: "closed" });
    });

    expect(latest.book).toBeNull();
  });

  it("a book frame still pending rAF is dropped on close -- a later flush must not resurrect the last ladder", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "book",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          status: "READY",
          bids: [{ price: 100, size: 1 }],
          asks: [{ price: 101, size: 2 }],
          lastUpdateId: 5,
          stale: false,
        },
      });
      lastWorker.emit({ kind: "status", status: "closed" });
      flushRaf();
    });

    expect(latest.book).toBeNull();
  });

  it("a book frame for a different pair than the confirmed selection is discarded", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection(); // BTC-USDT / SPOT
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "book",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "PERPETUAL",
          status: "READY",
          bids: [{ price: 100, size: 1 }],
          asks: [{ price: 101, size: 2 }],
          lastUpdateId: 5,
          stale: false,
        },
      });
      flushRaf();
    });

    expect(latest.book).toBeNull();
  });
});

describe("useMarketData -- active selection and stale-frame discard, the P3.03 sixth frame kind", () => {
  it("starts as null -- honestly unknown before any selection frame has arrived", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    expect(latest.activeSelection).toBeNull();
  });

  it("updates from a real selection frame, applied immediately", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: selectionFrame("ETH-USDT", "PERPETUAL"),
      });
    });

    expect(latest.activeSelection).toEqual({
      symbol: "ETH-USDT",
      provider: "BINANCE",
      marketKind: "PERPETUAL",
    });
  });

  it("resets to null when the browser's own connection to the server closes", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
    });
    expect(latest.activeSelection).not.toBeNull();

    await act(async () => {
      lastWorker.emit({ kind: "status", status: "closed" });
    });

    expect(latest.activeSelection).toBeNull();
  });

  it("a trade for a different pair than the confirmed selection is discarded", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection(); // BTC-USDT / SPOT
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({
          symbol: "BTC-USDT",
          marketKind: "PERPETUAL",
          trade_id: "stale-1",
        }),
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({
          symbol: "ETH-USDT",
          marketKind: "SPOT",
          trade_id: "stale-2",
        }),
      });
      flushRaf();
    });

    expect(latest.trades).toEqual([]);
  });

  it("a bar for a different pair than the confirmed selection is discarded", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    const bars: unknown[] = [];

    function BarHarness() {
      const result = useMarketData({
        url: "ws://test",
        onBar: (b) => bars.push(b),
      });
      latest = result;
      return null;
    }

    await act(async () => {
      root.render(<BarHarness />);
    });

    await act(async () => {
      confirmBaseSelection(); // BTC-USDT / SPOT
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "bar",
          symbol: "ETH-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          interval_ms: 60_000,
          ts_open: 0,
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          volume: 1,
          trade_count: 1,
          closed: true,
        },
      });
      flushRaf();
    });

    expect(bars).toEqual([]);
    expect(latest.stats.barUpdatesReceived).toBe(0);
  });

  it("rAF coalescing never lets a late developing update overwrite a queued close for the same candle", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const deliveredBars: BarFrame[] = [];

    function BarHarness() {
      useMarketData({
        url: "ws://test",
        onBar: (bar) => deliveredBars.push(bar),
      });
      return null;
    }

    await act(async () => root.render(<BarHarness />));
    const frame = (closed: boolean, close: number): BarFrame => ({
      type: "bar",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      interval_ms: 60_000,
      ts_open: 0,
      open: 1,
      high: Math.max(1, close),
      low: Math.min(1, close),
      close,
      volume: 1,
      trade_count: 1,
      closed,
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: frame(true, 2) });
      lastWorker.emit({ kind: "frame", frame: frame(false, 999) });
      flushRaf();
    });

    expect(deliveredBars).toEqual([
      expect.objectContaining({ closed: true, close: 2 }),
    ]);
    await act(async () => root.unmount());
    container.remove();
  });

  it("selectPair() posts a select message to the worker and optimistically resets trades and book", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: makeTrade({ trade_id: "1" }) });
      flushRaf();
    });
    expect(latest.trades).toHaveLength(1);

    act(() => {
      latest.selectPair("ETH-USDT", {
        provider: "BINANCE",
        marketKind: "PERPETUAL",
      });
    });

    expect(latest.trades).toEqual([]);
    expect(latest.book).toBeNull();
    expect(lastWorker.posted).toContainEqual(
      expect.objectContaining({
        kind: "select",
        symbol: "ETH-USDT",
        provider: "BINANCE",
        marketKind: "PERPETUAL",
        selectionTrace: expect.objectContaining({
          runId: expect.any(String),
          selectionGeneration: 1,
          requestedAtMs: expect.any(Number),
        }),
      }),
    );
    // activeSelection is untouched by the optimistic request -- only a
    // real matching selection frame back from the server should ever set it.
    expect(latest.activeSelection).toEqual({
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
    });
  });

  it("resets status-bar counters with the instrument generation instead of attributing old-pair activity to the new pair", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(
        <Harness
          onReady={(result) => {
            latest = result;
          }}
        />,
      );
    });
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "btc-1" }),
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "btc-2" }),
      });
      flushRaf();
    });
    expect(latest.stats.tradesReceived).toBe(2);

    await act(async () => {
      latest.selectPair("ETH-USDT", {
        provider: "BINANCE",
        marketKind: "PERPETUAL",
      });
    });
    expect(latest.stats).toEqual({
      tradesReceived: 0,
      barUpdatesReceived: 0,
      barsClosed: 0,
      latencyMs: null,
    });

    await act(async () => root.unmount());
    container.remove();
  });

  it("selectPair() called with the already-confirmed pair is a true no-op -- no optimistic reset, no spurious flicker to empty", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection(); // BTC-USDT / SPOT
      lastWorker.emit({ kind: "frame", frame: makeTrade({ trade_id: "1" }) });
      flushRaf();
    });
    expect(latest.trades).toHaveLength(1);
    const postsBeforeNoOp = lastWorker.posted.length;

    // A same-pair request is a server-side no-op that sends no selection
    // frame back -- if the optimistic reset fired here anyway, trades/
    // book/health would clear immediately and only self-correct once the
    // next real frame happens to arrive, a visible flicker for no reason.
    act(() => {
      latest.selectPair("BTC-USDT", {
        provider: "BINANCE",
        marketKind: "SPOT",
      });
    });

    expect(latest.trades).toHaveLength(1);
    expect(lastWorker.posted).toHaveLength(postsBeforeNoOp);
  });

  it("a forced same-pair selection is forwarded so an unavailable dxFeed session can be restarted manually", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(result) => (latest = result)} />);
    });
    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "selection",
          symbol: "AAPL",
          provider: "DXFEED",
          assetClass: "EQUITY",
        },
      });
    });
    const postsBeforeRestart = lastWorker.posted.length;

    act(() =>
      latest.selectPair(
        "AAPL",
        { provider: "DXFEED", assetClass: "EQUITY" },
        true,
      ),
    );

    expect(lastWorker.posted).toHaveLength(postsBeforeRestart + 1);
    expect(lastWorker.posted).toContainEqual(
      expect.objectContaining({
        kind: "select",
        symbol: "AAPL",
        provider: "DXFEED",
        assetClass: "EQUITY",
        selectionTrace: expect.objectContaining({
          runId: expect.any(String),
          selectionGeneration: 1,
          requestedAtMs: expect.any(Number),
        }),
      }),
    );
  });

  it("keeps an unconfirmed desired selection across reconnect and rejects the server's stale initial selection", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });
    await act(async () => {
      confirmBaseSelection();
    });
    act(() =>
      latest.selectPair("ETH-USDT", {
        provider: "BINANCE",
        marketKind: "PERPETUAL",
      }),
    );

    await act(async () => {
      lastWorker.emit({ kind: "status", status: "closed" });
      lastWorker.emit({ kind: "status", status: "open" });
      lastWorker.emit({
        kind: "frame",
        frame: selectionFrame("BTC-USDT", "SPOT"),
      });
    });
    expect(latest.activeSelection).toBeNull();

    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: selectionFrame("ETH-USDT", "PERPETUAL"),
      });
    });
    expect(latest.activeSelection).toEqual({
      symbol: "ETH-USDT",
      provider: "BINANCE",
      marketKind: "PERPETUAL",
    });
  });

  it("retains a previously confirmed selection as the reconnect barrier and rejects a stale shared-terminal view", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () =>
      root.render(<Harness onReady={(result) => (latest = result)} />),
    );
    await act(async () => confirmBaseSelection());

    await act(async () => {
      lastWorker.emit({ kind: "status", status: "closed" });
      lastWorker.emit({ kind: "status", status: "open" });
      lastWorker.emit({
        kind: "frame",
        frame: selectionFrame("ETH-USDT", "SPOT"),
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ symbol: "ETH-USDT", trade_id: "stale-shared-view" }),
      });
      flushRaf();
    });
    expect(latest.activeSelection).toBeNull();
    expect(latest.trades).toEqual([]);

    await act(async () =>
      lastWorker.emit({
        kind: "frame",
        frame: selectionFrame("BTC-USDT", "SPOT"),
      }),
    );
    expect(latest.activeSelection).toEqual({
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
    });
    root.unmount();
    container.remove();
  });

  it("treats a forced same-pair request as a generation barrier until its selection acknowledgement", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () =>
      root.render(<Harness onReady={(result) => (latest = result)} />),
    );
    await act(async () => confirmBaseSelection());
    act(() =>
      latest.selectPair(
        "BTC-USDT",
        { provider: "BINANCE", marketKind: "SPOT" },
        true,
      ),
    );

    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "pre-ack" }),
      });
      flushRaf();
    });
    expect(latest.trades).toEqual([]);

    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: selectionFrame("BTC-USDT", "SPOT"),
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "post-ack" }),
      });
      flushRaf();
    });
    expect(latest.trades.map((trade) => trade.trade_id)).toEqual(["post-ack"]);
    root.unmount();
    container.remove();
  });

  it("displays snapshot trades newest-first, matching the ordering of later live batches", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "snapshot",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          bars: [],
          trades: [
            makeTrade({ trade_id: "1" }),
            makeTrade({ trade_id: "2" }),
            makeTrade({ trade_id: "3" }),
          ],
          markers: [],
        },
      });
    });

    expect(latest.trades.map((trade) => trade.trade_id)).toEqual([
      "3",
      "2",
      "1",
    ]);
  });

  it("a trade for the previously selected pair arriving after selectPair() is discarded even though the server has not confirmed the new pair yet", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: makeTrade({ trade_id: "1" }) });
      flushRaf();
    });
    expect(latest.trades).toHaveLength(1);

    act(() => {
      latest.selectPair("ETH-USDT", {
        provider: "BINANCE",
        marketKind: "SPOT",
      });
    });

    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({
          symbol: "BTC-USDT",
          marketKind: "SPOT",
          trade_id: "stale-btc",
        }),
      });
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "book",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          status: "READY",
          bids: [{ price: 100, size: 1 }],
          asks: [{ price: 101, size: 2 }],
          lastUpdateId: 9,
          stale: false,
        },
      });
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "health",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          recoveryState: "READY",
          stale: false,
        },
      });
      flushRaf();
    });

    expect(latest.trades).toEqual([]);
    expect(latest.book).toBeNull();
    expect(latest.feedHealth).toBeNull();
  });

  it("selectPair() clears the previous pair's feedHealth so a degraded old pair cannot paint over the new pair's waiting overlay", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "health",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          recoveryState: "UNAVAILABLE",
          stale: true,
          reason: "CONNECTION_DOWN",
        },
      });
    });
    expect(latest.feedHealth?.recoveryState).toBe("UNAVAILABLE");

    act(() => {
      latest.selectPair("ETH-USDT", {
        provider: "BINANCE",
        marketKind: "SPOT",
      });
    });

    expect(latest.feedHealth).toBeNull();
  });

  it("selectPair() discards queued-but-not-yet-flushed trades and bars from the lifetime stats totals, not just from the visible trades/book", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
    });

    // Two trades and a closed bar arrive and are queued for the next rAF
    // flush, but the flush hasn't run yet -- switching now must not let
    // their counts leak into stats once a later flush finally fires.
    act(() => {
      lastWorker.emit({ kind: "frame", frame: makeTrade({ trade_id: "1" }) });
      lastWorker.emit({ kind: "frame", frame: makeTrade({ trade_id: "2" }) });
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "bar",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          interval_ms: 60_000,
          ts_open: 0,
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          volume: 1,
          trade_count: 1,
          closed: true,
        },
      });
      latest.selectPair("ETH-USDT", {
        provider: "BINANCE",
        marketKind: "SPOT",
      });
    });

    act(() => {
      flushRaf();
    });

    expect(latest.stats.tradesReceived).toBe(0);
    expect(latest.stats.barUpdatesReceived).toBe(0);
    expect(latest.stats.barsClosed).toBe(0);
  });

  it("a rapid double-switch (ETH then immediately back to BTC) ends in the correct confirmed selection with no stale trades leaking through", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    const snapshots: { symbol: string }[][] = [];

    function SnapshotHarness({
      onReady,
    }: {
      onReady: (r: UseMarketDataResult) => void;
    }) {
      const result = useMarketData({
        url: "ws://test",
        onSnapshotBars: (bars) =>
          snapshots.push(bars.map((b) => ({ symbol: b.symbol }))),
      });
      onReady(result);
      return null;
    }

    await act(async () => {
      root.render(<SnapshotHarness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection(); // BTC-USDT / SPOT
    });

    act(() => {
      latest.selectPair("ETH-USDT", {
        provider: "BINANCE",
        marketKind: "SPOT",
      });
      latest.selectPair("BTC-USDT", {
        provider: "BINANCE",
        marketKind: "SPOT",
      });
    });

    // Real server ordering: ETH's selection+snapshot can still be in
    // flight when the BTC request is already the pending one. Those
    // intermediate frames must not paint -- snapshots have no pair tag,
    // so this is the case the pendingRequest gate exists for.
    const ethBar = {
      type: "bar" as const,
      symbol: "ETH-USDT",
      provider: "BINANCE" as const,
      marketKind: "SPOT" as const,
      interval_ms: 60_000,
      ts_open: 0,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      trade_count: 1,
      closed: true,
    };
    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: selectionFrame("ETH-USDT", "SPOT"),
      });
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "snapshot",
          symbol: "ETH-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          bars: [ethBar],
          trades: [],
          markers: [],
        },
      });
      lastWorker.emit({
        kind: "frame",
        frame: selectionFrame("BTC-USDT", "SPOT"),
      });
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "snapshot",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          bars: [],
          trades: [],
          markers: [],
        },
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({
          symbol: "ETH-USDT",
          marketKind: "SPOT",
          trade_id: "stale-eth",
        }),
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({
          symbol: "BTC-USDT",
          marketKind: "SPOT",
          trade_id: "real-btc",
        }),
      });
      flushRaf();
    });

    expect(latest.activeSelection).toEqual({
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
    });
    expect(
      snapshots.some((bars) => bars.some((b) => b.symbol === "ETH-USDT")),
    ).toBe(false);
    expect(latest.trades.map((t) => t.trade_id)).toEqual(["real-btc"]);
  });
});

describe("useMarketData -- DX3.04 cross-provider contamination discard", () => {
  // Why only two history windows are retained: a visible history request is
  // capped at 64 periods and each frame at 300 rows, so keeping more would let a
  // long pan session grow the browser into an ever-larger collection of canvas
  // rectangles. Off-screen zones are cheap to request again from the runtime
  // cache, so dropping them costs a refetch rather than data.
  it("preserves snapshot history coverage for the presentation layer and clears it with the pair state", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "snapshot",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          bars: [],
          trades: [],
          markers: [],
          bar_history: {
            availability: "AVAILABLE",
            requestedStartTsOpen: 0,
            earliestObservedTsOpen: 60_000,
            coverage: "START_NOT_COVERED",
            interpretation: "OBSERVED_NONEMPTY_BARS_ONLY",
          },
        },
      });
    });

    expect(latest.barHistory?.coverage).toBe("START_NOT_COVERED");
    await act(async () => {
      latest.selectPair("ETH-USDT", {
        provider: "BINANCE",
        marketKind: "SPOT",
      });
    });
    expect(latest.barHistory).toBeNull();
  });

  it("a trade with the confirmed selection's exact symbol but a different provider is discarded", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection(); // BTC-USDT / BINANCE / SPOT
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "trade",
          symbol: "BTC-USDT",
          provider: "DXFEED",
          assetClass: "EQUITY",
          ts_exchange: 1,
          price: 100,
          size: 1,
          side: "buy",
          trade_id: "wrong-provider",
        },
      });
      flushRaf();
    });

    expect(latest.trades).toEqual([]);
  });

  it("a snapshot for the confirmed selection's exact symbol but a different provider is not applied", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection(); // BTC-USDT / BINANCE / SPOT
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "snapshot",
          symbol: "BTC-USDT",
          provider: "DXFEED",
          assetClass: "EQUITY",
          bars: [],
          trades: [makeTrade({ trade_id: "wrong-provider-snapshot" })],
          markers: [],
        },
      });
    });

    expect(latest.trades).toEqual([]);
  });

  it("a health frame for the confirmed selection's exact symbol but a different provider is discarded", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection(); // BTC-USDT / BINANCE / SPOT
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "health",
          symbol: "BTC-USDT",
          provider: "DXFEED",
          assetClass: "EQUITY",
          recoveryState: "READY",
          stale: false,
        },
      });
    });

    expect(latest.feedHealth).toBeNull();
  });

  it("a pending switch to a dxFeed symbol rejects a stale Binance selection frame for the previously confirmed pair", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });
    await act(async () => {
      confirmBaseSelection(); // BTC-USDT / BINANCE / SPOT
    });

    act(() => {
      latest.selectPair("AAPL", { provider: "DXFEED", assetClass: "EQUITY" });
    });

    await act(async () => {
      // A stale re-announcement of the pair being switched away from --
      // must not be mistaken for a confirmation of the new request, and
      // must leave the still-genuinely-active previous pair in place.
      lastWorker.emit({
        kind: "frame",
        frame: selectionFrame("BTC-USDT", "SPOT"),
      });
    });
    expect(latest.activeSelection).toEqual({
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
    });

    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "selection",
          symbol: "AAPL",
          provider: "DXFEED",
          assetClass: "EQUITY",
        },
      });
    });
    expect(latest.activeSelection).toEqual({
      symbol: "AAPL",
      provider: "DXFEED",
      assetClass: "EQUITY",
    });
  });
});

describe("useMarketData -- adversarial lifecycle and burst handling", () => {
  it("clears already-rendered tape, markers, and chart history on disconnect instead of presenting frozen data as current", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    const snapshots: BarFrame[][] = [];

    function DisconnectHarness() {
      latest = useMarketData({
        url: "ws://test",
        onSnapshotBars: (bars) => snapshots.push(bars),
      });
      return null;
    }

    await act(async () => {
      root.render(<DisconnectHarness />);
    });
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "snapshot",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          bars: [
            {
              type: "bar",
              symbol: "BTC-USDT",
              provider: "BINANCE",
              marketKind: "SPOT",
              interval_ms: 60_000,
              ts_open: 0,
              open: 1,
              high: 1,
              low: 1,
              close: 1,
              volume: 1,
              trade_count: 1,
              closed: true,
            },
          ],
          trades: [],
          markers: [],
        },
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "live-before-close" }),
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeMarker({ trade_id: "marker-before-close" }),
      });
      flushRaf();
    });
    expect(latest.trades).toHaveLength(1);
    expect(latest.markerView.snapshot()).toHaveLength(1);
    expect(snapshots.at(-1)).not.toEqual([]);

    await act(async () => {
      lastWorker.emit({ kind: "status", status: "closed" });
    });

    expect(latest.trades).toEqual([]);
    expect(latest.markerView.snapshot()).toEqual([]);
    expect(latest.book).toBeNull();
    expect(latest.activeSelection).toBeNull();
    expect(snapshots.at(-1)).toEqual([]);
    await act(async () => root.unmount());
  });

  it("drops queued trade and bar work on disconnect so a delayed rAF cannot repopulate disconnected state", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    const deliveredBars: unknown[] = [];

    function BarHarness() {
      latest = useMarketData({
        url: "ws://test",
        onBar: (bar) => deliveredBars.push(bar),
      });
      return null;
    }

    await act(async () => {
      root.render(<BarHarness />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "queued" }),
      });
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "bar",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          interval_ms: 60_000,
          ts_open: 0,
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          volume: 1,
          trade_count: 1,
          closed: true,
        },
      });
      lastWorker.emit({ kind: "status", status: "closed" });
      flushRaf();
    });

    expect(latest.trades).toEqual([]);
    expect(deliveredBars).toEqual([]);
    expect(latest.stats).toMatchObject({
      tradesReceived: 0,
      barUpdatesReceived: 0,
      barsClosed: 0,
    });
  });

  it("clears the prior pair immediately when the server announces an externally initiated selection", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    const snapshots: BarFrame[][] = [];

    function SelectionHarness() {
      latest = useMarketData({
        url: "ws://test",
        onSnapshotBars: (bars) => snapshots.push(bars),
      });
      return null;
    }

    await act(async () => {
      root.render(<SelectionHarness />);
    });
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: makeTrade({ trade_id: "btc" }) });
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "health",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          recoveryState: "READY",
          stale: false,
        },
      });
      flushRaf();
      lastWorker.emit({
        kind: "frame",
        frame: selectionFrame("ETH-USDT", "SPOT"),
      });
    });

    expect(latest.activeSelection).toEqual({
      symbol: "ETH-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
    });
    expect(latest.trades).toEqual([]);
    expect(latest.book).toBeNull();
    expect(latest.feedHealth).toBeNull();
    expect(snapshots.at(-1)).toEqual([]);
  });

  it("bounds a trade burst to the most recent displayable records while keeping received statistics exact", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(result) => (latest = result)} />);
    });
    await act(async () => {
      confirmBaseSelection();
      for (let index = 0; index < 501; index += 1) {
        lastWorker.emit({
          kind: "frame",
          frame: makeTrade({ trade_id: String(index) }),
        });
      }
      flushRaf();
    });

    expect(latest.trades).toHaveLength(60);
    expect(latest.trades[0]?.trade_id).toBe("500");
    expect(latest.stats.tradesReceived).toBe(501);
  });

  it("drops a replayed live trade ID without duplicating the tape or lifetime statistics", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(result) => (latest = result)} />);
    });
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "replayed" }),
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "replayed", price: 101 }),
      });
      flushRaf();
    });

    expect(latest.trades.map((trade) => trade.trade_id)).toEqual(["replayed"]);
    expect(latest.trades[0]?.price).toBe(100);
    expect(latest.stats.tradesReceived).toBe(1);
  });

  it("orders an out-of-order snapshot and subsequent live burst by exchange time, not WebSocket arrival", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(result) => (latest = result)} />);
    });
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "snapshot",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          bars: [],
          markers: [],
          trades: [
            makeTrade({ trade_id: "100", ts_exchange: 100 }),
            makeTrade({ trade_id: "300", ts_exchange: 300 }),
            makeTrade({ trade_id: "200", ts_exchange: 200 }),
          ],
        },
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "250", ts_exchange: 250 }),
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "400", ts_exchange: 400 }),
      });
      flushRaf();
    });

    expect(latest.trades.map((trade) => trade.trade_id)).toEqual([
      "400",
      "300",
      "250",
      "200",
      "100",
    ]);
  });

  it("does not replay a trade that was already delivered in the current snapshot", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    const snapshotted = makeTrade({ trade_id: "snapshot-id" });

    await act(async () => {
      root.render(<Harness onReady={(result) => (latest = result)} />);
    });
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "snapshot",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          bars: [],
          trades: [snapshotted],
          markers: [],
        },
      });
      lastWorker.emit({ kind: "frame", frame: { ...snapshotted } });
      flushRaf();
    });

    expect(latest.trades.map((trade) => trade.trade_id)).toEqual([
      "snapshot-id",
    ]);
    expect(latest.stats.tradesReceived).toBe(0);
  });
});

describe("useMarketData -- markers, the P4.01 large-trade-detector frame kind", () => {
  it("accumulates markers across multiple rAF flush cycles in chronological order", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeMarker({ trade_id: "1", ts_exchange: 1 }),
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeMarker({ trade_id: "2", ts_exchange: 60_001 }),
      });
      flushRaf();
    });
    expect(
      latest.markerView.snapshot().map((m: MarkerFrame) => m.trade_id),
    ).toEqual(["1", "2"]);

    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: makeMarker({ trade_id: "3", ts_exchange: 120_001 }),
      });
      flushRaf();
    });
    expect(
      latest.markerView.snapshot().map((m: MarkerFrame) => m.trade_id),
    ).toEqual(["1", "2", "3"]);
  });

  // Property: a marker_history page with reset replaces everything held for the
  // pair, a page without reset appends, and a same-pair snapshot merges its
  // inline markers instead of wiping the paged history behind it. Oracle: the
  // set of trade ids the view reports after each step, and the version counter.
  it("marker history pages reset then append, and a same-pair snapshot merges rather than wipes", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    const page = (
      reset: boolean,
      seq: number,
      ids: Array<[string, number]>,
    ): ServerFrame => ({
      type: "marker_history",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      reset,
      seq,
      markers: ids.map(([trade_id, ts]) =>
        makeMarker({ trade_id, ts_exchange: ts }),
      ),
    });
    const snapshotWith = (ids: Array<[string, number]>): ServerFrame => ({
      type: "snapshot",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      bars: [],
      trades: [],
      markers: ids.map(([trade_id, ts]) =>
        makeMarker({ trade_id, ts_exchange: ts }),
      ),
    });
    const ids = () =>
      latest.markerView.snapshot().map((m: MarkerFrame) => m.trade_id);

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeMarker({ trade_id: "live-before", ts_exchange: 5 }),
      });
      flushRaf();
    });
    expect(ids()).toEqual(["live-before"]);

    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: snapshotWith([["inline-1", 70_000]]),
      });
      lastWorker.emit({
        kind: "frame",
        frame: page(true, 0, [
          ["h-1", 10],
          ["h-2", 60_010],
          ["inline-1", 70_000],
        ]),
      });
      lastWorker.emit({
        kind: "frame",
        frame: page(false, 1, [["h-3", 130_000]]),
      });
      flushRaf();
    });
    expect(ids()).toEqual(["h-1", "h-2", "inline-1", "h-3"]);
    const versionAfterPages = latest.markersVersion;

    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: snapshotWith([["inline-2", 190_000]]),
      });
      flushRaf();
    });
    expect(ids()).toEqual(["h-1", "h-2", "inline-1", "h-3", "inline-2"]);
    expect(latest.markersVersion).toBeGreaterThan(versionAfterPages);

    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: makeMarker({ trade_id: "h-3", ts_exchange: 130_000 }),
      });
      lastWorker.emit({
        kind: "frame",
        frame: page(false, 2, [["h-3", 130_000]]),
      });
      flushRaf();
    });
    expect(ids()).toEqual(["h-1", "h-2", "inline-1", "h-3", "inline-2"]);

    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: page(true, 0, [["fresh", 250_000]]),
      });
      flushRaf();
    });
    expect(ids()).toEqual(["fresh"]);
    expect(latest.markerView.size()).toBe(1);
    expect(
      latest.markerView
        .topByMagnitude(5)
        .stats.map((stat) => stat.marker.trade_id),
    ).toEqual(["fresh"]);
  });

  it("dedupes live markers by trade_id -- a duplicate delivery of the same trade is dropped", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: makeMarker({ trade_id: "1" }) });
      lastWorker.emit({ kind: "frame", frame: makeMarker({ trade_id: "1" }) }); // exact duplicate, dropped
      lastWorker.emit({ kind: "frame", frame: makeMarker({ trade_id: "2" }) });
      flushRaf();
    });

    expect(
      latest.markerView.snapshot().map((m: MarkerFrame) => m.trade_id),
    ).toEqual(["1", "2"]);
  });

  it("does not silently discard a marker burst larger than the old pre-paint queue cap", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(result) => (latest = result)} />);
    });
    await act(async () => {
      confirmBaseSelection();
      for (let index = 0; index < 5_001; index += 1) {
        lastWorker.emit({
          kind: "frame",
          frame: makeMarker({
            trade_id: `burst-${index}`,
            ts_exchange: index * 60_000,
          }),
        });
      }
      flushRaf();
    });

    expect(latest.markerView.snapshot()).toHaveLength(5_001);
    expect(latest.markerView.snapshot()[0]?.trade_id).toBe("burst-0");
    expect(latest.markerView.snapshot().at(-1)?.trade_id).toBe("burst-5000");
  });

  it("drops a marker for the wrong pair, same discard discipline as trade/bar/book/health", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeMarker({
          symbol: "ETH-USDT",
          marketKind: "SPOT",
          trade_id: "wrong-pair",
        }),
      });
      flushRaf();
    });

    expect(latest.markerView.snapshot()).toEqual([]);
  });

  it("a snapshot seeds markers directly and re-arms dedup so a replayed live marker from before reconnect is ignored", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    const snapshotted = makeMarker({ trade_id: "snap-1" });
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "snapshot",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          bars: [],
          trades: [],
          markers: [snapshotted],
        },
      });
      lastWorker.emit({ kind: "frame", frame: { ...snapshotted } });
      flushRaf();
    });

    expect(
      latest.markerView.snapshot().map((m: MarkerFrame) => m.trade_id),
    ).toEqual(["snap-1"]);
  });

  it("a pair switch clears markers the same way it clears trades", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: makeMarker({ trade_id: "1" }) });
      flushRaf();
    });
    expect(latest.markerView.snapshot()).toHaveLength(1);

    await act(async () => {
      latest.selectPair("ETH-USDT", {
        provider: "BINANCE",
        marketKind: "SPOT",
      });
    });
    expect(latest.markerView.snapshot()).toEqual([]);
  });
});

describe("createBoundedIdTracker", () => {
  it("deduplicates within the bounded window and admits an identifier again only after FIFO eviction", () => {
    const tracker = createBoundedIdTracker(3);
    expect(tracker.remember("a")).toBe(true);
    expect(tracker.remember("b")).toBe(true);
    expect(tracker.remember("c")).toBe(true);
    expect(tracker.remember("a")).toBe(false);
    expect(tracker.remember("d")).toBe(true);
    expect(tracker.remember("a")).toBe(true);
    expect(tracker.remember("b")).toBe(true);
    tracker.clear();
    expect(tracker.remember("a")).toBe(true);
  });

  it("rejects unsafe capacities instead of creating an unbounded tracker", () => {
    expect(() => createBoundedIdTracker(0)).toThrow(/positive safe integer/);
    expect(() => createBoundedIdTracker(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /positive safe integer/,
    );
  });
});

function makeProfile(overrides: Partial<Record<string, unknown>> = {}) {
  const mode = overrides.mode === "fixed_range" ? "fixed_range" : "continuous";
  return {
    type: "profile" as const,
    symbol: "BTC-USDT",
    provider: "BINANCE" as const,
    marketKind: "SPOT" as const,
    mode,
    delivery_scope:
      mode === "fixed_range" ? ("FIXED_RANGE" as const) : ("LIVE" as const),
    history_request_id: null,
    period_start_ts: 1000,
    period_end_ts: null,
    row_width: 1,
    buckets: [
      {
        price: 100,
        volume: 5,
        buy_volume: 3,
        sell_volume: 2,
        single_print: false,
      },
    ],
    poc_price: 100,
    vah_price: 100,
    val_price: 100,
    ...overrides,
  };
}

describe("useMarketData -- volume profile, the P4.09 frame kind", () => {
  it("withdraws published and queued live analytics on query failure, filters other identities, and recovers", async () => {
    const root = createRoot(document.createElement("div"));
    let latest!: UseMarketDataResult;
    const status = (
      indicator: "PROFILE" | "VPIN",
      value: "READY" | "UNAVAILABLE",
    ) => ({
      type: "analytics_status" as const,
      symbol: "BTC-USDT",
      provider: "BINANCE" as const,
      marketKind: "SPOT" as const,
      indicator,
      status: value,
    });
    try {
      await act(async () =>
        root.render(
          <Harness
            onReady={(value) => {
              latest = value;
            }}
          />,
        ),
      );
      await act(async () => {
        confirmBaseSelection();
        lastWorker.emit({ kind: "frame", frame: makeProfile() as never });
        lastWorker.emit({ kind: "frame", frame: makeVpin() as never });
        flushRaf();
      });
      expect(latest.profile).not.toBeNull();
      expect(latest.vpinHistory.length).toBeGreaterThan(0);
      await act(async () => {
        lastWorker.emit({ kind: "frame", frame: makeProfile() as never });
        lastWorker.emit({ kind: "frame", frame: makeVpin() as never });
        lastWorker.emit({
          kind: "frame",
          frame: status("PROFILE", "UNAVAILABLE"),
        });
        lastWorker.emit({
          kind: "frame",
          frame: status("VPIN", "UNAVAILABLE"),
        });
        flushRaf();
      });
      expect(latest.profile).toBeNull();
      expect(latest.vpinHistory).toEqual([]);
      expect(latest.vpinStatus).toBe("UNAVAILABLE");
      await act(async () =>
        lastWorker.emit({
          kind: "frame",
          frame: { ...status("PROFILE", "READY"), symbol: "ETH-USDT" },
        }),
      );
      expect(latest.analyticsStatus?.PROFILE).toBe("UNAVAILABLE");
      await act(async () => {
        lastWorker.emit({ kind: "frame", frame: status("PROFILE", "READY") });
        lastWorker.emit({ kind: "frame", frame: makeProfile() as never });
        flushRaf();
      });
      expect(latest.profile).not.toBeNull();
      await act(async () =>
        lastWorker.emit({ kind: "status", status: "closed" }),
      );
      expect(latest.analyticsStatus).toEqual({});
      expect(latest.profile).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("starts as null -- honestly unknown before any profile frame has arrived", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    expect(latest.profile).toBeNull();
  });

  it("updates from a profile frame after the rAF flush, batched the same way book is", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: makeProfile() as never });
    });
    expect(latest.profile).toBeNull();

    await act(async () => {
      flushRaf();
    });

    expect(latest.profile?.poc_price).toBe(100);
  });

  it("a burst of profile frames in one animation frame keeps only the latest", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeProfile({
          poc_price: 100,
          vah_price: 100,
          val_price: 100,
        }) as never,
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeProfile({
          poc_price: 200,
          vah_price: 200,
          val_price: 200,
          buckets: [
            {
              price: 200,
              volume: 5,
              buy_volume: 3,
              sell_volume: 2,
              single_print: false,
            },
          ],
        }) as never,
      });
      flushRaf();
    });

    expect(latest.profile?.poc_price).toBe(200);
  });

  it("resets to null when the browser's connection to the server closes", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: makeProfile() as never });
      flushRaf();
    });
    expect(latest.profile).not.toBeNull();

    await act(async () => {
      lastWorker.emit({ kind: "status", status: "closed" });
    });

    expect(latest.profile).toBeNull();
  });

  it("discards a profile frame for a symbol other than the confirmed active pair", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeProfile({ symbol: "ETH-USDT" }) as never,
      });
      flushRaf();
    });

    expect(latest.profile).toBeNull();
  });

  it("clears to null on a pair switch, the same reset every other live frame kind gets", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: makeProfile() as never });
      flushRaf();
    });
    expect(latest.profile).not.toBeNull();

    await act(async () => {
      latest.selectPair("ETH-USDT", {
        provider: "BINANCE",
        marketKind: "SPOT",
      });
    });
    expect(latest.profile).toBeNull();
  });

  it("sendProfileConfig posts a profile_config message to the worker", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      latest.sendProfileConfig({
        mode: "per_candle",
        period_ms: 60_000,
        bin_size_multiplier: 1,
        range_start_ts: null,
        range_end_ts: null,
      });
    });

    expect(lastWorker.posted).toContainEqual({
      kind: "profile_config",
      mode: "per_candle",
      period_ms: 60_000,
      bin_size_multiplier: 1,
      range_start_ts: null,
      range_end_ts: null,
    });
  });
});

describe("useMarketData -- historical volume profile zones (fixed_range frames)", () => {
  it("starts as an empty array -- honestly unknown before any zone has arrived", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    expect(latest.historicalProfiles).toEqual([]);
  });

  it("a fixed_range frame populates historicalProfiles, not the live profile slot", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeProfile({
          mode: "fixed_range",
          period_start_ts: 1000,
        }) as never,
      });
      flushRaf();
    });

    expect(latest.profile).toBeNull();
    expect(latest.historicalProfiles).toHaveLength(1);
    expect(latest.historicalProfiles[0]?.period_start_ts).toBe(1000);
  });

  it("a continuous-mode frame does not leak into historicalProfiles -- it stays exclusively in profile", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeProfile({
          mode: "continuous",
          period_start_ts: 2000,
        }) as never,
      });
      flushRaf();
    });

    expect(latest.profile?.period_start_ts).toBe(2000);
    expect(latest.historicalProfiles).toEqual([]);
  });

  it("routes a per-candle historical frame by delivery scope without falsifying its calculation mode", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeProfile({
          mode: "per_candle",
          delivery_scope: "HISTORICAL",
          history_request_id: 7,
          period_start_ts: 2000,
          period_end_ts: 3000,
        }) as never,
      });
      flushRaf();
    });

    expect(latest.profile).toBeNull();
    expect(latest.historicalProfiles).toHaveLength(1);
    expect(latest.historicalProfiles[0]).toMatchObject({
      mode: "per_candle",
      delivery_scope: "HISTORICAL",
      history_request_id: 7,
    });
  });

  it("multiple fixed_range frames with different period_start_ts all accumulate together, not overwrite each other", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeProfile({
          mode: "fixed_range",
          period_start_ts: 1000,
        }) as never,
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeProfile({
          mode: "fixed_range",
          period_start_ts: 2000,
        }) as never,
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeProfile({
          mode: "fixed_range",
          period_start_ts: 3000,
        }) as never,
      });
      flushRaf();
    });

    expect(
      latest.historicalProfiles
        .map((p) => p.period_start_ts)
        .sort((a, b) => a - b),
    ).toEqual([1000, 2000, 3000]);
  });

  it("a fixed_range frame with the same period_start_ts as an existing entry updates it in place, not a duplicate", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeProfile({
          mode: "fixed_range",
          period_start_ts: 1000,
          poc_price: 100,
        }) as never,
      });
      flushRaf();
    });
    expect(latest.historicalProfiles).toHaveLength(1);

    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: makeProfile({
          mode: "fixed_range",
          period_start_ts: 1000,
          poc_price: 150,
        }) as never,
      });
      flushRaf();
    });

    expect(latest.historicalProfiles).toHaveLength(1);
    expect(latest.historicalProfiles[0]?.poc_price).toBe(150);
  });

  it("resets to an empty array on a pair switch, the same reset every other live frame kind gets", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeProfile({
          mode: "fixed_range",
          period_start_ts: 1000,
        }) as never,
      });
      flushRaf();
    });
    expect(latest.historicalProfiles).toHaveLength(1);

    await act(async () => {
      latest.selectPair("ETH-USDT", {
        provider: "BINANCE",
        marketKind: "SPOT",
      });
    });
    expect(latest.historicalProfiles).toEqual([]);
  });

  it("resets to an empty array when the browser's connection to the server closes", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeProfile({
          mode: "fixed_range",
          period_start_ts: 1000,
        }) as never,
      });
      flushRaf();
    });
    expect(latest.historicalProfiles).toHaveLength(1);

    await act(async () => {
      lastWorker.emit({ kind: "status", status: "closed" });
    });

    expect(latest.historicalProfiles).toEqual([]);
  });

  it("discards a fixed_range frame for a symbol other than the confirmed active pair", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeProfile({
          mode: "fixed_range",
          period_start_ts: 1000,
          symbol: "ETH-USDT",
        }) as never,
      });
      flushRaf();
    });

    expect(latest.historicalProfiles).toEqual([]);
  });
});

function makeVpin(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: "vpin" as const,
    symbol: "BTC-USDT",
    provider: "BINANCE" as const,
    marketKind: "SPOT" as const,
    seal_ts: 1_000,
    active: true,
    direction: "buy" as const,
    strength: 0.5,
    z_vpin: 1.2,
    z_velocity: 0.1,
    z_acceleration: 0.01,
    activated_at_ts: 900,
    ...overrides,
  };
}

describe("useMarketData -- vpin, the P4.12 frame kind", () => {
  it("starts as an empty array -- honestly unknown before any reading has arrived", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    expect(latest.vpinHistory).toEqual([]);
  });

  it("a live vpin frame appends onto vpinHistory after the rAF flush, batched the same way trades are", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: makeVpin() as never });
    });
    expect(latest.vpinHistory).toEqual([]);

    await act(async () => {
      flushRaf();
    });

    expect(latest.vpinHistory).toHaveLength(1);
    expect(latest.vpinHistory[0]?.seal_ts).toBe(1_000);
  });

  it("a burst of vpin frames in one animation frame keeps every reading, in order -- unlike profile's replace-with-latest", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeVpin({ seal_ts: 1_000 }) as never,
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeVpin({ seal_ts: 2_000 }) as never,
      });
      flushRaf();
    });
    expect(latest.vpinHistory.map((r) => r.seal_ts)).toEqual([1_000, 2_000]);

    // The distinguishing case: a second, separate flush cycle. A naive
    // `setVpinHistory(appended)` (replace, matching profile's own
    // keep-only-latest semantics) would pass the assertion above on its
    // own -- prev was empty on the very first flush either way -- but
    // only a real append preserves what a prior flush already committed.
    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: makeVpin({ seal_ts: 3_000 }) as never,
      });
      flushRaf();
    });

    expect(latest.vpinHistory.map((r) => r.seal_ts)).toEqual([
      1_000, 2_000, 3_000,
    ]);
  });

  it("preserves every same-millisecond seal -- a large print may close multiple volume buckets", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeVpin({ seal_ts: 1_000, z_vpin: null }) as never,
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeVpin({ seal_ts: 1_000, z_vpin: 0.5 }) as never,
      });
      flushRaf();
    });

    expect(latest.vpinHistory).toHaveLength(2);
    expect(latest.vpinHistory.map((entry) => entry.seal_ts)).toEqual([
      1_000, 1_000,
    ]);
    expect(latest.vpinHistory[1]?.z_vpin).toBe(0.5);
  });

  it("a snapshot's vpin_readings replaces vpinHistory wholesale, not appends onto it", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeVpin({ seal_ts: 1_000 }) as never,
      });
      flushRaf();
    });
    expect(latest.vpinHistory).toHaveLength(1);

    const {
      type: _t,
      symbol: _s,
      provider: _p,
      marketKind: _mk,
      ...reading
    } = makeVpin({ seal_ts: 5_000 });
    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "snapshot",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          bars: [],
          trades: [],
          markers: [],
          vpin_readings: [reading],
          vpin_status: "READY",
        } as never,
      });
    });

    expect(latest.vpinHistory).toHaveLength(1);
    expect(latest.vpinHistory[0]?.seal_ts).toBe(5_000);
    expect(latest.vpinStatus).toBe("READY");
  });

  it("a snapshot without vpin_readings clears vpinHistory to empty, not leaves the prior pair's readings behind", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: makeVpin() as never });
      flushRaf();
    });
    expect(latest.vpinHistory).toHaveLength(1);

    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "snapshot",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          bars: [],
          trades: [],
          markers: [],
        } as never,
      });
    });

    expect(latest.vpinHistory).toEqual([]);
    expect(latest.vpinStatus).toBeNull();
  });

  it("resets to empty when the browser's connection to the server closes", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: makeVpin() as never });
      flushRaf();
    });
    expect(latest.vpinHistory).not.toEqual([]);

    await act(async () => {
      lastWorker.emit({ kind: "status", status: "closed" });
    });

    expect(latest.vpinHistory).toEqual([]);
  });

  it("discards a vpin frame for a symbol other than the confirmed active pair", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeVpin({ symbol: "ETH-USDT" }) as never,
      });
      flushRaf();
    });

    expect(latest.vpinHistory).toEqual([]);
  });

  it("clears to empty on a pair switch, the same reset every other live frame kind gets", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: makeVpin() as never });
      flushRaf();
    });
    expect(latest.vpinHistory).not.toEqual([]);

    await act(async () => {
      latest.selectPair("ETH-USDT", {
        provider: "BINANCE",
        marketKind: "SPOT",
      });
    });
    expect(latest.vpinHistory).toEqual([]);
  });

  it("bounds accumulated readings, dropping the oldest first", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => {
      root.render(<Harness onReady={(r) => (latest = r)} />);
    });

    await act(async () => {
      confirmBaseSelection();
      for (let i = 0; i < 5_001; i += 1) {
        lastWorker.emit({
          kind: "frame",
          frame: makeVpin({ seal_ts: i }) as never,
        });
        if (i % 1_000 === 0) flushRaf();
      }
      flushRaf();
    });

    expect(latest.vpinHistory).toHaveLength(5_000);
    expect(latest.vpinHistory[0]?.seal_ts).toBe(1);
    expect(latest.vpinHistory[latest.vpinHistory.length - 1]?.seal_ts).toBe(
      5_000,
    );
  });
});

describe("aggressive tape across reconnects", () => {
  it("keeps the print tape through a socket drop and a reconnect to the same pair, and starts a new one on a real pair change", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () =>
      root.render(<Harness onReady={(result) => (latest = result)} />),
    );
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({
          trade_id: "before-drop-1",
          ts_exchange: 1_000,
          size: 3,
        }),
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({
          trade_id: "before-drop-2",
          ts_exchange: 2_000,
          size: 4,
        }),
      });
      flushRaf();
    });
    const tapeBefore = latest.aggressiveTape;
    expect(tapeBefore).not.toBeNull();
    expect(tapeBefore!.prints.map((print) => print.size)).toEqual([3, 4]);

    // The feed drops and comes back on the same pair: the bubbles must still be there.
    await act(async () => {
      lastWorker.emit({ kind: "status", status: "closed" });
      lastWorker.emit({ kind: "status", status: "open" });
      lastWorker.emit({
        kind: "frame",
        frame: selectionFrame("BTC-USDT", "SPOT"),
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({
          trade_id: "after-reconnect",
          ts_exchange: 3_000,
          size: 5,
        }),
      });
      flushRaf();
    });
    expect(latest.aggressiveTape).toBe(tapeBefore);
    expect(latest.aggressiveTape!.prints.map((print) => print.size)).toEqual([
      3, 4, 5,
    ]);

    // A real pair change starts a clean tape.
    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: selectionFrame("ETH-USDT", "SPOT"),
      });
    });
    expect(latest.aggressiveTape).toBeNull();
    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({
          symbol: "ETH-USDT",
          trade_id: "eth-1",
          ts_exchange: 4_000,
          size: 7,
        }),
      });
      flushRaf();
    });
    expect(latest.aggressiveTape).not.toBe(tapeBefore);
    expect(latest.aggressiveTape!.prints.map((print) => print.size)).toEqual([
      7,
    ]);
    root.unmount();
    container.remove();
  });

  it("still keeps the tape when the first reconnect attempt fails and the second one lands on the same pair", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () =>
      root.render(<Harness onReady={(result) => (latest = result)} />),
    );
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({
          trade_id: "before-drop",
          ts_exchange: 1_000,
          size: 3,
        }),
      });
      flushRaf();
    });
    const tapeBefore = latest.aggressiveTape;
    expect(tapeBefore).not.toBeNull();

    // The server is down for one retry: the worker reports closed twice before the socket comes back.
    await act(async () => {
      lastWorker.emit({ kind: "status", status: "closed" });
      lastWorker.emit({ kind: "status", status: "connecting" });
      lastWorker.emit({ kind: "status", status: "closed" });
      lastWorker.emit({ kind: "status", status: "open" });
      lastWorker.emit({
        kind: "frame",
        frame: selectionFrame("BTC-USDT", "SPOT"),
      });
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({
          trade_id: "after-reconnect",
          ts_exchange: 3_000,
          size: 5,
        }),
      });
      flushRaf();
    });
    expect(latest.aggressiveTape).toBe(tapeBefore);
    expect(latest.aggressiveTape!.prints.map((print) => print.size)).toEqual([
      3, 5,
    ]);
    root.unmount();
    container.remove();
  });
});

describe("aggressive history off the collector", () => {
  it("lays the snapshot's pool of big prints under the tape and counts its span as history received", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () =>
      root.render(<Harness onReady={(result) => (latest = result)} />),
    );
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "snapshot",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          bars: [],
          markers: [],
          trades: [
            makeTrade({ trade_id: "recent", ts_exchange: 100_000, size: 1 }),
          ],
          aggressive_prints: [
            makeTrade({ trade_id: "pool-1", ts_exchange: 1_000, size: 9 }),
            makeTrade({ trade_id: "recent", ts_exchange: 100_000, size: 1 }),
          ],
          aggressive_prints_floor: 5,
          aggressive_prints_from: 500,
        } as never,
      });
      flushRaf();
    });
    expect(
      latest.aggressiveTape!.prints.map((print) => [
        print.id,
        print.size,
        print.history,
      ]),
    ).toEqual([
      ["pool-1", 9, true],
      ["recent", 1, false],
    ]);
    expect(latest.aggressiveTape!.historyCoveredTo(5)).toBeGreaterThanOrEqual(
      100_000,
    );
    expect(latest.aggressiveTape!.historyFrom).toBe(500);
    await act(async () => root.unmount());
  });

  it("lays the prints a heatmap column carries under the tape by trade id, like a collector reply", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () =>
      root.render(<Harness onReady={(result) => (latest = result)} />),
    );
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "live-1", ts_exchange: 100_000, size: 3 }),
      });
      flushRaf();
    });
    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "liquidity",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          ts: 101_000,
          seq: 2,
          reset: true,
          row_width: 2,
          column_ms: 1_000,
          columns: [
            {
              ts: 100_000,
              lo: 10,
              hi: 12,
              bid: [],
              ask: [],
              prints: [
                {
                  ts: 99_500,
                  price: 80_000,
                  size: 4,
                  side: "buy",
                  id: "col-1",
                },
                {
                  ts: 100_000,
                  price: 80_000,
                  size: 3,
                  side: "buy",
                  id: "live-1",
                },
              ],
              prints_floor: 2,
            },
            { ts: 101_000, lo: 10, hi: 12, bid: [], ask: [] },
          ],
        } as never,
      });
      flushRaf();
    });
    expect(
      latest.aggressiveTape!.prints.map((print) => [
        print.id,
        print.size,
        print.history,
      ]),
    ).toEqual([
      ["col-1", 4, true],
      ["live-1", 3, false],
    ]);
    expect(latest.liquidity!.columns[0].prints).toHaveLength(2);
    await act(async () => root.unmount());
  });

  it("lays an aggressive_history reply under the tape by trade id and posts a history request to the worker", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () =>
      root.render(<Harness onReady={(result) => (latest = result)} />),
    );
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({
        kind: "frame",
        frame: makeTrade({ trade_id: "live-1", ts_exchange: 100_000, size: 3 }),
      });
      flushRaf();
    });
    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "aggressive_history",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          request_id: 1,
          from_ts: 0,
          to_ts: 200_000,
          min_size: 2,
          complete: true,
          reason: null,
          next_cursor: null,
          retry_after_ms: null,
          trades: [
            makeTrade({ trade_id: "h-1", ts_exchange: 1_000, size: 4 }),
            makeTrade({ trade_id: "live-1", ts_exchange: 100_000, size: 3 }),
          ],
        } as never,
      });
    });
    expect(
      latest.aggressiveTape!.prints.map((print) => [print.id, print.size]),
    ).toEqual([
      ["h-1", 4],
      ["live-1", 3],
    ]);

    act(() =>
      latest.requestAggressiveHistory({
        request_id: 2,
        from_ts: 0,
        to_ts: 200_000,
        min_size: 2,
      }),
    );
    expect(lastWorker.posted).toContainEqual({
      kind: "aggressive_history",
      request_id: 2,
      from_ts: 0,
      to_ts: 200_000,
      min_size: 2,
    });

    // A capped reply is followed by the same window and the server-provided cursor.
    act(() =>
      latest.requestAggressiveHistory({
        request_id: 3,
        from_ts: 0,
        to_ts: 200_000,
        min_size: 0,
      }),
    );
    const postedBefore = lastWorker.posted.length;
    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "aggressive_history",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          request_id: 3,
          from_ts: 0,
          to_ts: 200_000,
          min_size: 0,
          complete: false,
          reason: "CAP_REACHED",
          next_cursor: "cap-one",
          retry_after_ms: null,
          trades: [
            makeTrade({ trade_id: "h-2", ts_exchange: 50_000, size: 1 }),
            makeTrade({ trade_id: "h-3", ts_exchange: 60_000, size: 1 }),
          ],
        } as never,
      });
    });
    const followUp = lastWorker.posted
      .slice(postedBefore)
      .find(
        (message) =>
          (message as { kind: string }).kind === "aggressive_history",
      ) as
      | {
          from_ts: number;
          to_ts: number;
          min_size: number;
          request_id: number;
          cursor?: string;
        }
      | undefined;
    expect(followUp).toMatchObject({
      from_ts: 0,
      to_ts: 200_000,
      min_size: 0,
      cursor: "cap-one",
    });
    expect(followUp!.request_id).toBeGreaterThan(0);
    expect(latest.aggressiveTape!.historyCoveredTo(0)).toBeNull();
    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "aggressive_history",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          request_id: 4,
          from_ts: 0,
          to_ts: 200_000,
          min_size: 0,
          complete: true,
          reason: null,
          next_cursor: null,
          retry_after_ms: null,
          trades: [
            makeTrade({ trade_id: "h-4", ts_exchange: 10_000, size: 1 }),
          ],
        } as never,
      });
    });
    expect(latest.aggressiveTape!.historyCoveredTo(0)).toBe(200_000);

    // A reply for another pair is ignored.
    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "aggressive_history",
          symbol: "ETH-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          request_id: 3,
          from_ts: 0,
          to_ts: 200_000,
          min_size: 2,
          complete: true,
          trades: [
            makeTrade({
              symbol: "ETH-USDT",
              trade_id: "eth",
              ts_exchange: 5_000,
            }),
          ],
        } as never,
      });
    });
    expect(latest.aggressiveTape!.prints).toHaveLength(5); // h-1, live-1, h-2, h-3, h-4: nothing from ETH

    // A capped reply at a floor other than the newest request's (a superseded request answered late): its prints
    // are laid under the tape, but no walk-back continues from it, and it covers nothing at the floor in force.
    const postedBeforeStale = lastWorker.posted.length;
    await act(async () => {
      lastWorker.emit({
        kind: "frame",
        frame: {
          type: "aggressive_history",
          symbol: "BTC-USDT",
          provider: "BINANCE",
          marketKind: "SPOT",
          request_id: 2,
          from_ts: 0,
          to_ts: 200_000,
          min_size: 2,
          complete: false,
          reason: "CAP_REACHED",
          next_cursor: "cap-stale",
          retry_after_ms: null,
          trades: [
            makeTrade({ trade_id: "h-stale", ts_exchange: 30_000, size: 9 }),
          ],
        } as never,
      });
    });
    expect(latest.aggressiveTape!.prints).toHaveLength(6);
    expect(
      lastWorker.posted
        .slice(postedBeforeStale)
        .filter(
          (message) =>
            (message as { kind: string }).kind === "aggressive_history",
        ),
    ).toHaveLength(0);
    expect(latest.aggressiveTape!.historyCoveredTo(0)).toBe(200_000);
    expect(latest.aggressiveTape!.historyFrom).toBe(0);
    root.unmount();
    container.remove();
  });

  const historyReply = (over: Record<string, unknown>) =>
    ({
      type: "aggressive_history",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      request_id: 1,
      from_ts: 0,
      to_ts: 200_000,
      min_size: 0,
      complete: true,
      reason: null,
      next_cursor: null,
      retry_after_ms: null,
      trades: [],
      ...over,
    }) as never;
  const historyPosts = () =>
    lastWorker.posted.filter(
      (message) => (message as { kind: string }).kind === "aggressive_history",
    ) as {
      request_id: number;
      from_ts: number;
      to_ts: number;
      min_size: number;
      cursor?: string;
    }[];

  it("continues an empty capped page with its opaque cursor and records no false coverage", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    await act(async () =>
      root.render(<Harness onReady={(result) => (latest = result)} />),
    );
    await act(async () => confirmBaseSelection());
    act(() =>
      latest.requestAggressiveHistory({
        request_id: 1,
        from_ts: 0,
        to_ts: 200_000,
        min_size: 0,
      }),
    );
    const before = historyPosts().length;
    await act(async () =>
      lastWorker.emit({
        kind: "frame",
        frame: historyReply({
          complete: false,
          reason: "CAP_REACHED",
          next_cursor: "cap-empty",
          trades: [],
        }),
      }),
    );
    expect(historyPosts().slice(before)).toEqual([
      expect.objectContaining({
        from_ts: 0,
        to_ts: 200_000,
        min_size: 0,
        cursor: "cap-empty",
      }),
    ]);
    expect(latest.aggressiveTape!.historyCoveredTo(0)).toBeNull();
    root.unmount();
    container.remove();
  });

  it("resumes a rate-limited capped continuation from its cursor after the server-directed delay", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    try {
      await act(async () =>
        root.render(<Harness onReady={(result) => (latest = result)} />),
      );
      await act(async () => confirmBaseSelection());
      act(() =>
        latest.requestAggressiveHistory({
          request_id: 1,
          from_ts: 0,
          to_ts: 200_000,
          min_size: 0,
        }),
      );
      await act(async () =>
        lastWorker.emit({
          kind: "frame",
          frame: historyReply({
            complete: false,
            reason: "CAP_REACHED",
            next_cursor: "cap-resume",
            trades: [],
          }),
        }),
      );
      const continuation = historyPosts().at(-1) as {
        request_id: number;
        cursor?: string;
      };
      expect(continuation).toMatchObject({ cursor: "cap-resume" });
      const beforeRetry = historyPosts().length;
      await act(async () =>
        lastWorker.emit({
          kind: "frame",
          frame: historyReply({
            request_id: continuation.request_id,
            complete: false,
            reason: "OVERLOADED",
            retry_after_ms: 4_000,
            trades: [],
          }),
        }),
      );
      await act(async () => {
        vi.advanceTimersByTime(3_999);
      });
      expect(historyPosts()).toHaveLength(beforeRetry);
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(historyPosts()).toHaveLength(beforeRetry + 1);
      expect(historyPosts().at(-1)).toMatchObject({
        from_ts: 0,
        to_ts: 200_000,
        min_size: 0,
        cursor: "cap-resume",
      });
      expect(latest.aggressiveTape!.historyCoveredTo(0)).toBeNull();
    } finally {
      vi.useRealTimers();
      root.unmount();
      container.remove();
    }
  });

  it("lets a late superseded reply add its prints without cancelling or replacing the active request's retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    try {
      await act(async () =>
        root.render(<Harness onReady={(result) => (latest = result)} />),
      );
      await act(async () => confirmBaseSelection());
      act(() =>
        latest.requestAggressiveHistory({
          request_id: 1,
          from_ts: 0,
          to_ts: 100_000,
          min_size: 0,
        }),
      );
      act(() =>
        latest.requestAggressiveHistory({
          request_id: 2,
          from_ts: 100_000,
          to_ts: 200_000,
          min_size: 0,
        }),
      );

      // Request 1 was superseded by request 2. Its overloaded answer must not
      // consume the one retry timer or claim that the current request failed.
      await act(async () =>
        lastWorker.emit({
          kind: "frame",
          frame: historyReply({
            request_id: 1,
            from_ts: 0,
            to_ts: 100_000,
            complete: false,
            reason: "OVERLOADED",
            retry_after_ms: 2_000,
            trades: [
              makeTrade({ trade_id: "late-print", ts_exchange: 50_000 }),
            ],
          }),
        }),
      );
      expect(latest.aggressiveTape!.prints.map((print) => print.id)).toContain(
        "late-print",
      );
      expect(latest.aggressiveHistoryIssue).toBeNull();

      await act(async () =>
        lastWorker.emit({
          kind: "frame",
          frame: historyReply({
            request_id: 2,
            from_ts: 100_000,
            to_ts: 200_000,
            complete: false,
            reason: "OVERLOADED",
            retry_after_ms: 2_000,
          }),
        }),
      );
      expect(latest.aggressiveHistoryIssue).toBe("OVERLOADED");
      const beforeRetry = historyPosts().length;
      await act(async () => {
        vi.advanceTimersByTime(2_000);
      });
      expect(historyPosts()).toHaveLength(beforeRetry + 1);
      expect(historyPosts().at(-1)).toMatchObject({
        from_ts: 100_000,
        to_ts: 200_000,
        min_size: 0,
      });
    } finally {
      vi.useRealTimers();
      root.unmount();
      container.remove();
    }
  });

  it("fills a hole between two covered windows instead of skipping it", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    await act(async () =>
      root.render(<Harness onReady={(result) => (latest = result)} />),
    );
    await act(async () => confirmBaseSelection());
    act(() =>
      latest.requestAggressiveHistory({
        request_id: 1,
        from_ts: 100_000,
        to_ts: 200_000,
        min_size: 0,
      }),
    );
    await act(async () =>
      lastWorker.emit({
        kind: "frame",
        frame: historyReply({
          request_id: 1,
          from_ts: 100_000,
          to_ts: 200_000,
        }),
      }),
    );
    latest.aggressiveTape!.wantHistoryFrom(0);
    const before = historyPosts().length;
    await act(async () =>
      lastWorker.emit({
        kind: "frame",
        frame: historyReply({ request_id: 2, from_ts: 0, to_ts: 40_000 }),
      }),
    );
    expect(latest.aggressiveTape!.historyIntervals).toEqual([
      { from: 0, to: 40_000 },
      { from: 100_000, to: 200_000 },
    ]);
    expect(latest.aggressiveTape!.historyCoveredTo(0)).toBe(200_000);
    expect(historyPosts().slice(before)).toEqual([
      expect.objectContaining({ from_ts: 40_000, to_ts: 100_000, min_size: 0 }),
    ]);
    root.unmount();
    container.remove();
  });

  it("retries STORAGE_UNAVAILABLE, READ_FAILED and OVERLOADED with a bounded backoff, reports the issue, and a good reply clears it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    try {
      await act(async () =>
        root.render(<Harness onReady={(result) => (latest = result)} />),
      );
      await act(async () => confirmBaseSelection());
      act(() =>
        latest.requestAggressiveHistory({
          request_id: 1,
          from_ts: 0,
          to_ts: 200_000,
          min_size: 0,
        }),
      );
      expect(historyPosts()).toHaveLength(1);
      await act(async () =>
        lastWorker.emit({
          kind: "frame",
          frame: historyReply({
            complete: false,
            reason: "STORAGE_UNAVAILABLE",
          }),
        }),
      );
      expect(latest.aggressiveHistoryIssue).toBe("STORAGE_UNAVAILABLE");
      expect(latest.aggressiveTape!.historyCoveredTo(0)).toBeNull();
      expect(historyPosts()).toHaveLength(1);
      await act(async () => {
        vi.advanceTimersByTime(HISTORY_RETRY_BASE_MS - 1);
      });
      expect(historyPosts()).toHaveLength(1);
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(historyPosts()).toHaveLength(2);
      expect(historyPosts()[1]).toMatchObject({
        from_ts: 0,
        to_ts: 200_000,
        min_size: 0,
      });
      await act(async () =>
        lastWorker.emit({
          kind: "frame",
          frame: historyReply({
            request_id: historyPosts()[1].request_id,
            complete: false,
            reason: "READ_FAILED",
          }),
        }),
      );
      expect(latest.aggressiveHistoryIssue).toBe("READ_FAILED");
      await act(async () => {
        vi.advanceTimersByTime(HISTORY_RETRY_BASE_MS * 2);
      });
      expect(historyPosts()).toHaveLength(3);
      await act(async () =>
        lastWorker.emit({
          kind: "frame",
          frame: historyReply({
            request_id: historyPosts()[2].request_id,
            complete: false,
            reason: "OVERLOADED",
          }),
        }),
      );
      await act(async () => {
        vi.advanceTimersByTime(HISTORY_RETRY_BASE_MS * 4);
      });
      expect(historyPosts()).toHaveLength(4);
      await act(async () =>
        lastWorker.emit({
          kind: "frame",
          frame: historyReply({
            request_id: historyPosts()[3].request_id,
            complete: false,
            reason: "OVERLOADED",
          }),
        }),
      );
      await act(async () => {
        vi.advanceTimersByTime(HISTORY_RETRY_BASE_MS * 64);
      });
      expect(historyPosts()).toHaveLength(4);
      expect(latest.aggressiveHistoryIssue).toBeNull();
      await act(async () =>
        lastWorker.emit({
          kind: "frame",
          frame: historyReply({ request_id: historyPosts()[3].request_id }),
        }),
      );
      expect(latest.aggressiveHistoryIssue).toBeNull();
      expect(latest.aggressiveTape!.historyCoveredTo(0)).toBe(200_000);
    } finally {
      vi.useRealTimers();
      root.unmount();
      container.remove();
    }
  });

  it("keeps the prints of a CONVERSION_INCOMPLETE reply, covers nothing, asks for nothing more, and says so", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    await act(async () =>
      root.render(<Harness onReady={(result) => (latest = result)} />),
    );
    await act(async () => confirmBaseSelection());
    act(() =>
      latest.requestAggressiveHistory({
        request_id: 1,
        from_ts: 0,
        to_ts: 200_000,
        min_size: 0,
      }),
    );
    const before = historyPosts().length;
    await act(async () =>
      lastWorker.emit({
        kind: "frame",
        frame: historyReply({
          complete: false,
          reason: "CONVERSION_INCOMPLETE",
          trades: [
            makeTrade({ trade_id: "c-1", ts_exchange: 50_000, size: 2 }),
          ],
        }),
      }),
    );
    expect(latest.aggressiveTape!.prints.map((print) => print.id)).toEqual([
      "c-1",
    ]);
    expect(latest.aggressiveTape!.historyCoveredTo(0)).toBeNull();
    expect(historyPosts()).toHaveLength(before);
    expect(latest.aggressiveHistoryIssue).toBe("CONVERSION_INCOMPLETE");
    await act(async () =>
      lastWorker.emit({
        kind: "frame",
        frame: historyReply({ request_id: 2 }),
      }),
    );
    expect(latest.aggressiveHistoryIssue).toBeNull();
    expect(latest.aggressiveTape!.historyCoveredTo(0)).toBe(200_000);
    root.unmount();
    container.remove();
  });
});

describe("aggressive history over days", () => {
  it("thins a reply's prints older than the raw stretch to the biggest of each minute and side, and keeps recent ones whole", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    const minute = Math.floor((Date.now() - 3 * 24 * 60 * 60 * 1000) / 60_000) * 60_000;
    const recent = Date.now() - 60_000;

    await act(async () => root.render(<Harness onReady={(result) => (latest = result)} />));
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: {
        type: "aggressive_history", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
        request_id: 1, from_ts: minute, to_ts: recent + 1_000, min_size: 0, complete: true, reason: null, next_cursor: null, retry_after_ms: null,
        trades: [
          ...Array.from({ length: 6 }, (_unused, i) => makeTrade({ trade_id: `old-${i}`, ts_exchange: minute + i * 1_000, size: i + 1 })),
          ...Array.from({ length: 6 }, (_unused, i) => makeTrade({ trade_id: `new-${i}`, ts_exchange: recent + i, size: i + 1 })),
        ],
      } as never });
    });
    const ids = latest.aggressiveTape!.prints.map((print) => print.id);
    expect(ids.filter((id) => id.startsWith("old-"))).toEqual(["old-2", "old-3", "old-4", "old-5"]);
    expect(ids.filter((id) => id.startsWith("new-"))).toHaveLength(6);
    expect(latest.aggressiveTape!.historyCoveredTo(0)).toBe(recent + 1_000);
    await act(async () => root.unmount());
  });
});

describe("aggressive history asks the hook makes itself", () => {
  it("notes every request it posts on the tape, so the panel does not queue the same ask behind it", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    const day = HISTORY_ASK_MAX_MS;
    const to = Date.now() - 12 * 60 * 60 * 1000;

    await act(async () => root.render(<Harness onReady={(result) => (latest = result)} />));
    await act(async () => confirmBaseSelection());
    await act(async () => {
      lastWorker.emit({ kind: "frame", frame: {
        type: "aggressive_history", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
        request_id: 1, from_ts: to - day, to_ts: to, min_size: 2, complete: true, reason: null, next_cursor: null, retry_after_ms: null, trades: [],
      } as never });
    });
    latest.aggressiveTape!.wantHistoryFrom(to - 3 * day);
    act(() => latest.requestAggressiveHistory({ request_id: 2, from_ts: to - 2 * day, to_ts: to - day, min_size: 2 }));
    expect(latest.aggressiveTape!.lastHistoryAsk(2)?.ask).toEqual({ from: to - 2 * day, to: to - day });
    const before = lastWorker.posted.length;
    await act(async () => {
      lastWorker.emit({ kind: "frame", frame: {
        type: "aggressive_history", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
        request_id: 2, from_ts: to - 2 * day, to_ts: to - day, min_size: 2, complete: true, reason: null, next_cursor: null, retry_after_ms: null, trades: [],
      } as never });
    });
    const chained = lastWorker.posted.slice(before).find((message) => (message as { kind: string }).kind === "aggressive_history") as { from_ts: number; to_ts: number } | undefined;
    expect(chained).toMatchObject({ from_ts: to - 3 * day, to_ts: to - 2 * day });
    expect(latest.aggressiveTape!.lastHistoryAsk(2)?.ask).toEqual({ from: to - 3 * day, to: to - 2 * day });
    await act(async () => root.unmount());
  });
});

describe("aggressive history the collector cannot serve", () => {
  const historyPosts = () => lastWorker.posted.filter((message) => (message as { kind: string }).kind === "aggressive_history") as { request_id: number; from_ts: number; to_ts: number; min_size: number }[];
  const historyReply = (over: Record<string, unknown>) => ({
    type: "aggressive_history", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
    request_id: 1, from_ts: 0, to_ts: 200_000, min_size: 0, complete: true, reason: null, next_cursor: null, retry_after_ms: null, trades: [], ...over,
  }) as never;
  it("after the last retry it gives the window up on the tape for the cooldown, so the panel stops asking for it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    try {
      await act(async () => root.render(<Harness onReady={(result) => (latest = result)} />));
      await act(async () => confirmBaseSelection());
      act(() => latest.requestAggressiveHistory({ request_id: 1, from_ts: 0, to_ts: 200_000, min_size: 0 }));
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const last = historyPosts().at(-1)!;
        await act(async () => lastWorker.emit({ kind: "frame", frame: historyReply({ request_id: last.request_id, complete: false, reason: "STORAGE_UNAVAILABLE" }) }));
        expect(latest.aggressiveTape!.askable({ from: 0, to: 200_000 }, Date.now())).toEqual({ from: 0, to: 200_000 });
        expect(latest.aggressiveHistoryIssue).toBe("STORAGE_UNAVAILABLE");
        await act(async () => { vi.advanceTimersByTime(HISTORY_RETRY_BASE_MS * 2 ** attempt); });
      }
      expect(historyPosts()).toHaveLength(4);
      const last = historyPosts().at(-1)!;
      await act(async () => lastWorker.emit({ kind: "frame", frame: historyReply({ request_id: last.request_id, complete: false, reason: "STORAGE_UNAVAILABLE" }) }));
      expect(latest.aggressiveTape!.askable({ from: 0, to: 200_000 }, Date.now())).toBeNull();
      expect(latest.aggressiveTape!.askable({ from: 0, to: 200_000 }, Date.now() + HISTORY_GIVE_UP_MS)).toEqual({ from: 0, to: 200_000 });
      expect(latest.aggressiveHistoryIssue).toBeNull(); // given up is not an issue the legend keeps showing
    } finally {
      vi.useRealTimers();
      root.unmount();
      container.remove();
    }
  });
});

describe("aggressive history at the trader's floor over the pool's", () => {
  const historyPosts = () => lastWorker.posted.filter((message) => (message as { kind: string }).kind === "aggressive_history") as { request_id: number; from_ts: number; to_ts: number; min_size: number }[];

  it("a reply at a coarser floor than the snapshot pool's counts as coverage, so the chain moves to the older day instead of asking the same one again", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    const day = HISTORY_ASK_MAX_MS;
    const poolFrom = Date.now() - 12 * 60 * 60 * 1000;

    await act(async () => root.render(<Harness onReady={(result) => (latest = result)} />));
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: {
        type: "snapshot", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", bars: [], markers: [], trades: [],
        aggressive_prints: [], aggressive_prints_floor: 0.16, aggressive_prints_from: poolFrom,
      } as never });
      flushRaf();
    });
    latest.aggressiveTape!.wantHistoryFrom(poolFrom - 3 * day);
    act(() => latest.requestAggressiveHistory({ request_id: 5, from_ts: poolFrom - day, to_ts: poolFrom, min_size: 3 }));
    const before = historyPosts().length;
    await act(async () => {
      lastWorker.emit({ kind: "frame", frame: {
        type: "aggressive_history", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
        request_id: 5, from_ts: poolFrom - day, to_ts: poolFrom, min_size: 3, complete: true, reason: null, next_cursor: null, retry_after_ms: null, trades: [],
      } as never });
    });
    const chained = historyPosts().slice(before);
    expect(chained).toHaveLength(1);
    expect(chained[0]).toMatchObject({ from_ts: poolFrom - 2 * day, to_ts: poolFrom - day, min_size: 3 });
    await act(async () => {
      lastWorker.emit({ kind: "frame", frame: {
        type: "aggressive_history", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
        request_id: chained[0].request_id, from_ts: poolFrom - 2 * day, to_ts: poolFrom - day, min_size: 3, complete: true, reason: null, next_cursor: null, retry_after_ms: null, trades: [],
      } as never });
    });
    // A finer floor later: the day covered only at 3 is asked again at 1, not skipped as if the coarser reply had covered it.
    act(() => latest.requestAggressiveHistory({ request_id: 9, from_ts: poolFrom - day, to_ts: poolFrom, min_size: 1 }));
    const beforeFiner = historyPosts().length;
    await act(async () => {
      lastWorker.emit({ kind: "frame", frame: {
        type: "aggressive_history", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
        request_id: 9, from_ts: poolFrom - day, to_ts: poolFrom, min_size: 1, complete: true, reason: null, next_cursor: null, retry_after_ms: null, trades: [],
      } as never });
    });
    expect(historyPosts().slice(beforeFiner)[0]).toMatchObject({ from_ts: poolFrom - 2 * day, to_ts: poolFrom - day, min_size: 1 });
    await act(async () => root.unmount());
  });
});

describe("band_history relay", () => {
  it("asks the host's columns for a band first and lays the page into the band store, not the heatmap's history", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => root.render(<Harness onReady={(result) => (latest = result)} />));
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: { type: "snapshot", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", bars: [], trades: [], markers: [] } });
      flushRaf();
    });
    const store = latest.bandHistory!;
    const version = latest.bandHistoryVersion;
    store.want({ key: "k", fromTs: 0, toTs: 200_000, priceLo: 10, priceHi: 12, columnMs: 10_000 });
    expect(store.nextRequest(Date.now())).toBeNull();
    const asks = () => lastWorker.posted.filter((m) => (m as { kind: string }).kind === "heatmap_history") as { request_id: number }[];
    expect(asks()).toHaveLength(1);
    const ask = asks()[0];
    expect(lastWorker.posted.some((m) => (m as { kind: string }).kind === "band_history")).toBe(false);
    await act(async () => lastWorker.emit({ kind: "heatmap_history", request_id: ask.request_id, failed: false, page: {
      available: true, generation: null, levelMs: 10_000, rowFactor: 1, rowWidth: 1, span: { oldest: 0, newest: 0 }, next: null,
      windows: [{ ts: 0, state: "COVERED", columns: [{ ts: 10_000, lo: 9, hi: 12, bid: Float64Array.from([5, 1, 2, 5]), ask: new Float64Array(4) }] }],
    } }));
    expect(latest.bandHistoryVersion).toBe(version + 1);
    const answer = store.feedFor("k")!;
    expect(answer.feed.fine.columns).toHaveLength(21);
    expect([...answer.feed.fine.columns[1].bid]).toEqual([1, 2]);
    expect(asks()).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it("holds a band store from the first snapshot, posts its requests to the worker, lays replies into it, and drops it on a pair change", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => root.render(<Harness onReady={(result) => (latest = result)} />));
    expect(latest.bandHistory).toBeNull();
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: { type: "snapshot", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", bars: [], trades: [], markers: [] } });
      flushRaf();
    });
    const store = latest.bandHistory!;
    expect(store).not.toBeNull();
    expect(store.budget.pool).toBe(latest.columnHistory!.budget.pool);
    expect(store.budget.pool.maxPerMinute).toBe(COLUMN_HISTORY_MAX_PER_MINUTE);
    expect([latest.columnHistory!.budget.cap, store.budget.cap]).toEqual([STREAM_MAX_REQUESTS_PER_MINUTE, BAND_COLUMN_MAX_PER_MINUTE]);
    const version = latest.bandHistoryVersion;
    store.want({ key: "k", fromTs: 0, toTs: 200_000, priceLo: 10, priceHi: 12, columnMs: 10_000 });
    expect(store.nextRequest(Date.now())).toBeNull();
    const ask = lastWorker.posted.filter((m) => (m as { kind: string }).kind === "heatmap_history").at(-1) as { request_id: number };
    expect(ask).toMatchObject({ kind: "heatmap_history", provider: "BINANCE", market_kind: "SPOT", level_ms: 10_000, from_ts: 0, to_ts: 300_000, row_factor: 1 });
    expect(ownsBandColumnId(ask.request_id)).toBe(true);
    await act(async () => lastWorker.emit({ kind: "heatmap_history", request_id: ask.request_id, page: { available: false, reason: "NO_PYRAMID" }, failed: false }));
    expect(latest.bandHistoryVersion).toBe(version);
    const request = store.nextRequest(Date.now())!;
    act(() => latest.requestBandHistory(request));
    expect(lastWorker.posted).toContainEqual({ kind: "band_history", ...request });
    await act(async () => {
      lastWorker.emit({ kind: "frame", frame: {
        type: "band_history", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
        request_id: request.request_id, from_ts: 0, to_ts: 200_000, price_lo: 10, price_hi: 12, column_ms: 10_000,
        row_width: 1, row_lo: 10, row_hi: 11, complete: true, reason: null, retry_after_ms: null,
        columns: [{ ts: 10_000, bid: [1, 2], ask: [0, 0], buy: [0, 0], sell: [0, 0] }],
      } as never });
    });
    expect(latest.bandHistoryVersion).toBe(version + 1);
    expect(store.feedFor("k")!.feed.fine.columns).toHaveLength(21);
    await act(async () => {
      lastWorker.emit({ kind: "frame", frame: {
        type: "band_history", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
        request_id: 99, from_ts: 0, to_ts: 200_000, price_lo: 10, price_hi: 12, column_ms: 10_000,
        row_width: 1, row_lo: 10, row_hi: 11, complete: true, reason: null, retry_after_ms: null, columns: [],
      } as never });
    });
    expect(latest.bandHistoryVersion).toBe(version + 1);
    store.want({ key: "k2", fromTs: 0, toTs: 100_000, priceLo: 10, priceHi: 12, columnMs: 10_000 });
    expect(store.nextRequest(Date.now())).not.toBeNull();
    expect(store.pending).toBe(1);
    await act(async () => {
      lastWorker.emit({ kind: "status", status: "closed" });
    });
    expect(latest.bandHistory).toBe(store);
    expect(store.pending).toBe(0);
    await act(async () => {
      latest.selectPair("ETH-USDT", { provider: "BINANCE", marketKind: "SPOT" });
    });
    expect(latest.bandHistory).toBeNull();
    await act(async () => root.unmount());
  });
});

describe("delta_profile relay", () => {
  it("holds a delta store from the first snapshot at the pair's row width, feeds it live trades, posts its requests, lays replies in, reanchors on a drop and drops it on a pair change", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;

    await act(async () => root.render(<Harness onReady={(result) => (latest = result)} />));
    expect(latest.deltaProfile).toBeNull();
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit({ kind: "frame", frame: { type: "snapshot", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", bars: [], trades: [], markers: [] } });
      flushRaf();
    });
    const store = latest.deltaProfile!;
    expect(store).not.toBeNull();
    expect(store.rowWidth).toBe(1);
    const now = Date.now();
    store.setWindow({ from: now - 3_600_000, to: null, pieceMs: 7_200_000 }, now - 10_000);
    await act(async () => {
      lastWorker.emit({ kind: "frame", frame: { type: "trade", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", ts_exchange: now, price: 84_610.4, size: 2, side: "buy", trade_id: "t-1" } });
      flushRaf();
    });
    expect(store.rows()).toEqual([{ price: 84_610, buy: 2, sell: 0 }]);
    const version = latest.deltaProfileVersion;
    const request = store.nextRequest(now)!;
    act(() => latest.requestDeltaProfile(request));
    expect(lastWorker.posted).toContainEqual({ kind: "delta_profile", ...request });
    await act(async () => {
      lastWorker.emit({ kind: "frame", frame: {
        type: "delta_profile", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
        request_id: request.request_id, from_ts: request.from_ts, to_ts: request.to_ts, row_width: 1, complete: true, reason: null, retry_after_ms: null, pending: 0,
        rows: [[84_609, 1, 3]],
      } as never });
    });
    expect(latest.deltaProfileVersion).toBe(version + 1);
    expect(store.complete).toBe(true);
    expect(store.rows()).toEqual([{ price: 84_609, buy: 1, sell: 3 }, { price: 84_610, buy: 2, sell: 0 }]);
    await act(async () => {
      lastWorker.emit({ kind: "frame", frame: {
        type: "delta_profile", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
        request_id: 99, from_ts: request.from_ts, to_ts: request.to_ts, row_width: 1, complete: true, reason: null, retry_after_ms: null, pending: 0, rows: [],
      } as never });
    });
    expect(latest.deltaProfileVersion).toBe(version + 1);
    await act(async () => {
      lastWorker.emit({ kind: "status", status: "closed" });
    });
    expect(latest.deltaProfile).toBe(store);
    expect(store.rows()).toEqual([]);
    expect(store.complete).toBe(false);
    await act(async () => {
      latest.selectPair("ETH-USDT", { provider: "BINANCE", marketKind: "SPOT" });
    });
    expect(latest.deltaProfile).toBeNull();
    await act(async () => root.unmount());
  });

  it("sets the delta cut just after the newest trade of the snapshot, and again after a reconnect's snapshot, whatever the browser's clock says", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    const snapshot = (trades: TradeFrame[]) => ({ kind: "frame" as const, frame: { type: "snapshot", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", bars: [], trades, markers: [] } as never });
    const window = { from: 0, to: null, pieceMs: 7_200_000 };

    await act(async () => root.render(<Harness onReady={(result) => (latest = result)} />));
    await act(async () => {
      confirmBaseSelection();
      lastWorker.emit(snapshot([makeTrade({ trade_id: "s-1", ts_exchange: 7_000 }), makeTrade({ trade_id: "s-2", ts_exchange: 5_000 })]));
      flushRaf();
    });
    const store = latest.deltaProfile!;
    store.setWindow(window, 1_000);
    expect(store.liveFrom).toBe(7_001);

    await act(async () => {
      lastWorker.emit({ kind: "status", status: "closed" });
      lastWorker.emit({ kind: "status", status: "open" });
      lastWorker.emit({ kind: "frame", frame: selectionFrame("BTC-USDT", "SPOT") });
      lastWorker.emit(snapshot([makeTrade({ trade_id: "s-3", ts_exchange: 9_000 })]));
      flushRaf();
    });
    expect(latest.deltaProfile).toBe(store);
    store.setWindow(window, 2_000);
    expect(store.liveFrom).toBe(9_001);
    await act(async () => root.unmount());
  });
});

describe("range prints relay", () => {
  const H = 3_600_000;
  const historyPosts = () => lastWorker.posted.filter((message) => (message as { kind: string }).kind === "aggressive_history") as { request_id: number; from_ts: number; to_ts: number; min_size: number; cursor?: string }[];
  const snapshot = (trades: TradeFrame[]) => ({ kind: "frame" as const, frame: { type: "snapshot", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", bars: [], trades, markers: [] } as never });
  const answer = (request: { request_id: number; from_ts: number; to_ts: number; min_size: number }, trades: TradeFrame[] = []) => ({ kind: "frame" as const, frame: {
    type: "aggressive_history", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", request_id: request.request_id, from_ts: request.from_ts, to_ts: request.to_ts, min_size: request.min_size,
    complete: true, reason: null, next_cursor: null, retry_after_ms: null, trades,
  } as never });

  it("holds a store from the first snapshot, feeds it live trades, asks over an open socket only while Aggressive Orders has nothing out, keeps its replies off the tape, re-asks what Aggressive Orders made the host drop, and goes with the pair", async () => {
    expect(RANGE_REQUEST_IDS_KEPT).toBe(64);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    try {
      await act(async () => root.render(<Harness onReady={(result) => (latest = result)} />));
      expect(latest.rangePrints).toBeNull();
      act(() => latest.askRangePrints());
      await act(async () => {
        confirmBaseSelection();
        lastWorker.emit(snapshot([makeTrade({ trade_id: "s-1", ts_exchange: now - 10_000, size: 50 })]));
        flushRaf();
      });
      const store = latest.rangePrints!;
      expect(store).not.toBeNull();
      store.setWant({ from: now - H, to: now, floor: 10 }, now);
      expect(store.liveFrom).toBe(now - 9_999);
      await act(async () => {
        lastWorker.emit({ kind: "frame", frame: makeTrade({ trade_id: "t-1", ts_exchange: now - 5_000, size: 12, side: "sell" }) });
        lastWorker.emit({ kind: "frame", frame: makeTrade({ trade_id: "t-2", ts_exchange: now - 4_000, size: 12, side: "buy", auction: true } as Partial<TradeFrame>) });
        flushRaf();
      });
      expect(store.liveCount).toBe(1);
      clock.mockReturnValue(now + RANGE_ASK_DELAY_MS);
      act(() => latest.askRangePrints());
      expect(historyPosts()).toEqual([]);
      await act(async () => lastWorker.emit({ kind: "status", status: "open" }));
      act(() => latest.requestAggressiveHistory({ request_id: 7, from_ts: now - 3 * H, to_ts: now - 2 * H, min_size: 3 }));
      act(() => latest.askRangePrints());
      expect(historyPosts().map((post) => post.request_id)).toEqual([7]);
      await act(async () => lastWorker.emit(answer({ request_id: 7, from_ts: now - 3 * H, to_ts: now - 2 * H, min_size: 3 })));
      act(() => latest.askRangePrints());
      const ask = historyPosts().at(-1)!;
      expect(ask).toEqual({ kind: "aggressive_history", request_id: ask.request_id, from_ts: now - H, to_ts: now - 9_999, min_size: 10 });
      expect(store.pending).toBe(true);
      await act(async () => lastWorker.emit(answer(ask, [makeTrade({ trade_id: "r-1", ts_exchange: now - 600_000, size: 20, side: "sell" })])));
      expect(store.read(now - H, now, 10, now + RANGE_ASK_DELAY_MS)).toMatchObject({ sellCount: 2, sellVolume: 32, gaps: [] });
      expect(latest.aggressiveTape!.prints.some((print) => print.id === "r-1")).toBe(false);
      store.setWant({ from: now - 2 * H, to: now, floor: 10 }, now + RANGE_ASK_DELAY_MS);
      act(() => latest.askRangePrints());
      const second = historyPosts().at(-1)!;
      expect(second).toMatchObject({ from_ts: now - 2 * H, to_ts: now - H, min_size: 10 });
      act(() => latest.requestAggressiveHistory({ request_id: 8, from_ts: now - 5 * H, to_ts: now - 4 * H, min_size: 3 }));
      expect(store.pending).toBe(false);
      await act(async () => lastWorker.emit(answer(second, [makeTrade({ trade_id: "r-2", ts_exchange: now - 5_000_000, size: 20 })])));
      expect(latest.aggressiveTape!.prints.some((print) => print.id === "r-2")).toBe(false);
      expect(store.read(now - 2 * H, now - H, 10, now + RANGE_ASK_DELAY_MS)).toMatchObject({ buyCount: 0, loading: true });
      const posted = historyPosts().length;
      clock.mockReturnValue(now + RANGE_ASK_DELAY_MS + 10 * 60_000);
      act(() => latest.askRangePrints());
      expect(historyPosts()).toHaveLength(posted);
      await act(async () => lastWorker.emit(answer({ request_id: 8, from_ts: now - 5 * H, to_ts: now - 4 * H, min_size: 3 })));
      act(() => latest.askRangePrints());
      const again = historyPosts().at(-1)!;
      expect(again).toMatchObject({ from_ts: now - 2 * H, to_ts: now - H, min_size: 10 });
      expect(again.request_id).not.toBe(second.request_id);
      const capped = answer(again, [makeTrade({ trade_id: "r-3", ts_exchange: now - 5_000_000, size: 20 })]);
      await act(async () => lastWorker.emit({ ...capped, frame: { ...(capped.frame as object), complete: false, reason: "CAP_REACHED", next_cursor: "page-2" } as never }));
      const page = historyPosts().at(-1)!;
      expect(page).toMatchObject({ from_ts: now - 2 * H, to_ts: now - H, min_size: 10, cursor: "page-2" });
      expect(page.request_id).not.toBe(again.request_id);
      await act(async () => lastWorker.emit(answer(page, [makeTrade({ trade_id: "r-4", ts_exchange: now - 6_000_000, size: 30, side: "sell" })])));
      expect(store.read(now - 2 * H, now - H, 10, now + RANGE_ASK_DELAY_MS)).toMatchObject({ buyCount: 1, buyVolume: 20, sellCount: 1, sellVolume: 30, gaps: [] });
      await act(async () => lastWorker.emit({ kind: "status", status: "closed" }));
      expect(latest.rangePrints).toBe(store);
      expect(store.liveFrom).toBeNull();
      expect(store.recordedCount).toBe(3);
      await act(async () => {
        latest.selectPair("ETH-USDT", { provider: "BINANCE", marketKind: "SPOT" });
      });
      expect(latest.rangePrints).toBeNull();
    } finally {
      clock.mockRestore();
      await act(async () => root.unmount());
    }
  });

  it("waits while Aggressive Orders has a retry coming, however long that is", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    try {
      await act(async () => root.render(<Harness onReady={(result) => (latest = result)} />));
      await act(async () => {
        lastWorker.emit({ kind: "status", status: "open" });
        confirmBaseSelection();
        lastWorker.emit(snapshot([]));
        flushRaf();
      });
      const store = latest.rangePrints!;
      store.setWant({ from: now - H, to: now, floor: 10 }, now);
      act(() => latest.requestAggressiveHistory({ request_id: 9, from_ts: now - 3 * H, to_ts: now - 2 * H, min_size: 3 }));
      const busy = answer({ request_id: 9, from_ts: now - 3 * H, to_ts: now - 2 * H, min_size: 3 });
      await act(async () => lastWorker.emit({ ...busy, frame: { ...(busy.frame as object), complete: false, reason: "OVERLOADED", retry_after_ms: 120_000 } as never }));
      clock.mockReturnValue(now + 10 * 60_000 + RANGE_ASK_DELAY_MS);
      act(() => latest.askRangePrints());
      expect(historyPosts().map((post) => post.request_id)).toEqual([9]);
    } finally {
      clock.mockRestore();
      await act(async () => root.unmount());
    }
  });

  it("stops waiting for an Aggressive Orders request the closed socket will never answer", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    try {
      await act(async () => root.render(<Harness onReady={(result) => (latest = result)} />));
      await act(async () => {
        lastWorker.emit({ kind: "status", status: "open" });
        confirmBaseSelection();
        lastWorker.emit(snapshot([]));
        flushRaf();
      });
      const store = latest.rangePrints!;
      store.setWant({ from: now - H, to: now, floor: 10 }, now);
      clock.mockReturnValue(now + RANGE_ASK_DELAY_MS);
      act(() => latest.requestAggressiveHistory({ request_id: 11, from_ts: now - 3 * H, to_ts: now - 2 * H, min_size: 3 }));
      act(() => latest.askRangePrints());
      expect(historyPosts().map((post) => post.request_id)).toEqual([11]);
      await act(async () => lastWorker.emit({ kind: "status", status: "closed" }));
      await act(async () => lastWorker.emit({ kind: "status", status: "open" }));
      store.setWant({ from: now - H, to: now, floor: 10 }, now + RANGE_ASK_DELAY_MS);
      clock.mockReturnValue(now + 2 * RANGE_ASK_DELAY_MS);
      act(() => latest.askRangePrints());
      expect(historyPosts().at(-1)).toMatchObject({ min_size: 10 });
    } finally {
      clock.mockRestore();
      await act(async () => root.unmount());
    }
  });

  it("does not wait for an Aggressive Orders request made while the socket was not open, which the worker drops", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    try {
      await act(async () => root.render(<Harness onReady={(result) => (latest = result)} />));
      await act(async () => {
        confirmBaseSelection();
        lastWorker.emit(snapshot([]));
        flushRaf();
      });
      const store = latest.rangePrints!;
      store.setWant({ from: now - H, to: now, floor: 10 }, now);
      act(() => latest.requestAggressiveHistory({ request_id: 12, from_ts: now - 3 * H, to_ts: now - 2 * H, min_size: 3 }));
      await act(async () => lastWorker.emit({ kind: "status", status: "open" }));
      clock.mockReturnValue(now + RANGE_ASK_DELAY_MS);
      act(() => latest.askRangePrints());
      expect(historyPosts().at(-1)).toMatchObject({ min_size: 10 });
    } finally {
      clock.mockRestore();
      await act(async () => root.unmount());
    }
  });

  it("asks the store's next page the moment Aggressive Orders' reply lands, whatever the reply says, rather than on the next poll", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    try {
      await act(async () => root.render(<Harness onReady={(result) => (latest = result)} />));
      await act(async () => {
        lastWorker.emit({ kind: "status", status: "open" });
        confirmBaseSelection();
        lastWorker.emit(snapshot([]));
        flushRaf();
      });
      const store = latest.rangePrints!;
      store.setWant({ from: now - H, to: now, floor: 10 }, now);
      clock.mockReturnValue(now + RANGE_ASK_DELAY_MS);
      act(() => latest.requestAggressiveHistory({ request_id: 21, from_ts: now - 3 * H, to_ts: now - 2 * H, min_size: 3 }));
      act(() => latest.askRangePrints());
      expect(historyPosts().map((post) => post.request_id)).toEqual([21]);
      await act(async () => lastWorker.emit(answer({ request_id: 21, from_ts: now - 3 * H, to_ts: now - 2 * H, min_size: 3 })));
      expect(historyPosts()).toHaveLength(2);
      expect(historyPosts().at(-1)).toMatchObject({ from_ts: now - H, min_size: 10 });
      expect(store.pending).toBe(true);
      act(() => latest.requestAggressiveHistory({ request_id: 22, from_ts: now - 5 * H, to_ts: now - 4 * H, min_size: 3 }));
      expect(store.pending).toBe(false);
      const partial = answer({ request_id: 22, from_ts: now - 5 * H, to_ts: now - 4 * H, min_size: 3 });
      await act(async () => lastWorker.emit({ ...partial, frame: { ...(partial.frame as object), reason: "CONVERSION_INCOMPLETE" } as never }));
      expect(historyPosts()).toHaveLength(4);
      expect(historyPosts().at(-1)).toMatchObject({ from_ts: now - H, min_size: 10 });
      expect(store.pending).toBe(true);
    } finally {
      clock.mockRestore();
      await act(async () => root.unmount());
    }
  });

  it("keeps the ids of its newest RANGE_REQUEST_IDS_KEPT requests, so a late reply to one never reaches the tape", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest!: UseMarketDataResult;
    try {
      await act(async () => root.render(<Harness onReady={(result) => (latest = result)} />));
      await act(async () => {
        lastWorker.emit({ kind: "status", status: "open" });
        confirmBaseSelection();
        lastWorker.emit(snapshot([]));
        flushRaf();
      });
      const store = latest.rangePrints!;
      store.setWant({ from: now - H, to: now, floor: 10 }, now);
      for (let i = 0; i <= RANGE_REQUEST_IDS_KEPT; i += 1) {
        clock.mockReturnValue(now + RANGE_ASK_DELAY_MS + i * 2 * (RANGE_ASK_BUDGET_MS / RANGE_ASK_BUDGET));
        act(() => latest.askRangePrints());
        act(() => latest.requestAggressiveHistory({ request_id: 1_000_000 + i, from_ts: now - 3 * H, to_ts: now - 2 * H, min_size: 3 }));
        await act(async () => lastWorker.emit(answer({ request_id: 1_000_000 + i, from_ts: now - 3 * H, to_ts: now - 2 * H, min_size: 3 })));
      }
      const asks = historyPosts().filter((post) => post.min_size === 10);
      expect(new Set(asks.map((ask) => ask.request_id)).size).toBeGreaterThan(RANGE_REQUEST_IDS_KEPT);
      const oldestKept = asks[asks.length - RANGE_REQUEST_IDS_KEPT];
      const forgotten = asks[asks.length - RANGE_REQUEST_IDS_KEPT - 1];
      await act(async () => lastWorker.emit(answer(oldestKept, [makeTrade({ trade_id: "kept", ts_exchange: now - 1_000, size: 20 })])));
      expect(latest.aggressiveTape!.prints.some((print) => print.id === "kept")).toBe(false);
      await act(async () => lastWorker.emit(answer(forgotten, [makeTrade({ trade_id: "forgotten", ts_exchange: now - 1_000, size: 20 })])));
      expect(latest.aggressiveTape!.prints.some((print) => print.id === "forgotten")).toBe(true);
    } finally {
      clock.mockRestore();
      await act(async () => root.unmount());
    }
  });
});
