const {
  resolveRowWidth,
  resolveAtrBinSizePrice,
  assertBinSizeMultiplier,
  DEFAULT_BIN_SIZE_MULTIPLIER,
  DEFAULT_TARGET_ROW_COUNT,
} = require("./volume-profile-engine");

const PROFILE_ORIGIN_PRICE = 0;

function alignPeriodStart(nowMs, periodMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error(
      "volume-profile-setup: nowMs must be a non-negative safe integer",
    );
  }
  if (!Number.isSafeInteger(periodMs) || periodMs <= 0) {
    throw new Error(
      "volume-profile-setup: periodMs must be a positive safe integer",
    );
  }
  return Math.floor(nowMs / periodMs) * periodMs;
}


async function deriveBucketingParams({
  adapter,
  tickSize,
  fromTs,
  toTs,
  binSizeMultiplier = DEFAULT_BIN_SIZE_MULTIPLIER,
  atrReading = null,
  atrSessionMs = null,
  ...legacyArgs
}) {







  if ("ticksPerRow" in legacyArgs) {
    console.error(
      "volume-profile-setup: deriveBucketingParams received the removed ticksPerRow argument; ignoring it and sizing from the window's range. Migrate the caller to binSizeMultiplier.",
    );
  }
  if (!adapter || typeof adapter.readPriceRange !== "function") {
    throw new Error(
      "volume-profile-setup: adapter must implement readPriceRange",
    );
  }
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    throw new Error(
      "volume-profile-setup: tickSize must be a positive finite number",
    );
  }
  assertBinSizeMultiplier(binSizeMultiplier, "deriveBucketingParams");
  if (!Number.isSafeInteger(fromTs) || fromTs < 0) {
    throw new Error(
      "volume-profile-setup: fromTs must be a non-negative safe integer",
    );
  }
  if (!Number.isSafeInteger(toTs) || toTs < fromTs) {
    throw new Error(
      "volume-profile-setup: toTs must be a safe integer not before fromTs",
    );
  }
  if (
    atrReading !== null &&
    (!Number.isFinite(atrReading.atr) || atrReading.atr <= 0)
  ) {
    throw new Error(
      "volume-profile-setup: atrReading.atr must be a positive finite number",
    );
  }

  const atrSessionSizing =
    atrReading !== null &&
    Number.isFinite(atrSessionMs) &&
    atrSessionMs > 0;
  const atrReferenceRange =
    atrSessionSizing &&
    Number.isFinite(atrReading.referenceRange) &&
    atrReading.referenceRange > 0
      ? atrReading.referenceRange
      : null;

  const { minPrice, maxPrice, tradeCount, available } =
    atrReferenceRange === null
      ? await adapter.readPriceRange(fromTs, toTs)
      : { minPrice: null, maxPrice: null, tradeCount: 0, available: true };
  const hasRange =
    available &&
    tradeCount > 0 &&
    Number.isFinite(minPrice) &&
    Number.isFinite(maxPrice) &&
    maxPrice >= minPrice;
  const referenceRange = hasRange
    ? Math.max(maxPrice - minPrice, tickSize)
    : null;

  if (atrSessionSizing) {


    const rowWidth = Math.max(tickSize, resolveAtrBinSizePrice({
      referenceAtr: atrReading.atr,
      barIntervalMs: atrReading.barIntervalMs ?? 60_000,
      sessionMs: atrSessionMs,
      binSizeMultiplier,


      referenceRange: atrReferenceRange ?? referenceRange,
    }));
    return {
      originPrice: PROFILE_ORIGIN_PRICE,
      rowWidth,
      tradeCount: hasRange ? tradeCount : 0,
      minPrice: hasRange ? minPrice : null,
      maxPrice: hasRange ? maxPrice : null,
      sizing: "atr",
    };
  }



  if (!hasRange) return null;


  return {
    originPrice: PROFILE_ORIGIN_PRICE,
    rowWidth: Math.max(tickSize, resolveRowWidth({
      tickSize,
      referenceRange,
      targetRowCount: atrBinRowCountFor(binSizeMultiplier),
    })),
    tradeCount,
    minPrice,
    maxPrice,
    sizing: "range",
  };
}


function atrBinRowCountFor(binSizeMultiplier) {
  return DEFAULT_TARGET_ROW_COUNT / binSizeMultiplier;
}

module.exports = {
  alignPeriodStart,
  deriveBucketingParams,
  PROFILE_ORIGIN_PRICE,
};
