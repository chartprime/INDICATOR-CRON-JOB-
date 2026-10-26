const DEFAULT_BUCKETS_PER_DAY = 360;
const DEFAULT_MIN_V_BUCKET = 1_000;
const DEFAULT_W = 20;
const DEFAULT_N_BASELINE = 5_000;
const DEFAULT_Z_ON = 1.0;
const DEFAULT_Z_OFF = 0.2;
const DEFAULT_VELOCITY_LOOKBACK_MS = 5 * 60_000;
const BASELINE_EPSILON = 1e-9;

function median(sortedValues) {
  const n = sortedValues.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedValues[mid - 1] + sortedValues[mid]) / 2 : sortedValues[mid];
}

function calibrateVBucket(dailyVolumes, {
  bucketsPerDay = DEFAULT_BUCKETS_PER_DAY,
  minVBucket = DEFAULT_MIN_V_BUCKET,
} = {}) {
  if (!Number.isFinite(bucketsPerDay) || bucketsPerDay <= 0) {
    throw new Error("vpin-engine: bucketsPerDay must be a positive finite number");
  }
  if (!Number.isFinite(minVBucket) || minVBucket <= 0) {
    throw new Error("vpin-engine: minVBucket must be a positive finite number");
  }
  const finiteVolumes = dailyVolumes.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const medianDaily = median(finiteVolumes);
  if (!Number.isFinite(medianDaily) || medianDaily <= 0) return minVBucket;
  return Math.max(medianDaily / bucketsPerDay, minVBucket);
}

function createSealerState({ vBucket }) {
  if (!Number.isFinite(vBucket) || vBucket <= 0) {
    throw new Error("vpin-engine: vBucket must be a positive finite number");
  }
  return { vBucket, buyAcc: 0, sellAcc: 0, totalAcc: 0, openTs: null };
}

function assertValidVpinTrade({ ts, price, size, side }) {
  if (!Number.isSafeInteger(ts) || ts < 0) {
    throw new Error("vpin-engine: trade ts must be a non-negative safe integer");
  }
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("vpin-engine: trade price must be a positive finite number");
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error("vpin-engine: trade size must be a positive finite number");
  }
  if (side !== "buy" && side !== "sell" && side !== null) {
    throw new Error('vpin-engine: trade side must be "buy", "sell", or null');
  }
}

function ingestTrade(sealer, trade) {
  assertValidVpinTrade(trade);
  if (trade.side === null) return [];
  const value = trade.price * trade.size;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("vpin-engine: trade notional must be a positive finite number");
  }

  let remaining = value;
  const sealed = [];
  while (remaining > 0) {
    if (sealer.openTs === null) sealer.openTs = trade.ts;
    const capacity = sealer.vBucket - sealer.totalAcc;
    const allocation = Math.min(remaining, capacity);
    if (trade.side === "buy") sealer.buyAcc += allocation;
    else sealer.sellAcc += allocation;
    sealer.totalAcc += allocation;
    remaining -= allocation;

    if (sealer.totalAcc < sealer.vBucket) break;
    sealed.push({
      sealTs: trade.ts,
      imbalance: (sealer.buyAcc - sealer.sellAcc) / sealer.vBucket,
      durationMs: trade.ts - sealer.openTs,
    });
    sealer.buyAcc = 0;
    sealer.sellAcc = 0;
    sealer.totalAcc = 0;
    sealer.openTs = null;
  }
  return sealed;
}

function pushBounded(values, value, maxSize) {
  values.push(value);
  if (values.length > maxSize) values.shift();
  return values;
}

function pushWithAgeTrim(entries, entry, maxAgeMs) {
  entries.push(entry);
  const cutoff = entry.ts - maxAgeMs;
  let dropCount = 0;
  while (dropCount < entries.length && entries[dropCount].ts < cutoff) dropCount += 1;
  if (dropCount > 0) entries.splice(0, dropCount);
  return entries;
}

