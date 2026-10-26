#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance, monitorEventLoopDelay } = require("node:perf_hooks");
const { WebSocket } = require("ws");

const { createApp } = require("../../src/server/app");
const { createStorageDb } = require("../../src/storage/storage-db");
const { collectToolProvenance, percentile } = require("./live-storage-load");

const REPORT_CONTRACT_VERSION = 1;
const KIND = "ws-fanout";
const MAX_CLIENTS = 64;
const MAX_DURATION_MS = 600_000;
const MAX_WARMUP_MS = 60_000;
const MAX_TRADES_PER_PULSE = 400;
const DEFAULT_SAMPLE_EVERY_MS = 250;
const MAX_SERIES_SAMPLES = 2_000;
const MAX_TIMELINE_SECONDS = 600;
const MAX_LATENCY_MS = 60_000;
const MAX_TIMELINE_LATENCY_MS = 10_000;
const DEFAULT_SEED = 1;
const MAX_SEED = 4_294_967_295;
const BASE_PRICE = 60_000;
const WHALE_PROBABILITY = 0.01;
const WHALE_SIZE_MULTIPLIER = 20;
const DRAIN_TIMEOUT_MS = 3_000;
const MAX_CATCH_UP_PULSES = 4;
const PRODUCER_KEPT_UP_FRACTION = 0.95;
const SERVER_OPTION_KEYS = Object.freeze(["clientBufferSoftBytes", "clientBufferHardBytes", "clientBufferGraceMs"]);
const WS_OPEN = 1;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`ws-fanout-load: ${label} must be an integer ${min}..${max}`);
  }
}

function closedKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`ws-fanout-load: ${label} has unknown keys ${unknown.sort().join(",")}`);
}

function validateFanoutManifest(value) {
  if (!isRecord(value) || value.version !== 1 || value.kind !== KIND) {
    throw new Error(`ws-fanout-load: manifest must be version 1 with kind "${KIND}"`);
  }
  closedKeys(value, ["version", "kind", "name", "clients", "warmupMs", "durationMs", "upstream", "slowClients", "server", "sampleEveryMs"], "manifest");
  if (typeof value.name !== "string" || value.name.length === 0) throw new Error("ws-fanout-load: name must be a non-empty string");
  boundedInteger(value.clients, 1, MAX_CLIENTS, "clients");
  boundedInteger(value.warmupMs ?? 0, 0, MAX_WARMUP_MS, "warmupMs");
  boundedInteger(value.durationMs, 100, MAX_DURATION_MS, "durationMs");
  boundedInteger(value.sampleEveryMs ?? DEFAULT_SAMPLE_EVERY_MS, 20, 5_000, "sampleEveryMs");
  if (!isRecord(value.upstream)) throw new Error("ws-fanout-load: upstream must be an object");
  closedKeys(value.upstream, ["tradesPerPulse", "pulseMs", "seed"], "upstream");
  if (value.upstream.seed !== undefined) boundedInteger(value.upstream.seed, 0, MAX_SEED, "upstream.seed");
  boundedInteger(value.upstream.tradesPerPulse, 1, MAX_TRADES_PER_PULSE, "upstream.tradesPerPulse");
  boundedInteger(value.upstream.pulseMs, 5, 1_000, "upstream.pulseMs");
  if (value.slowClients !== undefined) {
    if (!isRecord(value.slowClients)) throw new Error("ws-fanout-load: slowClients must be an object");
    closedKeys(value.slowClients, ["count", "pauseAfterMs", "resumeAfterMs", "stopAfterEviction"], "slowClients");
    if (value.slowClients.stopAfterEviction !== undefined && typeof value.slowClients.stopAfterEviction !== "boolean") {
      throw new Error("ws-fanout-load: slowClients.stopAfterEviction must be a boolean");
    }
    boundedInteger(value.slowClients.count, 1, value.clients - 1, "slowClients.count (at least one client must stay healthy)");
    boundedInteger(value.slowClients.pauseAfterMs, 0, value.durationMs, "slowClients.pauseAfterMs");
    if (value.slowClients.resumeAfterMs !== undefined) {
      boundedInteger(value.slowClients.resumeAfterMs, value.slowClients.pauseAfterMs + 1, value.durationMs, "slowClients.resumeAfterMs");
    }
  }
  if (value.server !== undefined) {
    if (!isRecord(value.server)) throw new Error("ws-fanout-load: server must be an object");
    closedKeys(value.server, SERVER_OPTION_KEYS, "server");
    for (const key of ["clientBufferSoftBytes", "clientBufferHardBytes"]) {
      if (value.server[key] !== undefined) boundedInteger(value.server[key], 1, 1_073_741_824, `server.${key}`);
    }
    if (value.server.clientBufferGraceMs !== undefined) boundedInteger(value.server.clientBufferGraceMs, 0, 600_000, "server.clientBufferGraceMs");
    if (value.server.clientBufferSoftBytes !== undefined && value.server.clientBufferHardBytes !== undefined &&
        value.server.clientBufferHardBytes < value.server.clientBufferSoftBytes) {
      throw new Error("ws-fanout-load: server.clientBufferHardBytes must be >= clientBufferSoftBytes");
    }
  }
  return value;
}

