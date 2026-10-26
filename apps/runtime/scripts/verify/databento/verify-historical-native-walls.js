"use strict";

const fs = require("node:fs");
const { once } = require("node:events");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { createHistoricalSourceRunner } = require("../../../src/indicators/l2-memory/historical-source-runner");
const { createHistoricalTopNFrames } = require("../../../src/indicators/l2-memory/historical-topn-frames");
const { createWallService } = require("../../../src/indicators/l2-memory/wall-service");
const { sampleLiquidityColumn } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");
const { tradeFrame } = require("../../../src/indicators/l2-memory/input-frames");
const { historicalWallProfile } = require("../../../src/indicators/l2-memory/historical-wall-profile");

async function main() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (historicalWallProfile(config).id !== config.profileId) throw new Error("native detector profile differs from index");
  const period = BigInt(config.sampleMs) * 1000000n;
  const source = createHistoricalTopNFrames({ depthLimit: 10 });
  let service = null, trades = [], wallTrades = [], rows = 0, samples = 0, known = null, nextSample = null;
  let peakRss = 0;
  const runner = createHistoricalSourceRunner({ createEngine: () => {
    const engine = createMemoryEngine({ tickSize: Number(config.tickSize), snapshotDepth: 10 });
    service = createWallService({ engine, ...config.trackerOptions,
      onTrades: (values) => trades.push(...values), onWallTrade: (value) => wallTrades.push(value) });
    return engine;
  }, onSegmentEnd: () => { service.clear(); service = null; trades = []; wallTrades = []; } });
  async function emitBefore(boundary) {
    if (runner.engine === null || known === null) return;
    nextSample = nextSample === null || nextSample < known ? ((known + period - 1n) / period) * period : nextSample;
    while (nextSample < boundary) {
      if (samples >= 86401) throw new Error("native sample bound");
      const ts = Number(nextSample / 1000000n), snapshot = runner.engine.liteSnapshot();
      const column = sampleLiquidityColumn(snapshot, { ts, rowClusters: config.rowClusters, windowRows: config.windowRows, fold: config.fold });
      service.update({ ts, column, snapshot, rowClusters: config.rowClusters, referenceRows: config.referenceRows });
      const lifecycle = service.drainLifecycle();
      if (lifecycle.dropped) throw new Error("native lifecycle lost events");
      const value = { known_ns: String(nextSample), walls: service.walls(), lifecycle: lifecycle.records,
        trades: trades.splice(0), wall_trades: wallTrades.splice(0) };
      if (!process.stdout.write(JSON.stringify(value) + "\n")) await once(process.stdout, "drain");
      samples += 1; nextSample += period;
    }
  }
  let input = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    input = Buffer.concat([input, chunk]);
    let newline;
    while ((newline = input.indexOf(10)) >= 0) {
      if (newline > 8 * 1024 ** 2) throw new Error("native input line bound");
      const batch = JSON.parse(input.subarray(0, newline).toString());
      if (!Array.isArray(batch) || batch.length > 128) throw new Error("native input batch bound");
      input = input.subarray(newline + 1);
      for (const row of batch) {
        const nextKnown = BigInt(row.known_ns);
        if (known !== null && nextKnown < known) throw new Error("native knowledge regressed");
        if (known === null || nextKnown > known) await emitBefore(nextKnown);
        const engine = runner.applyTransition(source.push(row, { observationOnly: row.observation_only }));
        if (engine && row.matched_trade && row.matched_trade.side !== "UNKNOWN") {
          const trade = row.matched_trade;
          runner.applyTransition({ restartEngine: false, frames: [tradeFrame(Number(BigInt(row.event_ns) / 1000000n),
            trade.price, trade.size, trade.side.toLowerCase(), trade.record_id)] });
          engine.drainPrints();
        }
        known = nextKnown; rows += 1;
        if (rows > config.expectedSourceRows) throw new Error("native excess source count");
      }
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    if (input.length > 8 * 1024 ** 2) throw new Error("native input buffer bound");
  }
  if (input.length || rows !== config.expectedSourceRows) throw new Error("native truncated source");
  await emitBefore(BigInt(config.closeNs));
  process.stderr.write(JSON.stringify({ status: "COMPLETE_NATIVE_WALK", rows, samples, peak_rss_bytes: peakRss }) + "\n");
}

main().catch((error) => { process.stderr.write(String(error.stack ?? error) + "\n"); process.exitCode = 1; });
