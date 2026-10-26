const { createNativeIcebergTracker } = require("./native-iceberg-tracker");
const { createProbableIcebergTracker, DEFAULT_GAP_MS } = require("./probable-iceberg-tracker");
const { createLearnedCuts, DEFAULT_LEARNED_CUTS } = require("./learned-cuts");
const { createIcebergHistory, wireIcebergOf, validWireIceberg } = require("./iceberg-history");
const { saveIcebergHistory, saveIcebergHistoryAsync, loadIcebergHistory, defaultStoreDir } = require("./iceberg-store");
const { createIcebergHostFill } = require("./iceberg-host-fill");
const { createRemoteStorageReader } = require("../../storage/remote-storage-reader");
const { sizeCeilingFor } = require("../../server/wire-fields");
const { MAX_RETAINED_DEPTH_LEVELS } = require("../../providers/binance/binance-book-assembler");

const PROVIDERS = new Set(["BINANCE", "DXFEED"]);
const DEFAULT_STORE_S = 300;
const WATCH_GAP_MS = 30_000;
const DEFAULT_HOST_FILL_DELAY_MS = 120_000;
const DEFAULT_HOST_FILL_EVERY_MS = 1_800_000;
const DEFAULT_LIVE_REACH_MS = 14_400_000;
const DEFAULT_MAX_AGE_S = 7 * 86_400;
const DEFAULT_PRUNE_MS = 60_000;
const ACTIVE = "active";

function pairKeyOf(pair) {
  if (!pair || typeof pair.symbol !== "string" || pair.symbol.length === 0 || typeof pair.marketKind !== "string" || pair.marketKind.length === 0) {
    throw new Error("iceberg-indicator: pair must carry a symbol and a marketKind");
  }
  return `${pair.marketKind}:${pair.symbol}`;
}

function byMark(a, b) {
  return a.markedAt - b.markedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function positiveNumber(name, value) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`iceberg-indicator: ${name} must be a positive number`);
  return value;
}

