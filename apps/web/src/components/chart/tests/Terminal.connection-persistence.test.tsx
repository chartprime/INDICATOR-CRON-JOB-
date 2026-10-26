// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import type { WorkerToMainMessage } from "../../../workers/marketDataWorker";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// This file deliberately does NOT mock useMarketData -- it's the one
// place that can prove the P3.04 AC's own wording ("no reconnect")
// directly, by watching the real Worker constructor/terminate calls
// across a full panel-switch cycle, rather than inferring persistence
// from component structure.

vi.mock("../ChartPanel", () => ({
  ChartPanel: () => null,
}));

vi.mock("../DomPanel", () => ({
  DomPanel: () => null,
}));

class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerToMainMessage>) => void) | null = null;
  terminate = vi.fn();
  postMessage(): void {}
}

let workerInstances: FakeWorker[] = [];

const { Terminal } = await import("../Terminal");

beforeEach(() => {
  workerInstances = [];
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        const instance = new FakeWorker();
        workerInstances.push(instance);
        return instance as unknown as Worker;
      }
    },
  );
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

let container: HTMLDivElement;
let root: Root;

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe("Terminal -- live connection persists across a panel-switch cycle (P3.04 AC)", () => {
  it("shows incomplete analytics after a paused-render overflow while retaining the live connection", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Terminal />));
    const worker = workerInstances[0];
    const identity = { symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" } as const;
    await act(async () => {
      worker.onmessage?.({ data: { kind: "status", status: "open" } } as MessageEvent<WorkerToMainMessage>);
      worker.onmessage?.({ data: { kind: "frame", frame: { type: "selection", ...identity } } } as MessageEvent<WorkerToMainMessage>);
      for (let i = 0; i < 5001; i++) worker.onmessage?.({ data: { kind: "frame", frame: {
        type: "vpin", ...identity, seal_ts: i, active: false, direction: null, strength: 0, z_vpin: 0, z_velocity: 0, z_acceleration: 0, activated_at_ts: null,
      } } } as MessageEvent<WorkerToMainMessage>);
    });
    expect(container.textContent).toContain("Analytics incomplete — reload to rebuild");
    expect(worker.terminate).not.toHaveBeenCalled();
  });
  it("switching chart -> placeholder -> chart never tears down or recreates the Worker", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<Terminal />);
    });

    expect(workerInstances).toHaveLength(1);
    const worker = workerInstances[0];

    const railTabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('.rail [role="tab"]'));

    // live chart -> historical shell
    await act(async () => {
      railTabs()[1].click();
    });
    expect(container.querySelector("#panel-content-chart")?.hasAttribute("hidden")).toBe(true);
    expect(container.querySelector("#panel-content-historical")?.hasAttribute("hidden")).toBe(false);

    // historical shell -> heatmap
    await act(async () => {
      railTabs()[2].click();
    });

    // heatmap -> chart (back to the live view)
    await act(async () => {
      railTabs()[0].click();
    });
    expect(container.querySelector("#panel-content-chart")?.hasAttribute("hidden")).toBe(false);

    expect(workerInstances).toHaveLength(1);
    expect(worker.terminate).not.toHaveBeenCalled();
  });
});
