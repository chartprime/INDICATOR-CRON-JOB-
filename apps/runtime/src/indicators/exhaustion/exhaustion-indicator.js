"use strict";

const { createExhaustionTracker, CANDLE_MS, EXHAUSTION_RULES_VERSION, GAP_MS } = require("./exhaustion-engine");
const { readHours, probeBack, isShort, warmHours, afterHours, SHORT_MAX_MS, DEFAULT_CONCURRENCY } = require("./exhaustion-history");
const { saveExhaustionHistory, saveExhaustionHistoryAsync, loadExhaustionHistory, defaultStoreDir } = require("./exhaustion-store");
const { exhaustionShadesFrame, byStart } = require("../../server/exhaustion-frames");

const PROVIDERS = new Set(["BINANCE", "DXFEED"]);
const DEFAULT_STORE_S = 300;
const DEFAULT_MAX_AGE_S = 7 * 86_400;
const DEFAULT_FILL_S = 86_400;
const DEFAULT_COLUMNS_PER_TICK = 1_000;
const DEFAULT_MAX_SHADES = 4_000;
const DEFAULT_FILL_CHUNK_MS = 3_600_000;
const MIN_FILL_MS = 60_000;
const PASS_CHUNK_MS = 86_400_000;
const PRUNE_MS = 60_000;
const FINAL = new Set(["held", "broke", "interrupted"]);
const CHECK_IDENTITY = Object.freeze({ provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" });

function pairKeyOf(pair) {
  if (!pair || typeof pair.symbol !== "string" || pair.symbol.length === 0 || typeof pair.marketKind !== "string" || pair.marketKind.length === 0) {
    throw new Error("exhaustion-indicator: pair must carry a symbol and a marketKind");
  }
  return `${pair.marketKind}:${pair.symbol}`;
}

function positiveNumber(name, value) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`exhaustion-indicator: ${name} must be a positive number`);
  return value;
}

function withoutOrigin(shade) {
  const copy = { ...shade };
  delete copy.origin;
  return copy;
}

function validShade(shade) {
  try {
    exhaustionShadesFrame(CHECK_IDENTITY, { ts: 0, seq: 0, reset: true, shades: [shade], liveSince: 0, loading: null });
    return true;
  } catch {
    return false;
  }
}

function lengthsFor(pair, candleLengths) {
  return pair.marketKind === "EQUITY" ? candleLengths.filter((candleMs) => candleMs <= SHORT_MAX_MS) : candleLengths;
}

function runStart(columns) {
  let index = columns.length - 1;
  while (index > 0 && columns[index].ts - columns[index - 1].ts <= GAP_MS) index -= 1;
  return columns[index].ts;
}

