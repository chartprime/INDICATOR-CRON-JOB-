#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { monitorEventLoopDelay, performance } = require("node:perf_hooks");
const Database = require("better-sqlite3");
const { createDxFeedStorageService } = require("../../src/storage/dxfeed/dxfeed-storage-service");
const { listCollectorInstruments } = require("../../src/providers/dxfeed/dxfeed-instrument-catalog");

const DEFAULT_EVENTS_PER_INSTRUMENT = 5_000;
const DEFAULT_BATCH_SEQUENCES = 100;
const DEFAULT_NOMINAL_EVENTS_PER_SECOND = 1_000;
const MAX_BATCH_SEQUENCES = 125;

function positiveInteger(name, value, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`qualify-dxfeed-storage: ${name} must be a positive safe integer no greater than ${max}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    eventsPerInstrument: DEFAULT_EVENTS_PER_INSTRUMENT,
    batchSequences: DEFAULT_BATCH_SEQUENCES,
    nominalEventsPerSecond: DEFAULT_NOMINAL_EVENTS_PER_SECOND,
    existingDb: null,
    keepSyntheticDb: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--events-per-instrument") options.eventsPerInstrument = positiveInteger(arg, argv[++index]);
    else if (arg === "--batch-sequences") {
      options.batchSequences = positiveInteger(arg, argv[++index], { max: MAX_BATCH_SEQUENCES });
    } else if (arg === "--nominal-events-per-second") {
      options.nominalEventsPerSecond = positiveInteger(arg, argv[++index]);
    } else if (arg === "--existing-db") {
      const pathname = argv[++index];
      if (typeof pathname !== "string" || pathname.length === 0) {
        throw new Error("qualify-dxfeed-storage: --existing-db requires a file path");
      }
      options.existingDb = path.resolve(pathname);
      if (!fs.existsSync(options.existingDb) || !fs.statSync(options.existingDb).isFile()) {
        throw new Error("qualify-dxfeed-storage: existing DB must be an existing file");
      }
    } else if (arg === "--keep-synthetic-db") options.keepSyntheticDb = true;
    else throw new Error(`qualify-dxfeed-storage: unsupported argument ${arg}`);
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
      "SELECT started_at, ended_at, quality, clean_shutdown FROM dxfeed_capture_sessions ORDER BY started_at DESC LIMIT 1",
    ).get() ?? null;
    return Object.freeze({
      path: dbPath,
      databaseBytes: fs.statSync(dbPath).size,
      walBytes: fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`).size : 0,
      shmBytes: fs.existsSync(`${dbPath}-shm`) ? fs.statSync(`${dbPath}-shm`).size : 0,
      readOnlyOpenMs: Number((openedAt - startedAt).toFixed(1)),
      readOnlyInspectionMs: Number((performance.now() - startedAt).toFixed(1)),
      schemaVersion: db.prepare("SELECT version FROM dxfeed_storage_schema LIMIT 1").get()?.version ?? null,
      journalMode: db.pragma("journal_mode", { simple: true }),
      schema: Object.freeze(schema),
      latestSession: latestSession === null ? null : Object.freeze(latestSession),
    });
  } finally {
    db.close();
  }
}

function venueFor(instrument) {
  if (instrument.assetClass === "EQUITY") return null;
  return instrument.symbol.slice(instrument.symbol.lastIndexOf(":") + 1);
}

function envelopeBase(instrument, eventType, eventTime) {
  return {
    provider: "DXFEED",
    venue: venueFor(instrument),
    assetClass: instrument.assetClass,
    providerSymbol: instrument.symbol,
    eventType,
    eventTime: new Date(eventTime).toISOString(),
    receivedAt: new Date(eventTime + 1).toISOString(),
    timingClass: "REALTIME",
    stale: false,
    recoveryState: "READY",
  };
}

const ORDER_V2_WRITES_PER_SEQUENCE = 1;

