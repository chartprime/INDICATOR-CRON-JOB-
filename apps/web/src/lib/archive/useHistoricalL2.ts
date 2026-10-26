import { useEffect, useState, type RefObject } from "react";
import type { ChartPanelHandle } from "../../components/chart/ChartPanel";
import { studySegmentsFor } from "./archiveStudyPlan";
import type { HistoricalInstrument } from "./historicalCatalog";
import { createHistoricalL2Client, HistoricalL2RequestError, type HistoricalL2Catalog, type HistoricalL2Query } from "./historicalL2Client";
import { HistoricalL2States } from "./historicalL2States";
import { historicalBookL2 } from "./historicalBookL2";
import { historicalBookLiquidity } from "./historicalBookLiquidity";
import { historicalWallL2 } from "./historicalWallL2";
import { HistoricalLiquidityGrid } from "./historicalLiquidityGrid";
import { historicalPrints } from "./historicalPrints";
import type { AggressiveTape } from "../indicators/aggressive-orders/aggressiveTape";
import type { HistoricalL2Page } from "./historicalL2Client";

const TOKEN = typeof import.meta.env.VITE_ARCHIVE_CLIENT_TOKEN === "string" ? import.meta.env.VITE_ARCHIVE_CLIENT_TOKEN.trim() : "";
const MAX = "18446744073709551615";
let nextVersion = 0;
type Client = ReturnType<typeof createHistoricalL2Client>;
export type HistoricalL2Sample = Readonly<{ fromMs: number; toMs: number; date: string }>;
export type HistoricalL2Status = Readonly<{ available: boolean; loading: boolean; issue: string | null; wallsAvailable?: boolean; printsAvailable?: boolean; sample?: HistoricalL2Sample }>;

export function historicalL2Sample(instrument: HistoricalInstrument, catalog: HistoricalL2Catalog): HistoricalL2Sample | undefined {
  for (const session of catalog.sessions) {
    if (session.state !== "AVAILABLE" || !["walls", "prints"].every((family) => catalog.indexes?.some(
      (index) => index.instrument_id === session.instrument_id && index.date === session.date && index.family === family))) continue;
    const fromMs = Date.parse(`${session.date}T13:30:00Z`), toMs = fromMs + 15 * 60000;
    if (!studySegmentsFor(instrument).some((part) => part.instrumentId === session.instrument_id && part.fromTs <= fromMs && part.toTs >= toMs)) continue;
    return { fromMs, toMs, date: session.date };
  }
  return undefined;
}

export function historicalL2Window(instrument: HistoricalInstrument, catalog: HistoricalL2Catalog, fromMs: number, toMs: number): HistoricalL2Query {
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs < 0 || toMs <= fromMs || toMs - fromMs > 3600000) {
    throw new Error("Historical L2: zoom to one hour or less.");
  }
  const segment = studySegmentsFor(instrument).find((part) => part.fromTs <= fromMs && part.toTs >= toMs);
  if (segment === undefined) throw new Error("Historical L2: select one supported contract window.");
  const date = new Date(fromMs).toISOString().slice(0, 10);
  if (toMs > Date.parse(`${date}T00:00:00Z`) + 86400000) throw new Error("Historical L2: select one UTC day.");
  const session = catalog.sessions.find((row) => row.instrument_id === segment.instrumentId && row.date === date);
  if (session?.state !== "AVAILABLE") throw new Error(`Historical L2 unavailable for ${date}: ${session?.reason ?? "outside published coverage"}.`);
  // Close observations belong to the preceding second; include the right boundary without exceeding one hour.
  const from = (BigInt(fromMs) * 1000000n + 1n).toString(), cut = (BigInt(toMs) * 1000000n).toString();
  return { snapshotToken: catalog.snapshotToken, instrumentId: segment.instrumentId, date, family: "states",
    from, to: (BigInt(cut) + 1n).toString(), asOfKey: [cut, MAX, MAX, MAX], limit: 10000 };
}

