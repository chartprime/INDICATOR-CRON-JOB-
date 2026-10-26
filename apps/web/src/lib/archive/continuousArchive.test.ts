import { describe, expect, it, vi } from "vitest";
import type { ArchivePage, ArchiveQuery, ArchiveRow } from "./archiveClient";
import { createArchiveClient } from "./archiveClient";
import {
  mergeContinuousArchivePages,
  planContinuousArchiveQueries,
  queryContinuousArchivePage,
  validateContinuousFuture,
} from "./continuousArchive";
import { HISTORICAL_INSTRUMENTS, type HistoricalContinuousFuture } from "./historicalCatalog";

function future(id: string): HistoricalContinuousFuture {
  const instrument = HISTORICAL_INSTRUMENTS.find((candidate) => candidate.id === id);
  if (instrument?.kind !== "continuous") throw new Error(`missing continuous future ${id}`);
  return instrument;
}

function row(openMs: number): ArchiveRow {
  return {
    open_ns: (BigInt(openMs) * 1_000_000n).toString(),
    close_ns: (BigInt(openMs + 86_400_000) * 1_000_000n).toString(),
    open: "100.00",
    high: "101.00",
    low: "99.00",
    close: "100.50",
    volume: "42.00",
    closed: true,
  };
}

function page(
  query: ArchiveQuery,
  openMs: number,
  overrides: Partial<ArchivePage> = {},
): ArchivePage {
  return {
    outcome: "page",
    rows: [row(openMs)],
    nextCursor: null,
    pointerToken: "snapshot-token",
    queryFingerprint: "a".repeat(64),
    family: query.family,
    coverage: {
      requested: { from: query.from, to: query.to },
      served: { from: query.from, to: query.to },
      partitions: 1,
      states: { PUBLISHED: 1 },
      corrupt: [],
    },
    scan: {
      partitionsRead: 1,
      partitionsSelected: 1,
      partsOpened: 1,
      exactScanBytes: 10,
      bytesRead: 10,
      cacheHits: 1,
      cacheMisses: 0,
      fetchMs: 0.25,
      queryMs: 0.5,
    },
    ...overrides,
  };
}

