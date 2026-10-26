const fs = require("node:fs");
const path = require("node:path");
const { dataRoot } = require("../../platform/runtime-paths");
const { DEFAULT_DB_PATH } = require("../../storage/storage-db");
const { DEFAULT_DB_PATH: DEFAULT_DXFEED_DB_PATH } = require("../../storage/dxfeed/dxfeed-storage-db");
const { openIcebergHostStore } = require("./iceberg-host-store");
const { createIcebergHostBuilder, createCaptureBounds, DEFAULT_RETENTION_MS, DEFAULT_WARMUP_MS } = require("./iceberg-host-builder");

const DEFAULT_CYCLE_MS = 60_000;
const DEFAULT_CHUNKS_PER_CYCLE = 12;
const STATUS_FILE = "status.json";
const DAY_MS = 86_400_000;
const WAITING_REASONS = new Set(["NO_CAPTURE", "CAPTURE_UNREADABLE"]);

function defaultIcebergDir() {
  return path.join(dataRoot(), "iceberg-history");
}

function positiveNumber(raw) {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n > 0 ? n : undefined;
}

function icebergHostOptionsFromEnv(env = process.env) {
  const days = positiveNumber(env.TT_ICEBERG_RETENTION_DAYS);
  const warmupHours = positiveNumber(env.TT_ICEBERG_WARMUP_HOURS);
  const cycleMs = positiveNumber(env.TT_ICEBERG_CYCLE_MS);
  const perCycle = positiveNumber(env.TT_ICEBERG_CHUNKS_PER_CYCLE);
  return {
    enabled: env.TT_ICEBERG_HISTORY !== "0",
    dir: typeof env.TT_ICEBERG_DIR === "string" && env.TT_ICEBERG_DIR.length > 0 ? env.TT_ICEBERG_DIR : defaultIcebergDir(),
    dbPaths: {
      binance: env.TT_ICEBERG_BINANCE_DB_PATH || DEFAULT_DB_PATH,
      dxfeed: env.TT_ICEBERG_DXFEED_DB_PATH || DEFAULT_DXFEED_DB_PATH,
    },
    retentionMs: days === undefined ? DEFAULT_RETENTION_MS : Math.round(days * DAY_MS),
    warmupMs: { binance: warmupHours === undefined ? DEFAULT_WARMUP_MS.binance : Math.round(warmupHours * 3_600_000), dxfeed: DEFAULT_WARMUP_MS.dxfeed },
    cycleMs: cycleMs === undefined ? DEFAULT_CYCLE_MS : Math.round(cycleMs),
    chunksPerCycle: perCycle === undefined ? DEFAULT_CHUNKS_PER_CYCLE : Math.round(perCycle),
    pairFilter: typeof env.TT_ICEBERG_PAIRS === "string" && env.TT_ICEBERG_PAIRS.trim() !== "" ? new Set(env.TT_ICEBERG_PAIRS.split(",").map((key) => key.trim()).filter(Boolean)) : null,
  };
}

function pairKeyOf(pair) {
  return `${pair.provider}:${pair.marketKind}:${pair.symbol}`;
}

function icebergHostPairs({ catalog, pairFilter = null }) {
  const pairs = [];
  for (const entry of catalog.binance ?? []) pairs.push(Object.freeze({ provider: "binance", marketKind: entry.marketKind, symbol: entry.symbol.replace("-", "") }));
  for (const entry of catalog.dxfeed ?? []) pairs.push(Object.freeze({ provider: "dxfeed", marketKind: entry.assetClass, symbol: entry.symbol }));
  return pairFilter === null ? pairs : pairs.filter((pair) => pairFilter.has(pairKeyOf(pair)));
}

function writeStatus(dir, status) {
  const file = path.join(dir, STATUS_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(status, null, 2));
  fs.renameSync(temporary, file);
}

