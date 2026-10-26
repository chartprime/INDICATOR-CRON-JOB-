import type { IndicatorLiquidity } from "../chart/indicatorLiquidity";
import type { LiquidityColumn } from "../indicators/passive-liquidity/liquidityGrid";
import type { HistoricalBookSecond } from "./historicalL2States";

const EPOCH_STRIDE = 8192;

/** Observed top-ten depth, not the live retained-level ledger or a wall seed. */
export function historicalBookLiquidity(
  seconds: readonly HistoricalBookSecond[], tickSize: number, version: number, unit: "contracts" | "shares",
): IndicatorLiquidity {
  if (![0.25, 0.01].includes(tickSize) || !Number.isSafeInteger(version) || version < 1
      || version > Math.floor(Number.MAX_SAFE_INTEGER / EPOCH_STRIDE) - 1
      || seconds.length > 7200 || !["contracts", "shares"].includes(unit)) {
    throw new Error("invalid historical liquidity geometry/version/unit");
  }
  const entries: { known: bigint; epoch: number; first: number; columnEnd: number }[] = [];
  const columns: LiquidityColumn[] = [];
  let previousKnown = -1n, previousOpen = -1n, previousSegment: string | null = null;
  let epoch = version * EPOCH_STRIDE, first = 0;
  for (const second of seconds) {
    const known = BigInt(second.knownNs), open = BigInt(second.openNs);
    if (known < previousKnown || open < previousOpen) throw new Error("historical liquidity time regresses");
    const admitted = second.complete && second.trusted && second.segmentId !== null && second.column !== null;
    if ((second.column !== null) !== admitted) throw new Error("historical liquidity column is not complete/trusted");
    if (!admitted || previousSegment !== second.segmentId || open !== previousOpen + 1000000000n) {
      epoch += 1;
      first = columns.length;
    }
    if (second.column !== null) {
      if (!Number.isSafeInteger(second.column.ts) || BigInt(second.column.ts) * 1000000n !== open
          || known < BigInt(second.closeNs)) throw new Error("historical liquidity column time differs");
      columns.push(second.column);
    }
    entries.push({ known, epoch, first, columnEnd: columns.length });
    previousKnown = known;
    previousOpen = open;
    previousSegment = admitted ? second.segmentId : null;
  }
  let cached: { cut: bigint; value: IndicatorLiquidity } | null = null;
  const build = (cut: bigint): IndicatorLiquidity => {
    if (cached?.cut === cut) return cached.value;
    let lo = 0, hi = entries.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (entries[mid].known <= cut) lo = mid + 1; else hi = mid;
    }
    const last = entries[lo - 1];
    let selected: readonly LiquidityColumn[] | null = null;
    const value: IndicatorLiquidity = Object.freeze({ rowWidth: tickSize, baseAsset: unit, version, history: null,
      get feed() {
        selected ??= Object.freeze(last === undefined ? [] : columns.slice(last.first, last.columnEnd));
        return { epoch: last?.epoch ?? version * EPOCH_STRIDE, deep: null,
          fine: { columns: selected, columnMs: 1000 } };
      },
      atTime: (timeMs: number) => {
        if (!Number.isSafeInteger(timeMs) || timeMs < 0) return null;
        const ns = BigInt(timeMs) * 1000000n;
        return build(ns < cut ? ns : cut);
      },
    });
    cached = { cut, value };
    return value;
  };
  return build(previousKnown);
}
