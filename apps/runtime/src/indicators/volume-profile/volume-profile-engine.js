const ROLLUP_GRAIN_TICKS = 8;

const DEFAULT_TARGET_ROW_COUNT = 75;

const DEFAULT_BIN_SIZE_MULTIPLIER = 1;

const MIN_BIN_SIZE_MULTIPLIER = 0.02;
const MAX_BIN_SIZE_MULTIPLIER = 10;

const DEFAULT_REFERENCE_WINDOW_MS = 24 * 60 * 60 * 1000;

const MIN_ATR_ROW_COUNT = DEFAULT_TARGET_ROW_COUNT / MAX_BIN_SIZE_MULTIPLIER;
const MAX_ATR_ROW_COUNT = DEFAULT_TARGET_ROW_COUNT / MIN_BIN_SIZE_MULTIPLIER;
const DEFAULT_VALUE_AREA_PCT = 0.7;
const SINGLE_PRINT_RATIO = 0.15;

const SMOOTH_CENTER_WEIGHT = 0.5;
const SMOOTH_NEIGHBOR_WEIGHT = (1 - SMOOTH_CENTER_WEIGHT) / 2;
const DEFAULT_PAGE_LIMIT = 2_000;
const DEFAULT_MAX_PAGES_PER_TICK = 10;
const { bucketIndexOf } = require("../../storage/price-bucketing");

const MAX_PROFILE_BUCKETS = 4000;
const MAX_RESCALE_PASSES = 64;

function assertBinSizeMultiplier(binSizeMultiplier, field) {
  if (
    !Number.isFinite(binSizeMultiplier) ||
    binSizeMultiplier < MIN_BIN_SIZE_MULTIPLIER ||
    binSizeMultiplier > MAX_BIN_SIZE_MULTIPLIER
  ) {
    throw new Error(
      `volume-profile-engine: ${field} binSizeMultiplier must be a finite number between ${MIN_BIN_SIZE_MULTIPLIER} and ${MAX_BIN_SIZE_MULTIPLIER}`,
    );
  }
}

/**
 * Rounds a bin size in ticks to a whole number of rollup grains, never below
 * one grain.
 *
 * This is the bridge between "an automatically derived width" and "a width the
 * rollup cache can tile". A volatility-derived width lands on an arbitrary tick
 * count, and the cache only stores whole grains, so the width is snapped to the
 * grain grid before anything reads or writes a bucket. Both the live session and
 * the historical zones go through here, which is what guarantees they agree.
 *
 * Snapping is three-way: an exact multiple is returned untouched so a width that
 * already sits on the grain grid does not drift, and a sub-grain width floors at
 * exactly one grain because the cache holds no finer data.
 *
 * Note the rounding is deliberately NOT applied to an explicit user override:
 * substituting a nearby width for a number the user typed would silently change
 * what they asked for.
 */
function snapTicksPerRowToGrain(ticksPerRow, grainTicks = ROLLUP_GRAIN_TICKS) {
  if (!Number.isSafeInteger(ticksPerRow) || ticksPerRow <= 0) {
    throw new Error(
      "volume-profile-engine: ticksPerRow must be a positive safe integer",
    );
  }
  if (!Number.isSafeInteger(grainTicks) || grainTicks <= 0) {
    throw new Error(
      "volume-profile-engine: grainTicks must be a positive safe integer",
    );
  }
  const grains = Math.max(1, Math.round(ticksPerRow / grainTicks));
  return grains * grainTicks;
}

/**
 * The nearest grain-aligned tick count at or above `ticksPerRow`.
 *
 * Used where the bound is a MINIMUM that must actually hold: rounding to the
 * nearest grain can land below the requirement, which would silently break the
 * guarantee the caller is relying on.
 */
function snapTicksPerRowToGrainUp(
  ticksPerRow,
  grainTicks = ROLLUP_GRAIN_TICKS,
) {
  if (!Number.isFinite(ticksPerRow) || ticksPerRow <= 0) {
    throw new Error(
      "volume-profile-engine: ticksPerRow must be a positive finite number",
    );
  }
  if (!Number.isSafeInteger(grainTicks) || grainTicks <= 0) {
    throw new Error(
      "volume-profile-engine: grainTicks must be a positive safe integer",
    );
  }
  const grains = Math.max(1, Math.ceil(ticksPerRow / grainTicks));
  return grains * grainTicks;
}

