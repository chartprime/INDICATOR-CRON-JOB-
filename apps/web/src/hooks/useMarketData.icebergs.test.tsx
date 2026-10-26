// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { useMarketData, type UseMarketDataResult } from "./useMarketData";
import type { IcebergOrder, ServerFrame } from "../types/frames";
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

function selection(symbol = "BTC-USDT"): ServerFrame {
  return { type: "selection", ...PAIR, symbol } as ServerFrame;
}

function iceberg(id: string, overrides: Partial<IcebergOrder> = {}): IcebergOrder {
  return { id, kind: "probable", confidence: "strong", origin: "runtime", side: "ask", price: 80924.2, display: 1.545, tranches: 2, executed: 12.475, startedAt: 1000, markedAt: 1500, updatedAt: 2000, status: "active", ...overrides };
}

function page(seq: number, reset: boolean, icebergs: IcebergOrder[], symbol = "BTC-USDT"): ServerFrame {
  return { type: "iceberg_orders", ...PAIR, symbol, ts: 5000 + seq, seq, reset, icebergs, watched: [], liveSince: 1000 } as ServerFrame;
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

describe("useMarketData: the Iceberg Detector's pages", () => {
  it("a reset page becomes the book at the next frame flush, and an increment upserts into it", async () => {
    const { latest, unmount } = await mounted();
    try {
      await act(async () => emit(page(0, true, [iceberg("a")])));
      expect(latest().icebergs).toBeNull();
      await act(async () => flushRaf());
      const book = latest().icebergs;
      expect(book).not.toBeNull();
      expect(book?.list().map((entry) => entry.id)).toEqual(["a"]);
      expect(book?.trusted()).toBe(true);
      const version = latest().icebergsVersion;
      expect(version).toBeGreaterThan(0);
      await act(async () => {
        emit(page(1, false, [iceberg("a", { executed: 20, updatedAt: 3000 }), iceberg("b", { markedAt: 1600 })]));
        flushRaf();
      });
      expect(latest().icebergs).toBe(book);
      expect(book?.get("a")?.executed).toBe(20);
      expect(book?.size).toBe(2);
      expect(latest().icebergsVersion).toBeGreaterThan(version);
    } finally {
      await unmount();
    }
  });

  it("ignores another pair's pages and an increment that arrives before any reset", async () => {
    const { latest, unmount } = await mounted();
    try {
      await act(async () => {
        emit(page(0, true, [iceberg("eth")], "ETH-USDT"));
        emit(page(3, false, [iceberg("early")]));
        flushRaf();
      });
      expect(latest().icebergs?.size ?? 0).toBe(0);
      expect(latest().icebergs?.trusted() ?? false).toBe(false);
    } finally {
      await unmount();
    }
  });

  it("a pair switch clears the book before the new pair's reset arrives", async () => {
    const { latest, unmount } = await mounted();
    try {
      await act(async () => {
        emit(page(0, true, [iceberg("a")]));
        flushRaf();
      });
      const book = latest().icebergs!;
      const before = latest().icebergsVersion;
      await act(async () => emit(selection("ETH-USDT")));
      expect(book.size).toBe(0);
      expect(book.trusted()).toBe(false);
      expect(latest().icebergsVersion).toBeGreaterThan(before);
      await act(async () => {
        emit(page(0, true, [iceberg("e")], "ETH-USDT"));
        flushRaf();
      });
      expect(latest().icebergs?.list().map((entry) => entry.id)).toEqual(["e"]);
    } finally {
      await unmount();
    }
  });

  it("a dropped socket keeps the icebergs but untrusted until the server's reset page arrives again", async () => {
    const { latest, unmount } = await mounted();
    try {
      await act(async () => {
        emit(page(0, true, [iceberg("a")]));
        flushRaf();
      });
      const book = latest().icebergs!;
      await act(async () => lastWorker.emit({ kind: "status", status: "closed" }));
      expect(book.size).toBe(1);
      expect(book.trusted()).toBe(false);
      await act(async () => {
        lastWorker.emit({ kind: "status", status: "open" });
        emit(selection());
        emit(page(0, true, [iceberg("a")]));
        flushRaf();
      });
      expect(book.trusted()).toBe(true);
    } finally {
      await unmount();
    }
  });
});