function mean(values) {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function stdDev(values, meanValue) {
  if (values.length <= 1) return NaN;
  let sumSquares = 0;
  for (const value of values) sumSquares += (value - meanValue) ** 2;
  return Math.sqrt(sumSquares / (values.length - 1));
}

function createVpinState({
  vBucket,
  w = DEFAULT_W,
  nBaseline = DEFAULT_N_BASELINE,
  zOn = DEFAULT_Z_ON,
  zOff = DEFAULT_Z_OFF,
  velocityLookbackMs = DEFAULT_VELOCITY_LOOKBACK_MS,
}) {
  if (!Number.isSafeInteger(w) || w <= 0) {
    throw new Error("vpin-engine: w must be a positive safe integer");
  }
  if (!Number.isSafeInteger(nBaseline) || nBaseline <= 0) {
    throw new Error("vpin-engine: nBaseline must be a positive safe integer");
  }
  if (!Number.isFinite(zOn) || zOn <= 0) {
    throw new Error("vpin-engine: zOn must be a positive finite number");
  }
  if (!Number.isFinite(zOff) || zOff < 0 || zOff >= zOn) {
    throw new Error("vpin-engine: zOff must be a non-negative finite number less than zOn");
  }
  if (!Number.isSafeInteger(velocityLookbackMs) || velocityLookbackMs <= 0) {
    throw new Error("vpin-engine: velocityLookbackMs must be a positive safe integer");
  }
  return {
    sealer: createSealerState({ vBucket }),
    w,
    nBaseline,
    zOn,
    zOff,
    velocityLookbackMs,
    imbalances: [],
    svHistory: [],
    zHistory: [],
    active: false,
    direction: 0,
    zVpin: null,
    zActive: 0,
    zVelocity: null,
    zAcceleration: null,
    activatedAtTs: null,
    lastSealTs: null,
  };
}

function zAtOrBefore(zHistory, targetTs) {
  let candidate = null;
  for (let i = zHistory.length - 1; i >= 0; i -= 1) {
    if (zHistory[i].ts <= targetTs) {
      candidate = zHistory[i];
      break;
    }
  }
  return candidate;
}

function applySealedBucket(state, sealed) {
  pushBounded(state.imbalances, sealed.imbalance, state.w);
  if (state.imbalances.length < Math.floor(state.w / 2)) {
    state.lastSealTs = sealed.sealTs;
    return { sealed, sv: null, zVpin: null };
  }
  const sv = mean(state.imbalances);
  pushBounded(state.svHistory, sv, state.nBaseline);

  let zVpin = null;
  if (state.svHistory.length >= Math.floor(state.nBaseline / 2)) {
    const baselineMean = mean(state.svHistory);
    const baselineStd = stdDev(state.svHistory, baselineMean);
    zVpin = (sv - baselineMean) / (baselineStd + BASELINE_EPSILON);
  }
  state.zVpin = zVpin;
  state.lastSealTs = sealed.sealTs;

  if (zVpin !== null) {
    pushWithAgeTrim(state.zHistory, { ts: sealed.sealTs, z: zVpin }, 3 * state.velocityLookbackMs);
    const wasActive = state.active;
    const wasDirection = state.direction;
    applyHysteresisStep(state, zVpin);
    if (state.active && (!wasActive || state.direction !== wasDirection)) {
      state.activatedAtTs = sealed.sealTs;
    }
    if (!state.active) state.activatedAtTs = null;

    const reference = zAtOrBefore(state.zHistory, sealed.sealTs - state.velocityLookbackMs);
    if (reference !== null) {
      const priorReference = zAtOrBefore(state.zHistory, sealed.sealTs - 2 * state.velocityLookbackMs);
      const velocity = zVpin - reference.z;
      state.zVelocity = velocity;
      state.zAcceleration = priorReference !== null ? velocity - (reference.z - priorReference.z) : null;
    } else {
      state.zVelocity = null;
      state.zAcceleration = null;
    }
  } else {
    state.zVelocity = null;
    state.zAcceleration = null;
  }

  return { sealed, sv, zVpin };
}

function applyHysteresisStep(state, z) {
  if (!Number.isFinite(z)) return;
  if (state.active && Math.sign(z) === state.direction && Math.abs(z) >= state.zOff) {
    state.zActive = z;
    return;
  }
  state.active = false;
  state.direction = 0;
  if (Math.abs(z) >= state.zOn) {
    state.active = true;
    state.direction = Math.sign(z);
  }
  state.zActive = state.active ? z : 0;
}

function ingestVpinTrade(state, trade) {
  return ingestTrade(state.sealer, trade).map((sealed) => {
    const result = applySealedBucket(state, sealed);
    return { ...result, reading: snapshotVpinState(state) };
  });
}

function snapshotVpinState(state) {
  return {
    active: state.active,
    direction: state.direction > 0 ? "buy" : state.direction < 0 ? "sell" : null,
    strength: state.active && state.zVpin !== null ? Math.min(1, Math.abs(state.zActive) / (state.zOn * 3)) : 0,
    zVpin: state.zVpin,
    zVelocity: state.zVelocity,
    zAcceleration: state.zAcceleration,
    activatedAtTs: state.activatedAtTs,
    lastSealTs: state.lastSealTs,
  };
}

module.exports = {
  calibrateVBucket,
  createSealerState,
  ingestTrade,
  createVpinState,
  ingestVpinTrade,
  assertValidVpinTrade,
  applySealedBucket,
  applyHysteresisStep,
  snapshotVpinState,
  DEFAULT_BUCKETS_PER_DAY,
  DEFAULT_MIN_V_BUCKET,
  DEFAULT_W,
  DEFAULT_N_BASELINE,
  DEFAULT_Z_ON,
  DEFAULT_Z_OFF,
  DEFAULT_VELOCITY_LOOKBACK_MS,
};
