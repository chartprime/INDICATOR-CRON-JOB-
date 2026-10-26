// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { useMarketData, type UseMarketDataResult } from "./useMarketData";
import type { ExhaustionShade, ServerFrame } from "../types/frames";
import type { WorkerToMainMessage } from "../workers/marketDataWorker";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerToMainMessage>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: Event) => void) | null = null;
  posted: unknown[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {}
  emit(msg: WorkerToMainMessage): void {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerToMainMessage>);
  }
}

let lastWorker: FakeWorker;
let rafCallbacks: FrameRequestCallback[] = [];

beforeEach(() => {
  rafCallbacks = [];
  vi.stubGlobal("Worker", class {
    constructor() {
      lastWorker = new FakeWorker();
      return lastWorker as unknown as Worker;
    }
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

function flushRaf(): void {
  const cbs = rafCallbacks;
  rafCallbacks = [];
  for (const cb of cbs) cb(0);
}

const PAIR = { symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL" } as const;
const T = 1_790_000_000_000;

function selection(symbol = "BTC-USDT"): ServerFrame {
  return { type: "selection", ...PAIR, symbol } as ServerFrame;
}

function shade(id: string, overrides: Partial<ExhaustionShade> = {}): ExhaustionShade {
  return {
    id, candleMs: 60_000, side: "buyers", status: "open", intensity: 2, score: 5,
    readings: { rate: true, progress: true, delta: true, divergence: false, prints: true, book: true },
    values: { rate: 0.2, progress: 0, delta: -0.4, divergence: -1.4, prints: null, book: 0.5 },
    raw: { own: 3, other: 7, legOwn: 14, moved: 0, legMoved: 1.8, big: 0, legBig: 0, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 },
    startTs: T, endTs: T + 60_000, extremeTs: T - 60_000, extremePrice: 108, legStartTs: T - 600_000, legStartPrice: 100,
    legSize: 8, efficiency: 1, atr: 1, judgedAt: null, updatedAt: T + 60_000, origin: "runtime", ...overrides,
  };
}

function page(seq: number, reset: boolean, shades: ExhaustionShade[], symbol = "BTC-USDT"): ServerFrame {
  return { type: "exhaustion_shades", ...PAIR, symbol, ts: T + seq, seq, reset, shades, liveSince: T - 3_600_000, loading: null } as ServerFrame;
}

function monitor(ts: number, symbol = "BTC-USDT"): ServerFrame {
  return { type: "candle_monitor", ...PAIR, symbol, ts, entries: [{ candleMs: 60_000, candleTs: ts - 60_000, buy: 3, sell: 7, biggestBuy: { price: 105, size: 2 }, biggestSell: null }] } as ServerFrame;
}

async function mounted(): Promise<{ latest: () => UseMarketDataResult; unmount: () => Promise<void> }> {
  const root = createRoot(document.createElement("div"));
  let current!: UseMarketDataResult;
  function Harness() {
    current = useMarketData({ url: "ws://test" });
    return null;
  }
  await act(async () => root.render(<Harness />));
  await act(async () => lastWorker.emit({ kind: "frame", frame: selection() }));
  return { latest: () => current, unmount: async () => act(async () => root.unmount()) };
}

const emit = (frame: ServerFrame) => lastWorker.emit({ kind: "frame", frame });

describe("useMarketData: the Exhaustion pages and the Candle Monitor across a pair switch and a dropped socket", () => {
  it("a reset page becomes the book at the next frame flush, and an increment upserts into it", async () => {
    const { latest, unmount } = await mounted();
    try {
      await act(async () => emit(page(0, true, [shade("a")])));
      expect(latest().exhaustions).toBeNull();
      await act(async () => flushRaf());
      const book = latest().exhaustions;
      expect(book).not.toBeNull();
      expect(book?.list().map((entry) => entry.id)).toEqual(["a"]);
      expect(book?.trusted()).toBe(true);
      const version = latest().exhaustionsVersion;
      expect(version).toBeGreaterThan(0);
      await act(async () => {
        emit(page(1, false, [shade("a", { score: 6, status: "held", updatedAt: T + 120_000 }), shade("b", { startTs: T + 60_000 })]));
        flushRaf();
      });
      expect(latest().exhaustions).toBe(book);
      expect(book?.get("a")?.status).toBe("held");
      expect(book?.size).toBe(2);
      expect(latest().exhaustionsVersion).toBeGreaterThan(version);
    } finally {
      await unmount();
    }
  });

  it("ignores another pair's pages and an increment that arrives before any reset", async () => {
    const { latest, unmount } = await mounted();
    try {
      await act(async () => {
        emit(page(0, true, [shade("eth")], "ETH-USDT"));
        emit(page(3, false, [shade("early")]));
        flushRaf();
      });
      expect(latest().exhaustions?.size ?? 0).toBe(0);
      expect(latest().exhaustions?.trusted() ?? false).toBe(false);
    } finally {
      await unmount();
    }
  });

  it("a pair switch clears the book and the candle monitor before the new pair's frames arrive", async () => {
    const { latest, unmount } = await mounted();
    try {
      await act(async () => {
        emit(page(0, true, [shade("a")]));
        emit(monitor(T + 60_000));
        flushRaf();
      });
      const book = latest().exhaustions!;
      expect(latest().candleMonitor?.frame.ts).toBe(T + 60_000);
      const before = latest().exhaustionsVersion;
      await act(async () => emit(selection("ETH-USDT")));
      expect(book.size).toBe(0);
      expect(book.trusted()).toBe(false);
      expect(latest().exhaustionsVersion).toBeGreaterThan(before);
      expect(latest().candleMonitor).toBeNull();
      await act(async () => {
        emit(page(0, true, [shade("e")], "ETH-USDT"));
        emit(monitor(T + 120_000, "ETH-USDT"));
        flushRaf();
      });
      expect(latest().exhaustions?.list().map((entry) => entry.id)).toEqual(["e"]);
      expect(latest().candleMonitor?.frame.ts).toBe(T + 120_000);
    } finally {
      await unmount();
    }
  });

  it("a dropped socket keeps the shades but untrusted until the server's reset page arrives again, and drops the candle monitor", async () => {
    const { latest, unmount } = await mounted();
    try {
      await act(async () => {
        emit(page(0, true, [shade("a")]));
        emit(monitor(T + 60_000));
        flushRaf();
      });
      const book = latest().exhaustions!;
      expect(latest().candleMonitor).not.toBeNull();
      await act(async () => lastWorker.emit({ kind: "status", status: "closed" }));
      expect(book.size).toBe(1);
      expect(book.trusted()).toBe(false);
      expect(latest().candleMonitor).toBeNull();
      await act(async () => {
        lastWorker.emit({ kind: "status", status: "open" });
        emit(selection());
        emit(page(0, true, [shade("a")]));
        emit(monitor(T + 180_000));
        flushRaf();
      });
      expect(book.trusted()).toBe(true);
      expect(latest().candleMonitor?.frame.ts).toBe(T + 180_000);
    } finally {
      await unmount();
    }
  });
});
