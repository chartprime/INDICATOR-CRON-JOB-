const CONTRACT_MAGNITUDE_PROVIDER = "DXFEED";
const CONTRACT_MAGNITUDE_ASSET_CLASS = "FUTURE";

const MARKER_BUCKET_MS = 60_000;
const MARKERS_PER_BUCKET_SIDE = 4;

const MIN_TOP_FRACTION = 0.0002;
const MAX_TOP_FRACTION = 0.02;
const DEFAULT_TOP_FRACTION = 0.002;

function usesContractMagnitude(provider, assetClass) {
  return provider === CONTRACT_MAGNITUDE_PROVIDER && assetClass === CONTRACT_MAGNITUDE_ASSET_CLASS;
}

function tradeMagnitude(provider, assetClass, price, size) {
  return usesContractMagnitude(provider, assetClass) ? size : price * size;
}

function markerMagnitude(markerFrame) {
  return tradeMagnitude(markerFrame.provider, markerFrame.assetClass, markerFrame.price, markerFrame.size);
}

function lowerMagnitudePriority(candidate, incumbent) {
  const candidateMagnitude = markerMagnitude(candidate);
  const incumbentMagnitude = markerMagnitude(incumbent);
  if (candidateMagnitude !== incumbentMagnitude) return candidateMagnitude < incumbentMagnitude;
  if (candidate.ts_exchange !== incumbent.ts_exchange) return candidate.ts_exchange < incumbent.ts_exchange;
  return candidate.trade_id < incumbent.trade_id;
}

function resolveTopFractionCount(totalTradeCount, fraction, availableMarkerCount) {
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

module.exports = {
  usesContractMagnitude,
  tradeMagnitude,
  markerMagnitude,
  lowerMagnitudePriority,
  resolveTopFractionCount,
  CONTRACT_MAGNITUDE_PROVIDER,
  CONTRACT_MAGNITUDE_ASSET_CLASS,
  MARKER_BUCKET_MS,
  MARKERS_PER_BUCKET_SIDE,
  MIN_TOP_FRACTION,
  MAX_TOP_FRACTION,
  DEFAULT_TOP_FRACTION,
};
