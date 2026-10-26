#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance, monitorEventLoopDelay } = require("node:perf_hooks");
const { WebSocket } = require("ws");
const { createApp } = require("../../src/server/app");
const { createStorageDb } = require("../../src/storage/storage-db");
const { createStorageService } = require("../../src/storage/storage-service");
const { vacuumSnapshot, verifySnapshot } = require("../maintain/backup-to-drive");
const Database = require("better-sqlite3");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function quantiles(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const at = (percent) => ordered.length ? Number(ordered[Math.max(0, Math.ceil(ordered.length * percent) - 1)].toFixed(2)) : null;
  return { samples: ordered.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
}
function offlineSockets() {
  const sockets = [];
  class OfflineSocket {
    constructor(url) {
      this.url = url; this.readyState = 0; sockets.push(this);
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

async function run({ durationSeconds = 120, eventsPerPulse = 20, clientsCount = 8 } = {}) {
  if (![durationSeconds, eventsPerPulse, clientsCount].every((value) => Number.isSafeInteger(value) && value > 0) || eventsPerPulse > 400 || clientsCount > 16) {
    throw new Error("qualification requires positive integer settings, <=400 events/pulse and <=16 clients");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w503-pipeline-"));
  const dbPath = path.join(dir, "capture.sqlite");
  createStorageDb({ dbPath }).close();
  const { OfflineSocket, sockets } = offlineSockets();
  const incidents = [];
  const app = createApp({ port: 0, webSocketImpl: OfflineSocket, dbPath,
    dxfeedDbPath: path.join(dir, "absent-dxfeed.sqlite"), volumeProfileCachePath: path.join(dir, "profile-cache.sqlite"), dxfeedBrokerUrl: "",
    tickSizeResolver: { getBinanceTickSize: async () => 1, getDxFeedTickSize: () => 1 },
    telemetry: (entry) => { if (/dropped|overflow|fatal/.test(entry.event ?? "") && incidents.length < 100) incidents.push(entry.event); },
    fetchImpl: async (url) => new Response(JSON.stringify(String(url).includes("klines") ? [] : { lastUpdateId: 100, bids: [["99", "2"]], asks: [["101", "3"]] })),
  });
  const storage = createStorageService({ connection: app.connection, dbPath, useWorker: true, telemetry() {} });
  const clients = [];
  const received = Array(clientsCount).fill(0);
  const lastId = Array(clientsCount).fill(0);
  let duplicateOrReordered = 0;
  const phases = ["baseline", "sync-history", "async-history"].map((name) => ({ name, sent: 0, elapsedMs: 0, frameMs: [], queryMs: [], healthMs: [] }));
  const memory = [];
  const retainedHeap = [];
  let nextGcProbe = 0;
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  let id = 0;
  let workerStats;
  let producer = null;
  let closed = false;
  try {
    storage.start(); await storage.whenReady(); await app.start();
    const address = `127.0.0.1:${app.httpServer.address().port}`;
    let activePhase = phases[0];
    for (let index = 0; index < clientsCount; index++) {
      const client = new WebSocket(`ws://${address}/ws`);
      clients.push(client);
      client.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type !== "trade") return;
        const nextId = Number(frame.trade_id);
        if (nextId <= lastId[index]) duplicateOrReordered++;
        lastId[index] = nextId; received[index]++;
        if (index === 0 && activePhase.frameMs.length < 100_000) activePhase.frameMs.push(Date.now() - frame.ts_exchange);
      });
      await new Promise((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
    }
    const spot = sockets.find((socket) => socket.url.endsWith("stream.binance.com/stream"));
    if (!spot) throw new Error("offline spot socket not established");
    const startedAt = performance.now();
    const cpuStart = process.cpuUsage();
    eventLoop.enable();
    producer = setInterval(() => {
      const ts = Date.now();
      for (let i = 0; i < eventsPerPulse; i++) {
        id++; activePhase.sent++;
        spot.onmessage({ data: JSON.stringify({ stream: "btcusdt@trade", data: { e: "trade", E: ts, T: ts, s: "BTCUSDT", t: id, p: "100", q: "1", m: false } }) });
      }
    }, 20);
    for (const phase of phases) {
      activePhase = phase;
      const start = performance.now();
      let nextProbe = 0;
      let lastMemorySample = 0;
      while (performance.now() - start < durationSeconds * 1000 / phases.length) {
        await sleep(20);
        if (performance.now() >= nextProbe) {
          nextProbe = performance.now() + 1000;
          const queryStart = performance.now();
          const options = { fromTs: 0, toTs: Date.now() + 1, originPrice: 0, rowWidth: 1 };
          if (phase.name === "sync-history") {
            const result = app.storageReader.readVolumeProfile("BTCUSDT", "SPOT", options);
            if (!result.available) throw new Error("synchronous history query unavailable");
            phase.queryMs.push(performance.now() - queryStart);
          } else if (phase.name === "async-history") {
            const result = await app.storageReader.readVolumeProfileAsync("BTCUSDT", "SPOT", options);
            if (!result.available) throw new Error("worker history query unavailable");
            phase.queryMs.push(performance.now() - queryStart);
          }
          const healthStart = performance.now();
          const response = await fetch(`http://${address}/health`, { signal: AbortSignal.timeout(5000) });
          if (!response.ok || !(await response.json()).ready) throw new Error("HTTP readiness failed");
          phase.healthMs.push(performance.now() - healthStart);
        }
        if (performance.now() - lastMemorySample >= 1000) {
          lastMemorySample = performance.now();
          const stats = storage.getStats();
          memory.push({ seconds: Number(((performance.now() - startedAt) / 1000).toFixed(1)), phase: phase.name,
            rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed, pending: stats.pendingWriteItems ?? null });
          if (typeof global.gc === "function" && performance.now() >= nextGcProbe) {
            nextGcProbe = performance.now() + 30_000;
            global.gc();
            retainedHeap.push({ seconds: memory.at(-1).seconds, heap: process.memoryUsage().heapUsed });
          }
        }
      }
      phase.elapsedMs = performance.now() - start;
    }
    clearInterval(producer);
    producer = null;
    const drainStart = performance.now();
    while (received.some((count) => count !== id) || storage.getStats().pendingIngressEnvelopes > 0 || storage.getStats().pendingWriteItems > 0) {
      if (performance.now() - drainStart > 3000) break;
      await sleep(10);
    }
    workerStats = { ...storage.getStats(), connection: app.connection.getStatus() };
    storage.setCaptureOutcome({ quality: incidents.length ? "INVALID" : "HEALTHY", cleanShutdown: true,
      terminationReason: incidents.length ? "QUALIFICATION_SOURCE_LOSS" : "QUALIFICATION_COMPLETE" });
    const stopStart = performance.now();
    await storage.stop();
    await app.stop();
    closed = true;
    const stopMs = performance.now() - stopStart;
    const cpu = process.cpuUsage(cpuStart);
    eventLoop.disable();
    const verify = new Database(dbPath, { readonly: true });
    const stored = verify.prepare("SELECT COUNT(*) AS count, SUM(size) AS volume FROM trades").get();
    const integrity = verify.pragma("quick_check", { simple: true });
    verify.close();
    const backupStart = performance.now();
    const snapshotPath = path.join(dir, "backup.sqlite");
    vacuumSnapshot(dbPath, snapshotPath);
    const backup = verifySnapshot(snapshotPath);
    const restoredPath = path.join(dir, "restored.sqlite");
    fs.copyFileSync(snapshotPath, restoredPath, fs.constants.COPYFILE_EXCL);
    const restored = new Database(restoredPath, { readonly: true });
    const restoredCount = restored.prepare("SELECT COUNT(*) AS count FROM trades").get().count;
    const restoredIntegrity = restored.pragma("integrity_check", { simple: true });
    restored.close();
    const backupRestoreMs = performance.now() - backupStart;
    return { generatedAt: new Date().toISOString(), settings: { durationSeconds, eventsPerPulse, clientsCount },
      pass: stored.count === id && received.every((count) => count === id) && duplicateOrReordered === 0 && incidents.length === 0 && integrity === "ok" && restoredCount === id && restoredIntegrity === "ok",
      sent: id, stored, received, duplicateOrReordered, incidents, stopMs, integrity,
      cpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 },
      eventLoopMs: { p99: eventLoop.percentile(99) / 1e6, max: eventLoop.max / 1e6 },
      phases: phases.map((phase) => ({ name: phase.name, sent: phase.sent, elapsedMs: phase.elapsedMs,
        deliveredEventsPerSecond: phase.sent / phase.elapsedMs * 1000, frameMs: quantiles(phase.frameMs), queryMs: quantiles(phase.queryMs), healthMs: quantiles(phase.healthMs) })),
      memory, retainedHeap, workerStats, backupRestore: { ...backup, restoredCount, integrity: restoredIntegrity, durationMs: backupRestoreMs } };
  } finally {
    clearInterval(producer);
    eventLoop.disable();
    for (const client of clients) client.terminate();
    if (!closed) { await storage.stop().catch(() => {}); await app.stop().catch(() => {}); }
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  }
}
if (require.main === module) {
  const durationSeconds = Number(process.argv[2] ?? 120);
  run({ durationSeconds, eventsPerPulse: Number(process.argv[4] ?? 20) }).then((report) => {
    const output = process.argv[3];
    if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    else console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
module.exports = { run, quantiles };
