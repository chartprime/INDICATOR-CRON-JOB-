import type { SelectionTraceEvent } from "../../hooks/useMarketData";
import type { FrameIdentity } from "../../types/frames";
import type { SelectionTraceTransport } from "../../workers/marketDataWorker";

const MAX_SELECTION_TRACES = 64;
const MAX_PERFORMANCE_ENTRIES = 512;

export type SelectionTraceOutcome = "IN_PROGRESS" | "COMPLETE" | "SUPERSEDED";

export type SelectionTraceRecord = {
  runId: string;
  selectionGeneration: number;
  connectionId: number | null;
  provider: FrameIdentity["provider"];
  marketKind?: "SPOT" | "PERPETUAL";
  assetClass?: "EQUITY" | "FUTURE";
  symbol: string;
  requestedAtMs: number;
  workerSentAtMs: number | null;
  workerReceivedAtMs: number | null;
  workerParsedAtMs: number | null;
  mainReceivedAtMs: number | null;
  reactAppliedAtMs: number | null;
  chartCommittedAtMs: number | null;
  firstPaintAtMs: number | null;
  outcome: SelectionTraceOutcome;
  reason: "NONE" | "NEW_SELECTION";
  recoveries: Array<{ connectionId: number; workerReceivedAtMs: number; workerParsedAtMs: number; mainReceivedAtMs: number }>;
  backfill: Array<{ connectionId: number; status: "RUNNING" | "COMPLETE" | "FAILED"; reason: string | null; atMs: number }>;
};

export type BrowserPerformanceEntry = {
  entryType: string;
  name: string;
  startTime: number;
  duration: number;
};

declare global {
  interface Window {
    __ttSelectionTraces?: SelectionTraceRecord[];
    __ttPerformanceEntries?: BrowserPerformanceEntry[];
  }
}

function traces(): SelectionTraceRecord[] {
  return window.__ttSelectionTraces ??= [];
}

function boundedPush<T>(target: T[], value: T, limit: number): void {
  target.push(value);
  if (target.length > limit) target.splice(0, target.length - limit);
}

function traceNowMs(): number {
  return performance.timeOrigin + performance.now();
}

function identityFields(identity: FrameIdentity): Pick<SelectionTraceRecord, "provider" | "marketKind" | "assetClass"> {
  return identity.provider === "BINANCE"
    ? { provider: identity.provider, marketKind: identity.marketKind }
    : { provider: identity.provider, assetClass: identity.assetClass };
}

export function recordSelectionTrace(event: SelectionTraceEvent): void {
  const buffer = traces();
  if (event.phase === "selection_requested") {
    for (const record of buffer) {
      if (record.outcome === "IN_PROGRESS") {
        record.outcome = "SUPERSEDED";
        record.reason = "NEW_SELECTION";
      }
    }
    boundedPush(buffer, {
      selectionGeneration: event.selectionGeneration,
      runId: event.runId,
      connectionId: null,
      ...identityFields(event),
      symbol: event.symbol,
      requestedAtMs: event.requestedAtMs,
      workerSentAtMs: null,
      workerReceivedAtMs: null,
      workerParsedAtMs: null,
      mainReceivedAtMs: null,
      reactAppliedAtMs: null,
      chartCommittedAtMs: null,
      firstPaintAtMs: null,
      outcome: "IN_PROGRESS",
      reason: "NONE",
      recoveries: [],
      backfill: [],
    }, MAX_SELECTION_TRACES);
    return;
  }
  const record = buffer.findLast((candidate) => candidate.runId === event.runId && candidate.selectionGeneration === event.selectionGeneration);
  if (!record) return;
  if (event.phase === "recovery_confirmed") {
    boundedPush(record.recoveries, {
      connectionId: event.connectionId,
      workerReceivedAtMs: event.receivedAtMs,
      workerParsedAtMs: event.parsedAtMs,
      mainReceivedAtMs: event.mainReceivedAtMs,
    }, 16);
    return;
  }
  if (event.phase === "backfill_status") {
    if (event.backfillStatus === undefined) return;
    boundedPush(record.backfill, {
      connectionId: event.connectionId,
      status: event.backfillStatus,
      reason: event.backfillReason === null || event.backfillReason === undefined ? null : event.backfillReason.slice(0, 256),
      atMs: event.mainReceivedAtMs,
    }, 16);
    return;
  }
  if (event.phase !== "react_selection_applied") return;
  if (record.outcome !== "IN_PROGRESS") return;
  record.connectionId = event.connectionId;
  record.workerSentAtMs = event.sentAtMs;
  record.workerReceivedAtMs = event.receivedAtMs;
  record.workerParsedAtMs = event.parsedAtMs;
  record.mainReceivedAtMs = event.mainReceivedAtMs;
  record.reactAppliedAtMs = event.reactAppliedAtMs;
}

export function recordSelectionChartCommit(trace: SelectionTraceTransport): void {
  const record = traces().findLast((candidate) => candidate.runId === trace.runId && candidate.selectionGeneration === trace.selectionGeneration);
  if (!record || record.outcome !== "IN_PROGRESS") return;
  record.connectionId = trace.connectionId;
  record.workerSentAtMs ??= trace.sentAtMs;
  record.workerReceivedAtMs = trace.receivedAtMs;
  record.workerParsedAtMs = trace.parsedAtMs;
  record.chartCommittedAtMs = traceNowMs();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (record.outcome !== "IN_PROGRESS") return;
      record.firstPaintAtMs = traceNowMs();
      record.outcome = "COMPLETE";
    });
  });
}

export function installBrowserPerformanceTrace(): () => void {
  const entries = window.__ttPerformanceEntries ??= [];
  if (typeof PerformanceObserver !== "function") return () => {};
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      boundedPush(entries, {
        entryType: entry.entryType.slice(0, 32),
        name: entry.name.slice(0, 128),
        startTime: entry.startTime,
        duration: entry.duration,
      }, MAX_PERFORMANCE_ENTRIES);
    }
  });
  for (const type of ["longtask", "event", "paint"] as const) {
    try { observer.observe({ type, buffered: true, durationThreshold: type === "event" ? 16 : undefined } as PerformanceObserverInit); } catch { /* unsupported entry type */ }
  }
  return () => observer.disconnect();
}
