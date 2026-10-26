import { describe, expect, it, vi } from "vitest";
import { ArchiveTransportError, type ArchivePage, type ArchiveQuery, createArchiveClient } from "./archiveClient";
import { queryArchivePages } from "./archivePagination";

const request: ArchiveQuery = {
  instrumentId: '["BINANCE","SPOT","BTCUSDT","USDT","COIN"]',
  family: "candle_1m",
  from: "1000000000",
  to: "2000000000",
  limit: 10_000,
};

function page(overrides: Partial<ArchivePage> = {}): ArchivePage {
  return {
    outcome: "page",
    rows: [{ open_ns: "1000000000" }],
    nextCursor: null,
    pointerToken: "snapshot",
    queryFingerprint: "f".repeat(64),
    family: "candle_1m",
    coverage: {
      requested: { from: request.from, to: request.to }, served: null, partitions: 1, states: { PUBLISHED: 1 }, corrupt: [],
    },
    scan: { bytesRead: 10, cacheHits: 1, queryMs: 0.5 },
    ...overrides,
  };
}

function clientWith(...results: ArchivePage[]) {
  const query = vi.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  return { query } as unknown as ReturnType<typeof createArchiveClient>;
}

describe("archive pagination", () => {
  it("follows cursors inside one pinned request and combines only physical scan work", async () => {
    const client = clientWith(
      page({ nextCursor: "next", rows: [{ open_ns: "1000000000" }] }),
      page({ rows: [{ open_ns: "1001000000" }], scan: { bytesRead: 20, cacheHits: 2, queryMs: 1 } }),
    );

    const result = await queryArchivePages(client, request, { maximumPages: 2 });

    expect(result).toMatchObject({ outcome: "page", nextCursor: null, rows: [{ open_ns: "1000000000" }, { open_ns: "1001000000" }] });
    if (result.outcome !== "page") throw new Error("unreachable");
    expect(result.scan).toEqual({ bytesRead: 30, cacheHits: 3, queryMs: 1.5 });
    const query = client.query as unknown as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).not.toHaveProperty("pointerToken");
    expect(query.mock.calls[1][0]).toMatchObject({ cursor: "next", pointerToken: "snapshot" });
  });

  it("accepts the per-page served span the archive reports and merges it across pages", async () => {
    // Real shape from the host (ES 30m, 2026-09-21): every page reports its own
    // served span; only the rest of the coverage is identical across pages.
    const first = { from: "1787320800000000000", to: "1787826720000000000" };
    const second = { from: "1787826720000000000", to: "1788220800000000000" };
    const client = clientWith(
      page({ nextCursor: "next", coverage: { ...page().coverage, served: first, partitions: 9, states: { PUBLISHED: 9, UNKNOWN: 2 } } }),
      page({ rows: [{ open_ns: "1787826720000000000" }], coverage: { ...page().coverage, served: second, partitions: 9, states: { PUBLISHED: 9, UNKNOWN: 2 } } }),
    );

    const result = await queryArchivePages(client, request, { maximumPages: 2 });

    if (result.outcome !== "page") throw new Error("unreachable");
    expect(result.rows).toHaveLength(2);
    expect(result.coverage).toEqual({
      requested: { from: request.from, to: request.to },
      served: { from: first.from, to: second.to },
      partitions: 9,
      states: { PUBLISHED: 9, UNKNOWN: 2 },
      corrupt: [],
    });
  });

  it("merges served across an empty page and reports null when no page served anything", async () => {
    const served = { from: "1000000000", to: "1500000000" };
    const withEmpty = await queryArchivePages(clientWith(
      page({ nextCursor: "next", coverage: { ...page().coverage, served } }),
      page({ rows: [], coverage: { ...page().coverage, served: null } }),
    ), request, { maximumPages: 2 });
    if (withEmpty.outcome !== "page") throw new Error("unreachable");
    expect(withEmpty.coverage.served).toEqual(served);

    const nothing = await queryArchivePages(clientWith(page({ rows: [] })), request, { maximumPages: 1 });
    if (nothing.outcome !== "page") throw new Error("unreachable");
    expect(nothing.coverage.served).toBeNull();
  });

  it("refuses pages whose served span moves backwards, but tolerates the overlap tied timestamps produce", async () => {
    await expect(queryArchivePages(clientWith(
      page({ nextCursor: "next", coverage: { ...page().coverage, served: { from: "1200000000", to: "1500000000" } } }),
      page({ coverage: { ...page().coverage, served: { from: "1199999999", to: "2000000000" } } }),
    ), request, { maximumPages: 2 })).rejects.toThrow("out of order");
    await expect(queryArchivePages(clientWith(
      page({ nextCursor: "next", coverage: { ...page().coverage, served: { from: "1200000000", to: "1500000000" } } }),
      page({ coverage: { ...page().coverage, served: { from: "1300000000", to: "1499999999" } } }),
    ), request, { maximumPages: 2 })).rejects.toThrow("out of order");

    const overlapping = await queryArchivePages(clientWith(
      page({ nextCursor: "next", coverage: { ...page().coverage, served: { from: "1200000000", to: "1500000000" } } }),
      page({ coverage: { ...page().coverage, served: { from: "1499999999", to: "2000000000" } } }),
    ), request, { maximumPages: 2 });
    if (overlapping.outcome !== "page") throw new Error("unreachable");
    expect(overlapping.coverage.served).toEqual({ from: "1200000000", to: "2000000000" });
  });

  it("refuses to combine pages if their snapshot, query identity, or coverage changes", async () => {
    await expect(queryArchivePages(clientWith(
      page({ nextCursor: "next" }),
      page({ pointerToken: "other" }),
    ), request, { maximumPages: 2 })).rejects.toThrow("catalog snapshot");
    await expect(queryArchivePages(clientWith(
      page({ nextCursor: "next" }),
      page({ queryFingerprint: "e".repeat(64) }),
    ), request, { maximumPages: 2 })).rejects.toThrow("query identity");
    await expect(queryArchivePages(clientWith(
      page({ nextCursor: "next" }),
      page({ coverage: { ...page().coverage, states: { UNKNOWN: 1 } } }),
    ), request, { maximumPages: 2 })).rejects.toThrow("coverage while paging");
  });

  it("fails closed before a window can silently truncate", async () => {
    const client = clientWith(page({ nextCursor: "next" }));
    await expect(queryArchivePages(client, request, { maximumPages: 1 })).rejects.toBeInstanceOf(ArchiveTransportError);
  });
});
