// Browser mirror of apps/runtime/src/indicators/large-trade/large-trade-detection.js,
// line for line: the magnitude a print is ranked by (USD notional on Binance,
// contracts on dxFeed futures), the tie-break order and the top-fraction count.
// The runtime module is CommonJS and the Vite build cannot import it;
// workers/tests/tapeParity.test.ts requires the runtime file and asserts the
// two agree. Change both or neither.

export const CONTRACT_MAGNITUDE_PROVIDER = "DXFEED";
export const CONTRACT_MAGNITUDE_ASSET_CLASS = "FUTURE";

export const MARKER_BUCKET_MS = 60_000;
export const MARKERS_PER_BUCKET_SIDE = 4;

export const MIN_TOP_FRACTION = 0.0002;
export const MAX_TOP_FRACTION = 0.02;
export const DEFAULT_TOP_FRACTION = 0.002;

export interface RankedPrint {
  readonly provider: string;
  readonly assetClass?: string;
  readonly price: number;
  readonly size: number;
  readonly ts_exchange: number;
  readonly trade_id: string;
}

export interface TopFractionCount {
  readonly target: number;
  readonly shown: number;
  readonly truncated: boolean;
  readonly effectiveFraction: number;
}

export function usesContractMagnitude(provider: string, assetClass: string | undefined): boolean {
  return provider === CONTRACT_MAGNITUDE_PROVIDER && assetClass === CONTRACT_MAGNITUDE_ASSET_CLASS;
}

export function tradeMagnitude(provider: string, assetClass: string | undefined, price: number, size: number): number {
  return usesContractMagnitude(provider, assetClass) ? size : price * size;
}

export function markerMagnitude(markerFrame: RankedPrint): number {
  return tradeMagnitude(markerFrame.provider, markerFrame.assetClass, markerFrame.price, markerFrame.size);
}

export function lowerMagnitudePriority(candidate: RankedPrint, incumbent: RankedPrint): boolean {
  const candidateMagnitude = markerMagnitude(candidate);
  const incumbentMagnitude = markerMagnitude(incumbent);
  if (candidateMagnitude !== incumbentMagnitude) return candidateMagnitude < incumbentMagnitude;
  if (candidate.ts_exchange !== incumbent.ts_exchange) return candidate.ts_exchange < incumbent.ts_exchange;
  return candidate.trade_id < incumbent.trade_id;
}

export function resolveTopFractionCount(totalTradeCount: number, fraction: number, availableMarkerCount: number): TopFractionCount {
  if (!Number.isSafeInteger(totalTradeCount) || totalTradeCount < 0) {
    throw new Error("large-trade-detection: totalTradeCount must be a non-negative safe integer");
  }
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new Error("large-trade-detection: fraction must be a finite number in (0, 1]");
  }
  if (!Number.isSafeInteger(availableMarkerCount) || availableMarkerCount < 0) {
    throw new Error("large-trade-detection: availableMarkerCount must be a non-negative safe integer");
  }
  const target = totalTradeCount === 0 ? 0 : Math.max(1, Math.ceil(totalTradeCount * fraction));
  const shown = Math.min(target, availableMarkerCount);
  return Object.freeze({
    target,
    shown,
    truncated: shown < target,
    effectiveFraction: totalTradeCount === 0 ? 0 : shown / totalTradeCount,
  });
}
