import { historicalL2, type IndicatorL2 } from "../chart/indicatorL2";
import type { HistoricalBookSecond } from "./historicalL2States";

/** A display history, never an engine restore snapshot or a wall ledger. */
export function historicalBookL2(seconds: readonly HistoricalBookSecond[], tickSize: number, version: number): IndicatorL2 {
  if (![0.25, 0.01].includes(tickSize) || !Number.isSafeInteger(version) || version < 1) throw new Error("invalid historical L2 geometry/version");
  let previous = -1n;
  const knownSeconds: bigint[] = [];
  const columns: { known: bigint; column: NonNullable<HistoricalBookSecond["column"]>; priceLo: number; priceHi: number }[] = [];
  let priceLo = Infinity, priceHi = -Infinity;
  for (const second of seconds) {
    const known = BigInt(second.knownNs);
    if (known < previous) throw new Error("historical L2 knowledge time regresses");
    previous = known;
    knownSeconds.push(known);
    if (second.column !== null) {
      priceLo = Math.min(priceLo, second.column.lo * tickSize);
      priceHi = Math.max(priceHi, (second.column.hi + 1) * tickSize);
      columns.push({ known, column: second.column, priceLo, priceHi });
    }
  }
  const empty = historicalL2();
  const upper = <T>(entries: readonly T[], cut: bigint, known: (entry: T) => bigint): number => {
    let lo = 0, hi = entries.length;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (known(entries[mid]) <= cut) lo = mid + 1; else hi = mid; }
    return lo;
  };
  let cached: { cut: bigint; value: IndicatorL2 } | null = null;
  const build = (cut: bigint): IndicatorL2 => {
    if (cached?.cut === cut) return cached.value;
    const end = upper(knownSeconds, cut, (known) => known);
    const last = seconds[end - 1];
    const columnEnd = upper(columns, cut, (entry) => entry.known);
    const lastColumn = columns[columnEnd - 1];
    const synced = columnEnd > 0;
    let selected: NonNullable<HistoricalBookSecond["column"]>[] | null = null;
    const value = Object.freeze<IndicatorL2>({ ...empty, availability: "HISTORICAL", version,
      status: (channel) => channel === "l2_view" ? { synced, seq: null, lastTs: lastColumn?.column.ts ?? null, lastFrameAt: null } : empty.status(channel),
      trusted: (timeMs) => {
        if (timeMs === undefined) return last?.trusted === true && last.complete;
        if (!Number.isSafeInteger(timeMs) || timeMs < 0) return false;
        const ns = BigInt(timeMs) * 1000000n;
        if (ns > cut) return false;
        const index = upper(knownSeconds, ns, (known) => known) - 1;
        const second = seconds[index];
        return second?.trusted === true && second.complete && ns - knownSeconds[index] < 1000000000n;
      },
      lanes: () => synced ? [{ lane: 0, rowWidth: tickSize, columnMs: 1000, deepColumnMs: 1000, priceLo: lastColumn.priceLo, priceHi: lastColumn.priceHi }] : [],
      view: (lane) => {
        if (lane !== 0 || !synced) return null;
        selected ??= columns.slice(0, columnEnd).map((entry) => entry.column);
        return { epoch: version, deep: null, fine: { columns: selected, columnMs: 1000 } };
      },
      atTime: (timeMs) => {
        if (!Number.isSafeInteger(timeMs) || timeMs < 0) return empty;
        const ns = BigInt(timeMs) * 1000000n;
        return build(ns < cut ? ns : cut);
      },
    });
    cached = { cut, value };
    return value;
  };
  return build(previous);
}
