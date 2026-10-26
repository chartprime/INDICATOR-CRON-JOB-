"use strict";

const {
  MAX_PROFILE_BUCKETS,
} = require("../indicators/volume-profile/volume-profile-engine");

const MAX_WIRE_MAGNITUDE = 10_000_000;
const MAX_VALID_EPOCH_MS = 8_640_000_000_000_000;
const MAX_BAR_VOLUME = 1_000_000_000_000;
const MAX_EQUITY_TRADE_SIZE = 1_000_000_000_000;
const MAX_PROFILE_VOLUME = 1_000_000_000_000;
const PROFILE_MODES = new Set(["continuous", "per_candle", "fixed_range"]);
const DECIMAL_STRING_PATTERN = /^\d+(?:\.\d+)?$/;
const ZERO_DECIMAL_STRING_PATTERN = /^0+(?:\.0+)?$/;
const PROFILE_DELIVERY_SCOPES = new Set(["LIVE", "HISTORICAL", "FIXED_RANGE"]);

function sizeCeilingForAssetClass(assetClass) {
  return assetClass === "EQUITY" ? MAX_EQUITY_TRADE_SIZE : MAX_WIRE_MAGNITUDE;
}

function sizeCeilingFor(identity) {
  return identity?.provider === "DXFEED" ? sizeCeilingForAssetClass(identity.assetClass) : MAX_WIRE_MAGNITUDE;
}

function describeWireValue(value) {
  if (typeof value === "string") return JSON.stringify(value.slice(0, 40));
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  return value === null ? "null" : typeof value;
}

function decimalToFiniteNumber(
  value,
  field,
  { allowZero = false, ceiling = MAX_WIRE_MAGNITUDE } = {},
) {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !DECIMAL_STRING_PATTERN.test(value))
  ) {
    throw new Error(
      `${field}: decimal value is outside the supported wire-number range (value ${describeWireValue(value)}, ceiling ${ceiling})`,
    );
  }
  const converted = Number(value);
  if (
    !Number.isFinite(converted) ||
    converted > ceiling ||
    (allowZero ? converted < 0 : converted <= 0) ||
    (allowZero &&
      converted === 0 &&
      typeof value === "string" &&
      !ZERO_DECIMAL_STRING_PATTERN.test(value))
  ) {
    throw new Error(
      `${field}: decimal value is outside the supported wire-number range (value ${describeWireValue(value)}, ceiling ${ceiling})`,
    );
  }
  return converted;
}

function timestampToWireNumber(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_VALID_EPOCH_MS) {
    throw new Error(`${field}: timestamp is outside the supported wire range`);
  }
  return value;
}

function assertProfileMode(mode, field) {
  if (!PROFILE_MODES.has(mode)) {
    throw new Error(
      `${field}: mode must be "continuous", "per_candle", or "fixed_range"`,
    );
  }
}

function buildProfileWireFields(
  { session, profile, mode, deliveryScope = "LIVE", historyRequestId = null },
  field,
) {
  assertProfileMode(mode, field);
  if (!PROFILE_DELIVERY_SCOPES.has(deliveryScope)) {
    throw new Error(
      `${field}: deliveryScope must be "LIVE", "HISTORICAL", or "FIXED_RANGE"`,
    );
  }
  if (deliveryScope === "HISTORICAL") {
    if (!Number.isSafeInteger(historyRequestId) || historyRequestId <= 0) {
      throw new Error(
        `${field}: historical delivery requires a positive safe historyRequestId`,
      );
    }
  } else if (historyRequestId !== null) {
    throw new Error(
      `${field}: only historical delivery may carry a historyRequestId`,
    );
  }
  const { periodStartTs, periodEndTs, rowWidth, originPrice } = session;
  // The drawn bars must be the same shape the POC/Value-Area indices were
  // derived from, so the smoothed map computeProfile returns wins over the
  // session's raw one. The fallback keeps callers that build a profile without
  // buckets working exactly as before.
  const buckets = profile.buckets ?? session.buckets;
  timestampToWireNumber(periodStartTs, `${field}.periodStartTs`);
  if (periodEndTs !== null) {
    timestampToWireNumber(periodEndTs, `${field}.periodEndTs`);
    if (periodEndTs < periodStartTs) {
      throw new Error(`${field}: periodEndTs cannot precede periodStartTs`);
    }
  }
  if (!Number.isFinite(rowWidth) || rowWidth <= 0) {
    throw new Error(`${field}: rowWidth must be a positive finite number`);
  }
  if (!Number.isFinite(originPrice)) {
    throw new Error(`${field}: originPrice must be a finite number`);
  }
  if (profile.pocIndex === null || buckets.size === 0) {
    throw new Error(`${field}: profile must have at least one bucket`);
  }
  if (buckets.size > MAX_PROFILE_BUCKETS) {
    throw new Error(
      `${field}: buckets must not exceed ${MAX_PROFILE_BUCKETS} entries`,
    );
  }
  const singlePrintBuckets = new Set(profile.singlePrintBuckets ?? []);
  const bucketPriceByIndex = new Map();
  const wireBuckets = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucketIndex, bucket]) => {
      const price = decimalToFiniteNumber(
        originPrice + bucketIndex * rowWidth,
        `${field}.buckets.price`,
      );
      bucketPriceByIndex.set(bucketIndex, price);
      return {
        price,
        volume: decimalToFiniteNumber(
          bucket.volume,
          `${field}.buckets.volume`,
          { ceiling: MAX_PROFILE_VOLUME },
        ),
        buy_volume: decimalToFiniteNumber(
          bucket.buyVolume,
          `${field}.buckets.buyVolume`,
          { allowZero: true, ceiling: MAX_PROFILE_VOLUME },
        ),
        sell_volume: decimalToFiniteNumber(
          bucket.sellVolume,
          `${field}.buckets.sellVolume`,
          { allowZero: true, ceiling: MAX_PROFILE_VOLUME },
        ),
        single_print: singlePrintBuckets.has(bucketIndex),
      };
    });
  if (
    !buckets.has(profile.pocIndex) ||
    !buckets.has(profile.vaHigh) ||
    !buckets.has(profile.vaLow)
  ) {
    throw new Error(
      `${field}: POC/Value Area indices must reference existing buckets`,
    );
  }
  const pocPrice = bucketPriceByIndex.get(profile.pocIndex);
  const vahPrice = bucketPriceByIndex.get(profile.vaHigh);
  const valPrice = bucketPriceByIndex.get(profile.vaLow);
  if (valPrice > pocPrice || pocPrice > vahPrice) {
    throw new Error(`${field}: Value Area must nest around the POC`);
  }
  return {
    mode,
    delivery_scope: deliveryScope,
    history_request_id: historyRequestId,
    period_start_ts: periodStartTs,
    period_end_ts: periodEndTs,
    row_width: rowWidth,
    buckets: Object.freeze(wireBuckets),
    poc_price: pocPrice,
    vah_price: vahPrice,
    val_price: valPrice,
  };
}

