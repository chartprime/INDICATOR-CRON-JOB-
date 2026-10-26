"use strict";

const {
  createDxFeedVolumeProfileAdapter,
} = require("../indicators/volume-profile/volume-profile-adapters");
const {
  deriveBucketingParams,
  PROFILE_ORIGIN_PRICE,
} = require("../indicators/volume-profile/volume-profile-setup");
const {
  computeProfile,
  rescaleSessionToFit,
  DEFAULT_BIN_SIZE_MULTIPLIER,
} = require("../indicators/volume-profile/volume-profile-engine");
const { computeVpin } = require("../indicators/vpin/vpin-compute");
const {
  MARKER_BUCKET_MS,
  MARKERS_PER_BUCKET_SIDE,
} = require("../indicators/large-trade/large-trade-detection");
const {
  VPIN_REMOTE_BACKFILL_SLICE_MS,
  VPIN_CALIBRATION_WINDOW_MS,
  VPIN_N_BASELINE,
  DXFEED_CANDLE_WARMUP_WINDOW_MS,
  MAX_HISTORY_RANGES,
} = require("./history-parameters");
const { buildProfileWireFields, vpinReadingsToWire } = require("./wire-fields");

const MODULE = "archive-study";
const STUDIES = Object.freeze([
  "volume_profile",
  "vpin",
  "large_prints",
  "bar_flow",
]);
const PROFILE_MODES = Object.freeze([
  "continuous",
  "per_candle",
  "fixed_range",
]);
const ASSET_CLASSES = Object.freeze(["FUTURE", "EQUITY", "SPOT", "PERPETUAL"]);
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const WEEK_MS = 7 * DAY_MS;
const FIRST_MONDAY_MS = 4 * DAY_MS;
const MAX_PRINT_BARS = 5_000;
const MAX_BAR_FLOW_BARS = 5_000;
const MAX_VPIN_WEEKS = 26;
const LEGACY_MAX_PROFILE_BUCKETS = 300;
const ARCHIVE_MIN_BIN_SIZE_MULTIPLIER = 0.1;
const ARCHIVE_MAX_BIN_SIZE_MULTIPLIER = 10;
const VPIN_LEAD_IN_MS = DXFEED_CANDLE_WARMUP_WINDOW_MS;
const VPIN_BACKFILL_CHUNK_MS = WEEK_MS;

class ArchiveStudyError extends Error {
  constructor(code, reason) {
    super(`${code}:${reason}`);
    this.code = code;
    this.reason = reason;
  }
}

function refuse(reason) {
  throw new ArchiveStudyError("INVALID_STUDY", reason);
}

function isWeekStart(ts) {
  return (ts - FIRST_MONDAY_MS) % WEEK_MS === 0;
}

function validateRanges(ranges) {
  if (
    !Array.isArray(ranges) ||
    ranges.length === 0 ||
    ranges.length > MAX_HISTORY_RANGES
  )
    refuse("RANGES_OUT_OF_BOUNDS");
  let previousEnd = -1;
  return ranges.map((range) => {
    const { fromTs, toTs } = range ?? {};
    if (
      !Number.isSafeInteger(fromTs) ||
      !Number.isSafeInteger(toTs) ||
      fromTs < 0 ||
      toTs <= fromTs
    )
      refuse("RANGE_NOT_A_WINDOW");
    if (fromTs % MINUTE_MS !== 0 || toTs % MINUTE_MS !== 0)
      refuse("RANGE_NOT_MINUTE_ALIGNED");
    if (fromTs < previousEnd) refuse("RANGES_OVERLAP_OR_UNORDERED");
    previousEnd = toTs;
    return { fromTs, toTs };
  });
}

