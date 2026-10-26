// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArchiveQuery, ArchiveResult } from "./archiveClient";
import { HISTORICAL_INSTRUMENTS } from "./historicalCatalog";
import { useArchiveTradeAvailability } from "./useArchiveTradeAvailability";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const BTC = HISTORICAL_INSTRUMENTS.find((instrument) => instrument.id === "btc-spot")!;
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);

afterEach(async () => {
  await act(async () => root.render(<div />));
});

/**
 * Lets the hook's retry timers run until `done` holds, a few milliseconds at a
 * time, rather than for one fixed sleep: under a loaded full-suite run a fixed
 * sleep can end before the retries have, which made these tests flaky.
 */
async function settleUntil(done: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  // A little longer still, so a call past the expected count would show.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

const readyOf = () => container.firstElementChild?.getAttribute("data-ready");

describe("served crypto trade availability", () => {
  it("pins four family probes to the candle snapshot and admits the verified instrument", async () => {
    const query = vi.fn(async (request: ArchiveQuery): Promise<ArchiveResult> => ({
      outcome: "page", rows: [], nextCursor: null, pointerToken: request.pointerToken!,
      queryFingerprint: "probe", family: request.family,
      coverage: { requested: { from: request.from, to: request.to }, served: null,
        partitions: 1, states: { PUBLISHED: 1 }, corrupt: [] }, scan: {},
    }));
    function Probe({ pointer }: { pointer: string }) {
      const ready = useArchiveTradeAvailability(BTC, pointer, { client: { query } });
      return <div data-ready={String(ready)} />;
    }
    await act(async () => root.render(<Probe pointer="p1" />));
    expect(query).toHaveBeenCalledTimes(4);
    expect(container.firstElementChild?.getAttribute("data-ready")).toBe("true");
    expect(query.mock.calls.every(([request]) => request.pointerToken === "p1" && request.limit === 1)).toBe(true);
    expect(query.mock.calls[0][0].from).toBe("1757116800000000000");
    await act(async () => root.render(<Probe pointer="p2" />));
    expect(query).toHaveBeenCalledTimes(8);
    expect(container.firstElementChild?.getAttribute("data-ready")).toBe("true");
  });

  it("keeps studies closed when any family is missing", async () => {
    const query = vi.fn(async (request: ArchiveQuery): Promise<ArchiveResult> => ({
      outcome: "page", rows: [], nextCursor: null,
      pointerToken: request.family === "trade_prints_1m" ? "other" : request.pointerToken!,
      queryFingerprint: "probe", family: request.family,
      coverage: { requested: { from: request.from, to: request.to }, served: null,
        partitions: request.family === "trade_slice_2s" ? 0 : 1,
        states: request.family === "trade_slice_2s" ? { MISSING: 1 } : { PUBLISHED: 1 }, corrupt: [] }, scan: {},
    }));
    function Probe() {
      const ready = useArchiveTradeAvailability(BTC, "p1", { client: { query } });
      return <div data-ready={String(ready)} />;
    }
    await act(async () => root.render(<Probe />));
    expect(container.firstElementChild?.getAttribute("data-ready")).toBe("false");
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("rejects a response from another served pointer", async () => {
    const query = vi.fn(async (request: ArchiveQuery): Promise<ArchiveResult> => ({
      outcome: "page", rows: [], nextCursor: null, pointerToken: "other",
      queryFingerprint: "probe", family: request.family,
      coverage: { requested: { from: request.from, to: request.to }, served: null,
        partitions: 1, states: { PUBLISHED: 1 }, corrupt: [] }, scan: {},
    }));
    function Probe() {
      return <div data-ready={String(useArchiveTradeAvailability(BTC, "p1", { client: { query } }))} />;
    }
    await act(async () => root.render(<Probe />));
    expect(container.firstElementChild?.getAttribute("data-ready")).toBe("false");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("asks again after a network error or a busy archive, and opens once the families answer (PR #34 review)", async () => {
    let calls = 0;
    const query = vi.fn(async (request: ArchiveQuery): Promise<ArchiveResult> => {
      calls += 1;
      if (calls === 1) throw new TypeError("network down");
      if (calls === 2) return { outcome: "refused", code: "OVERLOADED", detail: null, status: 429, retryAfterMs: 5 };
      return {
        outcome: "page", rows: [], nextCursor: null, pointerToken: request.pointerToken!,
        queryFingerprint: "probe", family: request.family,
        coverage: { requested: { from: request.from, to: request.to }, served: null,
          partitions: 1, states: { PUBLISHED: 1 }, corrupt: [] }, scan: {},
      };
    });
    function Probe() {
      return <div data-ready={String(useArchiveTradeAvailability(BTC, "p1", { client: { query }, retryDelaysMs: [1, 1] }))} />;
    }
    await act(async () => root.render(<Probe />));
    await settleUntil(() => readyOf() === "true");
    expect(readyOf()).toBe("true");
    expect(query).toHaveBeenCalledTimes(6);
  });

  it("gives up after its retries, and never retries an answered refusal", async () => {
    const down = vi.fn(async (): Promise<ArchiveResult> => { throw new TypeError("network down"); });
    function Down() {
      return <div data-ready={String(useArchiveTradeAvailability(BTC, "p1", { client: { query: down }, retryDelaysMs: [1, 1] }))} />;
    }
    await act(async () => root.render(<Down />));
    await settleUntil(() => down.mock.calls.length >= 3);
    expect(readyOf()).toBe("false");
    expect(down).toHaveBeenCalledTimes(3);
    const refused = vi.fn(async (): Promise<ArchiveResult> => ({ outcome: "refused", code: "NOT_FOUND", detail: null, status: 404, retryAfterMs: null }));
    function Refused() {
      return <div data-ready={String(useArchiveTradeAvailability(BTC, "p1", { client: { query: refused }, retryDelaysMs: [1, 1] }))} />;
    }
    await act(async () => root.render(<Refused />));
    await settleUntil(() => refused.mock.calls.length >= 1);
    expect(readyOf()).toBe("false");
    expect(refused).toHaveBeenCalledTimes(1);
  });
});

