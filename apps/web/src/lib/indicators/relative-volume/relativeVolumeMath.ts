import type { BarFrame } from "../../../types/frames";
import { nyLocalMinuteOfDay } from "../killzones/killzones";

/**
 * Relative Volume by Time of Day: the pure, incremental machinery.
 *
 * One observation per committed bar is filed under the bar's start minute of
 * day (the "slot key") in a ring of the last `sessions` observations, and in a
 * second ring of the last 20 committed bars. A bar's ratio divides its volume
 * by the slot ring's median read *before* the bar's own observation entered
 * the ring (`baselineAtOpen`), so a bar never sees itself in its denominator
 * and every later revision of that bar divides by the same number.
 *
 * Corrections are tail-only: a closed dispatch of the newest bar with a
 * different volume updates the observation in place, a valid-to-invalid
 * correction removes it (restoring whatever its insertion evicted), and
 * invalid-to-valid re-inserts it. A correction to any older bar reaches the
 * indicator as a full replay, which recreates this state from scratch.
 *
 * Exported so that a later indicator (Squeeze Breakout Context) can import the
 * slot-median machinery as its volume confirmation.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const MINUTES_PER_DAY = 1_440;
/** Time of day needs an intraday bar: anything longer than one hour yields null. */
export const RVOL_MAX_INTERVAL_MS = HOUR_MS;
export const RVOL_ROLLING_LENGTH = 20;
export const RVOL_DEFAULT_SESSIONS = 10;
export const RVOL_MIN_SESSIONS_SETTING = 2;
export const RVOL_MAX_SESSIONS_SETTING = 60;
export const RVOL_DEFAULT_MIN_SESSIONS = 3;

export type RvolClock = "auto" | "newYork" | "utc";
export type ResolvedRvolClock = "newYork" | "utc";

export interface RelativeVolumeMathSettings {
  /** Ring capacity per slot key: the last N matching bars (2..60). */
  sessions: number;
  /** Prior observations a slot needs before a ratio is shown; clamped to `sessions` at read time. */
  minSessions: number;
  clock: RvolClock;
}

/** `auto` is New York for the dxFeed and Databento providers and UTC for Binance. */
export function resolveRvolClock(clock: RvolClock, provider: BarFrame["provider"]): ResolvedRvolClock {
  if (clock === "newYork" || clock === "utc") return clock;
  return provider === "DXFEED" || provider === "DATABENTO" ? "newYork" : "utc";
}

/**
 * One-entry cache of the New York minute at the start of a UTC hour. The New
 * York offset is constant inside any UTC hour (both DST changes fall on an
 * hour boundary), so a chronological series needs one `Intl` call per hour.
 */
export interface ClockCache {
  hourStart: number;
  minuteAtHourStart: number;
}

export function createClockCache(): ClockCache {
  return { hourStart: Number.NaN, minuteAtHourStart: 0 };
}

/** The bar's start minute of day (0..1439) in the resolved clock, or null for an unusable timestamp. */
export function slotKeyOf(tsOpen: number, clock: ResolvedRvolClock, cache?: ClockCache): number | null {
  if (!Number.isSafeInteger(tsOpen) || tsOpen < 0) return null;
  if (clock === "utc") return Math.floor((tsOpen % DAY_MS) / MINUTE_MS);
  const hourStart = Math.floor(tsOpen / HOUR_MS) * HOUR_MS;
  let minuteAtHourStart: number;
  if (cache !== undefined && cache.hourStart === hourStart) {
    minuteAtHourStart = cache.minuteAtHourStart;
  } else {
    minuteAtHourStart = nyLocalMinuteOfDay(hourStart);
    if (cache !== undefined) {
      cache.hourStart = hourStart;
      cache.minuteAtHourStart = minuteAtHourStart;
    }
  }
  return (minuteAtHourStart + Math.floor((tsOpen - hourStart) / MINUTE_MS)) % MINUTES_PER_DAY;
}

