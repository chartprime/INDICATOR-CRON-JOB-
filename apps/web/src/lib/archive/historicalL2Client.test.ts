import { describe, expect, it, vi } from "vitest";
import { createHistoricalL2Client, HISTORICAL_L2_CONTRACT, HISTORICAL_L2_PROFILES, type HistoricalL2Query } from "./historicalL2Client";

const query: HistoricalL2Query = { snapshotToken: "a".repeat(32), instrumentId: HISTORICAL_L2_PROFILES[0],
  date: "2026-08-05", family: "events", from: "1785888000000000000", to: "1785888001000000000",
  asOfKey: ["1785888000999999999", "2", "999", "0"] };
const row = (position: string) => ({ schema: "historical-l2-level-event/1", instrument_id: query.instrumentId,
  segment_id: "c".repeat(64), event_id: "d".repeat(64), event_seq: 1, event_type: "segment_open", source_ns: query.from,
  observed_engine_ms: 1785888000000, engine_seq: null, side: null, price_key: null, observation_id: null, lifecycle_id: null,
  record_evidence_gap: false, evidence_quality: "resting_unknown",
  derivation_id: "b".repeat(64), append_position: position, known_ns: query.from,
  known_key: [query.from, "2", "1", "0"], payload: { amount: 3, source_size: "9007199254740993" } });
function page(rows = [row("0")], nextCursor: string | null = null) {
  return { ...query, contractVersion: HISTORICAL_L2_CONTRACT, operation: "page", releaseId: "c".repeat(64),
    derivationId: "b".repeat(64), depthLimit: 10, tickSize: "0.25", quantityUnit: "CONTRACT", rows, nextCursor,
    truncatedBy: nextCursor === null ? null : "rows",
    scan: { scanBytes: 0, partsOpened: 0, bytesRead: 0, cacheHits: 0, cacheMisses: 0, fetchMs: 0, queryMs: 0 } };
}
const respond = (body: unknown) => new Response(JSON.stringify(body));

describe("historical L2 browser boundary", () => {
  it("concatenates bound pages with exact string times and source sizes", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(respond(page([row("0")], "next"))).mockResolvedValueOnce(respond(page([row("1")])));
    const client = createHistoricalL2Client({ token: "private-test-token", fetchImpl });
    expect((await client.window(query)).rows).toEqual([row("0"), row("1")]);
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body)).cursor).toBe("next");
    expect(fetchImpl.mock.calls[0][0]).toBe("/archive/l2");
  });

  it.each([
    { ...page(), releaseId: "invalid" }, { ...page(), instrumentId: HISTORICAL_L2_PROFILES[1] },
    { ...page(), rows: [{ ...row("0"), known_ns: query.to }] },
    { ...page(), rows: [{ ...row("0"), known_key: [query.to, "2", "1", "0"] }] },
    { ...page(), rows: [{ ...row("0"), payload: { amount: 9007199254740992 } }] },
    { ...page(), tickSize: "0.5" }, { ...page(), rows: [row("0"), row("0")] },
    { ...page(), extra: "unexpected" }, { ...page(), rows: [{ ...row("0"), extra: "unexpected" }] },
  ])("refuses malformed, mismatched and future rows", async (body) => {
    const client = createHistoricalL2Client({ token: "test", fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(respond(body)) });
    await expect(client.page(query)).rejects.toThrow();
  });

  it.each(["cursor", "rows", "release"]) ("refuses a broken %s chain", async (kind) => {
    const second = kind === "cursor" ? page([], "next") : kind === "rows" ? page([row("0")]) : { ...page([row("1")]), releaseId: "d".repeat(64) };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(respond(page([row("0")], "next"))).mockResolvedValueOnce(respond(second));
    await expect(createHistoricalL2Client({ token: "test", fetchImpl }).window(query)).rejects.toThrow();
  });

  it("refuses chart budgets instead of returning partial success", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(respond(page([row("0"), row("1")])));
    const client = createHistoricalL2Client({ token: "test", fetchImpl });
    await expect(client.window(query, { maxRows: 1 })).rejects.toThrow("chart budget");
  });

  it("aborts using the caller signal and rejects invalid requests before fetch", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(respond(page()));
    const client = createHistoricalL2Client({ token: "test", fetchImpl });
    await expect(client.page({ ...query, from: "0" })).rejects.toThrow("request");
    expect(fetchImpl).not.toHaveBeenCalled();
    await client.page(query, { signal: controller.signal });
    expect(fetchImpl.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it("rejects oversize responses and explicit unavailable responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(" ".repeat(4194305)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: HISTORICAL_L2_CONTRACT, error: "UNKNOWN_INSTRUMENT" }), { status: 404 }));
    const client = createHistoricalL2Client({ token: "test", fetchImpl });
    await expect(client.page(query)).rejects.toThrow("oversized");
    await expect(client.page(query)).rejects.toThrow("UNKNOWN_INSTRUMENT");
  });
});