function queriesWithWarmup(instrument: HistoricalInstrument, catalog: HistoricalL2Catalog, range: { fromMs: number; toMs: number }, warmupMs: number) {
  historicalL2Window(instrument, catalog, range.fromMs, range.toMs);
  const segment = studySegmentsFor(instrument).find((part) => part.fromTs <= range.fromMs && part.toTs >= range.toMs)!;
  const dayStart = Date.parse(new Date(range.fromMs).toISOString().slice(0, 10));
  const queries: HistoricalL2Query[] = [];
  for (let from = Math.max(dayStart, segment.fromTs, range.fromMs - warmupMs); from < range.toMs;) {
    const to = Math.min(from + 3600000, range.toMs);
    queries.push(historicalL2Window(instrument, catalog, from, to)); from = to;
  }
  return queries;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export function useHistoricalL2({ chartRef, instrument, generation, intervalMs, enabled, wallsEnabled = true, printsEnabled = true, token = TOKEN, client: injected,
  debounceMs = 300, pacingMs = 1000 }: { chartRef: RefObject<ChartPanelHandle | null>; instrument: HistoricalInstrument | null;
    generation: string | null; intervalMs: number; enabled: boolean; wallsEnabled?: boolean; printsEnabled?: boolean;
    token?: string; client?: Client; debounceMs?: number; pacingMs?: number }): HistoricalL2Status {
  const [status, setStatus] = useState<HistoricalL2Status>({ available: false, loading: false, issue: null });
  const [sample, setSample] = useState<Readonly<{ instrumentId: string; generation: string; value: HistoricalL2Sample }> | null>(null);
  useEffect(() => {
    const chart = chartRef.current;
    chart?.applyHistoricalL2(null);
    setStatus({ available: false, loading: false, issue: null });
    setSample(null);
    if (instrument === null || generation === null || instrument.source !== "databento" || chart === null) return;
    const client = injected ?? (token ? createHistoricalL2Client({ token }) : null);
    if (client === null) return;
    const controller = new AbortController();
    let request: AbortController | null = null, timer: ReturnType<typeof setTimeout> | null = null;
    let catalog: HistoricalL2Catalog | null = null, available = false;
    let range: { fromMs: number; toMs: number } | null = null;
    let cachedWindow: { fromMs: number; toMs: number; snapshotToken: string; apply: () => void; status: HistoricalL2Status } | null = null;
    let sequence = 0;
    const run = async () => {
      if (!enabled || catalog === null || range === null || controller.signal.aborted) return;
      request?.abort();
      const selected = new AbortController(); request = selected;
      const current = ++sequence;
      chart.applyHistoricalL2(null);
      try {
        const selectedRange = range;
        if (cachedWindow?.fromMs === selectedRange.fromMs && cachedWindow.toMs === selectedRange.toMs
            && cachedWindow.snapshotToken === catalog.snapshotToken) {
          cachedWindow.apply(); setStatus(cachedWindow.status); return;
        }
        setStatus({ available, loading: true, issue: "Historical L2: loading verified top-ten states." });
        let builder: HistoricalL2States | null = null, tick = 0;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const pinned = catalog;
          const queries = queriesWithWarmup(instrument, pinned, selectedRange, 10 * 60000);
          builder = null;
          let pageCount = 0, rowCount = 0;
          try {
            for (const query of queries) for await (const page of client.pages(query, { signal: selected.signal })) {
              if (builder === null) { builder = new HistoricalL2States(page.instrumentId, page.derivationId, page.tickSize); tick = Number(page.tickSize); }
              if (page.releaseId !== pinned.releaseId || page.derivationId !== builder.derivationId) throw new Error("Historical L2 release changed; reload the chart.");
              builder.push(page.rows);
              pageCount += 1; rowCount += page.rows.length;
              if (!selected.signal.aborted && !controller.signal.aborted && current === sequence) {
                setStatus({ available, loading: true, issue: `Historical L2: loading top-ten states; ${rowCount.toLocaleString()} rows, ${pageCount} pages.` });
              }
              if (page.nextCursor !== null) await wait(pacingMs, selected.signal);
            }
            break;
          } catch (error) {
            if (attempt !== 0 || !(error instanceof HistoricalL2RequestError) || error.code !== "POINTER_TOKEN_INVALID") throw error;
            if (selected.signal.aborted || controller.signal.aborted || current !== sequence) return;
            const refreshed = await client.catalog({ signal: selected.signal });
            if (selected.signal.aborted || controller.signal.aborted || current !== sequence) return;
            catalog = refreshed;
            const value = historicalL2Sample(instrument, refreshed);
            setSample(value === undefined ? null : { instrumentId: instrument.id, generation, value });
          }
        }
        if (selected.signal.aborted || controller.signal.aborted || current !== sequence || builder === null) return;
        let seconds = builder.finish();
        const version = ++nextVersion;
        let wallsAvailable = !wallsEnabled && catalog.indexes?.some((row) => row.family === "walls" && row.instrument_id === builder.instrumentId && row.date === new Date(selectedRange.fromMs).toISOString().slice(0, 10)) === true;
        let printsAvailable = !printsEnabled && catalog.indexes?.some((row) => row.family === "prints" && row.instrument_id === builder.instrumentId && row.date === new Date(selectedRange.fromMs).toISOString().slice(0, 10)) === true;
        let wallIssue = "", printIssue = "";
        let wallPage: HistoricalL2Page | null = null, tape: AggressiveTape | null = null;
        const query = historicalL2Window(instrument, catalog, selectedRange.fromMs, selectedRange.toMs);
        if (wallsEnabled) try {
          const rows: HistoricalL2Page["rows"][number][] = [];
          let bytes = 0;
          for (const warmed of queriesWithWarmup(instrument, catalog, selectedRange, 10 * 60000)) {
            const walls = await client.window({ ...warmed, family: "walls" }, { signal: selected.signal, maxRows: 14400, maxBytes: 64 * 1024 * 1024 });
            if (walls.releaseId !== catalog.releaseId || walls.derivationId !== builder.derivationId
                || wallPage !== null && wallPage.wallProfileId !== walls.wallProfileId) throw new Error("Historical wall source differs from depth.");
            bytes += new TextEncoder().encode(JSON.stringify(walls.rows)).length;
            if (rows.length + walls.rows.length > 14400 || bytes > 64 * 1024 * 1024) throw new Error("Historical wall warm-up exceeds the chart budget; zoom in.");
            rows.push(...walls.rows); wallPage = { ...walls, rows };
          }
          const tracker = wallPage?.wallProfile?.tracker;
          if (typeof tracker !== "object" || tracker === null || !("minSize" in tracker) || typeof tracker.minSize !== "number"
              || wallPage?.wallProfileId === undefined || wallPage.wallProfile?.sample_ms !== 1000) throw new Error("Historical wall detector profile unavailable.");
          wallsAvailable = true;
        } catch (error) {
          wallPage = null;
          if (selected.signal.aborted || controller.signal.aborted || current !== sequence) return;
          wallIssue = error instanceof HistoricalL2RequestError && error.code === "UNKNOWN_INSTRUMENT"
            ? "; wall history is not qualified for this date" : "; wall history unavailable";
        }
        if (printsEnabled) try {
          const rows: HistoricalL2Page["rows"][number][] = [];
          let bytes = 0;
          for (const warmed of queriesWithWarmup(instrument, catalog, selectedRange, 10 * 60000)) {
            const prints = await client.window({ ...warmed, family: "prints" }, { signal: selected.signal });
            if (prints.releaseId !== catalog.releaseId || prints.derivationId !== builder.derivationId) throw new Error("Historical trades differ from depth.");
            bytes += new TextEncoder().encode(JSON.stringify(prints.rows)).length;
            if (rows.length + prints.rows.length > 100000 || bytes > 32 * 1024 * 1024) throw new Error("Historical trades exceed the chart budget; zoom in.");
            rows.push(...prints.rows);
          }
          const prints = historicalPrints(rows, seconds, query.instrumentId, builder.derivationId, query.asOfKey[0]);
          seconds = prints.seconds; tape = prints.tape; printsAvailable = true;
          if (prints.unknownCount > 0) printIssue = `; ${prints.unknownCount} unclassified trades omitted from side-based studies`;
        } catch (error) {
          if (selected.signal.aborted || controller.signal.aborted || current !== sequence) return;
          printIssue = error instanceof Error ? `; individual trades unavailable: ${error.message}` : "; individual trades unavailable";
        }
        if (selected.signal.aborted || controller.signal.aborted || current !== sequence) return;
        let source = historicalBookL2(seconds, tick, version);
        if (wallPage !== null) source = historicalWallL2(source, wallPage.rows, version,
          { id: wallPage.wallProfileId!, minimumSize: Number((wallPage.wallProfile!.tracker as { minSize: number }).minSize), sampleMs: 1000 });
        const liquidity = historicalBookLiquidity(seconds, tick, version, instrument.group === "Futures" ? "contracts" : "shares");
        const grid = new HistoricalLiquidityGrid(liquidity, source, query.instrumentId);
        const apply = () => chart.applyHistoricalL2(source, liquidity, grid, tape);
        apply();
        const gaps = seconds.some((second) => !second.complete || !second.trusted);
        const loadedStatus: HistoricalL2Status = { available, wallsAvailable, printsAvailable, loading: false, issue: seconds.some((second) => second.column !== null)
          ? `Historical L2: top 10, one-second close observations; warm-up up to 10 minutes${gaps ? "; gaps/partial seconds are omitted" : ""}${wallPage !== null ? `; verified walls (minimum ${source.wallProfile!.minimumSize} ${instrument.group === "Futures" ? "contracts" : "shares"}, fixed detector profile; history limited to the loaded window)` : wallIssue}${printIssue}.`
          : "Historical L2: no complete trusted book seconds in this window." };
        cachedWindow = (!wallsEnabled || wallsAvailable) && (!printsEnabled || printsAvailable)
          ? { ...selectedRange, snapshotToken: catalog.snapshotToken, apply, status: loadedStatus } : null;
        setStatus(loadedStatus);
      } catch (error) {
        if (!selected.signal.aborted && !controller.signal.aborted && current === sequence) {
          chart.applyHistoricalL2(null);
          setStatus({ available, loading: false, issue: error instanceof Error ? error.message : "Historical L2 read failed." });
        }
      }
    };
    const unsubscribe = chart.subscribeVisibleRangeChange((fromMs, toMs) => {
      if (range?.fromMs === fromMs && range.toMs === toMs + intervalMs
          && cachedWindow?.fromMs === range.fromMs && cachedWindow.toMs === range.toMs
          && cachedWindow.snapshotToken === catalog?.snapshotToken) return;
      range = { fromMs, toMs: toMs + intervalMs };
      request?.abort(); ++sequence;
      chart.applyHistoricalL2(null);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void run(); }, debounceMs);
    });
    void client.catalog({ signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      catalog = result;
      const value = historicalL2Sample(instrument, result);
      setSample(value === undefined ? null : { instrumentId: instrument.id, generation, value });
      const identities = new Set(studySegmentsFor(instrument).map((segment) => segment.instrumentId));
      available = result.sessions.some((row) => identities.has(row.instrument_id) && row.state === "AVAILABLE");
      setStatus({ available, loading: false,
        wallsAvailable: result.indexes?.some((row) => row.family === "walls" && identities.has(row.instrument_id)) === true,
        printsAvailable: result.indexes?.some((row) => row.family === "prints" && identities.has(row.instrument_id)) === true,
        issue: available ? null : "Historical L2: no published qualified dates for this instrument." });
      if (timer !== null) { clearTimeout(timer); timer = null; }
      void run();
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setStatus({ available: false, loading: false,
        issue: enabled ? error instanceof Error ? error.message : "Historical L2 catalog unavailable." : null });
    });
    return () => {
      controller.abort(); request?.abort(); ++sequence;
      if (timer !== null) clearTimeout(timer);
      unsubscribe(); chart.applyHistoricalL2(null);
    };
  }, [chartRef, instrument, generation, intervalMs, enabled, wallsEnabled, printsEnabled, token, injected, debounceMs, pacingMs]);
  return { ...status, sample: sample?.instrumentId === instrument?.id && sample?.generation === generation ? sample.value : undefined };
}