function createIcebergIndicator({
  provider,
  enabled = true,
  now = () => Date.now(),
  log = console,
  histories = true,
  storeDir = defaultStoreDir(),
  storeS = DEFAULT_STORE_S,
  maxAgeS = DEFAULT_MAX_AGE_S,
  maxIcebergs,
  maxBytes,
  cuts = {},
  gapMs = DEFAULT_GAP_MS,
  watchGapMs = WATCH_GAP_MS,
  cutsFactory = (options) => createLearnedCuts(options),
  saveHistory = saveIcebergHistoryAsync,
  saveHistorySync = saveIcebergHistory,
  loadHistory = loadIcebergHistory,
  publish = () => {},
  host = null,
  hostFill = null,
  hostFillDelayMs = DEFAULT_HOST_FILL_DELAY_MS,
  hostFillEveryMs = DEFAULT_HOST_FILL_EVERY_MS,
  liveReachMs = DEFAULT_LIVE_REACH_MS,
  createRemoteReader = createRemoteStorageReader,
  createHostFill = createIcebergHostFill,
} = {}) {
  if (!PROVIDERS.has(provider)) throw new Error("iceberg-indicator: provider must be BINANCE or DXFEED");
  if (typeof enabled !== "boolean") throw new Error("iceberg-indicator: enabled must be a boolean");
  if (typeof publish !== "function") throw new Error("iceberg-indicator: publish must be a function");
  if (typeof storeDir !== "string" || storeDir.length === 0) throw new Error("iceberg-indicator: storeDir must be a non-empty string");
  const storeMs = Math.max(1000, Math.round(positiveNumber("storeS", storeS) * 1000));
  const maxAgeMs = Math.round(positiveNumber("maxAgeS", maxAgeS) * 1000);
  if (!Number.isSafeInteger(watchGapMs) || watchGapMs <= 0) throw new Error("iceberg-indicator: watchGapMs must be a positive safe integer");
  for (const [name, value] of [["hostFillDelayMs", hostFillDelayMs], ["hostFillEveryMs", hostFillEveryMs], ["liveReachMs", liveReachMs]]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`iceberg-indicator: ${name} must be a non-negative safe integer`);
  }
  if (host !== null && (typeof host.baseUrl !== "string" || host.baseUrl.length === 0 || typeof host.token !== "string" || host.token.length === 0)) throw new Error("iceberg-indicator: host needs a baseUrl and a token");
  const startedAt = now();
  if (!Number.isSafeInteger(liveReachMs) || liveReachMs <= 0) throw new Error("iceberg indicator: liveReachMs must be a positive safe integer");
  const liveSinceAt = (at) => Math.max(0, at - liveReachMs);
  const minProbableRatio = cuts.minRatio ?? DEFAULT_LEARNED_CUTS.minRatio;
  const states = new Map();
  let stopped = false;
  let generation = 0;

  function warn(message, detail) {
    if (typeof log.warn === "function") log.warn(message, detail);
  }

  let hostReader = null;
  let fill = hostFill;
  if (fill === null && host !== null && histories && enabled) {
    hostReader = createRemoteReader({ baseUrl: host.baseUrl, token: host.token, log: (...args) => warn(args.join(" ")), warn: (...args) => warn(args.join(" ")) });
    fill = createHostFill({ read: (fillProvider, symbol, marketKind, options) => hostReader.readIcebergHistory(symbol, marketKind, options, { provider: fillProvider }), now, log: (message) => warn(message) });
  }

  function noteFillReasons(state, outcome) {
    const counts = new Map();
    for (const reason of outcome.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
    const reasons = [...counts.keys()].sort();
    const changed = JSON.stringify(reasons) !== JSON.stringify(Object.keys(state.hostReasons).sort());
    state.hostReasons = Object.freeze(Object.fromEntries(counts));
    if (!changed) return;
    if (reasons.length === 0) {
      if (typeof log.info === "function") log.info(`iceberg indicator: ${state.pairKey} host fill answered every gap`);
      return;
    }
    warn(`iceberg indicator: ${state.pairKey} host fill left ${outcome.reasons.length} of ${outcome.gaps} gap(s) unfilled: ${reasons.map((reason) => `${reason} ${counts.get(reason)}`).join(", ")}`);
  }

  async function runFill(state) {
    state.filling = true;
    try {
      const outcome = await fill.fill({ provider: provider.toLowerCase(), symbol: state.pair.symbol, marketKind: state.pair.marketKind, history: state.history });
      state.fills += 1;
      const at = now();
      state.filledAt = at;
      noteFillReasons(state, outcome);
      if (outcome.icebergs.length > 0) {
        publish([...outcome.icebergs].sort(byMark), state.pair, at, state.history.coverage(), liveSinceAt(at));
        if (typeof log.info === "function") log.info(`iceberg indicator: ${state.pairKey} took ${outcome.icebergs.length} iceberg(s) from the host over ${outcome.watched.length} span(s)`);
      }
    } catch (error) {
      state.filledAt = now();
      warn(`iceberg indicator: ${state.pairKey} host fill failed`, { reason: error?.message ?? error });
    } finally {
      state.filling = false;
    }
  }

  function fillDue(state, at) {
    if (!histories || fill === null || stopped || state.filling) return false;
    return state.filledAt === null ? at - startedAt >= hostFillDelayMs : at - state.filledAt >= hostFillEveryMs;
  }

  function restore(state, at) {
    const saved = loadHistory({ dir: storeDir, pairKey: state.pairKey, onReject: (reason) => warn(`iceberg indicator: ${state.pairKey} history file rejected (${reason}); starting empty`) });
    if (!saved) return;
    if (!state.history.loadCoverage(saved.coverage)) warn(`iceberg indicator: ${state.pairKey} saved coverage rejected; starting unwatched`);
    if (!state.history.load(saved.history)) {
      state.history.loadCoverage([]);
      warn(`iceberg indicator: ${state.pairKey} history did not load; starting empty`);
    }
    const thin = state.history.stats().belowFloor;
    if (thin > 0) warn(`iceberg indicator: ${state.pairKey} dropped ${thin} saved probable iceberg(s) under the ratio floor`);
    if (saved.cuts !== null && state.cuts !== null) {
      if (state.cuts.load(saved.cuts)) state.cutsSavedVersion = state.cuts.version;
      else warn(`iceberg indicator: ${state.pairKey} saved cuts rejected; learning afresh`);
    }
    state.history.prune(at);
    state.savedAt = at;
  }

  function stateFor(pair) {
    const pairKey = pairKeyOf(pair);
    let state = states.get(pairKey);
    if (state) return state;
    const at = now();
    const learned = provider === "DXFEED" ? null : cutsFactory(cuts);
    const tracker = provider === "DXFEED"
      ? createNativeIcebergTracker({ symbol: pair.symbol })
      : createProbableIcebergTracker({ symbol: pair.symbol, marketKind: pair.marketKind, cuts: learned, gapMs, ...(MAX_RETAINED_DEPTH_LEVELS[pair.marketKind] === undefined ? {} : { maxLevels: 2 * MAX_RETAINED_DEPTH_LEVELS[pair.marketKind] }) });
    state = {
      pair: Object.freeze({ symbol: pair.symbol, marketKind: pair.marketKind }),
      pairKey,
      tracker,
      cuts: learned !== null && typeof learned.toJSON === "function" && typeof learned.load === "function" ? learned : null,
      cutsSavedVersion: -1,
      history: createIcebergHistory({ maxAgeMs, minProbableRatio, sizeCeiling: sizeCeilingFor({ provider, assetClass: pair.marketKind }), ...(maxIcebergs === undefined ? {} : { maxIcebergs }), ...(maxBytes === undefined ? {} : { maxBytes }) }),
      savedAt: at,
      prunedAt: at,
      saving: false,
      refused: 0,
      eventTs: null,
      seenAt: null,
      runFrom: null,
      depthDown: false,
      filledAt: null,
      filling: false,
      fills: 0,
      hostReasons: Object.freeze({}),
    };
    if (histories) restore(state, at);
    states.set(pairKey, state);
    return state;
  }

  function noteEvent(state, ts) {
    if (state.runFrom === null) {
      state.runFrom = ts;
      state.eventTs = ts;
    } else if (ts > state.eventTs) {
      state.eventTs = ts;
    }
    state.seenAt = now();
  }

  function watchTick(state, at) {
    if (state.seenAt !== null && at - state.seenAt <= watchGapMs) {
      if (state.runFrom !== null && state.eventTs > state.runFrom) state.history.watch(state.runFrom, state.eventTs);
      return;
    }
    state.runFrom = null;
  }

  function earliestOpenMark(state) {
    let earliest = Number.POSITIVE_INFINITY;
    for (const update of state.tracker.active()) {
      const { markedAt } = wireIcebergOf(update);
      if (markedAt < earliest) earliest = markedAt;
    }
    return earliest;
  }

  function emit(state, updates, at) {
    if (updates.length === 0) return [];
    const latest = new Map();
    for (const update of updates) latest.set(update.id, wireIcebergOf(update));
    const all = [...latest.values()];
    const wire = all.filter((entry) => validWireIceberg(entry, state.history.sizeCeiling)).sort(byMark);
    if (wire.length < all.length) {
      state.refused += all.length - wire.length;
      warn(`iceberg indicator: ${state.pairKey} refused ${all.length - wire.length} invalid iceberg update(s)`);
    }
    if (wire.length === 0) return [];
    for (const entry of wire) if (entry.status !== ACTIVE) state.history.record(entry);
    publish(wire, state.pair, at, state.history.coverage(), liveSinceAt(at));
    return wire;
  }

  function requireProvider(expected, method) {
    if (provider !== expected) throw new Error(`iceberg-indicator: ${method} is for the ${expected} provider`);
  }

  function onNativeEvents(pair, events, { snapshot = false, receivedAt } = {}) {
    requireProvider("DXFEED", "onNativeEvents");
    if (stopped || !enabled) return [];
    const state = stateFor(pair);
    const at = receivedAt ?? now();
    noteEvent(state, at);
    const updates = snapshot ? [...state.tracker.reset(at)] : [];
    for (const event of events) {
      const update = state.tracker.apply(event, at);
      if (update) updates.push(update);
    }
    return emit(state, updates, at);
  }

  function onNativeUnavailable(pair, receivedAt) {
    requireProvider("DXFEED", "onNativeUnavailable");
    if (stopped || !enabled) return [];
    const state = stateFor(pair);
    const at = receivedAt ?? now();
    return emit(state, [...state.tracker.reset(at)], at);
  }

  function onDepthUnavailable(pair, receivedAt) {
    requireProvider("BINANCE", "onDepthUnavailable");
    if (stopped || !enabled) return [];
    const state = stateFor(pair);
    state.depthDown = true;
    state.runFrom = null;
    const at = receivedAt ?? now();
    return emit(state, [...state.tracker.reset(at)], at);
  }

  function onDepth(pair, entries, ts) {
    requireProvider("BINANCE", "onDepth");
    if (stopped || !enabled) return [];
    const state = stateFor(pair);
    state.depthDown = false;
    if (entries.length > 0) noteEvent(state, ts);
    const updates = [];
    for (const [side, price, size] of entries) {
      const update = state.tracker.applyDepth({ side, price, size, ts });
      if (update) updates.push(update);
    }
    return emit(state, updates, ts);
  }

  function onTrade(pair, { price, size, aggressor, ts }) {
    requireProvider("BINANCE", "onTrade");
    if (stopped || !enabled) return [];
    const state = stateFor(pair);
    if (state.depthDown) return [];
    noteEvent(state, ts);
    const update = state.tracker.applyTrade({ price, size, aggressor, ts });
    return update ? emit(state, [update], ts) : [];
  }

  function unsaved(state) {
    return state.history.dirty || (state.cuts !== null && state.cuts.version !== state.cutsSavedVersion);
  }

  function savePayload(state, at) {
    return { dir: storeDir, pairKey: state.pairKey, savedAt: at, history: state.history.toJSON(), cuts: state.cuts === null ? null : state.cuts.toJSON(), coverage: state.history.coverageUntil(Math.min(at, earliestOpenMark(state))), maxBytes: state.history.maxBytes };
  }

  function settleSave(state, result, taken) {
    state.saving = false;
    if (taken.generation !== generation) return;
    if (result.ok) {
      if (state.history.revision === taken.revision) state.history.markSaved();
      state.cutsSavedVersion = taken.cutsVersion;
      return;
    }
    if (result.reason === "OVER_BUDGET") {
      const dropped = state.history.trimToBytes(state.history.maxBytes);
      warn(`iceberg indicator: ${state.pairKey} history over budget; dropped ${dropped} oldest`, { bytes: result.bytes });
      return;
    }
    warn(`iceberg indicator: ${state.pairKey} history save failed`, { reason: result.reason });
  }

  function saveInBackground(state, at) {
    if (state.saving || !unsaved(state)) return;
    state.saving = true;
    state.savedAt = at;
    const taken = { generation, revision: state.history.revision, cutsVersion: state.cuts === null ? -1 : state.cuts.version };
    let pending;
    try {
      pending = Promise.resolve(saveHistory({ ...savePayload(state, at), superseded: () => generation !== taken.generation }));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then((result) => settleSave(state, result, taken), (error) => settleSave(state, { ok: false, reason: error?.message ?? String(error) }, taken));
  }

  function tick(at = now()) {
    if (stopped) return [];
    const emitted = [];
    for (const state of states.values()) {
      watchTick(state, at);
      if (provider === "BINANCE" && state.eventTs !== null) emitted.push(...emit(state, [...state.tracker.sweep(state.eventTs + Math.max(0, at - state.seenAt))], at));
      if (at - state.prunedAt >= DEFAULT_PRUNE_MS) {
        state.history.prune(at);
        state.prunedAt = at;
      }
      if (histories && at - state.savedAt >= storeMs) saveInBackground(state, at);
      if (fillDue(state, at)) void runFill(state);
    }
    return emitted;
  }

  function snapshot(pair, at = now()) {
    if (!enabled) return Object.freeze({ ts: at, icebergs: Object.freeze([]), watched: Object.freeze([]), liveSince: liveSinceAt(at) });
    const state = stateFor(pair);
    const all = [...state.history.list(), ...state.tracker.active().map(wireIcebergOf)];
    const icebergs = all.filter((entry) => validWireIceberg(entry, state.history.sizeCeiling)).sort(byMark);
    if (icebergs.length < all.length) warn(`iceberg indicator: ${state.pairKey} snapshot left out ${all.length - icebergs.length} invalid iceberg(s)`);
    return Object.freeze({ ts: at, icebergs: Object.freeze(icebergs), watched: state.history.coverage(), liveSince: liveSinceAt(at) });
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
        watchTick(state, at);
        if (!unsaved(state)) continue;
        const result = saveHistorySync(savePayload(state, at));
        if (result.ok) state.history.markSaved();
        else warn(`iceberg indicator: ${state.pairKey} final history save failed`, { reason: result.reason });
      }
    }
    states.clear();
    hostReader?.close();
  }

  function stats() {
    const out = {};
    for (const [key, state] of states) {
      out[key] = Object.freeze({ active: state.tracker.active().length, settled: state.history.size, dirty: state.history.dirty, refused: state.refused, hostFills: state.fills, hostReasons: state.hostReasons, ...(provider === "DXFEED" ? { openLives: state.tracker.openLives() } : { openEpisodes: state.tracker.openEpisodes(), trackedLevels: state.tracker.trackedLevels() }) });
    }
    if (fill !== null) out.hostFill = Object.freeze(fill.stats());
    return Object.freeze(out);
  }

  return Object.freeze({ onNativeEvents, onNativeUnavailable, onDepth, onDepthUnavailable, onTrade, tick, snapshot, start, stop, stats, get provider() { return provider; } });
}