/**
 * The nearest grain-aligned tick count at or below `ticksPerRow`, never below
 * one grain.
 *
 * Used where the bound is a MAXIMUM that must hold, for the same reason
 * `snapTicksPerRowToGrainUp` exists for minima.
 */
function snapTicksPerRowToGrainDown(
  ticksPerRow,
  grainTicks = ROLLUP_GRAIN_TICKS,
) {
  if (!Number.isFinite(ticksPerRow) || ticksPerRow <= 0) {
    throw new Error(
      "volume-profile-engine: ticksPerRow must be a positive finite number",
    );
  }
  if (!Number.isSafeInteger(grainTicks) || grainTicks <= 0) {
    throw new Error(
      "volume-profile-engine: grainTicks must be a positive safe integer",
    );
  }
  const grains = Math.max(1, Math.floor(ticksPerRow / grainTicks));
  return grains * grainTicks;
}

/**
 * Projects how far a period of `sessionMs` would travel, from the volatility of
 * a shorter bar interval.
 *
 * A random walk over n bars spans about one bar's range times the square root of
 * n -- not n times, and not one bar's range. That square root is the whole reason
 * a reading taken over short bars can size rows for a session far longer than
 * them: a 1-minute ATR raised by sqrt(240) projects a 4-hour span.
 *
 * `referenceAtr` is a mean bar range, so this projects the span the session would
 * COVER, not the distance the price walked while covering it.
 */
function projectSessionSpan({ referenceAtr, barIntervalMs, sessionMs }) {
  if (!Number.isFinite(referenceAtr) || referenceAtr <= 0) {
    throw new Error(
      "volume-profile-engine: referenceAtr must be a positive finite number",
    );
  }
  if (!Number.isFinite(barIntervalMs) || barIntervalMs <= 0) {
    throw new Error(
      "volume-profile-engine: barIntervalMs must be a positive finite number",
    );
  }
  if (!Number.isFinite(sessionMs) || sessionMs <= 0) {
    throw new Error(
      "volume-profile-engine: sessionMs must be a positive finite number",
    );
  }
  return referenceAtr * Math.sqrt(sessionMs / barIntervalMs);
}

/**
 * The BIN WIDTH, IN PRICE, that a volatility reading and a multiplier imply.
 *
 * This is a price quantity and nothing else -- there is deliberately no tick
 * count, no grain snap and no rounding anywhere in it:
 *
 *   sessionSpan = referenceAtr x sqrt(sessionMs / barIntervalMs)
 *   binSize     = sessionSpan x multiplier / DEFAULT_TARGET_ROW_COUNT
 *
 * Equivalently, and this is the form the setting is actually about:
 *
 *   howManyBins = span / (atr x multiplier)
 *   binSize     = span / howManyBins
 *
 * so `span / binSize == rowCountTarget / multiplier` -- the multiplier is a
 * direct, linear control on how many bins fit across a session. Doubling it
 * halves the bin count.
 *
 * Why the previous design produced no visible change at all: the width used to
 * be converted to a whole number of TICKS and snapped to the rollup cache's
 * grain (32 ticks, so 8.00 points on /ES). On a coarse-tick instrument that
 * grain was coarser than the entire span of widths the multiplier could ask for,
 * so 0.1 and 10 both landed on 8.00 points. Every bound, clamp and grain floor
 * between the request and the answer was a rounding step that could, and on ES
 * did, collapse the whole range of the control onto one value. Removing the tick
 * layer removes every one of those failure modes at once: a price width needs no
 * common denominator with a tick size to be valid.
 *
 * Why volatility and not the session's own top-to-bottom range: a range is only
 * known once the period has finished, so a still-developing session measured
 * against its own range would change its bin width every time it was re-probed,
 * and would disagree with its own closed neighbours. A volatility reading taken
 * from a fixed reference window is knowable BEFORE the session starts and
 * identical wherever it is applied, which is what lets the live period and the
 * historical zones share one grid.
 *
 * The row-count clamp is applied to the PRICE width and is the only bound;
 * `referenceRange` merely calibrates it.
 */
