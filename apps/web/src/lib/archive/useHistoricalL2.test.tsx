// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChartPanelHandle } from "../../components/chart/ChartPanel";
import type { IndicatorL2 } from "../chart/indicatorL2";
import type { IndicatorLiquidity } from "../chart/indicatorLiquidity";
import { HISTORICAL_INSTRUMENTS } from "./historicalCatalog";
import { HISTORICAL_L2_PROFILES, HistoricalL2RequestError, type HistoricalL2Catalog, type HistoricalL2Page, type HistoricalL2Row, type createHistoricalL2Client } from "./historicalL2Client";
import { historicalL2Window, useHistoricalL2, type HistoricalL2Status } from "./useHistoricalL2";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const instrument = HISTORICAL_INSTRUMENTS.find((row) => row.id === "es-continuous")!;
const ts = Date.parse("2026-08-05T14:30:00Z"), id = HISTORICAL_L2_PROFILES[0];
const catalog: HistoricalL2Catalog = { operation: "catalog", releaseId: "c".repeat(64), snapshotToken: "d".repeat(32), depthLimit: 10,
  inference: "top-ten depth inference; not order-level cancellation truth", sessions: [{ instrument_id: id, date: "2026-08-05", state: "AVAILABLE", reason: "FULL_DAY_VERIFIED" }],
  indexes: [{ family: "walls", instrument_id: id, date: "2026-08-05" }, { family: "prints", instrument_id: id, date: "2026-08-05" }] };
const row: HistoricalL2Row = { schema: "historical-l2-second/1", family: "l2_level_state_1s", instrument_id: id, derivation_id: "a".repeat(64), append_position: "0",
  known_ns: String(BigInt(ts + 1000) * 1000000n), known_key: null, payload: { row_kind: "coverage", open_ns: String(BigInt(ts) * 1000000n), close_ns: String(BigInt(ts + 1000) * 1000000n),
    covered_from_ns: String(BigInt(ts) * 1000000n), complete: true, point_prefix: false, trusted: true, segment_id: "b".repeat(64), reason: "OBSERVED_PREFIX", tick_size: "0.25", depth_limit: 10,
    bid_range: [400, 400], ask_range: [404, 404], flow: { BUY: 0, SELL: 0, UNKNOWN: 0, count: 0 } } };
const page = { operation: "page", releaseId: catalog.releaseId, instrumentId: id, derivationId: row.derivation_id, tickSize: "0.25", rows: [row], nextCursor: null } as unknown as HistoricalL2Page;
let root: Root | null = null, container: HTMLDivElement | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; container?.remove(); container = null; });

function setup(pages?: () => AsyncGenerator<HistoricalL2Page>) {
  let handler: ((from: number, to: number) => void) | null = null;
  const apply = vi.fn<(source: IndicatorL2 | null, liquidity?: IndicatorLiquidity | null) => void>();
  const chart = { applyHistoricalL2: apply, subscribeVisibleRangeChange: (next: typeof handler) => { handler = next; next?.(ts, ts); return () => { handler = null; }; } };
  const client = { catalog: vi.fn(async () => catalog), pages: vi.fn(pages ?? async function* () { yield page; }),
    window: vi.fn(async () => { throw new Error("index unavailable"); }) } as unknown as ReturnType<typeof createHistoricalL2Client>;
  let status: HistoricalL2Status | null = null;
  function Probe({ generation = "old", enabled = true, wallsEnabled = true, printsEnabled = true }:
    { generation?: string; enabled?: boolean; wallsEnabled?: boolean; printsEnabled?: boolean }) {
    status = useHistoricalL2({ chartRef: ref, instrument, generation, intervalMs: 1000, enabled, wallsEnabled, printsEnabled, client, debounceMs: 0, pacingMs: 0 });
    return null;
  }
  const ref = { current: chart as unknown as ChartPanelHandle };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  return { apply, client, status: () => status, render: async (props = {}) => act(async () => root!.render(<Probe {...props} />)),
    pan: async (from: number, to: number) => act(async () => { handler?.(from, to); await new Promise((resolve) => setTimeout(resolve, 5)); }) };
}

