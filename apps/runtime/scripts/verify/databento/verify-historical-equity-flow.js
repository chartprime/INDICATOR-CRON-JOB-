#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const fs = require("node:fs");
const { createHistoricalTopNFrames } = require("../../../src/indicators/l2-memory/historical-topn-frames");
const { createHistoricalSourceRunner } = require("../../../src/indicators/l2-memory/historical-source-runner");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { tradeFrame } = require("../../../src/indicators/l2-memory/input-frames");

const SORT_FIELDS = ["event_ns", "source_rank", "stable_position", "ordinal"];

async function verify(path, tickSize, { nativeTradeEcho = false } = {}) {
  if (!Number.isFinite(tickSize) || tickSize <= 0) throw new Error("equity-flow: invalid tick size");
  const source = createHistoricalTopNFrames({ depthLimit: 10 });
  const runner = createHistoricalSourceRunner({ createEngine: () => createMemoryEngine({ tickSize, snapshotDepth: 10 }) });
  const observed = Object.fromEntries(["BUY", "SELL", "UNKNOWN"].map((side) => [side, { count: 0, volume: 0 }]));
  const outsideTrust = Object.fromEntries(["BUY", "SELL", "UNKNOWN"].map((side) => [side, { count: 0, volume: 0 }]));
  const samples = [];
  let firstKey = null;
  let lastKey = null;
  let lastTs = null;
  let nextSample = null;
  let rows = 0;
  let trusted = 0;
  let applied = 0;
  const started = performance.now();

  function sample(ts) {
    if (!runner.engine) return;
    if (samples.length >= 10_000) throw new Error("equity-flow: sample budget exceeded");
    const flow = runner.engine.flow.summary({ ts, lookbackMs: 60_000 });
    samples.push({ ts, segment: runner.segment, fromKey: firstKey, throughKey: lastKey,
      buyVolume: flow.buyVolume, sellVolume: flow.sellVolume, tradeCount: flow.tradeCount });
  }

  const input = path === "-" ? process.stdin : fs.createReadStream(path, { encoding: "utf8" });
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
    const row = JSON.parse(line);
    const ts = Number(BigInt(row.event_ns) / 1_000_000n);
    const key = SORT_FIELDS.map((field) => row[field]);
    const trade = row.matched_trade;
    if (trade !== null && trade !== undefined) {
      if (!Object.hasOwn(observed, trade.side) || typeof trade.record_id !== "string" || !trade.record_id
          || BigInt(trade.event_ns) !== BigInt(row.event_ns)
          || !Number.isSafeInteger(Number(trade.size)) || Number(trade.size) <= 0
          || !Number.isFinite(Number(trade.price)) || Number(trade.price) <= 0) {
        throw new Error("equity-flow: invalid anchored trade");
      }
    }
    if (nativeTradeEcho && (typeof row.observation_only !== "boolean" || row.observation_only !== Boolean(trade))) {
      throw new Error("native-flow: every trade requires an explicit native echo observation");
    }
    const transition = source.push(row, { observationOnly: nativeTradeEcho && row.observation_only });
    while (runner.engine && nextSample < ts) {
      sample(nextSample);
      nextSample += 60_000;
    }
    if (transition.restartEngine && runner.engine && (!samples.length || samples.at(-1).ts <= lastTs)) sample(lastTs);
    const engine = runner.applyTransition(transition);
    if (transition.restartEngine) {
      firstKey = engine ? key : null;
      nextSample = engine ? (Math.floor(ts / 60_000) + 1) * 60_000 - 1 : null;
    }
    lastKey = key;
    lastTs = ts;
    if (engine) {
      for (const [side, levels] of [["bid", row.bids], ["ask", row.asks]]) {
        const expected = levels.map(({ price, size }) => [Number(price), Number(size)]);
        if (JSON.stringify(engine.ladder({ side, depth: 10 })) !== JSON.stringify(expected)) {
          throw new Error(`equity-flow: ${side} book mismatch at row ${rows}`);
        }
      }
      trusted += 1;
    }
    if (trade) {
      const size = Number(trade.size);
      observed[trade.side].count += 1;
      observed[trade.side].volume += size;
      if (!Number.isSafeInteger(observed[trade.side].volume)) throw new Error("equity-flow: volume exceeds exact integer range");
      if (!engine) {
        outsideTrust[trade.side].count += 1;
        outsideTrust[trade.side].volume += size;
      } else if (trade.side !== "UNKNOWN") {
        runner.applyTransition({ restartEngine: false, frames: [
          tradeFrame(ts, trade.price, trade.size, trade.side.toLowerCase(), trade.record_id),
        ] });
        const prints = engine.drainPrints();
        if (prints.length !== 1 || prints[0].id !== trade.record_id || prints[0].size !== size) {
          throw new Error("equity-flow: accepted print did not reconcile");
        }
        applied += 1;
      }
    }
    rows += 1;
  }
  if (runner.engine) sample(lastTs);
  return { rows, trusted, observed, outsideTrust, applied, segments: runner.segment, samples,
    nodeVersion: process.versions.node, elapsedMs: Math.round(performance.now() - started),
    maxRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024) };
}

if (require.main === module) {
  const [path, tickSize, mode] = process.argv.slice(2);
  if (mode !== undefined && mode !== "native-trade-echo") throw new Error("flow: unknown mode");
  verify(path, Number(tickSize), { nativeTradeEcho: mode === "native-trade-echo" })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { process.stdin.destroy(); console.error(error.message); process.exitCode = 1; });
}

module.exports = { verify };
