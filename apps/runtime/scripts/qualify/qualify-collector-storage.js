const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { monitorEventLoopDelay, performance } = require("node:perf_hooks");
const Database = require("better-sqlite3");
const { createStorageDb } = require("../../src/storage/storage-db");
const { createStorageWorkerClient } = require("../../src/storage/storage-worker-client");

const DEFAULT_EVENTS_PER_TUPLE = 20_000;
const DEFAULT_DEPTH_EVENTS = 2_000;
const DEFAULT_NOMINAL_EVENTS_PER_SECOND = 1_000;

function positiveInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`qualify-collector-storage: ${name} must be a positive safe integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    eventsPerTuple: DEFAULT_EVENTS_PER_TUPLE,
    depthEvents: DEFAULT_DEPTH_EVENTS,
    nominalEventsPerSecond: DEFAULT_NOMINAL_EVENTS_PER_SECOND,
    existingDb: null,
    keepSyntheticDb: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--events-per-tuple") options.eventsPerTuple = positiveInteger(arg, argv[++index]);
    else if (arg === "--depth-events") options.depthEvents = positiveInteger(arg, argv[++index]);
    else if (arg === "--nominal-events-per-second") {
      options.nominalEventsPerSecond = positiveInteger(arg, argv[++index]);
    } else if (arg === "--existing-db") {
      const pathname = argv[++index];
      if (typeof pathname !== "string" || pathname.length === 0) {
        throw new Error("qualify-collector-storage: --existing-db requires a file path");
      }
      options.existingDb = path.resolve(pathname);
      if (!fs.existsSync(options.existingDb) || !fs.statSync(options.existingDb).isFile()) {
        throw new Error("qualify-collector-storage: existing DB must be an existing file");
      }
    } else if (arg === "--keep-synthetic-db") options.keepSyntheticDb = true;
    else throw new Error(`qualify-collector-storage: unsupported argument ${arg}`);
  }
  return Object.freeze(options);
}

function inspectExistingDatabase(dbPath) {
  const startedAt = performance.now();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 2_000 });
  const openedAt = performance.now();
  try {
    const schema = db.prepare(
      "SELECT type, COUNT(*) AS count FROM sqlite_master WHERE type IN ('table', 'index') GROUP BY type",
    ).all();
    const latestSession = db.prepare(
      "SELECT started_at, ended_at, quality, clean_shutdown FROM capture_sessions ORDER BY started_at DESC LIMIT 1",
    ).get() ?? null;
    return Object.freeze({
      path: dbPath,
      databaseBytes: fs.statSync(dbPath).size,
      walBytes: fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`).size : 0,
      shmBytes: fs.existsSync(`${dbPath}-shm`) ? fs.statSync(`${dbPath}-shm`).size : 0,
      readOnlyOpenMs: Number((openedAt - startedAt).toFixed(1)),
      readOnlyInspectionMs: Number((performance.now() - startedAt).toFixed(1)),
      userVersion: db.pragma("user_version", { simple: true }),
      schemaVersion: db.prepare("SELECT version FROM storage_schema LIMIT 1").get()?.version ?? null,
      journalMode: db.pragma("journal_mode", { simple: true }),
      schema: Object.freeze(schema),
      latestSession: latestSession === null ? null : Object.freeze(latestSession),
    });
  } finally {
    db.close();
  }
}

function tradeRecord(tradeId, symbol, marketKind) {
  return {
    ts: 1_700_000_000_000 + tradeId,
    symbol,
    marketKind,
    price: "65000.00",
    size: "0.00100000",
    side: tradeId % 2 === 0 ? "buy" : "sell",
    tradeId: String(tradeId),
  };
}

function depthRecord(sequence, levelsJson) {
  return {
    ts: 1_700_000_000_000 + sequence,
    receivedAt: 1_700_000_000_001 + sequence,
    symbol: "BTCUSDT",
    marketKind: "SPOT",
    firstUpdateId: sequence,
    lastUpdateId: sequence,
    previousUpdateId: null,
    bids: levelsJson,
    asks: levelsJson,
  };
}