function resolveAtrBinSizePrice({
  referenceAtr,
  barIntervalMs,
  sessionMs,
  binSizeMultiplier = DEFAULT_BIN_SIZE_MULTIPLIER,
  referenceRange = null,
  minRowCount = MIN_ATR_ROW_COUNT,
  maxRowCount = MAX_ATR_ROW_COUNT,
}) {
  if (!Number.isFinite(referenceAtr) || referenceAtr <= 0) {
    throw new Error(
      "volume-profile-engine: referenceAtr must be a positive finite number",
    );
  }
  if (!Number.isFinite(barIntervalMs) || barIntervalMs <= 0) {
    throw new Error(
      "volume-profile-engine: barIntervalMs must be a positive finite number",
    );
  }
  if (!Number.isFinite(sessionMs) || sessionMs <= 0) {
    throw new Error(
      "volume-profile-engine: sessionMs must be a positive finite number",
    );
  }
  assertBinSizeMultiplier(binSizeMultiplier, "resolveAtrBinSizePrice");
  if (!Number.isFinite(minRowCount) || minRowCount <= 0) {
    throw new Error(
      "volume-profile-engine: minRowCount must be a positive finite number",
    );
  }
  if (!Number.isFinite(maxRowCount) || maxRowCount < minRowCount) {
    throw new Error(
      "volume-profile-engine: maxRowCount must be a finite number not below minRowCount",
    );
  }

  const span = projectSessionSpan({
    referenceAtr,
    barIntervalMs,
    sessionMs,
  });
  // The multiplier scales the bin, so it divides the row count: a larger bin
  // means fewer of them across the same span. Straight division -- no rounding,
  // so the control is continuous rather than quantised onto a grid.
  const idealBinSize = (span * binSizeMultiplier) / DEFAULT_TARGET_ROW_COUNT;
  if (!Number.isFinite(idealBinSize) || idealBinSize <= 0) {
    throw new Error(
      "volume-profile-engine: implied bin size must be a positive finite number",
    );
  }

  if (!Number.isFinite(referenceRange) || referenceRange <= 0) {
    return idealBinSize;
  }

  // The clamp keeps a mis-scaled reading from asking for a handful of rows or
  // several thousand. Applied as a PRICE width, so it cannot be defeated by a
  // coarse tick or by the rollup grain.
  const finestBinSize = referenceRange / maxRowCount;
  const coarsestBinSize = referenceRange / minRowCount;
  return Math.min(Math.max(idealBinSize, finestBinSize), coarsestBinSize);
}

/**
 * The bin width in TICKS that a volatility reading implies.
 *
 * Retained for the rollup cache, which stores whole grain rows and therefore
 * needs an integer tick count. The LIVE and direct-historical paths must NOT go
 * through here -- see `resolveAtrBinSizePrice` for why the tick layer is what
 * made the bin-size control inert.
 *
 * Note the grain snap floors at one grain: a width finer than the cache's own
 * resolution cannot be served from the cache at all, and this is the only place
 * that limitation is allowed to apply.
 *
 * The grain snap is applied to the ALREADY-CLAMPED price width, and the clamp is
 * deliberately loosened here so the snap cannot push the result back outside it.
 * Snapping and then clamping would let rounding break the bound; clamping first
 * and snapping after would do the same in the other direction. The row-count
 * guarantee this function's caller relies on is therefore approximate by up to
 * one grain -- which is exactly why the live path no longer goes through here.
 */
function resolveAtrTicksPerRow({
  tickSize,
  referenceAtr,
  barIntervalMs,
  sessionMs,
  binSizeMultiplier = DEFAULT_BIN_SIZE_MULTIPLIER,
  referenceRange = null,
  minRowCount = MIN_ATR_ROW_COUNT,
  maxRowCount = MAX_ATR_ROW_COUNT,
}) {
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    throw new Error(
      "volume-profile-engine: tickSize must be a positive finite number",
    );
  }
  if (!Number.isFinite(referenceAtr) || referenceAtr <= 0) {
    throw new Error(
      "volume-profile-engine: referenceAtr must be a positive finite number",
    );
  }
  if (!Number.isFinite(barIntervalMs) || barIntervalMs <= 0) {
    throw new Error(
      "volume-profile-engine: barIntervalMs must be a positive finite number",
    );
  }
  if (!Number.isFinite(sessionMs) || sessionMs <= 0) {
    throw new Error(
      "volume-profile-engine: sessionMs must be a positive finite number",
    );
  }
  assertBinSizeMultiplier(binSizeMultiplier, "resolveAtrTicksPerRow");

  const binSizePrice = resolveAtrBinSizePrice({
    referenceAtr,
    barIntervalMs,
    sessionMs,
    binSizeMultiplier,
    referenceRange,
    minRowCount,
    maxRowCount,
  });
  // Snap UP, not to the nearest grain. `maxRowCount` is a floor on the bin
  // WIDTH, so rounding the width DOWN to the nearest grain would produce a
  // narrower bin than the clamp allows and more rows than it permits -- which is
  // the pathological case the clamp exists to prevent. Snap-up can only widen
  // the bin, so the row ceiling always holds; the cost is that the row floor
  // (`minRowCount`) is approximate to within one grain, which is acceptable
  // because it is the fine end that matters and because the live path does not
  // use this function at all.
  return snapTicksPerRowToGrainUp(
    Math.max(1, Math.round(binSizePrice / tickSize)),
  );
}

