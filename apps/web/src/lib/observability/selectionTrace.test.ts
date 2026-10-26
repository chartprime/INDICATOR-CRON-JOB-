// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordSelectionChartCommit, recordSelectionTrace } from "./selectionTrace";

describe("selection trace", () => {
  beforeEach(() => {
    window.__ttSelectionTraces = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
  });

  it("closes a request through confirmation, chart commit and the paint after commit", () => {
    recordSelectionTrace({
      phase: "selection_requested", runId: "11111111-1111-4111-8111-111111111111", selectionGeneration: 1, requestedAtMs: 10,
      symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
    });
    recordSelectionTrace({
      phase: "react_selection_applied", runId: "11111111-1111-4111-8111-111111111111", connectionId: 3, selectionGeneration: 1,
      requestedAtMs: 10, sentAtMs: 11, receivedAtMs: 12, parsedAtMs: 13,
      mainReceivedAtMs: 14, reactAppliedAtMs: 15,
      symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
    });
    recordSelectionChartCommit({
      phase: "first_snapshot", runId: "11111111-1111-4111-8111-111111111111", connectionId: 3, selectionGeneration: 1,
      requestedAtMs: 10, sentAtMs: 11, receivedAtMs: 16, parsedAtMs: 17,
    });

    expect(window.__ttSelectionTraces).toEqual([expect.objectContaining({
      selectionGeneration: 1,
      connectionId: 3,
      symbol: "BTC-USDT",
      chartCommittedAtMs: expect.any(Number),
      firstPaintAtMs: expect.any(Number),
      outcome: "COMPLETE",
    })]);
  });

  it("marks an unfinished generation superseded and keeps the buffer bounded", () => {
    for (let generation = 1; generation <= 70; generation++) {
      recordSelectionTrace({
        phase: "selection_requested", runId: "22222222-2222-4222-8222-222222222222", selectionGeneration: generation, requestedAtMs: generation,
        symbol: `PAIR-${generation}`, provider: "DXFEED", assetClass: "FUTURE",
      });
    }
    expect(window.__ttSelectionTraces).toHaveLength(64);
    expect(window.__ttSelectionTraces?.[0].selectionGeneration).toBe(7);
    expect(window.__ttSelectionTraces?.at(-2)).toMatchObject({ outcome: "SUPERSEDED", reason: "NEW_SELECTION" });
    expect(window.__ttSelectionTraces?.at(-1)).toMatchObject({ outcome: "IN_PROGRESS", reason: "NONE" });
  });

  it("retains bounded recovery and backfill milestones after first paint", () => {
    const common = {
      runId: "44444444-4444-4444-8444-444444444444", selectionGeneration: 4,
      requestedAtMs: 10, sentAtMs: 11, receivedAtMs: 12, parsedAtMs: 13,
      symbol: "BTC-USDT", provider: "BINANCE" as const, marketKind: "SPOT" as const,
    };
    recordSelectionTrace({ phase: "selection_requested", ...common });
    recordSelectionChartCommit({ phase: "first_snapshot", ...common, connectionId: 1 });
    for (let index = 0; index < 20; index++) {
      recordSelectionTrace({
        phase: "recovery_confirmed", ...common, connectionId: index + 2, mainReceivedAtMs: 20 + index,
      });
      recordSelectionTrace({
        phase: "backfill_status", ...common, connectionId: index + 2, mainReceivedAtMs: 40 + index,
        backfillStatus: index === 19 ? "COMPLETE" : "RUNNING", backfillReason: "x".repeat(300),
      });
    }
    const record = window.__ttSelectionTraces?.[0];
    expect(record?.recoveries).toHaveLength(16);
    expect(record?.backfill).toHaveLength(16);
    expect(record?.backfill.at(-1)).toMatchObject({ status: "COMPLETE" });
    expect(record?.backfill.at(-1)?.reason).toHaveLength(256);
  });

  it("rejects a milestone from the wrong selection generation", () => {
    recordSelectionTrace({
      phase: "selection_requested", runId: "55555555-5555-4555-8555-555555555555", selectionGeneration: 5, requestedAtMs: 10,
      symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
    });
    recordSelectionTrace({
      phase: "backfill_status", runId: "55555555-5555-4555-8555-555555555555", selectionGeneration: 6,
      connectionId: 1, requestedAtMs: 10, sentAtMs: 11, receivedAtMs: 12, parsedAtMs: 13, mainReceivedAtMs: 14,
      backfillStatus: "COMPLETE", backfillReason: null,
      symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
    });
    expect(window.__ttSelectionTraces?.[0].backfill).toEqual([]);
  });
});