/** A finite volume at or above zero; anything else contributes no observation. */
export function usableVolume(volume: unknown): number | null {
  return typeof volume === "number" && Number.isFinite(volume) && volume >= 0 ? volume : null;
}

export interface Observation {
  tsOpen: number;
  volume: number;
}

export interface ObservationRing {
  readonly capacity: number;
  /** Oldest first; never longer than `capacity`. */
  readonly items: Observation[];
  /** What the newest insertion pushed out, kept until that tail is superseded so a correction can restore it. */
  evictedByTail: Observation | null;
}

export function createRing(capacity: number): ObservationRing {
  const size = Number.isFinite(capacity) ? Math.max(1, Math.floor(capacity)) : 1;
  return { capacity: size, items: [], evictedByTail: null };
}

export function ringInsert(ring: ObservationRing, observation: Observation): void {
  ring.items.push(observation);
  if (ring.items.length > ring.capacity) ring.evictedByTail = ring.items.shift() ?? null;
}

/** Changes the volume of the observation filed under `tsOpen` in place; false when none is filed. */
export function ringUpdate(ring: ObservationRing, tsOpen: number, volume: number): boolean {
  for (let index = ring.items.length - 1; index >= 0; index -= 1) {
    if (ring.items[index].tsOpen === tsOpen) {
      ring.items[index].volume = volume;
      return true;
    }
  }
  return false;
}

/** Removes the observation filed under `tsOpen` and restores what its insertion evicted. */
export function ringRemove(ring: ObservationRing, tsOpen: number): boolean {
  for (let index = ring.items.length - 1; index >= 0; index -= 1) {
    if (ring.items[index].tsOpen !== tsOpen) continue;
    ring.items.splice(index, 1);
    if (ring.evictedByTail !== null) {
      ring.items.unshift(ring.evictedByTail);
      ring.evictedByTail = null;
    }
    return true;
  }
  return false;
}

/** The tail that inserted into this ring has been superseded by a newer bar: its eviction is final. */
export function ringSupersede(ring: ObservationRing): void {
  ring.evictedByTail = null;
}

/** Median of the ring's volumes (mean of the two middle values for an even count); null when empty. */
export function ringMedian(ring: ObservationRing, scratch: number[] = []): number | null {
  const count = ring.items.length;
  if (count === 0) return null;
  scratch.length = count;
  for (let index = 0; index < count; index += 1) {
    // Insertion sort: the ring holds at most 60 values and this runs once per bar.
    const value = ring.items[index].volume;
    let position = index;
    while (position > 0 && scratch[position - 1] > value) {
      scratch[position] = scratch[position - 1];
      position -= 1;
    }
    scratch[position] = value;
  }
  const middle = count >> 1;
  const median = count % 2 === 1 ? scratch[middle] : (scratch[middle - 1] + scratch[middle]) / 2;
  return Number.isFinite(median) ? median : null;
}

export function ringMean(ring: ObservationRing): number | null {
  const count = ring.items.length;
  if (count === 0) return null;
  let sum = 0;
  for (let index = 0; index < count; index += 1) sum += ring.items[index].volume;
  const mean = sum / count;
  return Number.isFinite(mean) ? mean : null;
}

/** What the baselines were before this bar's observation existed: read once, stored on the bar record. */
export interface BaselineAtOpen {
  slotMedian: number | null;
  slotMean: number | null;
  priorCount: number;
  rollingMean: number | null;
  rollingCount: number;
}

export interface TailRecord {
  tsOpen: number;
  /** Start minute of day in the resolved clock; null when the bar cannot be keyed. */
  key: number | null;
  /** False for a timeframe longer than one hour or an unkeyable bar: nothing is filed, every output is null. */
  supported: boolean;
  /** Last known volume, null when the latest dispatch carried no usable volume. */
  volume: number | null;
  baselineAtOpen: BaselineAtOpen;
  /** The commit event (first closed dispatch, or a newer bar arriving) has happened. */
  committed: boolean;
  /** An observation for this bar currently sits in both rings. */
  inRings: boolean;
  /** A closed dispatch has been seen: outputs are confirmed, not provisional. */
  confirmed: boolean;
}