/**
 * Resolves a bin's width in TICKS.
 *
 * Split out from `resolveRowWidth` so a caller that needs the tick count itself
 * (the rollup cache query works in whole grains) gets an exact integer instead of
 * dividing a price width back down by the tick size, which reintroduces
 * floating-point error on instruments such as a 1-cent crypto tick.
 *
 * Width sources, in precedence order:
 *
 * 1. `binSizeTicks` -- an already-resolved grain-aligned width, returned
 *    untouched. This is how the ATR / range paths hand their result here.
 * 2. `binSizePrice` -- a width derived from volatility. Independent of the window
 *    being binned, so a developing period and its closed neighbours agree.
 * 3. `referenceRange` -- the window's own span divided by `targetRowCount`.
 *    Self-tuning but window-dependent, so it is the fallback, not the default.
 *
 * There is deliberately no absolute tick override any more. Sizing is always
 * derived from the instrument, with `binSizeMultiplier` as the user's control
 * over how coarse the result is.
 */
function resolveTicksPerRow({
  tickSize,
  referenceRange = null,
  binSizeTicks = null,
  binSizePrice = null,
  targetRowCount = DEFAULT_TARGET_ROW_COUNT,
}) {
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    throw new Error(
      "volume-profile-engine: tickSize must be a positive finite number",
    );
  }

  if (binSizeTicks !== null) {
    if (!Number.isSafeInteger(binSizeTicks) || binSizeTicks <= 0) {
      throw new Error(
        "volume-profile-engine: binSizeTicks must be a positive safe integer",
      );
    }
    return binSizeTicks;
  }

  if (binSizePrice !== null) {
    if (!Number.isFinite(binSizePrice) || binSizePrice <= 0) {
      throw new Error(
        "volume-profile-engine: binSizePrice must be a positive finite number",
      );
    }
    return snapTicksPerRowToGrain(
      Math.max(1, Math.round(binSizePrice / tickSize)),
    );
  }

  if (!Number.isFinite(referenceRange) || referenceRange <= 0) {
    throw new Error(
      "volume-profile-engine: referenceRange must be a positive finite number when no explicit row size or binSizePrice is given",
    );
  }
  if (!Number.isFinite(targetRowCount) || targetRowCount <= 0) {
    throw new Error(
      "volume-profile-engine: targetRowCount must be a positive finite number",
    );
  }

  return snapTicksPerRowToGrain(
    Math.max(1, Math.round(referenceRange / tickSize / targetRowCount)),
  );
}

/**
 * Resolves the row (bin) width in PRICE -- the form every live and direct path
 * should use.
 *
 * Precedence:
 *
 * 1. `binSizePrice` -- an already-derived width. Returned verbatim, because it
 *    has already been clamped by whoever derived it, and re-rounding a price
 *    width is exactly the mistake this function exists to avoid.
 * 2. `referenceRange` / `targetRowCount` -- the window's own span divided by the
 *    row target. Self-tuning but window-dependent, so it is the fallback.
 * 3. `binSizeTicks` -- a grain-aligned tick count, for the rollup cache's
 *    queries, which genuinely must work in whole grains.
 *
 * Deliberately NOT implemented as `tickSize x resolveTicksPerRow(...)`: routing
 * a price width through a tick count reintroduces the grain snap, which on a
 * coarse-tick instrument is coarser than the whole range of widths the user can
 * ask for. A price width needs no common denominator with a tick size to be
 * valid, so nothing is lost by keeping it in price.
 */