function validateStudy({
  study,
  assetClass,
  tickSize,
  ranges,
  requestId,
  options,
}) {
  if (!STUDIES.includes(study)) refuse("UNKNOWN_STUDY");
  if (!ASSET_CLASSES.includes(assetClass)) refuse("UNKNOWN_ASSET_CLASS");
  if (!Number.isFinite(tickSize) || tickSize <= 0) refuse("INVALID_TICK_SIZE");
  if (!Number.isSafeInteger(requestId) || requestId <= 0)
    refuse("INVALID_REQUEST_ID");
  const checked = validateRanges(ranges);
  if (study === "volume_profile") {
    if (!PROFILE_MODES.includes(options?.mode)) refuse("UNKNOWN_PROFILE_MODE");
    if (
      options?.ticksPerRow !== undefined &&
      options?.binSizeMultiplier !== undefined
    ) {
      refuse("AMBIGUOUS_PROFILE_BIN_SIZE");
    }
    const ticksPerRow = options?.ticksPerRow ?? null;
    if (
      ticksPerRow !== null &&
      (!Number.isSafeInteger(ticksPerRow) ||
        ticksPerRow <= 0 ||
        !Number.isFinite(tickSize * ticksPerRow))
    ) {
      refuse("INVALID_TICKS_PER_ROW");
    }
    const binSizeMultiplier =
      options?.binSizeMultiplier ?? DEFAULT_BIN_SIZE_MULTIPLIER;
    if (
      !Number.isFinite(binSizeMultiplier) ||
      binSizeMultiplier < ARCHIVE_MIN_BIN_SIZE_MULTIPLIER ||
      binSizeMultiplier > ARCHIVE_MAX_BIN_SIZE_MULTIPLIER
    ) {
      refuse("INVALID_BIN_SIZE_MULTIPLIER");
    }
    return checked;
  }
  if (checked.length !== 1) refuse("SINGLE_RANGE_REQUIRED");
  const [{ fromTs, toTs }] = checked;
  if (study === "bar_flow") {
    const bucketMs = options?.bucketMs;
    if (
      !Number.isSafeInteger(bucketMs) ||
      bucketMs < MINUTE_MS ||
      bucketMs % MINUTE_MS !== 0
    ) {
      refuse("FLOW_BUCKET_NOT_WHOLE_MINUTES");
    }
    if (fromTs % bucketMs !== 0 || toTs % bucketMs !== 0)
      refuse("FLOW_RANGE_NOT_BAR_ALIGNED");
    if ((toTs - fromTs) / bucketMs > MAX_BAR_FLOW_BARS)
      refuse("FLOW_TOO_MANY_BARS");
    return checked;
  }
  if (study === "vpin") {
    if (!isWeekStart(fromTs) || !isWeekStart(toTs))
      refuse("VPIN_RANGE_NOT_WHOLE_WEEKS");
    if ((toTs - fromTs) / WEEK_MS > MAX_VPIN_WEEKS) refuse("TOO_MANY_WEEKS");
    return checked;
  }
  const bucketMs = options?.bucketMs;
  if (
    !Number.isSafeInteger(bucketMs) ||
    bucketMs < MARKER_BUCKET_MS ||
    bucketMs % MARKER_BUCKET_MS !== 0
  ) {
    refuse("PRINT_BUCKET_NOT_WHOLE_MINUTES");
  }
  if (fromTs % bucketMs !== 0 || toTs % bucketMs !== 0)
    refuse("PRINT_RANGE_NOT_BAR_ALIGNED");
  if ((toTs - fromTs) / bucketMs > MAX_PRINT_BARS) refuse("TOO_MANY_BARS");
  return checked;
}

async function volumeProfiles({
  adapter,
  tickSize,
  ranges,
  requestId,
  options,
}) {
  const profiles = [];
  const missing = [];
  const empty = [];
  for (const { fromTs, toTs } of ranges) {
    const span = await adapter.readPriceRange(fromTs, toTs);
    if (!span.available) {
      missing.push({ fromTs, toTs });
      continue;
    }
    if (span.tradeCount === 0) {
      empty.push({ fromTs, toTs });
      continue;
    }
    const params =
      options?.ticksPerRow != null
        ? {
            originPrice: PROFILE_ORIGIN_PRICE,
            rowWidth: tickSize * options.ticksPerRow,
          }
        : await deriveBucketingParams({
            adapter: { readPriceRange: async () => span },
            tickSize,
            fromTs,
            toTs,
            binSizeMultiplier:
              options?.binSizeMultiplier ?? DEFAULT_BIN_SIZE_MULTIPLIER,
          });
    if (params === null) {
      missing.push({ fromTs, toTs });
      continue;
    }
    const { originPrice, rowWidth } = params;
    const { buckets: readerBuckets, available } =
      await adapter.readVolumeProfile(fromTs, toTs, originPrice, rowWidth);
    if (!available || readerBuckets.length === 0) {
      missing.push({ fromTs, toTs });
      continue;
    }
    const buckets = new Map(
      readerBuckets.map((row) => [
        row.bucket,
        {
          volume: row.volume,
          buyVolume: row.buyVolume,
          sellVolume: row.sellVolume,
        },
      ]),
    );
    const session = {
      periodStartTs: fromTs,
      periodEndTs: toTs,
      rowWidth,
      originPrice,
      buckets,
    };
    rescaleSessionToFit(
      session,
      options?.ticksPerRow !== undefined
        ? LEGACY_MAX_PROFILE_BUCKETS
        : undefined,
    );
    const profile = computeProfile(session.buckets);
    profiles.push(
      buildProfileWireFields(
        {
          session,
          profile,
          mode: options.mode,
          deliveryScope: "HISTORICAL",
          historyRequestId: requestId,
        },
        `${MODULE}.volume_profile`,
      ),
    );
  }
  return { profiles, missing, empty, complete: missing.length === 0 };
}

