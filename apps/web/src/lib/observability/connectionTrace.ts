const MAX_CONNECTION_CLOSES = 256;
const MAX_REASON_LENGTH = 160;

export type ConnectionCloseRecord = {
  atMs: number;
  reason: string;
};

export type ConnectionCloseTrace = {
  counts: Record<string, number>;
  recent: ConnectionCloseRecord[];
};

declare global {
  interface Window {
    __ttConnectionCloses?: ConnectionCloseTrace;
  }
}

export function connectionCloseCategory(reason: string): string {
  const separator = reason.indexOf(":");
  return separator === -1 ? reason : reason.slice(0, separator);
}

export function recordConnectionClose(reason: string | undefined, atMs = performance.timeOrigin + performance.now()): void {
  const trace = window.__ttConnectionCloses ??= { counts: {}, recent: [] };
  const bounded = (reason ?? "unspecified").slice(0, MAX_REASON_LENGTH);
  const category = connectionCloseCategory(bounded);
  trace.counts[category] = (trace.counts[category] ?? 0) + 1;
  trace.recent.push({ atMs, reason: bounded });
  if (trace.recent.length > MAX_CONNECTION_CLOSES) trace.recent.splice(0, trace.recent.length - MAX_CONNECTION_CLOSES);
}