function resolveRowWidth({
  tickSize,
  referenceRange = null,
  binSizeTicks = null,
  binSizePrice = null,
  targetRowCount = DEFAULT_TARGET_ROW_COUNT,
}) {
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    throw new Error(
      "volume-profile-engine: tickSize must be a positive finite number",
    );
  }

  if (binSizePrice !== null) {
    if (!Number.isFinite(binSizePrice) || binSizePrice <= 0) {
      throw new Error(
        "volume-profile-engine: binSizePrice must be a positive finite number",
      );
    }
    return binSizePrice;
  }

  if (binSizeTicks !== null) {
    if (!Number.isSafeInteger(binSizeTicks) || binSizeTicks <= 0) {
      throw new Error(
        "volume-profile-engine: binSizeTicks must be a positive safe integer",
      );
    }
    return tickSize * binSizeTicks;
  }

  if (!Number.isFinite(referenceRange) || referenceRange <= 0) {
    throw new Error(
      "volume-profile-engine: referenceRange must be a positive finite number when no binSizePrice or binSizeTicks is given",
    );
  }
  if (!Number.isFinite(targetRowCount) || targetRowCount <= 0) {
    throw new Error(
      "volume-profile-engine: targetRowCount must be a positive finite number",
    );
  }
  return referenceRange / targetRowCount;
}

function createSession({ periodStartTs, originPrice, rowWidth }) {
  if (!Number.isSafeInteger(periodStartTs) || periodStartTs < 0) {
    throw new Error(
      "volume-profile-engine: periodStartTs must be a non-negative safe integer",
    );
  }
  if (!Number.isFinite(originPrice)) {
    throw new Error(
      "volume-profile-engine: originPrice must be a finite number",
    );
  }
  if (!Number.isFinite(rowWidth) || rowWidth <= 0) {
    throw new Error(
      "volume-profile-engine: rowWidth must be a positive finite number",
    );
  }
  return {
    periodStartTs,
    periodEndTs: null,
    rowWidth,
    originPrice,
    buckets: new Map(),
    pollFromTs: periodStartTs,
    pollCursor: null,
    latestRowTs: null,
    lastTradeId: null,
  };
}

async function seedSessionFromStorage(
  session,
  adapter,
  seedToTs,
  prefetched = null,
) {
  if (!Number.isSafeInteger(seedToTs) || seedToTs < session.periodStartTs) {
    throw new Error(
      "volume-profile-engine: seedSessionFromStorage seedToTs must be a safe integer not before periodStartTs",
    );
  }
  if (seedToTs === session.periodStartTs) return false;
  const { buckets, available } =
    prefetched ??
    (await adapter.readVolumeProfile(
      session.periodStartTs,
      seedToTs,
      session.originPrice,
      session.rowWidth,
    ));
  if (!available) return false;
  session.buckets = bucketsFromReaderResult(buckets);
  rescaleSessionToFit(session);
  session.pollFromTs = seedToTs;
  session.pollCursor = null;
  return true;
}

function assertBucketingParams(originPrice, rowWidth, field) {
  if (!Number.isFinite(originPrice)) {
    throw new Error(
      `volume-profile-engine: ${field} originPrice must be a finite number`,
    );
  }
  if (!Number.isFinite(rowWidth) || rowWidth <= 0) {
    throw new Error(
      `volume-profile-engine: ${field} rowWidth must be a positive finite number`,
    );
  }
}

function bucketIndexFor(price, { originPrice, rowWidth }) {
  assertBucketingParams(originPrice, rowWidth, "bucketIndexFor");
  if (!Number.isFinite(price)) {
    throw new Error(
      "volume-profile-engine: bucketIndexFor price must be a finite number",
    );
  }
  return bucketIndexOf(price, originPrice, rowWidth, "volume-profile-engine");
}

function assertValidTradeRow({ price, size, side }, { originPrice, rowWidth }) {
  assertBucketingParams(originPrice, rowWidth, "applyTradeRow");
  if (!Number.isFinite(price)) {
    throw new Error(
      "volume-profile-engine: applyTradeRow price must be a finite number",
    );
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(
      "volume-profile-engine: applyTradeRow size must be a positive finite number",
    );
  }
  if (side !== "buy" && side !== "sell" && side !== null) {
    throw new Error(
      'volume-profile-engine: applyTradeRow side must be "buy", "sell", or null',
    );
  }
}

function applyTradeRow(
  buckets,
  { price, size, side },
  { originPrice, rowWidth },
) {
  assertValidTradeRow({ price, size, side }, { originPrice, rowWidth });
  const bucketIndex = bucketIndexFor(price, { originPrice, rowWidth });
  const existing = buckets.get(bucketIndex) ?? {
    volume: 0,
    buyVolume: 0,
    sellVolume: 0,
  };
  existing.volume += size;
  if (side === "buy") existing.buyVolume += size;
  else if (side === "sell") existing.sellVolume += size;
  buckets.set(bucketIndex, existing);
  return buckets;
}

