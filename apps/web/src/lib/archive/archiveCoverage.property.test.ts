import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ARCHIVE_CONTRACT_VERSION, ARCHIVE_COVERAGE_STATES, ArchiveTransportError, createArchiveClient } from "./archiveClient";

// Report 57 W1, F5: the browser enforces the archive-query/1 coverage block
// exactly as docs/contracts/archive-query/v1/archive-query-v1.schema.json
// defines it -- the closed eight-state vocabulary, half-open nanosecond
// windows as decimal strings, bounded gap and corrupt lists, no extra keys.
// Every schema-valid coverage is accepted unchanged; any single violation is
// a contract error at the boundary, never a page with a half-read coverage.

const window = fc.tuple(
  fc.bigInt({ min: 0n, max: 10n ** 19n - 100_000n }),
  fc.integer({ min: 5_000, max: 100_000 }),
).map(([from, width]) => ({ from: String(from), to: String(from + BigInt(width)) }));
const date = fc.date({ min: new Date("2020-01-01T00:00:00Z"), max: new Date("2030-12-31T00:00:00Z"), noInvalidDate: true }).map((d) => d.toISOString().slice(0, 10));
const coverage = fc.record({
  requested: window,
  served: fc.option(fc.tuple(fc.nat({ max: 1_000 }), fc.nat({ max: 1_000 })), { nil: null }),
  partitions: fc.nat({ max: 10_000 }),
  states: fc.dictionary(fc.constantFrom(...ARCHIVE_COVERAGE_STATES), fc.nat({ max: 10_000 })),
  gaps: fc.option(fc.array(fc.record({ date, state: fc.constantFrom("MISSING", "QUARANTINED", "FAILED", "CORRUPT", "UNKNOWN") }), { maxLength: 5 }), { nil: undefined }),
  corrupt: fc.array(fc.record({ date, reason: fc.option(fc.string({ maxLength: 128 }), { nil: null }) }), { maxLength: 5 }),
}).map((value) => {
  const { gaps, served, ...rest } = value;
  const contained = served === null ? null : {
    from: String(BigInt(rest.requested.from) + BigInt(served[0])),
    to: String(BigInt(rest.requested.to) - BigInt(served[1])),
  };
  return gaps === undefined ? { ...rest, served: contained } : { ...rest, served: contained, gaps };
});

function clientReturning(body: unknown) {
  return createArchiveClient({
    token: "t",
    fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
  });
}

function page(cov: unknown) {
  return { contractVersion: ARCHIVE_CONTRACT_VERSION, rows: [], nextCursor: null, pointerToken: "p", queryFingerprint: "f", family: "candle_1m", coverage: cov, scan: {} };
}

const request = { instrumentId: "i", family: "candle_1m" as const, from: "0", to: "1" };

const violations: ReadonlyArray<[string, (cov: Record<string, unknown>) => Record<string, unknown>]> = [
  ["a numeric window bound", (cov) => ({ ...cov, requested: { from: 1, to: "2" } })],
  ["a leading-zero window bound", (cov) => ({ ...cov, requested: { from: "01", to: "2" } })],
  ["a zero-length requested window", (cov) => ({ ...cov, requested: { from: "1", to: "1" } })],
  ["a reversed served window", (cov) => ({ ...cov, served: { from: "2", to: "1" } })],
  ["a served window outside the request", (cov) => ({ ...cov, served: { from: "0", to: "99999999999999999999" } })],
  ["a missing served key", (cov) => { const { served: _served, ...rest } = cov; return rest; }],
  ["a state outside the vocabulary", (cov) => ({ ...cov, states: { ...(cov.states as object), PARTIAL: 1 } })],
  ["a negative state count", (cov) => ({ ...cov, states: { UNKNOWN: -1 } })],
  ["a fractional state count", (cov) => ({ ...cov, states: { PUBLISHED: 1.5 } })],
  ["a negative partition count", (cov) => ({ ...cov, partitions: -1 })],
  ["an unknown coverage key", (cov) => ({ ...cov, inferred: true })],
  ["a gap in a non-gap state", (cov) => ({ ...cov, gaps: [{ date: "2026-09-23", state: "PUBLISHED" }] })],
  ["an over-long corrupt reason", (cov) => ({ ...cov, corrupt: [{ date: "2026-09-23", reason: "x".repeat(129) }] })],
  ["an unbounded corrupt list", (cov) => ({ ...cov, corrupt: Array.from({ length: 513 }, () => ({ date: "2026-09-23", reason: null })) })],
];

describe("archive-query/1 coverage at the browser boundary (F5)", () => {
  it("accepts every schema-valid coverage block unchanged", async () => {
    await fc.assert(fc.asyncProperty(coverage, async (cov) => {
      const result = await clientReturning(page(cov)).query(request);
      expect(result.outcome).toBe("page");
      if (result.outcome !== "page") return;
      expect(result.coverage.requested).toEqual(cov.requested);
      expect(result.coverage.served).toEqual(cov.served);
      expect(result.coverage.states).toEqual(cov.states);
      expect(result.coverage.corrupt).toEqual(cov.corrupt);
    }), { numRuns: 300 });
  });

  it.each(violations)("rejects %s as a contract error", async (_name, violate) => {
    await fc.assert(fc.asyncProperty(coverage, async (cov) => {
      await expect(clientReturning(page(violate(cov as Record<string, unknown>))).query(request)).rejects.toBeInstanceOf(ArchiveTransportError);
    }), { numRuns: 25 });
  });

  it("a valid empty window and a window outside coverage both parse and stay distinguishable by state", async () => {
    const empty = await clientReturning(page({ requested: { from: "0", to: "1" }, served: null, partitions: 1, states: { PUBLISHED: 1 }, corrupt: [] })).query(request);
    const outside = await clientReturning(page({ requested: { from: "0", to: "1" }, served: null, partitions: 0, states: { UNKNOWN: 1 }, corrupt: [] })).query(request);
    expect(empty.outcome === "page" && empty.coverage.states).toEqual({ PUBLISHED: 1 });
    expect(outside.outcome === "page" && outside.coverage.states).toEqual({ UNKNOWN: 1 });
  });
});
