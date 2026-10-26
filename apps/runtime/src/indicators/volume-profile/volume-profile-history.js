const {
  MINUTE_MS,
  ROLLUP_GRAIN_TICKS,
  floorToMinute,
} = require("./volume-profile-cache");
const {
  computeProfile,
  rescaleSessionToFit,
  resolveTicksPerRow,
  resolveAtrTicksPerRow,
  assertBinSizeMultiplier,
  DEFAULT_TARGET_ROW_COUNT,
  DEFAULT_BIN_SIZE_MULTIPLIER,
} = require("./volume-profile-engine");
const { PROFILE_ORIGIN_PRICE } = require("./volume-profile-setup");

const MAX_MATERIALIZE_MINUTES_PER_CALL = 24 * 60;
const MAX_DIRECT_PROFILE_CONCURRENCY = 4;

async function mapConcurrent(values, limit, fn) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await fn(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, worker),
  );
  return results;
}

function medianSpanSize(spans) {
  const sizes = spans
    .map((span) => span.maxBucket - span.minBucket)
    .sort((a, b) => a - b);
  const middle = Math.floor(sizes.length / 2);
  return sizes.length % 2 === 1
    ? sizes[middle]
    : (sizes[middle - 1] + sizes[middle]) / 2;
}

async function ensureCoverage({
  cache,
  adapter,
  instrument,
  tickSize,
  fromMinuteTs,
  toMinuteTs,
}) {
  const gaps = cache.coverageGaps(instrument, fromMinuteTs, toMinuteTs);
  if (gaps === null) return false;
  const grainSize = tickSize * ROLLUP_GRAIN_TICKS;
  for (const gap of gaps) {
    let cursor = gap.fromMinuteTs;
    while (cursor < gap.toMinuteTs) {
      const chunkEnd = Math.min(
        cursor + MAX_MATERIALIZE_MINUTES_PER_CALL * MINUTE_MS,
        gap.toMinuteTs,
      );
      const source = await adapter.readMinuteRollup(
        cursor,
        chunkEnd,
        grainSize,
      );
      if (!source.available) return false;
      if (
        !cache.materialize(instrument, {
          tickSize: grainSize,
          fromMinuteTs: cursor,
          toMinuteTs: chunkEnd,
          rows: source.rows,
        })
      ) {
        return false;
      }
      cursor = chunkEnd;
    }
  }
  return true;
}

function sessionsFromPeriodBuckets({ byPeriod, rowWidth, ranges }) {
  const rangeByStart = new Map(
    ranges.map((range) => [range.rangeStartTs, range]),
  );
  const sessions = [];
  for (const [periodStartTs, buckets] of byPeriod) {
    const range = rangeByStart.get(periodStartTs);
    if (range === undefined || buckets.size === 0) continue;
    const session = {
      periodStartTs,
      periodEndTs: range.rangeEndTs,
      rowWidth,
      originPrice: PROFILE_ORIGIN_PRICE,
      buckets: new Map(
        [...buckets.entries()].map(([index, bucket]) => [
          index,
          {
            volume: bucket.volume,
            buyVolume: bucket.buyVolume,
            sellVolume: bucket.sellVolume,
          },
        ]),
      ),
    };
    rescaleSessionToFit(session);
    sessions.push({ range, session, profile: computeProfile(session.buckets) });
  }
  sessions.sort((a, b) => a.session.periodStartTs - b.session.periodStartTs);
  return sessions;
}


function resolveBatchTicksPerRow({
  tickSize,
  binSizeMultiplier,
  atrReading,
  periodMs,
  referenceRange = null,
}) {
  assertBinSizeMultiplier(binSizeMultiplier, "resolveBatchTicksPerRow");
  if (atrReading && Number.isFinite(periodMs) && periodMs > 0) {
    return resolveAtrTicksPerRow({
      tickSize,
      referenceAtr: atrReading.atr,
      barIntervalMs: atrReading.barIntervalMs ?? 60_000,
      sessionMs: periodMs,
      binSizeMultiplier,
      referenceRange: atrReading.referenceRange ?? referenceRange,
    });
  }
  return resolveTicksPerRow({
    tickSize,
    referenceRange,
    targetRowCount: DEFAULT_TARGET_ROW_COUNT / binSizeMultiplier,
  });
}

async function buildDirectHistoricalProfiles({
  adapter,
  ranges,
  tickSize,
  binSizeMultiplier = DEFAULT_BIN_SIZE_MULTIPLIER,
  atrReading = null,
  periodMs = null,
}) {










  let referenceRange =
    Number.isFinite(atrReading?.referenceRange) &&
    atrReading.referenceRange > 0
      ? atrReading.referenceRange
      : null;
  if (referenceRange === null && typeof adapter.readPriceRange === "function") {
    const rangeResults = await mapConcurrent(
      ranges,
      MAX_DIRECT_PROFILE_CONCURRENCY,
      async (range) => {
        const result = await adapter.readPriceRange(
          range.rangeStartTs,
          range.rangeEndTs,
        );
        if (!result?.available) return { unavailable: true };
        if (result.tradeCount === 0) return { empty: true };
        if (
          !Number.isFinite(result.minPrice) ||
          !Number.isFinite(result.maxPrice) ||
          result.maxPrice < result.minPrice
        ) {
          return { unavailable: true };
        }
        return { span: result.maxPrice - result.minPrice };
      },
    );
    const spans = rangeResults.filter((result) => result.span !== undefined);
    if (spans.length === 0) {
      return rangeResults.some((result) => result.unavailable === true)
        ? null
        : [];
    }
    referenceRange = Math.max(...spans.map((result) => result.span), tickSize);
  } else if (atrReading === null) {
    return null;
  }



  const rowWidth =
    tickSize *
    resolveBatchTicksPerRow({
      tickSize,
      binSizeMultiplier,
      atrReading,
      periodMs,
      referenceRange,
    });

  return buildProfilesAtRowWidth({ adapter, ranges, rowWidth });
}