describe("continuous archive futures", () => {
  it("turns the published ES manifest into five contiguous daily requests and four labelled boundary markers", () => {
    const plan = planContinuousArchiveQueries(future("es-continuous"), "1d");

    expect(plan.requests.map((request) => request.contract)).toEqual(["ESU5", "ESZ5", "ESH6", "ESM6", "ESU6"]);
    expect(plan.rollMarkers).toEqual([
      { time: Date.parse("2025-09-17T00:00:00.000Z"), label: "ESU5 → ESZ5" },
      { time: Date.parse("2025-12-17T00:00:00.000Z"), label: "ESZ5 → ESH6" },
      { time: Date.parse("2026-03-18T00:00:00.000Z"), label: "ESH6 → ESM6" },
      { time: Date.parse("2026-06-17T00:00:00.000Z"), label: "ESM6 → ESU6" },
    ]);
    for (let index = 1; index < plan.requests.length; index += 1) {
      expect(plan.requests[index - 1].toMs).toBe(plan.requests[index].fromMs);
    }
  });

  it("bounds an intraday request to the sole current contract instead of fanning out unnecessarily", () => {
    const plan = planContinuousArchiveQueries(future("nq-continuous"), "1m");

    expect(plan.requests).toHaveLength(1);
    expect(plan.requests[0].contract).toBe("NQU6");
    expect(plan.rollMarkers).toEqual([]);
  });

  it("refuses a malformed static manifest before it can create a network request", () => {
    const es = future("es-continuous");
    const invalid = {
      ...es,
      rolls: [{ ...es.rolls[0], archiveInstrumentId: JSON.stringify(["XCME", "FUTURE", "NQU5", "USD", "CONTRACT"]) }],
    } as HistoricalContinuousFuture;

    expect(() => validateContinuousFuture(invalid)).toThrow("mismatched archive identity");
  });

  it("merges only complete same-snapshot pages, rejecting output outside the contract that owns it", () => {
    const plan = planContinuousArchiveQueries(future("es-continuous"), "1d");
    const pages = plan.requests.map((request) => page(request.request, request.fromMs));
    const result = mergeContinuousArchivePages(plan, pages);

    expect(result.rows).toHaveLength(5);
    expect(result.pointerToken).toBe("snapshot-token");
    expect(result.coverage.partitions).toBe(5);
    expect(result.scan).toEqual({
      partitionsRead: 5,
      partitionsSelected: 5,
      partsOpened: 5,
      exactScanBytes: 50,
      bytesRead: 50,
      cacheHits: 5,
      cacheMisses: 0,
      fetchMs: 1.25,
      queryMs: 2.5,
    });

    expect(() => mergeContinuousArchivePages(plan, [
      ...pages.slice(0, -1),
      page(plan.requests.at(-1)!.request, plan.requests.at(-1)!.toMs),
    ])).toThrow("outside its roll interval");
    expect(() => mergeContinuousArchivePages(plan, [
      ...pages.slice(0, -1),
      page(plan.requests.at(-1)!.request, plan.requests.at(-1)!.fromMs, { pointerToken: "other-token" }),
    ])).toThrow("do not share one catalog snapshot");
    expect(() => mergeContinuousArchivePages(plan, [
      ...pages.slice(0, -1),
      page(plan.requests.at(-1)!.request, plan.requests.at(-1)!.fromMs, {
        coverage: { ...pages.at(-1)!.coverage, requested: { from: "0", to: "1" } },
      }),
    ])).toThrow("mismatched coverage bounds");
    expect(() => mergeContinuousArchivePages(plan, [
      ...pages.slice(0, -1),
      page(plan.requests.at(-1)!.request, plan.requests.at(-1)!.fromMs, {
        coverage: {
          ...pages.at(-1)!.coverage,
          served: { from: "0", to: plan.requests.at(-1)!.request.to },
        },
      }),
    ])).toThrow("invalid served coverage");
    expect(() => mergeContinuousArchivePages(plan, [
      ...pages.slice(0, -1),
      page(plan.requests.at(-1)!.request, plan.requests.at(-1)!.fromMs, {
        scan: { bytesRead: 1 },
      }),
    ])).toThrow("invalid scan metric set");
    expect(() => mergeContinuousArchivePages(plan, [
      ...pages.slice(0, -1),
      page(plan.requests.at(-1)!.request, plan.requests.at(-1)!.fromMs, { pointerToken: "" }),
    ])).toThrow("empty catalog snapshot token");
  });

  it("resolves the catalog snapshot from the first leg alone, then runs the remaining legs in parallel pinned to it", async () => {
    const plan = planContinuousArchiveQueries(future("es-continuous"), "1d");
    const query = vi.fn(async (request: ArchiveQuery): Promise<ArchivePage> =>
      page(request, plan.requests.find((item) => item.request.instrumentId === request.instrumentId)!.fromMs));
    const client = { query } as unknown as ReturnType<typeof createArchiveClient>;

    await expect(queryContinuousArchivePage(client, plan)).resolves.toMatchObject({ outcome: "page" });
    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls[0][0].pointerToken).toBeUndefined();
    for (const [index] of query.mock.calls.entries()) {
      if (index === 0) continue;
      expect(query.mock.calls[index][0].pointerToken).toBe("snapshot-token");
    }

    query.mockClear();
    query.mockImplementationOnce(async (request: ArchiveQuery) => page(request, plan.requests[0].fromMs, { nextCursor: "more" }));
    await expect(queryContinuousArchivePage(client, plan)).rejects.toThrow("page budget was exhausted");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("still fails the whole page when a parallel leg's response does not share the first leg's catalog snapshot", async () => {
    const plan = planContinuousArchiveQueries(future("es-continuous"), "1d");
    const query = vi.fn(async (request: ArchiveQuery) => page(
      request,
      plan.requests.find((item) => item.request.instrumentId === request.instrumentId)!.fromMs,
      { pointerToken: request.instrumentId === plan.requests[2].request.instrumentId ? "changed-token" : "snapshot-token" },
    ));
    const client = { query } as unknown as ReturnType<typeof createArchiveClient>;

    await expect(queryContinuousArchivePage(client, plan)).rejects.toThrow("changed catalog snapshot");
    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls[0][0].pointerToken).toBeUndefined();
    for (const [index] of query.mock.calls.entries()) {
      if (index === 0) continue;
      expect(query.mock.calls[index][0].pointerToken).toBe("snapshot-token");
    }
  });

  it("follows every bounded cursor page within an intraday roll interval before it joins the series", async () => {
    const nq = future("nq-continuous");
    const toMs = Date.parse(nq.availableToExclusive);
    const plan = planContinuousArchiveQueries(nq, "1m", {
      fromMs: toMs - 500 * 30 * 60_000,
      toMs,
    });
    expect(plan.requests).toHaveLength(1);
    expect(plan.requests[0].maximumPages).toBe(4);
    const request = plan.requests[0].request;
    const query = vi.fn(async (candidate: ArchiveQuery): Promise<ArchivePage> => page(
      request,
      candidate.cursor === "next-2" ? plan.requests[0].fromMs + 120_000
        : candidate.cursor === "next-1" ? plan.requests[0].fromMs + 60_000 : plan.requests[0].fromMs,
      candidate.cursor === undefined ? { nextCursor: "next-1" }
        : candidate.cursor === "next-1" ? { nextCursor: "next-2" } : {},
    ));
    const client = { query } as unknown as ReturnType<typeof createArchiveClient>;

    const result = await queryContinuousArchivePage(client, plan);

    expect(result).toMatchObject({ outcome: "page" });
    if (result.outcome !== "page") throw new Error("unreachable");
    expect(result.page.rows).toHaveLength(3);
    expect(query.mock.calls).toHaveLength(3);
    expect(query.mock.calls[1][0]).toMatchObject({ cursor: "next-1", pointerToken: "snapshot-token" });
    expect(query.mock.calls[2][0]).toMatchObject({ cursor: "next-2", pointerToken: "snapshot-token" });
  });
});