function latencySummary(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return {
    samples: ordered.length,
    p50: percentile(ordered, 0.5),
    p95: percentile(ordered, 0.95),
    p99: percentile(ordered, 0.99),
    max: ordered.at(-1) ?? null,
  };
}

function createLatencyHistogram(maxMs = MAX_LATENCY_MS) {
  const counts = new Uint32Array(maxMs + 2);
  let samples = 0;
  let max = null;
  return {
    record(value) {
      const ms = value < 0 ? 0 : Math.round(value);
      counts[ms > maxMs ? maxMs + 1 : ms] += 1;
      samples += 1;
      if (max === null || value > max) max = value;
    },
    merge(other) {
      const snapshot = other.snapshot();
      for (let index = 0; index < counts.length; index += 1) counts[index] += snapshot.counts[index];
      samples += snapshot.samples;
      if (snapshot.max !== null && (max === null || snapshot.max > max)) max = snapshot.max;
    },
    snapshot() {
      return { counts, samples, max };
    },
    summary() {
      const rank = (fraction) => Math.max(1, Math.ceil(samples * fraction));
      const at = (fraction) => {
        if (samples === 0) return null;
        const target = rank(fraction);
        let seen = 0;
        for (let index = 0; index < counts.length; index += 1) {
          seen += counts[index];
          if (seen >= target) return index > maxMs ? max : index;
        }
        return max;
      };
      return { samples, p50: at(0.5), p95: at(0.95), p99: at(0.99), max };
    },
  };
}

function producerKeptUp(achievedTradesPerSecond, nominalTradesPerSecond) {
  return achievedTradesPerSecond >= Math.round(nominalTradesPerSecond * PRODUCER_KEPT_UP_FRACTION);
}

function gapBefore(lastTradeId, tradeId, measureFloor) {
  const expected = Math.max(lastTradeId, measureFloor) + 1;
  return tradeId > expected ? tradeId - expected : 0;
}