async function vpinWeek({ adapter, tickSize, weekStart }) {
  const weekEnd = weekStart + WEEK_MS;
  const result = await computeVpin({
    adapter,
    tickSize,
    nowMs: weekEnd,
    calibrationEndTs: weekStart,
    calibrationWindowMs: VPIN_CALIBRATION_WINDOW_MS,
    backfillWindowMs: VPIN_LEAD_IN_MS + WEEK_MS,
    engineOptions: { nBaseline: VPIN_N_BASELINE },
    backfill: {
      backfillMode: "SLICED_APPROXIMATE",
      sliceMs: VPIN_REMOTE_BACKFILL_SLICE_MS,
      chunkMs: VPIN_BACKFILL_CHUNK_MS,
    },
  });
  if (!result.available)
    return { readings: [], reason: result.reason ?? "UNAVAILABLE" };
  return {
    readings: result.history.filter(
      (reading) => reading.sealTs >= weekStart && reading.sealTs < weekEnd,
    ),
    reason: null,
  };
}

async function vpin({ adapter, tickSize, range }) {
  const readings = [];
  const missingWeeks = [];
  for (
    let weekStart = range.fromTs;
    weekStart < range.toTs;
    weekStart += WEEK_MS
  ) {
    const week = await vpinWeek({ adapter, tickSize, weekStart });
    if (week.reason !== null)
      missingWeeks.push({
        fromTs: weekStart,
        toTs: weekStart + WEEK_MS,
        reason: week.reason,
      });
    readings.push(...week.readings);
  }
  return {
    readings: vpinReadingsToWire(readings, `${MODULE}.vpin`),
    missing: missingWeeks,
    complete: missingWeeks.length === 0,
  };
}

async function largePrints({ reader, symbol, assetClass, range, bucketMs }) {
  const bars = (range.toTs - range.fromTs) / bucketMs;
  const { rows, available } = await reader.readLargeTradesAsync(
    symbol,
    assetClass,
    {
      nowMs: range.toTs - 1,
      limit: bars * MARKERS_PER_BUCKET_SIDE * 2,
      fromMs: range.fromTs,
      bucketMs,
      perBucketSideLimit: MARKERS_PER_BUCKET_SIDE,
    },
  );
  if (!available) return { prints: [], missing: [range], complete: false };
  const prints = rows.map(({ row }) => ({
    ts_exchange: row.event_time,
    price: row.price,
    size: row.size,
    side: row.aggressor_side === "BUY" ? "buy" : "sell",
  }));
  return { prints, missing: [], complete: true };
}

async function barFlow({ reader, symbol, assetClass, range, bucketMs }) {
  const { rows, available } = await reader.readMinuteFlow(symbol, assetClass, {
    fromTs: range.fromTs,
    toTs: range.toTs,
  });
  if (!available) return { bars: [], missing: [range], complete: false };
  const bars = new Map();
  for (const row of rows) {
    const tsOpen = Math.floor(row.minuteTs / bucketMs) * bucketMs;
    let bar = bars.get(tsOpen);
    if (bar === undefined) {
      bar = {
        ts_open: tsOpen,
        volume: 0,
        buy_volume: 0,
        sell_volume: 0,
        unknown_volume: 0,
        trade_count: 0,
      };
      bars.set(tsOpen, bar);
    }
    bar.volume += row.volume;
    bar.buy_volume += row.buyVolume;
    bar.sell_volume += row.sellVolume;
    bar.unknown_volume += row.unknownVolume;
    bar.trade_count += row.tradeCount;
  }
  return {
    bars: [...bars.values()].sort(
      (left, right) => left.ts_open - right.ts_open,
    ),
    missing: [],
    complete: true,
  };
}

async function runStudy({
  reader,
  symbol,
  study,
  assetClass,
  tickSize,
  ranges,
  requestId,
  options = {},
}) {
  const checked = validateStudy({
    study,
    assetClass,
    tickSize,
    ranges,
    requestId,
    options,
  });
  const adapter = createDxFeedVolumeProfileAdapter(reader, symbol, assetClass);
  if (study === "volume_profile") {
    return {
      study,
      requestId,
      ...(await volumeProfiles({
        adapter,
        tickSize,
        ranges: checked,
        requestId,
        options,
      })),
    };
  }
  if (study === "vpin")
    return {
      study,
      requestId,
      ...(await vpin({ adapter, tickSize, range: checked[0] })),
    };
  if (study === "bar_flow") {
    return {
      study,
      requestId,
      ...(await barFlow({
        reader,
        symbol,
        assetClass,
        range: checked[0],
        bucketMs: options.bucketMs,
      })),
    };
  }
  return {
    study,
    requestId,
    ...(await largePrints({
      reader,
      symbol,
      assetClass,
      range: checked[0],
      bucketMs: options.bucketMs,
    })),
  };
}

module.exports = {
  runStudy,
  validateStudy,
  ArchiveStudyError,
  STUDIES,
  WEEK_MS,
  FIRST_MONDAY_MS,
  MAX_PRINT_BARS,
  MAX_BAR_FLOW_BARS,
  MAX_VPIN_WEEKS,
  VPIN_LEAD_IN_MS,
  ARCHIVE_MIN_BIN_SIZE_MULTIPLIER,
};