function assertVpinReading(
  {
    sealTs,
    active,
    direction,
    strength,
    zVpin,
    zVelocity,
    zAcceleration,
    activatedAtTs,
  },
  field,
) {
  timestampToWireNumber(sealTs, `${field}.sealTs`);
  if (typeof active !== "boolean") {
    throw new Error(`${field}: active must be boolean`);
  }
  if (direction !== "buy" && direction !== "sell" && direction !== null) {
    throw new Error(`${field}: direction must be "buy", "sell", or null`);
  }
  if (active && direction === null) {
    throw new Error(`${field}: an active reading must carry a direction`);
  }
  if (!active && direction !== null) {
    throw new Error(`${field}: an inactive reading cannot carry a direction`);
  }
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
    throw new Error(`${field}: strength must be a finite number in [0, 1]`);
  }
  if (active && strength === 0) {
    throw new Error(
      `${field}: an active reading must carry a positive strength`,
    );
  }
  if (!active && strength !== 0) {
    throw new Error(`${field}: an inactive reading must carry zero strength`);
  }
  for (const [key, value] of [
    ["zVpin", zVpin],
    ["zVelocity", zVelocity],
    ["zAcceleration", zAcceleration],
  ]) {
    if (value !== null && !Number.isFinite(value)) {
      throw new Error(`${field}: ${key} must be a finite number or null`);
    }
  }
  if (activatedAtTs !== null) {
    timestampToWireNumber(activatedAtTs, `${field}.activatedAtTs`);
    if (activatedAtTs > sealTs) {
      throw new Error(`${field}: activatedAtTs cannot be after sealTs`);
    }
  }
  if (active && activatedAtTs === null) {
    throw new Error(`${field}: an active reading must carry activatedAtTs`);
  }
  if (!active && activatedAtTs !== null) {
    throw new Error(`${field}: an inactive reading cannot carry activatedAtTs`);
  }
}

function buildVpinWireFields(reading, field) {
  assertVpinReading(reading, field);
  return {
    seal_ts: reading.sealTs,
    active: reading.active,
    direction: reading.direction,
    strength: reading.strength,
    z_vpin: reading.zVpin,
    z_velocity: reading.zVelocity,
    z_acceleration: reading.zAcceleration,
    activated_at_ts: reading.activatedAtTs,
  };
}

function vpinReadingsToWire(readings, field) {
  if (!Array.isArray(readings)) {
    throw new Error(`${field}: vpinReadings must be an array`);
  }
  let previousSealTs = -1;
  const wireReadings = readings.map((reading) => {
    const wireFields = buildVpinWireFields(reading, field);
    if (wireFields.seal_ts < previousSealTs) {
      throw new Error(`${field}: vpinReadings must be chronological`);
    }
    previousSealTs = wireFields.seal_ts;
    return Object.freeze(wireFields);
  });
  return Object.freeze(wireReadings);
}

module.exports = {
  MAX_WIRE_MAGNITUDE,
  MAX_VALID_EPOCH_MS,
  MAX_BAR_VOLUME,
  MAX_EQUITY_TRADE_SIZE,
  MAX_PROFILE_VOLUME,
  PROFILE_MODES,
  decimalToFiniteNumber,
  sizeCeilingFor,
  sizeCeilingForAssetClass,
  timestampToWireNumber,
  buildProfileWireFields,
  buildVpinWireFields,
  vpinReadingsToWire,
};
