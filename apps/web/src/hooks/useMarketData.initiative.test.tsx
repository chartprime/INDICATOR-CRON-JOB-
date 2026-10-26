// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { useMarketData, type UseMarketDataResult } from "./useMarketData";
import type { InitiativeBand, ServerFrame } from "../types/frames";
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

function band(id: string, overrides: Partial<InitiativeBand> = {}): InitiativeBand {
  return {
    id, candleMs: 60_000, side: "down", dominant: "sellers", dominantShare: 0.75, score: 4,
    facts: { efficiency: { yes: true, value: 0.714 }, closes: { yes: true, value: 2 }, burst: { yes: false, value: 0.8 }, delta: { yes: true, rank: 1, share: 0.75 }, prints: { yes: true, rank: 0.833, perCandle: 1 } },
    pivotTs: T, pivotPrice: 108, frozenTs: T + 180_000, frozenPrice: 105.5, windowCandles: 3, atr: 1,
    legExtremePrice: 105, legExtremeTs: T + 180_000, legEndTs: null, updatedAt: T + 240_000, origin: "runtime", ...overrides,
  };
}

function page(seq: number, reset: boolean, bands: InitiativeBand[], symbol = "BTC-USDT"): ServerFrame {
  return { type: "initiative_bands", ...PAIR, symbol, ts: T + seq, seq, reset, bands, liveSince: T - 3_600_000, loading: null } as ServerFrame;
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

describe("useMarketData: the Initiative Continuation pages across a pair switch and a dropped socket", () => {
  it("a reset page becomes the book at the next frame flush, and an increment upserts into it", async () => {
    const { latest, unmount } = await mounted();
    try {
      await act(async () => emit(page(0, true, [band("a")])));
      expect(latest().initiatives).toBeNull();
      await act(async () => flushRaf());
      const book = latest().initiatives;
      expect(book).not.toBeNull();
      expect(book?.list().map((entry) => entry.id)).toEqual(["a"]);
      expect(book?.trusted()).toBe(true);
      const version = latest().initiativesVersion;
      expect(version).toBeGreaterThan(0);
      await act(async () => {
        emit(page(1, false, [band("a", { legEndTs: T + 600_000, updatedAt: T + 600_000 }), band("b", { pivotTs: T + 60_000 })]));
        flushRaf();
      });
      expect(latest().initiatives).toBe(book);
      expect(book?.get("a")?.legEndTs).toBe(T + 600_000);
      expect(book?.size).toBe(2);
      expect(latest().initiativesVersion).toBeGreaterThan(version);
    } finally {
      await unmount();
    }
  });

  it("ignores another pair's pages and an increment that arrives before any reset", async () => {
    const { latest, unmount } = await mounted();
    try {
      await act(async () => {
        emit(page(0, true, [band("eth")], "ETH-USDT"));
        emit(page(3, false, [band("early")]));
        flushRaf();
      });
      expect(latest().initiatives?.size ?? 0).toBe(0);
      expect(latest().initiatives?.trusted() ?? false).toBe(false);
    } finally {
      await unmount();
    }
  });

  it("a pair switch clears the book before the new pair's frames arrive", async () => {
    const { latest, unmount } = await mounted();
    try {
      await act(async () => {
        emit(page(0, true, [band("a")]));
        flushRaf();
      });
      const book = latest().initiatives!;
      const before = latest().initiativesVersion;
      await act(async () => emit(selection("ETH-USDT")));
      expect(book.size).toBe(0);
      expect(book.trusted()).toBe(false);
      expect(latest().initiativesVersion).toBeGreaterThan(before);
      await act(async () => {
        emit(page(0, true, [band("e")], "ETH-USDT"));
        flushRaf();
      });
      expect(latest().initiatives?.list().map((entry) => entry.id)).toEqual(["e"]);
    } finally {
      await unmount();
    }
  });

  it("a dropped socket keeps the bands but untrusted until the server's reset page arrives again", async () => {
    const { latest, unmount } = await mounted();
    try {
      await act(async () => {
        emit(page(0, true, [band("a")]));
        flushRaf();
      });
      const book = latest().initiatives!;
      await act(async () => lastWorker.emit({ kind: "status", status: "closed" }));
      expect(book.size).toBe(1);
      expect(book.trusted()).toBe(false);
      await act(async () => {
        lastWorker.emit({ kind: "status", status: "open" });
        emit(selection());
        emit(page(0, true, [band("a")]));
        flushRaf();
      });
      expect(book.trusted()).toBe(true);
    } finally {
      await unmount();
    }
  });

  it("requestInitiativeHistory posts an initiative_history control message with the asked start to the worker", async () => {
    const { latest, unmount } = await mounted();
    try {
      await act(async () => {
        latest().requestInitiativeHistory(1_700_000_000_000);
      });
      expect(lastWorker.posted.filter((m) => (m as { kind?: string }).kind === "initiative_history")).toEqual([{ kind: "initiative_history", from_ts: 1_700_000_000_000 }]);
    } finally {
      await unmount();
    }
  });
});
