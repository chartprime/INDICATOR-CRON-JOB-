"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { createStorageDb } = require("../../src/storage/storage-db");
const { createReplaySource } = require("../../src/indicators/l2-memory/replay-source");
const { runBandHistory } = require("../../src/server/band-history");

async function main() {
  const levels = Number(process.argv[2] ?? 5_000);
  const updates = Number(process.argv[3] ?? 1_000);
  if (!Number.isSafeInteger(levels) || levels < 10 || levels > 5_000 || !Number.isSafeInteger(updates) || updates < 10 || updates > 20_000) throw new Error("levels must be in 10..5000 and updates in 10..20000");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "block8-band-bench-"));
  if (!dir.startsWith(`${os.tmpdir()}${path.sep}`) || !path.basename(dir).startsWith("block8-band-bench-")) throw new Error("UNSAFE_TEMP_TARGET");
  const dbPath = path.join(dir, "market.sqlite");
  const T = 1_700_000_000_000;
  const identity = { symbol: "BTCUSDT", marketKind: "SPOT" };
  let storage;
  try {
    storage = createStorageDb({ dbPath });
    const db = storage.raw;
    const bids = Array.from({ length: levels }, (_, index) => [String(30_000 - index), "5"]);
    const asks = Array.from({ length: levels }, (_, index) => [String(30_002 + index), "3"]);
    db.prepare("INSERT INTO l2_depth_snapshots (captured_at, symbol, market_kind, last_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?)").run(T, identity.symbol, identity.marketKind, 100, JSON.stringify(bids), JSON.stringify(asks));
    const depth = db.prepare("INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const trade = db.prepare("INSERT INTO trades (ts, symbol, market_kind, price, size, side, trade_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
    db.transaction(() => {
      for (let index = 0; index < updates; index += 1) {
        const ts = T + index * 100 + 50;
        depth.run(ts, ts + 1, identity.symbol, identity.marketKind, index === 0 ? 100 : 101 + index, 101 + index, null, JSON.stringify([["30000", String(5 + index % 3)]]), "[]");
        if (index % 10 === 0) trade.run(ts + 2, identity.symbol, identity.marketKind, 30_000, 1, "sell", String(index));
      }
    })();
    storage.close(); storage = null;
    const results = [];
    for (const bookMode of ["full", "sparse"]) {
      global.gc?.();
      const cpu = process.cpuUsage();
      const started = performance.now();
      let sampledPeakRssBytes = process.memoryUsage().rss;
      const sample = setInterval(() => { sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss); }, 20);
      let result;
      try {
        result = await runBandHistory({ source: createReplaySource({ dbPath, ...identity, fromTs: T, toTs: T + updates * 100 + 1_000, bookMode, includeBuffering: true }), tickSize: 1, clusterTicks: 1, rowClusters: 1, fromTs: T, toTs: T + updates * 100 + 1_000, columnMs: 1_000, priceLo: 29_990, priceHi: 30_010, yieldEvery: 128 });
      } finally { clearInterval(sample); }
      const used = process.cpuUsage(cpu);
      if (result.columns.length === 0 || result.stats.gaps !== 0 || result.stats.eventsRead !== updates) throw new Error("INVALID_BENCHMARK_COVERAGE");
      results.push({ bookMode, wallMs: performance.now() - started, cpuMs: (used.user + used.system) / 1_000, sampledPeakRssBytes, endMemory: process.memoryUsage(), columns: result.columns.length, frames: result.frames, digest: crypto.createHash("sha256").update(JSON.stringify(result.columns)).digest("hex") });
    }
    if (results[0].digest !== results[1].digest || results[0].frames !== results[1].frames) throw new Error("FULL_SPARSE_PARITY_FAILED");
    process.stdout.write(`${JSON.stringify({ kind: "block8-band-replay", fixture: { levelsPerSide: levels, updates }, results, wallSpeedup: results[0].wallMs / results[1].wallMs }, null, 2)}\n`);
  } finally {
    storage?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