function observeTradeId(lastTradeId, tradeId, measured, measureFloor) {
  return {
    lastTradeId: Math.max(lastTradeId, tradeId),
    duplicateOrReordered: tradeId <= lastTradeId,
    gap: measured ? gapBefore(lastTradeId, tradeId, measureFloor) : 0,
  };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function createTradeGenerator(seed) {
  const random = seededRandom(seed);
  let price = BASE_PRICE;
  return () => {
    price = Math.max(1, price + Math.round((random() - 0.5) * 6));
    const size = (0.001 + -Math.log(1 - random()) * 0.05) * (random() < WHALE_PROBABILITY ? WHALE_SIZE_MULTIPLIER : 1);
    return { price: price.toFixed(2), quantity: size.toFixed(6), buyerIsMaker: random() < 0.5 };
  };
}

function offlineSockets() {
  const sockets = [];
  class OfflineSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); });
    }

    send(wire) {
      const request = JSON.parse(wire);
      if (request.id) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: request.id, result: null }) }));
    }

    close() { this.readyState = 3; this.onclose?.({}); }
  }
  return { OfflineSocket, sockets };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runFanout({ manifest, provenance = null, signal = null }) {
  validateFanoutManifest(manifest);
  const { clients: clientCount, durationMs, upstream } = manifest;
  const warmupMs = manifest.warmupMs ?? 0;
  const sampleEveryMs = manifest.sampleEveryMs ?? DEFAULT_SAMPLE_EVERY_MS;
  const slowCount = manifest.slowClients?.count ?? 0;
  const firstSlowIndex = clientCount - slowCount;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-fanout-"));
  const dbPath = path.join(dir, "capture.sqlite");
  createStorageDb({ dbPath }).close();
  const icebergStoreDirBefore = process.env.L2_ICEBERG_STORE_DIR;
  process.env.L2_ICEBERG_STORE_DIR = path.join(dir, "icebergs");
  const { OfflineSocket, sockets } = offlineSockets();
  const incidents = [];
  const app = createApp({
    port: 0, archiveRoute: null, webSocketImpl: OfflineSocket, dbPath, maxWsClients: clientCount + 8,
    dxfeedDbPath: path.join(dir, "absent-dxfeed.sqlite"), volumeProfileCachePath: path.join(dir, "profile-cache.sqlite"), dxfeedBrokerUrl: "",
    tickSizeResolver: { getBinanceTickSize: async () => 1, getDxFeedTickSize: () => 1 },
    telemetry: (entry) => { if (/dropped|overflow|fatal/.test(entry.event ?? "") && incidents.length < 100) incidents.push(entry.event); },
    fetchImpl: async (url) => new Response(JSON.stringify(String(url).includes("klines") ? [] : { lastUpdateId: 100, bids: [["99", "2"]], asks: [["101", "3"]] })),
    ...manifest.server,
  });
  const records = Array.from({ length: clientCount }, (_, index) => ({
    index, slow: index >= firstSlowIndex, socket: null, serverSocket: null,
    received: 0, frameCounts: {}, lastTradeId: 0, duplicatesOrReordered: 0, gaps: 0, latency: createLatencyHistogram(),
    maxBufferedBytes: 0, bufferedSeries: [], bufferedSeriesDropped: 0, pausedAtMs: null, resumedAtMs: null,
    serverClose: null, serverTerminatedAtMs: null, clientClosed: null,
  }));
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  const timers = [];
  let sent = 0;
  let sentAtMeasureStart = 0;
  let measuring = false;
  let measureStartedAt = 0;
  let interrupted = false;
  let producer = null;
  let sampler = null;
  let stopped = false;
  const pulseIntervalsMs = [];
  const timeline = new Map();
  let lastPulseAt = null;
  const rssBytes = [];
  const sinceMeasureStart = () => Number((performance.now() - measureStartedAt).toFixed(3));
  const timelineBucket = () => {
    const second = Math.floor((performance.now() - measureStartedAt) / 1000);
    if (second >= MAX_TIMELINE_SECONDS) return null;
    let bucket = timeline.get(second);
    if (bucket === undefined) {
      bucket = { second, latency: createLatencyHistogram(MAX_TIMELINE_LATENCY_MS), frames: {} };
      timeline.set(second, bucket);
    }
    return bucket;
  };
  const wallStartedAt = performance.now();
  const startedAtUtc = new Date().toISOString();
  const onInterrupt = () => { interrupted = true; };
  if (signal !== null) {
    if (signal.aborted) interrupted = true;
    else signal.addEventListener("abort", onInterrupt, { once: true });
  }
  try {
    await app.start();
    const address = `127.0.0.1:${app.httpServer.address().port}`;
    let connected = 0;
    app.wss.on("connection", (serverSocket) => {
      const record = records[connected];
      connected += 1;
      if (record === undefined) return;
      record.serverSocket = serverSocket;
      const originalClose = serverSocket.close.bind(serverSocket);
      serverSocket.close = (code, reason) => {
        if (record.serverClose === null) record.serverClose = { atMs: measuring ? sinceMeasureStart() : null, code: code ?? null, reason: typeof reason === "string" ? reason.slice(0, 120) : null };
        return originalClose(code, reason);
      };
      const originalTerminate = serverSocket.terminate.bind(serverSocket);
      serverSocket.terminate = () => {
        if (record.serverTerminatedAtMs === null) record.serverTerminatedAtMs = measuring ? sinceMeasureStart() : -1;
        return originalTerminate();
      };
    });
    for (const record of records) {
      const client = new WebSocket(`ws://${address}/ws`);
      record.socket = client;
      client.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        const type = typeof frame?.type === "string" ? frame.type : "unknown";
        if (type !== "trade") {
          if (measuring) {
            record.frameCounts[type] = (record.frameCounts[type] ?? 0) + 1;
            if (record.index === 0) {
              const bucket = timelineBucket();
              if (bucket !== null) bucket.frames[type] = (bucket.frames[type] ?? 0) + 1;
            }
          }
          return;
        }
        const tradeId = Number(frame.trade_id);
        const measured = measuring && tradeId > sentAtMeasureStart;
        const observed = observeTradeId(record.lastTradeId, tradeId, measured, sentAtMeasureStart);
        if (observed.duplicateOrReordered) record.duplicatesOrReordered += 1;
        record.gaps += observed.gap;
        record.lastTradeId = observed.lastTradeId;
        if (!measured) return;
        record.received += 1;
        record.frameCounts.trade = record.received;
        const latency = Date.now() - frame.ts_exchange;
        record.latency.record(latency);
        if (record.index === 0) timelineBucket()?.latency.record(latency);
      });
      client.on("close", (code, reason) => {
        record.clientClosed = { atMs: measuring ? sinceMeasureStart() : null, code, reason: reason.toString().slice(0, 120) };
      });
      client.on("error", () => {});
      await new Promise((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
    }
    const spot = sockets.find((socket) => socket.url.endsWith("stream.binance.com/stream"));
    if (!spot) throw new Error("ws-fanout-load: offline spot socket not established");

    const nextTrade = createTradeGenerator(upstream.seed ?? DEFAULT_SEED);
    const nominalTradesPerSecond = upstream.tradesPerPulse * 1000 / upstream.pulseMs;
    const producerStartedAt = performance.now();
    producer = setInterval(() => {
      const pulseAt = performance.now();
      if (measuring && lastPulseAt !== null) pulseIntervalsMs.push(pulseAt - lastPulseAt);
      lastPulseAt = pulseAt;
      const due = Math.floor((pulseAt - producerStartedAt) * nominalTradesPerSecond / 1000) - sent;
      const emit = Math.min(due, upstream.tradesPerPulse * MAX_CATCH_UP_PULSES);
      const ts = Date.now();
      for (let i = 0; i < emit; i += 1) {
        sent += 1;
        const trade = nextTrade();
        spot.onmessage({ data: JSON.stringify({ stream: "btcusdt@trade", data: { e: "trade", E: ts, T: ts, s: "BTCUSDT", t: sent, p: trade.price, q: trade.quantity, m: trade.buyerIsMaker } }) });
      }
    }, upstream.pulseMs);

    const untilElapsed = async (ms, stopWhen = () => false) => {
      const end = performance.now() + ms;
      while (!interrupted && performance.now() < end && !stopWhen()) await sleep(Math.min(20, Math.max(1, end - performance.now())));
    };
    await untilElapsed(warmupMs);

    sentAtMeasureStart = sent;
    measureStartedAt = performance.now();
    measuring = true;
    eventLoop.enable();
    rssBytes.push(process.memoryUsage().rss);
    sampler = setInterval(() => {
      const atMs = sinceMeasureStart();
      for (const record of records) {
        const buffered = record.serverSocket?.bufferedAmount;
        if (!Number.isFinite(buffered)) continue;
        record.maxBufferedBytes = Math.max(record.maxBufferedBytes, buffered);
        if (!record.slow) continue;
        if (record.bufferedSeries.length < MAX_SERIES_SAMPLES) record.bufferedSeries.push([atMs, buffered]);
        else record.bufferedSeriesDropped += 1;
      }
      rssBytes.push(process.memoryUsage().rss);
    }, sampleEveryMs);
    const resumeAfterMs = manifest.slowClients?.resumeAfterMs;
    const resumeSlowClients = () => {
      for (const record of records.filter((entry) => entry.slow)) {
        if (record.resumedAtMs !== null || record.socket.readyState !== WS_OPEN) continue;
        record.socket.resume();
        record.resumedAtMs = sinceMeasureStart();
      }
    };
    if (slowCount > 0) {
      timers.push(setTimeout(() => {
        for (const record of records.filter((entry) => entry.slow)) {
          record.socket.pause();
          record.pausedAtMs = sinceMeasureStart();
        }
      }, manifest.slowClients.pauseAfterMs));
      if (resumeAfterMs !== undefined && resumeAfterMs < durationMs) timers.push(setTimeout(resumeSlowClients, resumeAfterMs));
    }
    const slowRecords = records.filter((record) => record.slow);
    const allSlowEvicted = () => slowRecords.length > 0 && slowRecords.every((record) => record.serverClose !== null || record.serverTerminatedAtMs !== null);
    const stopAfterEviction = manifest.slowClients?.stopAfterEviction === true;
    await untilElapsed(durationMs, () => stopAfterEviction && allSlowEvicted());
    const endedEarly = stopAfterEviction && allSlowEvicted() ? "SLOW_CLIENTS_EVICTED" : null;
    if (resumeAfterMs !== undefined) resumeSlowClients();

    clearInterval(producer);
    producer = null;
    const measuredWallMs = Number((performance.now() - measureStartedAt).toFixed(3));
    const sentMeasured = sent - sentAtMeasureStart;
    const drainStartedAt = performance.now();
    const healthy = records.filter((record) => !record.slow);
    const evictedRecord = (record) => record.serverClose !== null || record.serverTerminatedAtMs !== null;
    const resumedSlow = records.filter((record) => record.slow && record.resumedAtMs !== null && !evictedRecord(record));
    const catchingUp = [...healthy, ...resumedSlow];
    while (catchingUp.some((record) => record.received < sentMeasured) && performance.now() - drainStartedAt < DRAIN_TIMEOUT_MS) await sleep(10);
    measuring = false;
    clearInterval(sampler);
    sampler = null;
    eventLoop.disable();
    rssBytes.push(process.memoryUsage().rss);

    const pooledHealthy = createLatencyHistogram();
    for (const record of healthy) pooledHealthy.merge(record.latency);
    const achievedTradesPerSecond = Math.round(sentMeasured * 1000 / measuredWallMs);
    const slow = records.filter((record) => record.slow);
    const evicted = slow.filter(evictedRecord);
    const clientReport = (record) => ({
      index: record.index,
      slow: record.slow,
      received: record.received,
      frameCounts: record.frameCounts,
      duplicatesOrReordered: record.duplicatesOrReordered,
      gaps: record.gaps,
      latencyMs: record.latency.summary(),
      maxBufferedBytes: record.maxBufferedBytes,
      ...(record.slow ? {
        pausedAtMs: record.pausedAtMs,
        resumedAtMs: record.resumedAtMs,
        bufferedSeriesMs: record.bufferedSeries,
        ...(record.bufferedSeriesDropped > 0 ? { bufferedSeriesDropped: record.bufferedSeriesDropped } : {}),
      } : {}),
      serverClose: record.serverClose,
      serverTerminatedAtMs: record.serverTerminatedAtMs,
      clientClosed: record.clientClosed,
    });
    return {
      contractVersion: REPORT_CONTRACT_VERSION,
      kind: KIND,
      name: manifest.name,
      ...(provenance === null ? {} : { source: { ...provenance, wsVersion: require("ws/package.json").version } }),
      startedAtUtc,
      ...(interrupted ? { interrupted: true } : {}),
      ...(endedEarly === null ? {} : { endedEarly }),
      settings: {
        clients: clientCount, warmupMs, durationMs, sampleEveryMs, upstream,
        slowClients: manifest.slowClients ?? null, server: manifest.server ?? null,
      },
      wallMs: Number((performance.now() - wallStartedAt).toFixed(3)),
      measuredWallMs,
      sent: {
        total: sent,
        measured: sentMeasured,
        nominalTradesPerSecond: Math.round(upstream.tradesPerPulse * 1000 / upstream.pulseMs),
        achievedTradesPerSecond,
        pulseIntervalMs: latencySummary(pulseIntervalsMs),
      },
      latencyMs: { healthy: pooledHealthy.summary() },
      timelineClient0: [...timeline.values()].sort((a, b) => a.second - b.second).map((bucket) => ({
        second: bucket.second, trades: bucket.latency.summary().samples, latencyMs: bucket.latency.summary(), frames: bucket.frames,
      })),
      invariants: {
        producerKeptUp: producerKeptUp(achievedTradesPerSecond, upstream.tradesPerPulse * 1000 / upstream.pulseMs),
        healthyClientsReceivedEverySentTrade: healthy.every((record) => record.received === sentMeasured),
        resumedSlowClientsReceivedEverySentTrade: resumedSlow.length === 0 ? null : resumedSlow.every((record) => record.received === sentMeasured),
        healthyClientsMinReceived: Math.min(...healthy.map((record) => record.received)),
        healthyClientsMaxReceived: Math.max(...healthy.map((record) => record.received)),
        duplicatesOrReordered: records.reduce((total, record) => total + record.duplicatesOrReordered, 0),
        gapsOnHealthyClients: healthy.reduce((total, record) => total + record.gaps, 0),
        slowClients: slowCount,
        slowClientsEvictedByServer: evicted.length,
        serverCloseCodes: Object.fromEntries([...new Set(evicted.map((record) => String(record.serverClose?.code ?? "terminated")))].sort()
          .map((code) => [code, evicted.filter((record) => String(record.serverClose?.code ?? "terminated") === code).length])),
        incidents: incidents.length,
      },
      server: {
        maxHealthyBufferedBytes: Math.max(0, ...healthy.map((record) => record.maxBufferedBytes)),
        maxSlowBufferedBytes: Math.max(0, ...slow.map((record) => record.maxBufferedBytes)),
        rssBytes: { start: rssBytes[0] ?? null, max: Math.max(...rssBytes), end: rssBytes.at(-1) ?? null },
        eventLoopDelayMs: { p50: eventLoop.percentile(50) / 1e6, p99: eventLoop.percentile(99) / 1e6, max: eventLoop.max / 1e6 },
        incidents,
      },
      clients: records.map(clientReport),
    };
  } finally {
    if (signal !== null) signal.removeEventListener("abort", onInterrupt);
    for (const timer of timers) clearTimeout(timer);
    if (producer !== null) clearInterval(producer);
    if (sampler !== null) clearInterval(sampler);
    eventLoop.disable();
    for (const record of records) {
      try { record.socket?.terminate(); } catch { void 0; }
    }
    if (!stopped) {
      stopped = true;
      await app.stop().catch(() => {});
    }
    fs.rmSync(dir, { recursive: true, force: true });
    if (icebergStoreDirBefore === undefined) delete process.env.L2_ICEBERG_STORE_DIR;
    else process.env.L2_ICEBERG_STORE_DIR = icebergStoreDirBefore;
  }
}

async function main(argv = process.argv.slice(2)) {
  const manifestPath = argv[0];
  if (!manifestPath) throw new Error("usage: ws-fanout-load <manifest.json> [output.json]");
  const manifestBytes = fs.readFileSync(path.resolve(manifestPath));
  const manifest = validateFanoutManifest(JSON.parse(manifestBytes.toString("utf8")));
  const provenance = collectToolProvenance({ manifestBytes, scriptPath: __filename });
  const interruption = new AbortController();
  const interrupt = () => {
    process.exitCode = 130;
    interruption.abort();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const { log, info } = console;
  console.log = console.error;
  console.info = console.error;
  let report;
  try {
    report = await runFanout({ manifest, provenance, signal: interruption.signal });
  } finally {
    console.log = log;
    console.info = info;
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (argv[1]) {
    const outputPath = path.resolve(argv[1]);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporaryPath = `${outputPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporaryPath, outputPath);
  } else {
    process.stdout.write(serialized);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}

module.exports = {
  main, runFanout, validateFanoutManifest, latencySummary, gapBefore, observeTradeId, seededRandom, createTradeGenerator, producerKeptUp, createLatencyHistogram,
};