function bucketsFromReaderResult(readerBuckets) {
  const buckets = new Map();
  for (const row of readerBuckets) {
    buckets.set(row.bucket, {
      volume: row.volume,
      buyVolume: row.buyVolume,
      sellVolume: row.sellVolume,
    });
  }
  return buckets;
}

function indexRange(buckets) {
  let minIndex = Infinity;
  let maxIndex = -Infinity;
  for (const index of buckets.keys()) {
    if (index < minIndex) minIndex = index;
    if (index > maxIndex) maxIndex = index;
  }
  return { minIndex, maxIndex };
}

/**
 * Smooths a bucket map into a shape suitable for drawing.
 *
 * Each bin keeps SMOOTH_CENTER_WEIGHT of its volume and passes
 * SMOOTH_NEIGHBOR_WEIGHT to each existing neighbour. The three fields are
 * weighted identically, so buy_volume + sell_volume === volume still holds for
 * every smoothed bin (P4.10's invariant), and so the two sides of a Delta
 * Profile keep reporting the same sell share they did before smoothing.
 *
 * Three properties this deliberately preserves:
 *
 * - Total volume is conserved exactly. A bin sends weight to a neighbour only
 *   when that neighbour exists; the share with nowhere to go is folded back
 *   into the bin itself. An interior bin therefore always sums to 1.0x its own
 *   volume (0.5 + 0.25 + 0.25), and an isolated or edge bin keeps the whole
 *   1.0x rather than leaking the outer quarter out of the profile.
 * - The key set never grows. Smoothing moves volume between bins that already
 *   exist, so a gap between two clusters stays a gap and the profile can never
 *   exceed the MAX_PROFILE_BUCKETS ceiling that engine, wire-fields, the client
 *   parser and the frame schema all agree on.
 * - Gaps stay gaps. A missing neighbour is not treated as a zero bin, because
 *   materialising one would widen the histogram past the traded range and
 *   invent volume in a price band nothing traded at.
 */
function smoothBuckets(buckets) {
  const smoothed = new Map();
  if (buckets.size === 0) return smoothed;

  for (const [index, bucket] of buckets) {
    const hasBelow = buckets.has(index - 1);
    const hasAbove = buckets.has(index + 1);
    // Keep the centre share, then add back whatever could not be given away
    // because a neighbour is missing. Since SMOOTH_CENTER_WEIGHT plus two
    // neighbour shares is exactly 1.0, an interior bin keeps its centre share
    // and a bin with fewer than two neighbours keeps proportionally more --
    // never less. Total volume is therefore conserved for every shape.
    const neighborCount = Number(hasBelow) + Number(hasAbove);
    const keptWeight =
      SMOOTH_CENTER_WEIGHT + (2 - neighborCount) * SMOOTH_NEIGHBOR_WEIGHT;

    const own = smoothed.get(index) ?? {
      volume: 0,
      buyVolume: 0,
      sellVolume: 0,
    };
    own.volume += bucket.volume * keptWeight;
    own.buyVolume += bucket.buyVolume * keptWeight;
    own.sellVolume += bucket.sellVolume * keptWeight;
    smoothed.set(index, own);

    for (const neighborIndex of [index - 1, index + 1]) {
      if (!buckets.has(neighborIndex)) continue;
      const neighbor = smoothed.get(neighborIndex) ?? {
        volume: 0,
        buyVolume: 0,
        sellVolume: 0,
      };
      neighbor.volume += bucket.volume * SMOOTH_NEIGHBOR_WEIGHT;
      neighbor.buyVolume += bucket.buyVolume * SMOOTH_NEIGHBOR_WEIGHT;
      neighbor.sellVolume += bucket.sellVolume * SMOOTH_NEIGHBOR_WEIGHT;
      smoothed.set(neighborIndex, neighbor);
    }
  }

  return smoothed;
}

function resolvePocIndex(buckets) {
  let maxVolume = -Infinity;
  for (const { volume } of buckets.values()) {
    if (volume > maxVolume) maxVolume = volume;
  }
  const tied = [...buckets.entries()]
    .filter(([, bucket]) => bucket.volume === maxVolume)
    .map(([index]) => index);
  const { minIndex, maxIndex } = indexRange(buckets);
  const midpoint = (minIndex + maxIndex) / 2;
  tied.sort((a, b) => Math.abs(a - midpoint) - Math.abs(b - midpoint) || a - b);
  return tied[0];
}