export type RvolStatus = "unsupported" | "noVolume" | "learning" | "noBaseline" | "forming" | "ready";

export interface RvolReading {
  tsOpen: number;
  key: number | null;
  volume: number | null;
  /** volume / median of the slot ring as it stood when this bar opened. */
  rvol: number | null;
  /** volume / mean of the last 20 committed bars as they stood when this bar opened. */
  rolling: number | null;
  /** volume / mean of the same slot observations the median uses (the baseline comparison's second method). */
  slotMeanRatio: number | null;
  priorCount: number;
  rollingCount: number;
  /** `minSessions` clamped to `sessions`: what `priorCount` must reach. */
  requiredPrior: number;
  confirmed: boolean;
  status: RvolStatus;
}

export interface RelativeVolumeEngine {
  readonly settings: RelativeVolumeMathSettings;
  /** Feeds one dispatch of a bar and returns the reading for the bar of this call (the tail). */
  onBar(bar: BarFrame): RvolReading;
  readonly current: RvolReading | null;
  readonly tail: TailRecord | null;
  readonly rollingRing: ObservationRing;
  slotRing(key: number): ObservationRing | undefined;
  readonly slotCount: number;
}

export function requiredPriorOf(settings: RelativeVolumeMathSettings): number {
  const sessions = Number.isFinite(settings.sessions) ? Math.floor(settings.sessions) : RVOL_DEFAULT_SESSIONS;
  const minimum = Number.isFinite(settings.minSessions) ? Math.floor(settings.minSessions) : RVOL_DEFAULT_MIN_SESSIONS;
  return Math.max(1, Math.min(minimum, sessions));
}

function ratioOf(volume: number, denominator: number | null): number | null {
  if (denominator === null || !(denominator > 0)) return null;
  const ratio = volume / denominator;
  return Number.isFinite(ratio) ? ratio : null;
}

/** The reading for a tail record: rule 9 (outputs) and rule 11 (status precedence, first match wins). */
export function readingOf(tail: TailRecord, settings: RelativeVolumeMathSettings): RvolReading {
  const requiredPrior = requiredPriorOf(settings);
  const base = tail.baselineAtOpen;
  const reading: RvolReading = {
    tsOpen: tail.tsOpen,
    key: tail.key,
    volume: tail.volume,
    rvol: null,
    rolling: null,
    slotMeanRatio: null,
    priorCount: base.priorCount,
    rollingCount: base.rollingCount,
    requiredPrior,
    confirmed: tail.confirmed,
    status: "ready",
  };
  if (!tail.supported) {
    reading.status = "unsupported";
    return reading;
  }
  if (tail.volume === null) {
    reading.status = "noVolume";
    return reading;
  }
  reading.rolling = base.rollingCount >= RVOL_ROLLING_LENGTH ? ratioOf(tail.volume, base.rollingMean) : null;
  if (base.priorCount < requiredPrior) {
    reading.status = "learning";
    return reading;
  }
  reading.slotMeanRatio = ratioOf(tail.volume, base.slotMean);
  reading.rvol = ratioOf(tail.volume, base.slotMedian);
  if (reading.rvol === null) {
    reading.status = "noBaseline";
    return reading;
  }
  reading.status = tail.confirmed ? "ready" : "forming";
  return reading;
}

