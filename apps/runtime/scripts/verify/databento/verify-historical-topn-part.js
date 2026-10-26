#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const readline = require("node:readline");
const { createHistoricalTopNFrames } = require("../../../src/indicators/l2-memory/historical-topn-frames");
const { createHistoricalSourceRunner } = require("../../../src/indicators/l2-memory/historical-source-runner");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");

async function verify(path, { tickSize, depthLimit }) {
  if (!Number.isFinite(tickSize) || tickSize <= 0 || !Number.isSafeInteger(depthLimit) || depthLimit <= 0) {
    throw new Error("historical-topn-part: invalid geometry");
  }
  const source = createHistoricalTopNFrames({ depthLimit });
  const reasons = {};
  const runner = createHistoricalSourceRunner({
    createEngine: () => createMemoryEngine({ tickSize, snapshotDepth: depthLimit }),
  });
  let rows = 0;
  let trusted = 0;
  const coverage = { unobserved: { bids: 0, asks: 0 }, preexisting: { bids: 0, asks: 0 } };
  const started = performance.now();
  const input = path === "-" ? process.stdin : fs.createReadStream(path, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const row = JSON.parse(line);
    const transition = source.push(row);
    if (transition.reason) reasons[transition.reason] = (reasons[transition.reason] ?? 0) + 1;
    for (const frame of transition.frames) {
      if (!frame.coverage) continue;
      for (const side of ["bids", "asks"]) {
        coverage.unobserved[side] += frame.coverage.unobserved[side].length;
        coverage.preexisting[side] += frame.coverage.preexisting[side].length;
      }
    }
    const engine = runner.applyTransition(transition);
    if (!row.bids.length || !row.asks.length || Number(row.bids[0].price) >= Number(row.asks[0].price)) {
      if (engine !== null) throw new Error(`historical-topn-part: invalid source book at row ${rows} is trusted`);
    } else if (engine) {
      for (const [side, sourceLevels] of [["bid", row.bids], ["ask", row.asks]]) {
        const expected = sourceLevels.map(({ price, size }) => [Number(price), Number(size)]);
        const actual = engine.ladder({ side, depth: depthLimit });
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(`historical-topn-part: ${side} ladder mismatch at row ${rows}`);
        }
      }
      trusted += 1;
    }
    rows += 1;
  }
  return { rows, trusted, reasons, segments: runner.segment, coverage,
    nodeVersion: process.versions.node,
    elapsedMs: Math.round(performance.now() - started), maxRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024) };
}

if (require.main === module) {
  const [path, rawTickSize, rawDepthLimit] = process.argv.slice(2);
  if (!path || !rawTickSize || !rawDepthLimit) {
    console.error("usage: verify-historical-topn-part.js <ordered.jsonl> <tick-size> <depth-limit>");
    process.exitCode = 2;
  } else {
    verify(path, { tickSize: Number(rawTickSize), depthLimit: Number(rawDepthLimit) })
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error) => { process.stdin.destroy(); console.error(error.message); process.exitCode = 1; });
  }
}

module.exports = { verify };
