import { useEffect, useState } from "react";
import { createArchiveClient, type ArchiveFamily, type ArchiveQuery, type ArchiveResult } from "./archiveClient";
import { studySegmentsFor } from "./archiveStudyPlan";
import type { HistoricalInstrument } from "./historicalCatalog";

const TOKEN = typeof import.meta.env.VITE_ARCHIVE_CLIENT_TOKEN === "string"
  ? import.meta.env.VITE_ARCHIVE_CLIENT_TOKEN.trim() : "";
const FAMILIES: readonly ArchiveFamily[] = [
  "trade_minute_1m", "trade_level_1m", "trade_slice_2s", "trade_prints_1m",
];
const DAY_MS = 86_400_000;
/**
 * A probe that could not be answered (a network error, a timeout, the archive busy or failing: 429 or 5xx) is asked
 * again after these waits, or the archive's own retry-after when longer.
 * A probe that was answered -- a family missing, a different snapshot -- is the answer and is never retried.
 */
export const TRADE_PROBE_RETRY_DELAYS_MS: readonly number[] = Object.freeze([2_000, 5_000]);

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type Client = Readonly<{
  query: (request: ArchiveQuery,
    options?: { signal?: AbortSignal }) => Promise<ArchiveResult>;
}>;

export function useArchiveTradeAvailability(
  instrument: HistoricalInstrument | null,
  pointerToken: string | null,
  { token = TOKEN, client, retryDelaysMs = TRADE_PROBE_RETRY_DELAYS_MS }: { token?: string; client?: Client; retryDelaysMs?: readonly number[] } = {},
): boolean {
  const [verified, setVerified] = useState<string | null>(null);
  const key = instrument === null || pointerToken === null ? null : `${instrument.id}\u0000${pointerToken}`;
  const query = client?.query;
  // By value: a caller passing a fresh array each render must not restart the probe each render.
  const retryKey = retryDelaysMs.join(",");

  useEffect(() => {
    setVerified(null);
    if (instrument === null || instrument.source !== "binance" || pointerToken === null || !token && !query) return;
    const segments = studySegmentsFor(instrument);
    if (segments.length !== 1 || segments[0].toTs - segments[0].fromTs < DAY_MS) return;
    const segment = segments[0];
    const queryClient = query ? { query } : createArchiveClient({ token });
    const delays = retryKey === "" ? [] : retryKey.split(",").map(Number);
    const controller = new AbortController();
    const from = (BigInt(segment.fromTs) * 1_000_000n).toString();
    const to = (BigInt(segment.fromTs + DAY_MS) * 1_000_000n).toString();
    const probe = async (family: ArchiveFamily): Promise<ArchiveResult> => {
      for (let attempt = 0; ; attempt += 1) {
        let result: ArchiveResult;
        try {
          result = await queryClient.query({
            instrumentId: segment.instrumentId, family, from, to, limit: 1, pointerToken,
          }, { signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted || attempt >= delays.length) throw error;
          await wait(delays[attempt], controller.signal);
          continue;
        }
        // Busy or failing upstream (429, 5xx) is transient too; any other answer stands.
        const transient = result.outcome === "refused" && (result.status === 429 || result.status >= 500);
        if (!transient || attempt >= delays.length) return result;
        await wait(Math.max(delays[attempt], result.outcome === "refused" ? result.retryAfterMs ?? 0 : 0), controller.signal);
      }
    };
    void (async () => {
      for (const family of FAMILIES) {
        const result = await probe(family);
        if (result.outcome !== "page" || result.pointerToken !== pointerToken || result.family !== family
          || result.coverage.requested.from !== from || result.coverage.requested.to !== to
          || result.coverage.states.PUBLISHED !== 1 || result.coverage.partitions < 1
          || Object.entries(result.coverage.states).some(([state, count]) => state !== "PUBLISHED" && count > 0)
          || result.coverage.corrupt.length > 0) return;
      }
      if (!controller.signal.aborted) setVerified(key);
    })().catch(() => {});
    return () => controller.abort();
  }, [instrument, key, pointerToken, token, query, retryKey]);

  return key !== null && verified === key;
}