async function buildProfilesAtRowWidth({ adapter, ranges, rowWidth }) {
  const results = await mapConcurrent(
    ranges,
    MAX_DIRECT_PROFILE_CONCURRENCY,
    async (range) => {
      const source = await adapter.readVolumeProfile(
        range.rangeStartTs,
        range.rangeEndTs,
        PROFILE_ORIGIN_PRICE,
        rowWidth,
      );
      if (!source?.available || !Array.isArray(source.buckets))
        return { unavailable: true };
      if (source.buckets.length === 0) return { empty: true };
      const session = {
        periodStartTs: range.rangeStartTs,
        periodEndTs: range.rangeEndTs,
        rowWidth,
        originPrice: PROFILE_ORIGIN_PRICE,
        buckets: new Map(
          source.buckets.map((bucket) => [
            bucket.bucket,
            {
              volume: bucket.volume,
              buyVolume: bucket.buyVolume,
              sellVolume: bucket.sellVolume,
            },
          ]),
        ),
      };
      rescaleSessionToFit(session);
      return { range, session, profile: computeProfile(session.buckets) };
    },
  );
  const built = results.filter(
    (result) => result.unavailable !== true && result.empty !== true,
  );
  if (built.length === 0 && results.some((result) => result.unavailable === true))
    return null;
  return built;
}

async function buildHistoricalProfiles({
  cache,
  adapter,
  instrument,
  tickSize,
  ranges,
  periodMs,
  binSizeMultiplier = DEFAULT_BIN_SIZE_MULTIPLIER,
  atrReading = null,
  nowMs,
}) {
  if (!cache || !adapter) return null;
  if (!Array.isArray(ranges) || ranges.length === 0) return [];
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    throw new Error(
      "volume-profile-history: tickSize must be a positive finite number",
    );
  }
  if (
    !Number.isSafeInteger(periodMs) ||
    periodMs <= 0 ||
    periodMs % MINUTE_MS !== 0
  ) {
    return null;
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error(
      "volume-profile-history: nowMs must be a non-negative safe integer",
    );
  }

  const currentMinute = floorToMinute(nowMs);
  // A historical frame closes the whole requested period. Never attach that
  // closed label to a cache query that only covers its elapsed prefix.
  ranges = ranges.filter((range) => range.rangeEndTs <= currentMinute);
  if (ranges.length === 0) return [];
  let fromMinuteTs = Infinity;
  let toMinuteTs = -Infinity;
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.rangeStartTs) ||
      !Number.isSafeInteger(range.rangeEndTs)
    )
      return null;
    if (range.rangeStartTs % MINUTE_MS !== 0) return null;
    fromMinuteTs = Math.min(fromMinuteTs, range.rangeStartTs);
    toMinuteTs = Math.max(toMinuteTs, floorToMinute(range.rangeEndTs));
  }
  toMinuteTs = Math.min(toMinuteTs, currentMinute);
  if (!Number.isFinite(fromMinuteTs) || toMinuteTs <= fromMinuteTs) return [];

  if (adapter.prefersDirectHistoricalProfiles === true) {
    return buildDirectHistoricalProfiles({
      adapter,
      ranges,
      tickSize,
      binSizeMultiplier,
      atrReading,
      periodMs,
    });
  }

  if (
    !(await ensureCoverage({
      cache,
      adapter,
      instrument,
      tickSize,
      fromMinuteTs,
      toMinuteTs,
    }))
  )
    return null;

  const spans = cache.readPeriodBucketSpans(instrument, {
    fromMinuteTs,
    toMinuteTs,
    periodMs,
  });
  if (spans === null) return null;
  if (spans.length === 0) return [];




  const grainSize = tickSize * ROLLUP_GRAIN_TICKS;
  const referenceRange = Math.max(medianSpanSize(spans) * grainSize, tickSize);
  const snappedTicksPerRow = resolveBatchTicksPerRow({
    tickSize,
    binSizeMultiplier,
    atrReading,
    periodMs,
    referenceRange,
  });
  const rowWidth = tickSize * snappedTicksPerRow;
  const grainsPerRow = snappedTicksPerRow / ROLLUP_GRAIN_TICKS;

  const byPeriod = cache.readPeriodBuckets(instrument, {
    fromMinuteTs,
    toMinuteTs,
    periodMs,
    ticksPerRow: grainsPerRow,
  });
  if (byPeriod === null) return null;
  return sessionsFromPeriodBuckets({ byPeriod, rowWidth, ranges });
}

module.exports = {
  buildHistoricalProfiles,
  buildDirectHistoricalProfiles,
  ensureCoverage,
  MAX_MATERIALIZE_MINUTES_PER_CALL,
  MAX_DIRECT_PROFILE_CONCURRENCY,
};