function canonicalEnvelopes(instrument, sequence) {
  const eventTime = 1_800_000_000_000 + sequence;
  const basePrice = instrument.assetClass === "FUTURE" ? 20_000 : 250;
  const price = basePrice + (sequence % 100) * 0.25;
  return [
    {
      ...envelopeBase(instrument, "QUOTE", eventTime),
      payload: {
        bidPrice: price - 0.25, bidSize: 2, bidTime: eventTime, bidExchangeCode: "Q",
        askPrice: price + 0.25, askSize: 3, askTime: eventTime, askExchangeCode: "Q",
      },
    },
    {
      ...envelopeBase(instrument, "TRADE", eventTime),
      payload: {
        price, size: 1 + sequence % 5, time: eventTime, exchangeCode: "T", change: 0,
        dayVolume: sequence, dayTurnover: sequence * price, tickDirection: "ZERO_UP",
        extendedTradingHours: false,
      },
    },
    {
      ...envelopeBase(instrument, "TIMEANDSALE", eventTime),
      payload: {
        price, size: 1 + sequence % 5, time: eventTime, timeNanoPart: 0, sequence,
        exchangeCode: "T", extendedTradingHours: false,
        aggressorSide: sequence % 2 === 0 ? "BUY" : "SELL", spreadLeg: false,
        validTick: true, type: "NEW", index: sequence, tradeId: sequence,
      },
    },
  ];
}

function orderV2Envelope(instrument, sequence) {
  const eventTime = 1_800_000_000_000 + sequence;
  const price = (instrument.assetClass === "FUTURE" ? 20_000 : 250) + (sequence % 100) * 0.25;
  return {
    ...envelopeBase(instrument, "ORDER", eventTime),
    payload: {
      index: String(sequence), eventFlags: 0, time: eventTime, action: "NEW", actionTime: eventTime,
      orderId: sequence, price, size: 1 + sequence % 5,
      side: sequence % 2 === 0 ? "BUY" : "SELL", scope: "ORDER", source: instrument.orderSource,
    },
  };
}

function percentile(values, percentileValue) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1)];
}

