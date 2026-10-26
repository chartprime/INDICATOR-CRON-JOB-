const MULTI_HIT = 2;
const CUTS_VERSION = 1;

const DEFAULT_LEARNED_CUTS = Object.freeze({
  visiblePercentile: 0.9,
  durationPercentile: 0.99,
  ratioPercentile: 0.99,
  strongMultiple: 1.5,
  minRatio: 1,
  minSamples: 200,
  minRatioSamples: 50,
  capacity: 4096,
});

function assertPercentile(name, value) {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`learned-cuts: ${name} must be a number in (0, 1]`);
  }
}

function assertObservation(name, value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`learned-cuts: ${name} must be a finite non-negative number`);
  }
}

function createRing(capacity) {
  const values = new Float64Array(capacity);
  let next = 0;
  let count = 0;
  return {
    push(value) {
      values[next] = value;
      next = (next + 1) % capacity;
      if (count < capacity) count += 1;
    },
    count() {
      return count;
    },
    values() {
      return count < capacity ? Array.from(values.subarray(0, count)) : [...values.subarray(next), ...values.subarray(0, next)];
    },
    replace(list) {
      next = 0;
      count = 0;
      for (const value of list) this.push(value);
    },
    percentile(p) {
      if (count === 0) return null;
      const sorted = values.slice(0, count).sort();
      return sorted[Math.max(0, Math.ceil(count * p) - 1)];
    },
  };
}

function createLearnedCuts(options = {}) {
  const config = { ...DEFAULT_LEARNED_CUTS, ...options };
  assertPercentile("visiblePercentile", config.visiblePercentile);
  assertPercentile("durationPercentile", config.durationPercentile);
  assertPercentile("ratioPercentile", config.ratioPercentile);
  if (!Number.isFinite(config.strongMultiple) || config.strongMultiple < 1) {
    throw new Error("learned-cuts: strongMultiple must be a number of at least 1");
  }
  if (!Number.isFinite(config.minRatio) || config.minRatio < 1) {
    throw new Error("learned-cuts: minRatio must be a number of at least 1");
  }
  if (!Number.isSafeInteger(config.minSamples) || config.minSamples < 1) {
    throw new Error("learned-cuts: minSamples must be a positive safe integer");
  }
  if (!Number.isSafeInteger(config.minRatioSamples) || config.minRatioSamples < 1) {
    throw new Error("learned-cuts: minRatioSamples must be a positive safe integer");
  }
  if (!Number.isSafeInteger(config.capacity) || config.capacity < config.minSamples) {
    throw new Error("learned-cuts: capacity must be a safe integer of at least minSamples");
  }
  const touch = createRing(config.capacity);
  const durations = createRing(config.capacity);
  const ratios = createRing(config.capacity);
  let version = 0;
  let cached = null;
  let cachedVersion = -1;

  function minDurationMs() {
    return durations.percentile(config.durationPercentile);
  }

  function observeTouch(visible) {
    assertObservation("touch size", visible);
    touch.push(visible);
    version += 1;
  }

  function observeEpisode({ ratio, durationMs, solid = false, hits = MULTI_HIT } = {}) {
    assertObservation("ratio", ratio);
    assertObservation("durationMs", durationMs);
    if (!Number.isSafeInteger(hits) || hits < 1) throw new Error("learned-cuts: hits must be a positive safe integer");
    if (hits < MULTI_HIT) {
      version += 1;
      return;
    }
    durations.push(durationMs);
    const floor = minDurationMs();
    if (solid === true && floor !== null && durationMs >= floor) ratios.push(ratio);
    version += 1;
  }

  function current() {
    if (cachedVersion === version) return cached;
    const ready = touch.count() >= config.minSamples && durations.count() >= config.minSamples && ratios.count() >= config.minRatioSamples;
    const learned = ratios.percentile(config.ratioPercentile);
    const ratioCut = learned === null ? null : Math.max(config.minRatio, learned);
    cached = Object.freeze({
      ready,
      visibleFloor: touch.percentile(config.visiblePercentile),
      minDurationMs: minDurationMs(),
      ratioCut,
      strongRatio: ratioCut === null ? null : ratioCut * config.strongMultiple,
      visiblePercentile: config.visiblePercentile,
      durationPercentile: config.durationPercentile,
      ratioPercentile: config.ratioPercentile,
      strongMultiple: config.strongMultiple,
      minRatio: config.minRatio,
      minRatioSamples: config.minRatioSamples,
      samples: Object.freeze({ touch: touch.count(), episodes: durations.count(), ratios: ratios.count() }),
    });
    cachedVersion = version;
    return cached;
  }

  function toJSON() {
    return { version: CUTS_VERSION, touch: touch.values(), durations: durations.values(), ratios: ratios.values() };
  }

  function samplesOf(list) {
    return Array.isArray(list) && list.length <= config.capacity && list.every((value) => Number.isFinite(value) && value >= 0);
  }

  function load(saved) {
    if (!saved || typeof saved !== "object" || saved.version !== CUTS_VERSION) return false;
    if (!samplesOf(saved.touch) || !samplesOf(saved.durations) || !samplesOf(saved.ratios)) return false;
    touch.replace(saved.touch);
    durations.replace(saved.durations);
    ratios.replace(saved.ratios);
    version += 1;
    return true;
  }

  return Object.freeze({ observeTouch, observeEpisode, current, toJSON, load, get version() { return version; } });
}

module.exports = { createLearnedCuts, DEFAULT_LEARNED_CUTS };