function createIcebergHostService({
  catalog,
  options,
  now = () => Date.now(),
  openStore = openIcebergHostStore,
  createBuilder = createIcebergHostBuilder,
  captureBoundsFor = createCaptureBounds,
  log = () => {},
} = {}) {
  if (!options || typeof options.dir !== "string" || options.dir.length === 0) throw new Error("iceberg-host-service: options.dir is required");
  if (!options.dbPaths || typeof options.dbPaths.binance !== "string" || typeof options.dbPaths.dxfeed !== "string") throw new Error("iceberg-host-service: options.dbPaths.binance and dbPaths.dxfeed are required");
  if (!Number.isSafeInteger(options.chunksPerCycle) || options.chunksPerCycle <= 0) throw new Error("iceberg-host-service: options.chunksPerCycle must be a positive integer");
  const pairs = icebergHostPairs({ catalog, pairFilter: options.pairFilter ?? null });
  const bounds = captureBoundsFor({ dbPaths: options.dbPaths, log });
  const entries = new Map();
  const status = { startedAt: now(), updatedAt: null, pairs: {} };
  let stopping = false;
  let wake = null;

  function pause(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });
  }

  function entryFor(pair) {
    const key = pairKeyOf(pair);
    let entry = entries.get(key);
    if (entry !== undefined) return entry;
    const store = openStore({ dir: options.dir, pairKey: key });
    const builder = createBuilder({
      store, pair, dbPath: options.dbPaths[pair.provider], retentionMs: options.retentionMs, warmupMs: options.warmupMs[pair.provider],
      captureBounds: (wanted) => bounds.of(pair, wanted), now, log,
    });
    entry = { key, store, builder, prunedAt: 0 };
    entries.set(key, entry);
    return entry;
  }

  function* runPair(pair) {
    const key = pairKeyOf(pair);
    try {
      const entry = entryFor(pair);
      const at = now();
      if (at - entry.prunedAt >= DEFAULT_CYCLE_MS) {
        entry.store.prune(at - options.retentionMs);
        entry.prunedAt = at;
      }
      let built = 0;
      let settled = 0;
      let last = null;
      for (let i = 0; i < options.chunksPerCycle && !stopping; i += 1) {
        last = entry.builder.runChunk();
        if (!last.built) break;
        built += 1;
        settled += last.settled;
        yield;
      }
      const stats = entry.store.stats();
      status.pairs[key] = { state: last === null || last.built ? "RUNNING" : WAITING_REASONS.has(last.reason) ? "WAITING" : "RUNNING", reason: last !== null && !last.built ? last.reason : null, cursor: stats.cursor, settledThrough: stats.settledThrough, icebergs: stats.icebergs, gaps: stats.gaps, droppedGaps: entry.builder.droppedGaps, chunks: built, settled, at };
      if (built > 0) log(`iceberg-history: ${key} built ${built} chunk(s) to ${new Date(stats.cursor).toISOString()}, ${settled} settled, ${stats.icebergs} held`);
      return built;
    } catch (error) {
      status.pairs[key] = { state: "ERROR", reason: String(error?.message ?? error).slice(0, 300), at: now() };
      log(`iceberg-history: ${key} failed: ${error?.message ?? error}`);
      return 0;
    }
  }

  function* cycle() {
    let built = 0;
    for (const pair of pairs) {
      if (stopping) break;
      built += yield* runPair(pair);
    }
    status.updatedAt = now();
    try {
      writeStatus(options.dir, status);
    } catch (error) {
      log(`iceberg-history: could not write the status file: ${error?.message ?? error}`);
    }
    return built;
  }

  function runOnce() {
    const steps = cycle();
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }

  async function run() {
    fs.mkdirSync(options.dir, { recursive: true });
    while (!stopping) {
      const steps = cycle();
      let step = steps.next();
      while (!step.done) {
        await new Promise((resolve) => setImmediate(resolve));
        step = steps.next();
      }
      if (step.value === 0 && !stopping) await pause(options.cycleMs ?? DEFAULT_CYCLE_MS);
    }
  }

  function stop() {
    stopping = true;
    wake?.();
  }

  function close() {
    for (const entry of entries.values()) {
      entry.builder.close();
      entry.store.close();
    }
    entries.clear();
    bounds.close();
  }

  return Object.freeze({ pairs, runOnce, run, stop, close, status: () => status });
}

module.exports = { createIcebergHostService, icebergHostOptionsFromEnv, icebergHostPairs, pairKeyOf, defaultIcebergDir, STATUS_FILE, DEFAULT_CYCLE_MS, DEFAULT_CHUNKS_PER_CYCLE };
