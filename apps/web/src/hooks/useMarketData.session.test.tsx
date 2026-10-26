// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { useMarketData, type UseMarketDataResult } from "./useMarketData";
import type { BarFrame, MarkerFrame, TradeFrame } from "../types/frames";
import type { WorkerToMainMessage } from "../workers/marketDataWorker";

// Report 57 W1, GE-14: for a US equity everything on the chart is regular
// session only -- bars (and so every bar study), bubbles and markers -- while
// the trade tape keeps every print. Futures are untouched.

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerToMainMessage>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: Event) => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
  emit(msg: WorkerToMainMessage): void {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerToMainMessage>);
  }
}

let worker: FakeWorker;
let rafCallbacks: FrameRequestCallback[] = [];

beforeEach(() => {
  rafCallbacks = [];
  vi.stubGlobal("Worker", class {
    constructor() {
      worker = new FakeWorker();
      return worker as unknown as Worker;
    }
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => rafCallbacks.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

function flushRaf(): void {
  const callbacks = rafCallbacks;
  rafCallbacks = [];
  for (const cb of callbacks) cb(0);
}

const PRE = Date.parse("2026-09-23T13:29:00Z"); // 09:29 EDT
const OPEN = Date.parse("2026-09-23T13:30:00Z"); // 09:30 EDT

function identity(assetClass: "EQUITY" | "FUTURE") {
  return { symbol: assetClass === "EQUITY" ? "AAPL" : "/NQZ26:XCME", provider: "DXFEED" as const, assetClass };
}

function trade(assetClass: "EQUITY" | "FUTURE", ts: number, id: string): TradeFrame {
  return { type: "trade", ...identity(assetClass), ts_exchange: ts, price: 100, size: 5_000, side: "buy", trade_id: id } as TradeFrame;
}

function marker(assetClass: "EQUITY" | "FUTURE", ts: number, id: string): MarkerFrame {
  return { type: "marker", ...identity(assetClass), ts_exchange: ts, price: 100, size: 5_000, side: "buy", trade_id: id } as MarkerFrame;
}

function bar(assetClass: "EQUITY" | "FUTURE", tsOpen: number): BarFrame {
  return {
    type: "bar", ...identity(assetClass), interval_ms: 60_000, ts_open: tsOpen, open: 100, high: 100, low: 100, close: 100,
    volume: 5_000, trade_count: 1, closed: false,
  } as BarFrame;
}

async function run(assetClass: "EQUITY" | "FUTURE", auctionAtOpen = false) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const delivered: [number, string[]][] = [];
  let latest: UseMarketDataResult | null = null;
  function Harness() {
    latest = useMarketData({ url: "ws://test", onBar: (b, trades) => delivered.push([b.ts_open, trades.map((t) => t.trade_id)]) });
    return null;
  }
  await act(async () => root.render(<Harness />));
  await act(async () => {
    worker.emit({ kind: "frame", frame: { type: "selection", ...identity(assetClass) } as never });
    worker.emit({ kind: "frame", frame: trade(assetClass, PRE + 1_000, "pre") });
    worker.emit({ kind: "frame", frame: marker(assetClass, PRE + 1_000, "pre-m") });
    worker.emit({ kind: "frame", frame: bar(assetClass, PRE) });
    worker.emit({ kind: "frame", frame: trade(assetClass, OPEN + 1_000, "rth") });
    if (auctionAtOpen) worker.emit({ kind: "frame", frame: { ...trade(assetClass, OPEN, "cross"), auction: true } });
    worker.emit({ kind: "frame", frame: marker(assetClass, OPEN + 1_000, "rth-m") });
    worker.emit({ kind: "frame", frame: bar(assetClass, OPEN) });
    flushRaf();
  });
  const result = latest as unknown as UseMarketDataResult;
  const outcome = {
    tape: result.trades.map((t) => t.trade_id).sort(),
    bubbles: (result.aggressiveTape?.prints ?? []).map((p) => p.id).sort(),
    bars: delivered,
    markers: result.markerView.snapshot().map((m) => m.trade_id).sort(),
  };
  await act(async () => root.unmount());
  return outcome;
}

describe("useMarketData regular-session chart scope (GE-14)", () => {
  it("an auction print (O-3) is on the tape and in its bar, but never a bubble", async () => {
    const outcome = await run("EQUITY", true);
    expect(outcome.tape).toEqual(["cross", "pre", "rth"]);
    expect(outcome.bubbles).toEqual(["rth"]);
    expect(outcome.bars).toEqual([[OPEN, ["cross", "rth"]]]);
  });

  it("equity: the tape keeps the pre-market print; bars, bubbles and markers are regular session only", async () => {
    const outcome = await run("EQUITY");
    expect(outcome.tape).toEqual(["pre", "rth"]);
    expect(outcome.bubbles).toEqual(["rth"]);
    expect(outcome.bars).toEqual([[OPEN, ["rth"]]]);
    expect(outcome.markers).toEqual(["rth-m"]);
  });

  it("futures: every hour stays on the chart", async () => {
    const outcome = await run("FUTURE");
    expect(outcome.tape).toEqual(["pre", "rth"]);
    expect(outcome.bubbles).toEqual(["pre", "rth"]);
    expect(outcome.bars).toEqual([[PRE, ["pre"]], [OPEN, ["rth"]]]);
    expect(outcome.markers).toEqual(["pre-m", "rth-m"]);
  });
});