function removeDatabase(dbPath) {
  for (const suffix of ["", "-wal", "-shm", ".lock"]) {
    if (fs.existsSync(`${dbPath}${suffix}`)) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

async function runSyntheticQualification({ eventsPerTuple, depthEvents, nominalEventsPerSecond, keepSyntheticDb }) {
  const dbPath = path.join(
    os.tmpdir(),
    `terminal-collector-qualification-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  const tuples = [
    ["BTCUSDT", "SPOT"],
    ["ETHUSDT", "SPOT"],
    ["BTCUSDT", "PERPETUAL"],
    ["ETHUSDT", "PERPETUAL"],
  ];
  const expectedTrades = eventsPerTuple * tuples.length;
  const expectedTotal = expectedTrades + depthEvents;
  const levelsJson = JSON.stringify(Array.from({ length: 64 }, (_, index) => [String(65_000 - index), "0.125"]));
  const db = createStorageDb({ dbPath });
  db.close();
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const initialRss = process.memoryUsage().rss;
  let peakRss = initialRss;
  const memorySampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 10);
  const client = createStorageWorkerClient({
    dbPath,
    maxPendingItems: Math.max(100_000, expectedTotal + 1),
    maxPendingBytes: 512 * 1024 * 1024,
    maxBatchItems: 1_000,
    maxBatchBytes: 8 * 1024 * 1024,
    maxInFlightBatches: 2,
    batchFlushIntervalMs: 1,
  });

  try {
    const startupStartedAt = performance.now();
    await client.waitUntilReady();
    const startupMs = performance.now() - startupStartedAt;
    const startedAt = performance.now();
    for (let tradeId = 1; tradeId <= eventsPerTuple; tradeId += 1) {
      for (const [symbol, marketKind] of tuples) {
        client.push("trades", tradeRecord(tradeId, symbol, marketKind));
      }
      if (tradeId % 250 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    for (let sequence = 1; sequence <= depthEvents; sequence += 1) {
      client.push("l2_depth_events", depthRecord(sequence, levelsJson));
      if (sequence % 250 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    const shutdownStartedAt = performance.now();
    await client.stop();
    const shutdownMs = performance.now() - shutdownStartedAt;
    const elapsedMs = performance.now() - startedAt;
    clearInterval(memorySampler);
    eventLoop.disable();
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const stats = client.getStats();
    const verify = new Database(dbPath, { readonly: true, fileMustExist: true });
    let groups;
    let storedTrades;
    let storedDepthEvents;
    let quickCheck;
    try {
      groups = verify.prepare(
        "SELECT symbol, market_kind AS marketKind, COUNT(*) AS count FROM trades GROUP BY symbol, market_kind ORDER BY market_kind, symbol",
      ).all();
      storedTrades = verify.prepare("SELECT COUNT(*) AS count FROM trades").get().count;
      storedDepthEvents = verify.prepare("SELECT COUNT(*) AS count FROM l2_depth_events").get().count;
      quickCheck = verify.pragma("quick_check", { simple: true });
    } finally {
      verify.close();
    }
    const databaseBytes = fs.statSync(dbPath).size;
    const throughputEventsPerSecond = expectedTotal / (elapsedMs / 1_000);
    const bytesPerEvent = databaseBytes / expectedTotal;
    const capacityMultiple = throughputEventsPerSecond / nominalEventsPerSecond;
    const pass =
      stats.storageWrittenItems === expectedTotal &&
      stats.pendingWriteItems === 0 &&
      storedTrades === expectedTrades &&
      storedDepthEvents === depthEvents &&
      quickCheck === "ok" &&
      capacityMultiple >= 5 &&
      stats.storageAckP99Ms < 5_000 &&
      peakRss - initialRss < 1024 * 1024 * 1024;
    return Object.freeze({
      pass,
      dbPath: keepSyntheticDb ? dbPath : null,
      expectedTotal,
      storedTrades,
      storedDepthEvents,
      groups: Object.freeze(groups),
      elapsedMs: Number(elapsedMs.toFixed(1)),
      workerStartupMs: Number(startupMs.toFixed(1)),
      durableShutdownMs: Number(shutdownMs.toFixed(1)),
      throughputEventsPerSecond: Number(throughputEventsPerSecond.toFixed(1)),
      nominalEventsPerSecond,
      capacityMultiple: Number(capacityMultiple.toFixed(1)),
      eventLoopP99Ms: Number((eventLoop.percentile(99) / 1e6).toFixed(1)),
      eventLoopMaxMs: Number((eventLoop.max / 1e6).toFixed(1)),
      initialRssBytes: initialRss,
      peakRssBytes: peakRss,
      rssGrowthBytes: peakRss - initialRss,
      databaseBytes,
      walBytesAfterShutdown: fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`).size : 0,
      estimatedBytesPerEvent: Number(bytesPerEvent.toFixed(1)),
      estimatedGrowthPerHourBytes: Math.round(bytesPerEvent * nominalEventsPerSecond * 3_600),
      estimatedGrowthPerDayBytes: Math.round(bytesPerEvent * nominalEventsPerSecond * 86_400),
      quickCheck,
      storage: stats,
    });
  } finally {
    clearInterval(memorySampler);
    eventLoop.disable();
    if (client.getStats().storageWorkerState !== "STOPPED") {
      await client.stop().catch(() => {});
    }
    if (!keepSyntheticDb) removeDatabase(dbPath);
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = {
    generatedAt: new Date().toISOString(),
    existingDatabase: options.existingDb ? inspectExistingDatabase(options.existingDb) : null,
    synthetic: await runSyntheticQualification(options),
  };
  console.log(JSON.stringify(report, null, 2));
  return report.synthetic.pass ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  parseArgs,
  inspectExistingDatabase,
  runSyntheticQualification,
  main,
  DEFAULT_EVENTS_PER_TUPLE,
  DEFAULT_DEPTH_EVENTS,
  DEFAULT_NOMINAL_EVENTS_PER_SECOND,
};