function expandValueArea(buckets, pocIndex, valueAreaPct) {
  let totalVolume = 0;
  for (const { volume } of buckets.values()) totalVolume += volume;
  const targetVolume = totalVolume * valueAreaPct;

  let minIndex = pocIndex;
  let maxIndex = pocIndex;
  for (const index of buckets.keys()) {
    if (index < minIndex) minIndex = index;
    if (index > maxIndex) maxIndex = index;
  }

  let vaHigh = pocIndex;
  let vaLow = pocIndex;
  let vaVolume = buckets.get(pocIndex).volume;

  while (vaVolume < targetVolume && (vaHigh < maxIndex || vaLow > minIndex)) {
    const canExpandAbove = vaHigh < maxIndex;
    const canExpandBelow = vaLow > minIndex;
    const aboveVolume = canExpandAbove
      ? (buckets.get(vaHigh + 1)?.volume ?? 0)
      : -1;
    const belowVolume = canExpandBelow
      ? (buckets.get(vaLow - 1)?.volume ?? 0)
      : -1;
    if (canExpandAbove && aboveVolume >= belowVolume) {
      vaHigh += 1;
      vaVolume += aboveVolume;
    } else {
      vaLow -= 1;
      vaVolume += belowVolume;
    }
  }
  return { vaHigh, vaLow, vaVolume, totalVolume };
}

/**
 * Derives a profile's POC, Value Area and single prints from a bucket map, and
 * returns the smoothed bucket map those indices describe.
 *
 * Deriving the indices from the smoothed map rather than the raw one is what
 * keeps the drawn histogram and the POC/VAH/VAL lines telling the same story:
 * the frame builders take the line prices from these indices but the bar
 * widths from the buckets, so if the two came from different shapes the lines
 * would sit at positions the bars do not justify. `buckets` itself is never
 * mutated -- the caller's map stays raw, which matters because a live session's
 * map is re-read and re-smoothed on every poll and must never accumulate two
 * rounds of smoothing.
 */
function computeProfile(
  buckets,
  { valueAreaPct = DEFAULT_VALUE_AREA_PCT } = {},
) {
  if (!Number.isFinite(valueAreaPct) || valueAreaPct <= 0 || valueAreaPct > 1) {
    throw new Error(
      "volume-profile-engine: valueAreaPct must be a finite number in (0, 1]",
    );
  }
  if (buckets.size === 0) {
    return {
      pocIndex: null,
      vaHigh: null,
      vaLow: null,
      totalVolume: 0,
      singlePrintBuckets: [],
      buckets: new Map(),
    };
  }
  const smoothed = smoothBuckets(buckets);
  const pocIndex = resolvePocIndex(smoothed);
  const pocVolume = smoothed.get(pocIndex).volume;
  const { vaHigh, vaLow, totalVolume } = expandValueArea(
    smoothed,
    pocIndex,
    valueAreaPct,
  );
  const singlePrintBuckets = [...smoothed.entries()]
    .filter(([, bucket]) => bucket.volume < pocVolume * SINGLE_PRINT_RATIO)
    .map(([index]) => index)
    .sort((a, b) => a - b);
  return {
    pocIndex,
    vaHigh,
    vaLow,
    totalVolume,
    singlePrintBuckets,
    buckets: smoothed,
  };
}

function rescaleSessionToFit(session, maxBuckets = MAX_PROFILE_BUCKETS) {
  if (!Number.isSafeInteger(maxBuckets) || maxBuckets <= 0) {
    throw new Error(
      "volume-profile-engine: maxBuckets must be a positive safe integer",
    );
  }
  assertBucketingParams(
    session.originPrice,
    session.rowWidth,
    "rescaleSessionToFit",
  );
  let passes = 0;
  while (session.buckets.size > maxBuckets) {
    if (passes >= MAX_RESCALE_PASSES) {
      throw new Error(
        "volume-profile-engine: rescaleSessionToFit exceeded its pass budget",
      );
    }
    const merged = new Map();
    for (const [index, bucket] of session.buckets) {
      const mergedIndex = Math.floor(index / 2);
      const existing = merged.get(mergedIndex);
      if (existing === undefined) {
        merged.set(mergedIndex, {
          volume: bucket.volume,
          buyVolume: bucket.buyVolume,
          sellVolume: bucket.sellVolume,
        });
      } else {
        existing.volume += bucket.volume;
        existing.buyVolume += bucket.buyVolume;
        existing.sellVolume += bucket.sellVolume;
      }
    }
    session.buckets = merged;
    session.rowWidth *= 2;
    passes += 1;
  }
  return passes;
}

