#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const readline = require("node:readline");
const { once } = require("node:events");
const { createHistoricalLevelEvents } = require("../../../src/indicators/l2-memory/historical-level-events");
const { createHistoricalSecondSampler } = require("../../../src/indicators/l2-memory/historical-second-sampler");
const { createHistoricalTopNFrames } = require("../../../src/indicators/l2-memory/historical-topn-frames");
const { createHistoricalSourceRunner } = require("../../../src/indicators/l2-memory/historical-source-runner");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { tradeFrame } = require("../../../src/indicators/l2-memory/input-frames");

function createProducer(config) {
  const { derivationId, instrumentId, fromNs, toNs, tickSize } = config;
  const tradePolicy = config.tradePolicy ?? "native-trade-echo";
  const sourceRank = tradePolicy === "native-trade-echo" ? "2" : config.sourceRank;
  if (!(tradePolicy === "native-trade-echo" && tickSize === "0.25"
        || tradePolicy === "equity-trade-observation" && tickSize === "0.01")
      || typeof sourceRank !== "string" || !/^(0|[1-9]\d{0,4})$/.test(sourceRank) || Number(sourceRank) > 65535
      || !Number.isSafeInteger(config.expectedRows) || config.expectedRows < 1
      || config.expectedRows > 30_000_000) throw new Error("CME core: unsupported geometry or source budget");
  const sampler = createHistoricalSecondSampler({ derivationId, instrumentId, fromNs, toNs, tickSize });
  const source = createHistoricalTopNFrames({ depthLimit: 10 });
  const observed = Object.fromEntries(["BUY", "SELL", "UNKNOWN"].map((side) => [side, { count: 0, volume: 0 }]));
  const outsideTrust = structuredClone(observed);
  let observer = null;
  let sourceKey;
  let knownNs;
  let prunedAt = null;
  let closing = [];
  let rows = 0;
  let trusted = 0;
  let applied = 0;
  let closed = false;
  let priorBook = null;
  const runner = createHistoricalSourceRunner({ createEngine: () => createMemoryEngine({ tickSize: Number(tickSize), snapshotDepth: 10 }),
    onSegmentEnd: ({ engine, reason }) => {
      closing = observer.close(engine, { sourceKey, knownNs, cause: reason });
      observer = null;
      prunedAt = null;
    } });
  function add(total, trade) {
    total[trade.side].count += 1;
    total[trade.side].volume += Number(trade.size);
    if (!Number.isSafeInteger(total[trade.side].volume)) throw new Error("CME core: inexact flow total");
  }
  function* push(row) {
    if (closed || rows >= config.expectedRows) throw new Error("CME core: closed or excess source");
    sourceKey = [row.event_ns, row.source_rank, row.stable_position, row.ordinal];
    if (row.instrument_id !== instrumentId || row.source_rank !== sourceRank || row.ordinal !== "0"
        || typeof row.known_ns !== "string" || !/^(0|[1-9]\d*)$/.test(row.known_ns)
        || BigInt(row.known_ns) < BigInt(row.event_ns)) throw new Error("CME core: unpinned source identity or knowledge");
    knownNs = row.known_ns;
    const trade = row.matched_trade ?? null;
    const book = JSON.stringify([row.bids, row.asks]);
    const observationOnly = Boolean(trade) && (tradePolicy === "native-trade-echo" || book === priorBook);
    if (typeof row.observation_only !== "boolean" || row.observation_only !== observationOnly
        || trade && (!Object.hasOwn(observed, trade.side) || trade.event_ns !== row.event_ns
          || typeof trade.record_id !== "string" || !trade.record_id || !/^[1-9]\d*$/.test(trade.size)
          || !Number.isSafeInteger(Number(trade.size)))) throw new Error("CME core: invalid native trade echo");
    priorBook = book;
    const transition = source.push(row, { observationOnly: row.observation_only });
    const engine = runner.applyTransition(transition);
    for (const event of closing) yield { family: "l2_level_event", row: event };
    closing = [];
    const ts = Number(BigInt(row.event_ns) / 1_000_000n);
    let pruned = false;
    if (engine) {
      if (!observer) observer = createHistoricalLevelEvents({ derivationId, instrumentId, seedKey: sourceKey, tickSize });
      pruned = prunedAt === null || ts - prunedAt >= 1000;
      if (pruned) prunedAt = ts;
      trusted += 1;
    }
    if (trade) {
      add(observed, trade);
      if (!engine) add(outsideTrust, trade);
      else if (trade.side !== "UNKNOWN") {
        runner.applyTransition({ restartEngine: false, frames: [tradeFrame(ts, trade.price, trade.size,
          trade.side.toLowerCase(), trade.record_id)] });
        const prints = engine.drainPrints();
        if (prints.length !== 1 || prints[0].id !== trade.record_id || prints[0].size !== Number(trade.size)) {
          throw new Error("CME core: accepted print did not reconcile");
        }
        applied += 1;
      }
    }
    if (engine) for (const event of observer.capture(engine, { sourceKey, knownNs,
      bookFrame: transition.frames.find((frame) => frame.kind === "book"), pruned })) {
      yield { family: "l2_level_event", row: event };
    }
    for (const value of sampler.observe({ sourceKey, knownNs, segmentId: observer?.segmentId ?? null,
      bids: row.bids, asks: row.asks, unavailableReason: transition.reason, boundaryReason: transition.reason, trade })) {
      yield { family: value.family, row: value };
    }
    rows += 1;
  }
  function* finish() {
    if (closed || rows !== config.expectedRows) throw new Error("CME core: missing or closed source");
    closed = true;
    if (observer) for (const event of observer.close(runner.engine, { sourceKey, knownNs, cause: "EOF" })) {
      yield { family: "l2_level_event", row: event };
    }
    for (const value of sampler.finish()) yield { family: value.family, row: value };
  }
  return { push, finish, summary: () => ({ rows, trusted, observed, outsideTrust, applied, segments: runner.segment }) };
}

async function run(config) {
  const producer = createProducer(config);
  const started = performance.now();
  let nextProgress = 100_000;
  const outputRows = { l2_level_event: 0, l2_level_state_1s: 0, l2_book_segment: 0 };
  let jsonBytes = 0;
  async function emit(value) {
    const line = JSON.stringify(value) + "\n";
    jsonBytes += Buffer.byteLength(line);
    if (Object.hasOwn(outputRows, value.family)) outputRows[value.family] += 1;
    if (!process.stdout.write(line)) await once(process.stdout, "drain");
  }
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (Buffer.byteLength(line) > 16_384) throw new Error("CME core: oversized input row");
    for (const value of producer.push(JSON.parse(line))) await emit(value);
    const summary = producer.summary();
    if (summary.rows >= nextProgress) {
      const progress = { rows: summary.rows, outputRows: { ...outputRows }, jsonBytes,
        elapsedMs: Math.round(performance.now() - started), maxRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024) };
      console.error(JSON.stringify({ phase: "progress", ...progress }));
      await emit({ family: "progress", row: progress });
      nextProgress += 100_000;
    }
  }
  for (const value of producer.finish()) await emit(value);
  await emit({ family: "completion", row: { ...producer.summary(), derivationId: config.derivationId,
    outputRows, jsonBytes,
    elapsedMs: Math.round(performance.now() - started), maxRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024) } });
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file || fs.statSync(file).size > 64 * 1024) throw new Error("CME core: bounded config file required");
  run(JSON.parse(fs.readFileSync(file, "utf8"))).catch((error) => {
    process.stdin.destroy();
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { createProducer };