export function createRelativeVolumeEngine(settings: RelativeVolumeMathSettings): RelativeVolumeEngine {
  const capacity = Number.isFinite(settings.sessions)
    ? Math.min(RVOL_MAX_SESSIONS_SETTING, Math.max(RVOL_MIN_SESSIONS_SETTING, Math.floor(settings.sessions)))
    : RVOL_DEFAULT_SESSIONS;
  const slots = new Map<number, ObservationRing>();
  const rolling = createRing(RVOL_ROLLING_LENGTH);
  const clockCache = createClockCache();
  const scratch: number[] = [];
  let tail: TailRecord | null = null;
  let current: RvolReading | null = null;

  function slotFor(key: number): ObservationRing {
    let ring = slots.get(key);
    if (ring === undefined) {
      ring = createRing(capacity);
      slots.set(key, ring);
    }
    return ring;
  }

  function readBaseline(key: number | null): BaselineAtOpen {
    const slot = key === null ? undefined : slots.get(key);
    return {
      slotMedian: slot === undefined ? null : ringMedian(slot, scratch),
      slotMean: slot === undefined ? null : ringMean(slot),
      priorCount: slot === undefined ? 0 : slot.items.length,
      rollingMean: ringMean(rolling),
      rollingCount: rolling.items.length,
    };
  }

  /** Rule 7: the commit event for the tail, filing its last known volume when it is usable. */
  function commit(record: TailRecord): void {
    record.committed = true;
    if (!record.supported || record.key === null || record.volume === null) return;
    const observation = { tsOpen: record.tsOpen, volume: record.volume };
    ringInsert(slotFor(record.key), observation);
    ringInsert(rolling, { tsOpen: record.tsOpen, volume: record.volume });
    record.inRings = true;
  }

  /** A later dispatch of a committed tail: update in place, remove (valid to invalid) or insert (invalid to valid). */
  function reconcile(record: TailRecord): void {
    if (!record.supported || record.key === null) return;
    const slot = slotFor(record.key);
    if (record.volume !== null && record.inRings) {
      ringUpdate(slot, record.tsOpen, record.volume);
      ringUpdate(rolling, record.tsOpen, record.volume);
    } else if (record.volume !== null) {
      ringInsert(slot, { tsOpen: record.tsOpen, volume: record.volume });
      ringInsert(rolling, { tsOpen: record.tsOpen, volume: record.volume });
      record.inRings = true;
    } else if (record.inRings) {
      ringRemove(slot, record.tsOpen);
      ringRemove(rolling, record.tsOpen);
      record.inRings = false;
    }
  }

  function supersede(record: TailRecord): void {
    if (record.key !== null) {
      const slot = slots.get(record.key);
      if (slot !== undefined) ringSupersede(slot);
    }
    ringSupersede(rolling);
  }

  function onBar(bar: BarFrame): RvolReading {
    const tsOpen = bar.ts_open;
    if (tail !== null && tsOpen < tail.tsOpen) {
      // A dispatch older than the current record: the runtime replays those, so here it is ignored.
      return current ?? readingOf(tail, settings);
    }
    if (tail === null || tsOpen > tail.tsOpen) {
      if (tail !== null) {
        if (!tail.committed) commit(tail); // rule 7(b): a close that never arrived
        supersede(tail);
      }
      const intervalOk = Number.isFinite(bar.interval_ms) && bar.interval_ms > 0 && bar.interval_ms <= RVOL_MAX_INTERVAL_MS;
      const key = intervalOk ? slotKeyOf(tsOpen, resolveRvolClock(settings.clock, bar.provider), clockCache) : null;
      tail = {
        tsOpen,
        key,
        supported: intervalOk && key !== null,
        volume: usableVolume(bar.volume),
        baselineAtOpen: readBaseline(key),
        committed: false,
        inRings: false,
        confirmed: false,
      };
    } else {
      tail.volume = usableVolume(bar.volume);
    }
    if (bar.closed === true) tail.confirmed = true;
    if (!tail.committed) {
      if (bar.closed === true) commit(tail); // rule 7(a)
    } else {
      reconcile(tail);
    }
    current = readingOf(tail, settings);
    return current;
  }

  return {
    settings,
    onBar,
    get current() {
      return current;
    },
    get tail() {
      return tail;
    },
    rollingRing: rolling,
    slotRing: (key) => slots.get(key),
    get slotCount() {
      return slots.size;
    },
  };
}