function icebergOptionsFromEnv(env = process.env) {
  const options = {};
  if (env.L2_ICEBERG === "0") options.enabled = false;
  if (env.L2_ICEBERG === "1") options.enabled = true;
  if (env.L2_ICEBERG_HISTORY === "0") options.histories = false;
  if (env.L2_ICEBERG_HISTORY === "1") options.histories = true;
  if (typeof env.L2_ICEBERG_STORE_DIR === "string" && env.L2_ICEBERG_STORE_DIR.length > 0) options.storeDir = env.L2_ICEBERG_STORE_DIR;
  const storeS = Number(env.L2_ICEBERG_STORE_S);
  if (Number.isFinite(storeS) && storeS > 0) options.storeS = storeS;
  const maxAgeS = Number(env.L2_ICEBERG_MAX_AGE_S);
  if (Number.isFinite(maxAgeS) && maxAgeS > 0) options.maxAgeS = maxAgeS;
  if (env.L2_ICEBERG_HOST_FILL !== "0" && typeof env.TT_LIVE_STORAGE_SERVICE_URL === "string" && env.TT_LIVE_STORAGE_SERVICE_URL.length > 0 &&
      typeof env.TT_LIVE_STORAGE_CLIENT_TOKEN === "string" && env.TT_LIVE_STORAGE_CLIENT_TOKEN.length > 0) {
    options.host = { baseUrl: env.TT_LIVE_STORAGE_SERVICE_URL, token: env.TT_LIVE_STORAGE_CLIENT_TOKEN };
  }
  const fillDelayS = Number(env.L2_ICEBERG_FILL_DELAY_S);
  if (Number.isFinite(fillDelayS) && fillDelayS >= 0) options.hostFillDelayMs = Math.round(fillDelayS * 1000);
  const fillEveryS = Number(env.L2_ICEBERG_FILL_EVERY_S);
  if (Number.isFinite(fillEveryS) && fillEveryS > 0) options.hostFillEveryMs = Math.round(fillEveryS * 1000);
  return options;
}

module.exports = { createIcebergIndicator, icebergOptionsFromEnv, DEFAULT_STORE_S, DEFAULT_MAX_AGE_S, WATCH_GAP_MS, DEFAULT_HOST_FILL_DELAY_MS, DEFAULT_HOST_FILL_EVERY_MS, DEFAULT_LIVE_REACH_MS };