function createExhaustionIndicator({
  provider,
  now = () => Date.now(),
  log = console,
  histories = true,
  storeDir = defaultStoreDir(),
  storeS = DEFAULT_STORE_S,
  maxAgeS = DEFAULT_MAX_AGE_S,
  fillS = DEFAULT_FILL_S,
  maxShades = DEFAULT_MAX_SHADES,
  columnsPerTick = DEFAULT_COLUMNS_PER_TICK,
  candleLengths = CANDLE_MS,
  columnsAfter,
  geometryOf,
  hostColumns = null,
  hostFill = true,
  fillChunkMs = DEFAULT_FILL_CHUNK_MS,
  fillConcurrency = DEFAULT_CONCURRENCY,
  activePair = () => null,
  publish = () => {},
  reselect = () => {},
  saveHistory = saveExhaustionHistoryAsync,
  saveHistorySync = saveExhaustionHistory,
  loadHistory = loadExhaustionHistory,
} = {}) {
  if (!PROVIDERS.has(provider)) throw new Error("exhaustion-indicator: provider must be BINANCE or DXFEED");
  for (const [name, value] of [["columnsAfter", columnsAfter], ["geometryOf", geometryOf], ["publish", publish], ["activePair", activePair], ["reselect", reselect]]) {
    if (typeof value !== "function") throw new Error(`exhaustion-indicator: ${name} must be a function`);
  }
  if (hostColumns !== null && typeof hostColumns !== "function") throw new Error("exhaustion-indicator: hostColumns must be a function or null");
  if (typeof storeDir !== "string" || storeDir.length === 0) throw new Error("exhaustion-indicator: storeDir must be a non-empty string");
  if (!Number.isSafeInteger(columnsPerTick) || columnsPerTick <= 0) throw new Error("exhaustion-indicator: columnsPerTick must be a positive safe integer");
  if (!Number.isSafeInteger(maxShades) || maxShades <= 0) throw new Error("exhaustion-indicator: maxShades must be a positive safe integer");
  if (!Number.isSafeInteger(fillChunkMs) || fillChunkMs <= 0) throw new Error("exhaustion-indicator: fillChunkMs must be a positive safe integer");
  if (!Number.isSafeInteger(fillConcurrency) || fillConcurrency <= 0) throw new Error("exhaustion-indicator: fillConcurrency must be a positive safe integer");
  if (!Array.isArray(candleLengths) || candleLengths.length === 0 || candleLengths.some((ms) => !CANDLE_MS.includes(ms))) throw new Error("exhaustion-indicator: candleLengths must be chart candle lengths");
  const storeMs = Math.max(1000, Math.round(positiveNumber("storeS", storeS) * 1000));
  const maxAgeMs = Math.round(positiveNumber("maxAgeS", maxAgeS) * 1000);
  const fillMs = Math.min(maxAgeMs, Math.round(positiveNumber("fillS", fillS) * 1000));
  const fillHours = Math.max(1, Math.round(fillMs / fillChunkMs));
  const filling = hostFill && hostColumns !== null;
  const states = new Map();
  let fillRun = null;
  let stopped = false;
  let generation = 0;

  function warn(message, detail) {
    if (typeof log.warn === "function") log.warn(message, detail);
  }

  function info(message) {
    if (typeof log.info === "function") log.info(message);
  }

  function makeTrackers(lengths, rowWidth) {
    return new Map(lengths.map((candleMs) => [candleMs, createExhaustionTracker({ candleMs, rowWidth })]));
  }

  function touch(state) {
    state.dirty = true;
    state.revision += 1;
  }

  function restore(state, at) {
    const saved = loadHistory({ dir: storeDir, pairKey: state.pairKey, rulesVersion: EXHAUSTION_RULES_VERSION, onReject: (reason) => warn(`exhaustion indicator: ${state.pairKey} history file rejected (${reason}); starting empty`) });
    if (!saved) return;
    let refused = 0;
    for (const entry of saved.shades) {
      const shade = { ...entry, origin: "stored" };
      if (!validShade(shade) || !FINAL.has(shade.status) || !state.lengths.includes(shade.candleMs) || shade.endTs < at - maxAgeMs) {
        refused += 1;
        continue;
      }
      state.stored.set(shade.id, Object.freeze(shade));
    }
    for (const scales of saved.scales) {
      const tracker = isShort(scales?.candleMs) ? undefined : state.trackers.get(scales?.candleMs);
      if (!tracker) continue;
      const waiting = tracker.restore(scales);
      if (waiting === null) {
        warn(`exhaustion indicator: ${state.pairKey} saved engine state for ${scales.candleMs} ms rejected; starting afresh`);
        continue;
      }
      for (const shade of waiting) {
        const restored = Object.freeze({ ...shade, origin: "stored" });
        if (validShade(restored)) state.live.set(shade.id, restored);
        else refused += 1;
      }
    }
    if (refused > 0) warn(`exhaustion indicator: ${state.pairKey} left out ${refused} saved shade(s)`);
    state.coveredUntil = saved.coveredUntil;
    state.coveredFrom = saved.coveredFrom;
    state.savedAt = at;
  }

  function stateFor(pair, rowWidth, at) {
    const pairKey = pairKeyOf(pair);
    let state = states.get(pairKey);
    if (state && state.rowWidth !== rowWidth) {
      warn(`exhaustion indicator: ${pairKey} row width changed from ${state.rowWidth} to ${rowWidth}; trackers restart`);
      state.trackers = makeTrackers(state.lengths, rowWidth);
      state.rowWidth = rowWidth;
      state.lastTs = null;
      state.liveSince = null;
      state.fill = { state: "waiting", columns: 0, hours: 0, reason: null };
      touch(state);
    }
    if (state) return state;
    const lengths = lengthsFor(pair, candleLengths);
    state = {
      pair: Object.freeze({ symbol: pair.symbol, marketKind: pair.marketKind }),
      pairKey,
      rowWidth,
      lengths,
      shortLengths: lengths.filter(isShort),
      trackers: makeTrackers(lengths, rowWidth),
      live: new Map(),
      stored: new Map(),
      lastTs: null,
      liveSince: null,
      coveredUntil: null,
      coveredFrom: null,
      loading: null,
      asked: null,
      fill: { state: "waiting", columns: 0, hours: 0, reason: null },
      savedAt: at,
      prunedAt: at,
      saving: false,
      dirty: false,
      revision: 0,
      columns: 0,
    };
    if (histories) restore(state, at);
    states.set(pairKey, state);
    return state;
  }

  function absorb(state, shade) {
    state.live.set(shade.id, shade);
    for (const [id, stored] of state.stored) {
      if (stored.candleMs === shade.candleMs && stored.side === shade.side && Math.abs(stored.startTs - shade.startTs) <= shade.candleMs) state.stored.delete(id);
    }
    if (state.live.size > maxShades) state.live.delete(state.live.keys().next().value);
  }

  function liveSinceOf(state, at) {
    return state.liveSince ?? at;
  }

  function publishUpdates(state, latest, at) {
    if (latest.size === 0) return [];
    const wire = [...latest.values()].filter(validShade).sort(byStart);
    if (wire.length < latest.size) warn(`exhaustion indicator: ${state.pairKey} refused ${latest.size - wire.length} invalid shade update(s)`);
    for (const shade of wire) absorb(state, shade);
    touch(state);
    if (wire.length > 0) publish(wire, state.pair, at, liveSinceOf(state, at), state.loading);
    return wire;
  }

  function originOf(state, update, origin) {
    return state.live.get(update.id)?.origin === "host" ? "host" : origin;
  }

  function feedColumns(state, columns, origin, at) {
    const latest = new Map();
    for (const column of columns) {
      if (state.lastTs !== null && column.ts <= state.lastTs) continue;
      for (const tracker of state.trackers.values()) {
        for (const update of tracker.push(column)) {
          latest.set(update.id, Object.freeze({ ...update, origin: originOf(state, update, origin) }));
        }
      }
      state.lastTs = column.ts;
      state.columns += 1;
      if (origin === "runtime") state.liveSince ??= column.ts;
    }
    return publishUpdates(state, latest, at);
  }

  function feedLive(state, at) {
    const columns = columnsAfter(state.pair, state.lastTs, columnsPerTick);
    if (!Array.isArray(columns) || columns.length === 0) return [];
    return feedColumns(state, columns, "runtime", at);
  }

  function setLoading(state, from) {
    if (state.loading === from) return;
    state.loading = from;
    if (isActive(state.pair)) reselect();
  }

  function keepHostShades(state, shades, at) {
    const kept = [];
    let invalid = 0;
    for (const shade of shades.map((entry) => Object.freeze({ ...entry, origin: "host" }))) {
      if (!validShade(shade)) {
        invalid += 1;
        continue;
      }
      const stored = state.stored.get(shade.id);
      if (state.live.has(shade.id) || (stored?.status === shade.status && stored?.judgedAt === shade.judgedAt)) continue;
      kept.push(shade);
    }
    if (invalid > 0) warn(`exhaustion indicator: ${state.pairKey} refused ${invalid} invalid host shade(s)`);
    if (kept.length === 0) return 0;
    kept.sort(byStart);
    for (const shade of kept) state.stored.set(shade.id, shade);
    touch(state);
    publish(kept, state.pair, at, liveSinceOf(state, at), state.loading);
    return kept.length;
  }

  function replaced(state) {
    return stopped || states.get(state.pairKey) !== state;
  }

  function ringOf(state) {
    const columns = columnsAfter(state.pair, null, undefined);
    return Array.isArray(columns) && columns.length > 0 ? columns : null;
  }

  function joined(state, liveStart) {
    return state.coveredUntil !== null && liveStart - state.coveredUntil < MIN_FILL_MS;
  }

  function goLive(state, liveStart, coveredFrom, fillState) {
    state.lastTs = liveStart - 1;
    state.liveSince = liveStart;
    state.coveredFrom = coveredFrom;
    state.fill.state = fillState;
    touch(state);
  }

  function goLiveAt(state, lastTs, coveredFrom, fillState) {
    state.lastTs = lastTs;
    state.coveredFrom = coveredFrom;
    state.fill.state = fillState;
    touch(state);
  }

  function startOff(state, ring) {
    const liveStart = runStart(ring);
    goLive(state, liveStart, joined(state, liveStart) ? Math.min(state.coveredFrom ?? liveStart, liveStart) : liveStart, "off");
  }

  function readSpan(state, fromTs, toTs, onHour) {
    return readHours({ pair: state.pair, fromTs, toTs, hostColumns, chunkMs: fillChunkMs, concurrency: fillConcurrency, onHour, stopped: () => replaced(state) });
  }

  async function runFill(state) {
    const edge = now();
    const floor = Math.max(edge - maxAgeMs, state.coveredUntil ?? -Infinity);
    if (edge - floor < MIN_FILL_MS) {
      goLiveAt(state, state.coveredUntil, Math.min(state.coveredFrom ?? floor, floor), "done");
      return;
    }
    state.fill.state = "reading";
    setLoading(state, Math.max(floor, edge - fillMs));
    const warm = warmHours(state.shortLengths) * fillChunkMs;
    let fromTs = edge;
    try {
      const probe = await probeBack({ pair: state.pair, toTs: edge, floorTs: floor, needed: fillHours, hostColumns, chunkMs: fillChunkMs, concurrency: fillConcurrency, stopped: () => replaced(state) });
      if (replaced(state)) return;
      state.fill.hours = probe.read;
      fromTs = probe.fromTs;
      const contiguous = state.coveredUntil !== null && fromTs <= state.coveredUntil;
      if (probe.failed !== null && probe.traded === 0 && probe.reason === "NO_HOST") {
        state.fill.reason = probe.reason;
        const ring = ringOf(state);
        if (ring === null) goLiveAt(state, state.coveredUntil, state.coveredFrom, "off");
        else startOff(state, ring);
        return;
      }
      if (edge - fromTs < MIN_FILL_MS || probe.traded === 0) {
        state.fill.reason = probe.reason;
        const ring = ringOf(state);
        const start = ring === null ? fromTs : runStart(ring);
        goLiveAt(state, Math.max(state.coveredUntil ?? -Infinity, Math.min(fromTs, start - 1)), probe.failed === null ? (contiguous ? Math.min(state.coveredFrom ?? fromTs, fromTs) : fromTs) : start, probe.failed === null ? "done" : "failed");
        if (probe.failed !== null) warn(`exhaustion indicator: ${state.pairKey} host history stopped at ${new Date(edge - (probe.failed + 1) * fillChunkMs).toISOString()} (${probe.reason}); the engines start at the live tier`);
        return;
      }
      setLoading(state, fromTs);
      const result = await readSpan(state, fromTs - warm, edge, (columns) => { feedColumns(state, columns, "host", now()); });
      if (replaced(state)) return;
      state.fill.columns = result.columns;
      state.fill.hours += result.read;
      state.fill.reason = result.reason;
      const ring = ringOf(state);
      const start = ring === null ? fromTs : runStart(ring);
      const lastTs = Math.max(state.lastTs ?? -Infinity, state.coveredUntil ?? -Infinity, Math.min(fromTs, start - 1));
      if (result.failed === null) {
        goLiveAt(state, lastTs, contiguous ? Math.min(state.coveredFrom ?? fromTs, fromTs) : fromTs, "done");
        info(`exhaustion indicator: ${state.pairKey} judged ${result.columns} host column(s) over ${result.hours} hour(s) from ${new Date(fromTs).toISOString()} to the host's edge`);
      } else {
        goLiveAt(state, lastTs, lastTs >= start - 1 ? (contiguous ? Math.min(state.coveredFrom ?? fromTs, fromTs) : fromTs) : start, "failed");
        warn(`exhaustion indicator: ${state.pairKey} host history stopped at ${new Date(fromTs - warm + result.failed * fillChunkMs).toISOString()} (${result.reason}); the engines start at the live tier`);
      }
    } finally {
      if (!replaced(state)) {
        if (state.fill.state === "reading") goLiveAt(state, Math.max(state.lastTs ?? -Infinity, state.coveredUntil ?? -Infinity, fromTs), state.lastTs ?? fromTs, "failed");
        setLoading(state, null);
      }
    }
  }

  async function runPass(state) {
    const from = state.asked;
    const to = state.coveredFrom;
    state.asked = null;
    if (from === null || to === null || from >= to) return;
    const warm = warmHours(state.shortLengths) * fillChunkMs;
    const after = afterHours(state.shortLengths) * fillChunkMs;
    let handed = 0;
    let end = to;
    setLoading(state, from);
    try {
      while (end > from) {
        const start = Math.max(from, end - PASS_CHUNK_MS);
        const trackers = makeTrackers(state.shortLengths, state.rowWidth);
        const result = await readSpan(state, start - warm, Math.min(end + after, state.liveSince ?? now()), (columns) => {
          const latest = new Map();
          for (const column of columns) {
            for (const tracker of trackers.values()) {
              for (const update of tracker.push(column)) if (FINAL.has(update.status) && update.startTs >= start && update.startTs < end) latest.set(update.id, update);
            }
          }
          if (latest.size > 0) handed += keepHostShades(state, [...latest.values()], now());
        });
        if (replaced(state)) return;
        if (result.failed !== null) {
          warn(`exhaustion indicator: ${state.pairKey} history pass stopped at ${new Date(start - warm + result.failed * fillChunkMs).toISOString()} (${result.reason}); covered back to ${new Date(end).toISOString()}`);
          return;
        }
        state.coveredFrom = start;
        touch(state);
        end = start;
      }
      info(`exhaustion indicator: ${state.pairKey} judged ${handed} shade(s) over the host's columns back to ${new Date(from).toISOString()}`);
    } finally {
      if (!replaced(state)) setLoading(state, null);
    }
  }

  function startPass(state) {
    fillRun = runPass(state)
      .catch((error) => {
        warn(`exhaustion indicator: ${state.pairKey} history pass failed`, { reason: error?.message ?? error });
      })
      .finally(() => {
        fillRun = null;
      });
  }

  function requestHistory(pair, fromTs) {
    if (stopped || !Number.isSafeInteger(fromTs) || fromTs < 0 || !pair || typeof pair.symbol !== "string" || typeof pair.marketKind !== "string") return false;
    const state = states.get(`${pair.marketKind}:${pair.symbol}`);
    if (!state || (state.fill.state !== "done" && state.fill.state !== "failed")) return false;
    const from = Math.max(fromTs, now() - maxAgeMs);
    const reach = Math.min(state.asked ?? Infinity, state.coveredFrom ?? Infinity);
    if (from >= reach) return false;
    state.asked = from;
    return true;
  }

  function startFill(state) {
    fillRun = runFill(state)
      .catch((error) => {
        warn(`exhaustion indicator: ${state.pairKey} host history failed`, { reason: error?.message ?? error });
        if (replaced(state)) return;
        if (state.fill.state !== "done" && state.fill.state !== "off" && state.fill.state !== "failed") goLiveAt(state, state.lastTs ?? state.coveredUntil, state.lastTs ?? state.coveredUntil, "failed");
        setLoading(state, null);
      })
      .finally(() => {
        fillRun = null;
      });
  }

  function prune(state, at) {
    const cutoff = at - maxAgeMs;
    for (const map of [state.live, state.stored]) for (const [id, shade] of map) if (shade.endTs < cutoff) map.delete(id);
    state.prunedAt = at;
  }

  function isLive(state) {
    return state.fill.state === "done" || state.fill.state === "failed" || state.fill.state === "off";
  }

  function coveredUntilOf(state) {
    if (!isLive(state)) return state.coveredUntil;
    return state.lastTs ?? state.coveredUntil;
  }

  function savePayload(state, at) {
    const shades = [...state.stored.values(), ...state.live.values()].filter((shade) => FINAL.has(shade.status)).sort(byStart).map(withoutOrigin);
    return { dir: storeDir, pairKey: state.pairKey, savedAt: at, rulesVersion: EXHAUSTION_RULES_VERSION, coveredUntil: coveredUntilOf(state), coveredFrom: state.coveredFrom, shades, scales: [...state.trackers.values()].filter((tracker) => !isShort(tracker.candleMs)).map((tracker) => tracker.toJSON()) };
  }

  function settleSave(state, result, taken) {
    state.saving = false;
    if (taken.generation !== generation) return;
    if (result.ok) {
      if (state.revision === taken.revision) state.dirty = false;
      return;
    }
    if (result.reason === "SUPERSEDED") return;
    warn(`exhaustion indicator: ${state.pairKey} history save failed`, { reason: result.reason, ...(result.bytes === undefined ? {} : { bytes: result.bytes }) });
  }

  function saveInBackground(state, at) {
    if (state.saving || !state.dirty) return;
    state.saving = true;
    state.savedAt = at;
    const taken = { generation, revision: state.revision };
    let pending;
    try {
      pending = Promise.resolve(saveHistory({ ...savePayload(state, at), superseded: () => generation !== taken.generation }));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then((result) => settleSave(state, result, taken), (error) => settleSave(state, { ok: false, reason: error?.message ?? String(error) }, taken));
  }

  function isActive(pair) {
    const active = activePair();
    return active !== null && active !== undefined && active.marketKind === pair.marketKind && active.symbol === pair.symbol;
  }

  function tick(pairs, at = now()) {
    if (stopped) return [];
    const emitted = [];
    const ordered = [...pairs].sort((a, b) => Number(isActive(b)) - Number(isActive(a)));
    for (const pair of ordered) {
      const geometry = geometryOf(pair);
      if (!geometry || !(geometry.rowWidth > 0)) continue;
      const state = stateFor(pair, geometry.rowWidth, at);
      if (state.fill.state === "waiting") {
        if (filling) {
          if (fillRun === null) startFill(state);
        } else {
          const ring = ringOf(state);
          if (ring !== null) startOff(state, ring);
        }
      }
      if (isLive(state)) {
        try {
          emitted.push(...feedLive(state, at));
        } catch (error) {
          warn(`exhaustion indicator: ${state.pairKey} rejected a column`, { reason: error?.message ?? error });
        }
      }
      if (at - state.prunedAt >= PRUNE_MS) prune(state, at);
      if (histories && state.dirty && at - state.savedAt >= storeMs) saveInBackground(state, at);
    }
    if (fillRun === null) {
      const next = ordered.map((pair) => states.get(pairKeyOf(pair))).find((state) => state !== undefined && isLive(state) && state.asked !== null);
      if (next) startPass(next);
    }
    return emitted;
  }

  function snapshot(pair, at = now()) {
    const state = states.get(pairKeyOf(pair));
    if (!state) return Object.freeze({ ts: at, shades: Object.freeze([]), liveSince: at, loading: null });
    const shades = [...state.stored.values(), ...state.live.values()].sort(byStart);
    return Object.freeze({ ts: at, shades: Object.freeze(shades), liveSince: liveSinceOf(state, at), loading: state.loading });
  }

  function idle() {
    return fillRun ?? Promise.resolve();
  }

  function start() {
    stopped = false;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    generation += 1;
    if (histories) {
      const at = now();
      for (const state of states.values()) {
        if (!state.dirty) continue;
        const result = saveHistorySync(savePayload(state, at));
        if (result.ok) state.dirty = false;
        else warn(`exhaustion indicator: ${state.pairKey} final history save failed`, { reason: result.reason });
      }
    }
    states.clear();
  }

  function stats() {
    const out = {};
    for (const [key, state] of states) {
      out[key] = Object.freeze({
        columns: state.columns,
        live: state.live.size,
        stored: state.stored.size,
        dirty: state.dirty,
        phase: isLive(state) ? "live" : "history",
        liveSince: state.liveSince,
        coveredUntil: coveredUntilOf(state),
        coveredFrom: state.coveredFrom,
        loading: state.loading,
        asked: state.asked,
        fill: Object.freeze({ ...state.fill }),
        trackers: Object.freeze(Object.fromEntries([...state.trackers].map(([candleMs, tracker]) => [candleMs, tracker.stats()]))),
      });
    }
    return Object.freeze(out);
  }

  return Object.freeze({ tick, snapshot, requestHistory, idle, start, stop, stats, get provider() { return provider; } });
}

function exhaustionOptionsFromEnv(env = process.env) {
  const options = {};
  if (env.L2_EXHAUSTION === "0") options.enabled = false;
  if (env.L2_EXHAUSTION === "1") options.enabled = true;
  if (env.L2_EXHAUSTION_HISTORY === "0") options.histories = false;
  if (env.L2_EXHAUSTION_HISTORY === "1") options.histories = true;
  if (env.L2_EXHAUSTION_HOST_FILL === "0") options.hostFill = false;
  if (env.L2_EXHAUSTION_HOST_FILL === "1") options.hostFill = true;
  if (typeof env.L2_EXHAUSTION_STORE_DIR === "string" && env.L2_EXHAUSTION_STORE_DIR.length > 0) options.storeDir = env.L2_EXHAUSTION_STORE_DIR;
  const storeS = Number(env.L2_EXHAUSTION_STORE_S);
  if (Number.isFinite(storeS) && storeS > 0) options.storeS = storeS;
  const maxAgeS = Number(env.L2_EXHAUSTION_MAX_AGE_S);
  if (Number.isFinite(maxAgeS) && maxAgeS > 0) options.maxAgeS = maxAgeS;
  const fillS = Number(env.L2_EXHAUSTION_FILL_S);
  if (Number.isFinite(fillS) && fillS > 0) options.fillS = fillS;
  const fillConcurrency = Number(env.L2_EXHAUSTION_FILL_CONCURRENCY);
  if (Number.isSafeInteger(fillConcurrency) && fillConcurrency > 0) options.fillConcurrency = fillConcurrency;
  return options;
}

module.exports = { createExhaustionIndicator, exhaustionOptionsFromEnv, lengthsFor, runStart, DEFAULT_STORE_S, DEFAULT_MAX_AGE_S, DEFAULT_FILL_S, DEFAULT_COLUMNS_PER_TICK, DEFAULT_MAX_SHADES, DEFAULT_FILL_CHUNK_MS, MIN_FILL_MS, PASS_CHUNK_MS };