describe("historical L2 loading", () => {
  it("offers a sample only where both derived families and the selected contract are published", async () => {
    const run = setup(); await run.render({ enabled: false });
    expect(run.status()?.sample).toEqual({ date: "2026-08-05", fromMs: Date.parse("2026-08-05T13:30:00Z"), toMs: Date.parse("2026-08-05T13:45:00Z") });
    vi.mocked(run.client.catalog).mockResolvedValue({ ...catalog, indexes: catalog.indexes!.filter((item) => item.family === "walls") });
    await run.render({ generation: "new", enabled: false });
    expect(run.status()?.sample).toBeUndefined();
  });
  it("reuses only the exact verified window and discards the cache on generation change", async () => {
    const run = setup(); await run.render({ wallsEnabled: false, printsEnabled: false });
    const source = run.apply.mock.calls.at(-1)?.[0];
    const calls = run.apply.mock.calls.length;
    await run.pan(ts, ts);
    expect(run.apply.mock.calls).toHaveLength(calls);
    expect(run.client.pages).toHaveBeenCalledTimes(1);
    await run.pan(ts, ts + 3600000);
    expect(run.apply.mock.calls.at(-1)?.[0]).toBeNull();
    await run.pan(ts, ts);
    expect(run.apply.mock.calls.at(-1)?.[0]).toBe(source);
    expect(run.client.pages).toHaveBeenCalledTimes(1);
    await run.render({ generation: "new", wallsEnabled: false, printsEnabled: false });
    expect(run.client.pages).toHaveBeenCalledTimes(2);
    expect(run.apply.mock.calls.at(-1)?.[0]).not.toBe(source);
  });
  it("loads only selected dependencies without hiding eligible unselected studies", async () => {
    const run = setup(); await run.render({ wallsEnabled: false, printsEnabled: false });
    expect(run.client.pages).toHaveBeenCalledTimes(1);
    expect(run.client.window).not.toHaveBeenCalled();
    expect(run.status()).toMatchObject({ available: true, wallsAvailable: true, printsAvailable: true, loading: false });
    expect(run.status()?.issue).not.toContain("verified walls");
    await run.render({ wallsEnabled: false, printsEnabled: true });
    expect(vi.mocked(run.client.window).mock.calls.map(([query]) => query.family)).toEqual(["prints"]);
    expect(run.status()).toMatchObject({ wallsAvailable: true, printsAvailable: false });
  });
  it("resolves the continuous contract, includes the closing boundary and refuses absent/day-crossing/oversized windows", () => {
    const query = historicalL2Window(instrument, catalog, ts, ts + 3600000);
    expect(query.instrumentId).toBe(id);
    expect(BigInt(query.to) - BigInt(query.from)).toBe(3600000000000n);
    expect(BigInt(query.to)).toBe(BigInt(ts + 3600000) * 1000000n + 1n);
    expect(() => historicalL2Window(instrument, catalog, ts, ts + 3600001)).toThrow("one hour");
    expect(() => historicalL2Window(instrument, catalog, ts + 86400000, ts + 86401000)).toThrow("unavailable");
    const midnight = Date.parse("2026-08-05T23:59:59Z");
    expect(() => historicalL2Window(instrument, catalog, midnight, midnight + 2000)).toThrow("UTC day");
  });
  it("discovers coverage and installs a complete bounded display; switching generation clears and reloads it", async () => {
    const run = setup(); await run.render();
    expect(run.status()).toMatchObject({ available: true, loading: false });
    expect(run.client.pages).toHaveBeenCalledTimes(1);
    expect(run.apply.mock.calls.at(-1)?.[0]?.availability).toBe("HISTORICAL");
    const input = run.apply.mock.calls.at(-1)?.[1];
    expect(input?.baseAsset).toBe("contracts");
    expect(input?.atTime?.(ts)?.feed.fine.columns).toHaveLength(0);
    expect(input?.atTime?.(ts + 1000)?.feed.fine.columns).toHaveLength(1);
    const firstEpoch = input!.feed.epoch;
    await run.render({ generation: "new" });
    expect(run.client.catalog).toHaveBeenCalledTimes(2);
    expect(run.apply.mock.calls.some(([source]) => source === null)).toBe(true);
    expect(run.apply.mock.calls.at(-1)?.[1]?.feed.epoch).not.toBe(firstEpoch);
  });
  it("discovers eligibility without loading unselected indicators", async () => {
    const run = setup(); await run.render({ enabled: false });
    expect(run.status()?.available).toBe(true);
    expect(run.client.pages).not.toHaveBeenCalled();
    expect(run.apply.mock.calls.every(([source]) => source === null)).toBe(true);
  });
  it("clears on an oversized pan instead of retaining another time's book", async () => {
    const run = setup(); await run.render(); await run.pan(ts, ts + 3600000);
    expect(run.status()?.issue).toContain("one hour");
    expect(run.apply.mock.calls.at(-1)?.[0]).toBeNull();
    expect(run.client.pages).toHaveBeenCalledTimes(1);
  });
  it("does not install a late response after the viewer moves away", async () => {
    let release: (() => void) | null = null;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const run = setup(async function* () { await paused; yield page; });
    await run.render(); await run.pan(ts, ts + 3600000);
    await act(async () => { release!(); await paused; });
    expect(run.apply.mock.calls.every(([source]) => source === null)).toBe(true);
  });
  it("refuses a changed derivation mid-window and doesn't install partial data", async () => {
    const run = setup(async function* () { yield { ...page, nextCursor: "next" }; yield { ...page, derivationId: "f".repeat(64) }; });
    await run.render(); await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(run.status()?.issue).toContain("release changed");
    expect(run.apply.mock.calls.every(([source]) => source === null)).toBe(true);
  });
  it("discards a partial expired snapshot and restarts the whole window against fresh discovery", async () => {
    let calls = 0;
    const refreshed = { ...catalog, releaseId: "e".repeat(64), snapshotToken: "f".repeat(32) };
    const run = setup(async function* () {
      if (calls++ === 0) {
        yield { ...page, nextCursor: "next" };
        throw new HistoricalL2RequestError("POINTER_TOKEN_INVALID", 409);
      }
      yield { ...page, releaseId: refreshed.releaseId };
    });
    vi.mocked(run.client.catalog).mockResolvedValueOnce(catalog).mockResolvedValue(refreshed);
    await run.render(); await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(run.client.catalog).toHaveBeenCalledTimes(2);
    expect(run.client.pages).toHaveBeenCalledTimes(2);
    expect(vi.mocked(run.client.pages).mock.calls[1][0].snapshotToken).toBe(refreshed.snapshotToken);
    expect(vi.mocked(run.client.pages).mock.calls[1][0]).not.toHaveProperty("cursor");
    expect(run.status()).toMatchObject({ available: true, loading: false });
    expect(run.apply.mock.calls.at(-1)?.[0]?.availability).toBe("HISTORICAL");
  });
  it("bounds snapshot recovery and never retries corruption as snapshot expiry", async () => {
    const expired = setup(async function* () { throw new HistoricalL2RequestError("POINTER_TOKEN_INVALID", 409); });
    await expired.render();
    expect(expired.client.catalog).toHaveBeenCalledTimes(2);
    expect(expired.client.pages).toHaveBeenCalledTimes(2);
    expect(expired.status()?.issue).toContain("POINTER_TOKEN_INVALID");
    expect(expired.apply.mock.calls.every(([source]) => source === null)).toBe(true);
    await act(async () => root!.unmount()); root = null; container?.remove();
    const corrupt = setup(async function* () { throw new HistoricalL2RequestError("PARTITION_VERIFICATION_FAILED", 500); });
    await corrupt.render();
    expect(corrupt.client.catalog).toHaveBeenCalledTimes(1);
    expect(corrupt.client.pages).toHaveBeenCalledTimes(1);
    expect(corrupt.status()?.issue).toContain("PARTITION_VERIFICATION_FAILED");
  });
});