async function pollOpenPeriod(
  session,
  adapter,
  nowMs,
  {
    pageLimit = DEFAULT_PAGE_LIMIT,
    maxPagesPerTick = DEFAULT_MAX_PAGES_PER_TICK,
    maxBuckets = MAX_PROFILE_BUCKETS,
  } = {},
) {
  if (!Number.isSafeInteger(nowMs) || nowMs < session.periodStartTs) {
    throw new Error(
      "volume-profile-engine: pollOpenPeriod nowMs must be a safe integer not before periodStartTs",
    );
  }
  let pagesFetched = 0;
  let rowsApplied = 0;
  let rescalePasses = 0;
  let complete = false;
  try {
    for (;;) {
      if (pagesFetched >= maxPagesPerTick) break;
      const { rows, nextCursor, available } = await adapter.readTradesSince(
        session.pollFromTs ?? session.periodStartTs,
        nowMs,
        session.pollCursor,
        pageLimit,
      );
      pagesFetched += 1;
      if (!available)
        throw new Error("volume-profile-engine: trade source unavailable");
      for (const row of rows) {
        assertValidTradeRow(row, session);
      }
      for (const row of rows) {
        applyTradeRow(session.buckets, row, session);
        session.latestRowTs = row.ts;
        session.lastTradeId = row.tradeId;
        rowsApplied += 1;
      }
      if (nextCursor === null) {
        complete = true;
        break;
      }
      session.pollCursor = nextCursor;
      if (rows.length < pageLimit) {
        complete = true;
        break;
      }
    }
  } finally {
    // Successful pages survive a later query failure. Their memory bound must
    // survive it too, while the original failure still reaches the caller.
    rescalePasses = rescaleSessionToFit(session, maxBuckets);
  }
  return { rowsApplied, pagesFetched, rescalePasses, complete };
}

async function finalizePeriod(session, adapter, nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < session.periodStartTs) {
    throw new Error(
      "volume-profile-engine: finalizePeriod nowMs must be a safe integer not before periodStartTs",
    );
  }
  const { buckets: readerBuckets, available } = await adapter.readVolumeProfile(
    session.periodStartTs,
    nowMs,
    session.originPrice,
    session.rowWidth,
  );
  if (available) {
    session.buckets = bucketsFromReaderResult(readerBuckets);
    rescaleSessionToFit(session);
  }
  session.periodEndTs = nowMs;
  return session;
}

async function rolloverPeriod(session, adapter, nowMs, newRowWidthInputs) {
  await finalizePeriod(session, adapter, nowMs);
  const rowWidth = resolveRowWidth(newRowWidthInputs);
  const originPrice = newRowWidthInputs.originPrice ?? session.originPrice;
  return {
    closedSession: session,
    nextSession: createSession({ periodStartTs: nowMs, originPrice, rowWidth }),
  };
}

module.exports = {
  resolveRowWidth,
  resolveTicksPerRow,
  resolveAtrTicksPerRow,
  resolveAtrBinSizePrice,
  assertBinSizeMultiplier,
  projectSessionSpan,
  snapTicksPerRowToGrain,
  snapTicksPerRowToGrainUp,
  snapTicksPerRowToGrainDown,
  createSession,
  seedSessionFromStorage,
  bucketIndexFor,
  applyTradeRow,
  computeProfile,
  smoothBuckets,
  pollOpenPeriod,
  finalizePeriod,
  rolloverPeriod,
  rescaleSessionToFit,
  ROLLUP_GRAIN_TICKS,
  DEFAULT_TARGET_ROW_COUNT,
  DEFAULT_BIN_SIZE_MULTIPLIER,
  MIN_BIN_SIZE_MULTIPLIER,
  MAX_BIN_SIZE_MULTIPLIER,
  DEFAULT_REFERENCE_WINDOW_MS,
  MIN_ATR_ROW_COUNT,
  MAX_ATR_ROW_COUNT,
  DEFAULT_VALUE_AREA_PCT,
  SINGLE_PRINT_RATIO,
  DEFAULT_PAGE_LIMIT,
  DEFAULT_MAX_PAGES_PER_TICK,
  MAX_PROFILE_BUCKETS,
};