function removeDatabase(dbPath) {
  for (const suffix of ["", "-wal", "-shm", ".lock"]) {
    if (fs.existsSync(`${dbPath}${suffix}`)) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

async function runSyntheticQualification({
  eventsPerInstrument,
  batchSequences,
  nominalEventsPerSecond,
  keepSyntheticDb,
}) {
  const dbPath = path.join(
    os.tmpdir(),
    `dxfeed-storage-qualification-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  const instruments = listCollectorInstruments();
  const expectedPerTable = eventsPerInstrument * instruments.length;
  const writesPerSequence = canonicalEnvelopes(instruments[0], 0).length + ORDER_V2_WRITES_PER_SEQUENCE;
  const expectedTotal = expectedPerTable * writesPerSequence;
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const initialRss = process.memoryUsage().rss;
  let peakRss = initialRss;
  const memorySampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 10);
  const batchDurations = [];
  let service = null;

  try {
    service = createDxFeedStorageService({ dbPath, bootstrap: true });
    service.beginCaptureSession({ sessionId: "synthetic-qualification", startedAt: 1_800_000_000_000 });
    const startedAt = performance.now();
    for (let pageStart = 1; pageStart <= eventsPerInstrument; pageStart += batchSequences) {
      const pageEnd = Math.min(eventsPerInstrument, pageStart + batchSequences - 1);
      const canonical = [];
      const exactOrders = [];
      for (let sequence = pageStart; sequence <= pageEnd; sequence += 1) {
        for (const instrument of instruments) {
          canonical.push(...canonicalEnvelopes(instrument, sequence));
          exactOrders.push(orderV2Envelope(instrument, sequence));
        }
      }
      const batchStartedAt = performance.now();
      const canonicalResults = service.handleEnvelopes(canonical);
      const orderResults = service.handleOrderV2Envelopes(exactOrders);
      batchDurations.push(performance.now() - batchStartedAt);
      if (!canonicalResults.every((accepted) => accepted === true) || !orderResults.every((accepted) => accepted === true)) {
        throw new Error("qualify-dxfeed-storage: canonical batch was not fully accepted");
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    const elapsedMs = performance.now() - startedAt;
    const counters = service.getCounters();
    service.finishCaptureSession({
      endedAt: 1_800_000_000_000 + eventsPerInstrument + 1,
      quality: "HEALTHY", cleanShutdown: true, terminationReason: "synthetic qualification complete",
    });
    service.close();
    service = null;
    clearInterval(memorySampler);
    eventLoop.disable();
    peakRss = Math.max(peakRss, process.memoryUsage().rss);

    const verify = new Database(dbPath, { readonly: true, fileMustExist: true });
    let counts;
    let perInstrument;
    let quickCheck;
    let session;
    try {
      counts = Object.freeze({
        quotes: verify.prepare("SELECT COUNT(*) AS count FROM dxfeed_quotes").get().count,
        trades: verify.prepare("SELECT COUNT(*) AS count FROM dxfeed_trades").get().count,
        timeAndSales: verify.prepare("SELECT COUNT(*) AS count FROM dxfeed_time_and_sales").get().count,
        orderBookCapture: verify.prepare("SELECT COUNT(*) AS count FROM dxfeed_order_book_capture").get().count,
      });
      perInstrument = verify.prepare(
        "SELECT symbol, asset_class AS assetClass, COUNT(*) AS count, MIN(provider_trade_id) AS firstTradeId, " +
        "MAX(provider_trade_id) AS lastTradeId FROM dxfeed_time_and_sales GROUP BY symbol, asset_class ORDER BY asset_class, symbol",
      ).all();
      quickCheck = verify.pragma("quick_check", { simple: true });
      session = verify.prepare(
        "SELECT quality, clean_shutdown AS cleanShutdown FROM dxfeed_capture_sessions WHERE session_id = 'synthetic-qualification'",
      ).get();
    } finally {
      verify.close();
    }
    const databaseBytes = fs.statSync(dbPath).size;
    const throughputEventsPerSecond = expectedTotal / (elapsedMs / 1_000);
    const capacityMultiple = throughputEventsPerSecond / nominalEventsPerSecond;
    const rssGrowthBytes = peakRss - initialRss;
    const batchP99Ms = percentile(batchDurations, 99);
    const eventLoopP99Ms = eventLoop.percentile(99) / 1e6;
    const pass =
      Object.values(counts).every((count) => count === expectedPerTable) &&
      Object.values(counters).filter((value) => typeof value === "number").every((value) => value >= 0) &&
      counters.rejected === 0 && counters.skipped === 0 && counters.tradeIdGaps === 0 &&
      counters.tradeIdNonMonotonic === 0 && quickCheck === "ok" &&
      session?.quality === "HEALTHY" && session?.cleanShutdown === 1 &&
      capacityMultiple >= 5 && batchP99Ms < 250 && eventLoopP99Ms < 250 && rssGrowthBytes < 512 * 1024 * 1024;
    return Object.freeze({
      pass,
      dbPath: keepSyntheticDb ? dbPath : null,
      expectedTotal,
      expectedPerTable,
      counts,
      perInstrument: Object.freeze(perInstrument),
      elapsedMs: Number(elapsedMs.toFixed(1)),
      throughputEventsPerSecond: Number(throughputEventsPerSecond.toFixed(1)),
      nominalEventsPerSecond,
      capacityMultiple: Number(capacityMultiple.toFixed(1)),
      batchCount: batchDurations.length,
      batchP50Ms: Number(percentile(batchDurations, 50).toFixed(1)),
      batchP95Ms: Number(percentile(batchDurations, 95).toFixed(1)),
      batchP99Ms: Number(batchP99Ms.toFixed(1)),
      batchMaxMs: Number(Math.max(...batchDurations).toFixed(1)),
      eventLoopP99Ms: Number(eventLoopP99Ms.toFixed(1)),
      eventLoopMaxMs: Number((eventLoop.max / 1e6).toFixed(1)),
      initialRssBytes: initialRss,
      peakRssBytes: peakRss,
      rssGrowthBytes,
      databaseBytes,
      estimatedBytesPerEvent: Number((databaseBytes / expectedTotal).toFixed(1)),
      estimatedGrowthPerHourBytes: Math.round((databaseBytes / expectedTotal) * nominalEventsPerSecond * 3_600),
      estimatedGrowthPerDayBytes: Math.round((databaseBytes / expectedTotal) * nominalEventsPerSecond * 86_400),
      quickCheck,
      counters,
    });
  } finally {
    clearInterval(memorySampler);
    eventLoop.disable();
    try {
      service?.close();
    } catch {
      void 0;
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
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  parseArgs, inspectExistingDatabase, runSyntheticQualification, canonicalEnvelopes, orderV2Envelope,
  main, DEFAULT_EVENTS_PER_INSTRUMENT, DEFAULT_BATCH_SEQUENCES, DEFAULT_NOMINAL_EVENTS_PER_SECOND,
  MAX_BATCH_SEQUENCES,
};
