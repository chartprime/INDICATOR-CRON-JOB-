#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { createHistoricalTardisFrames } = require("../../../src/indicators/l2-memory/historical-tardis-frames");
const { createHistoricalSourceRunner } = require("../../../src/indicators/l2-memory/historical-source-runner");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");

function verify(sample, { tickSize }) {
  if (!sample || !Array.isArray(sample.groups) || !Array.isArray(sample.references)) {
    throw new Error("historical-l2-sample: groups and references are required");
  }
  const source = createHistoricalTardisFrames({ exchange: sample.exchange, symbol: sample.symbol });
  const references = new Map(sample.references.map((row) => [`${row.timestamp}:${row.local_timestamp}`, row]));
  const runner = createHistoricalSourceRunner({ createEngine: () => createMemoryEngine({ tickSize, snapshotDepth: Infinity }) });
  let compared = 0;
  let restarts = 0;
  let groupCount = 0;
  for (const rows of sample.groups) {
    if (!Array.isArray(rows) || rows.length === 0) throw new Error("historical-l2-sample: empty group");
    const transitions = [...rows.flatMap((row) => source.push(row)), ...source.flush()];
    if (transitions.length !== 1) throw new Error("historical-l2-sample: group boundary mismatch");
    const transition = transitions[0];
    if (transition.restartEngine) restarts += 1;
    const engine = runner.applyTransition(transition);
    const reference = references.get(`${transition.eventUs}:${transition.receiveUs}`);
    if (reference) {
      if (!engine || !engine.live) throw new Error(`historical-l2-sample: no trusted engine at group ${groupCount}`);
      for (const [side, field] of [["bid", "bids"], ["ask", "asks"]]) {
        const expected = reference[field].map(([price, size]) => [Number(price), Number(size)]);
        const actual = engine.ladder({ side, depth: expected.length });
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(`historical-l2-sample: ${side} mismatch at group ${groupCount}`);
        }
      }
      references.delete(`${transition.eventUs}:${transition.receiveUs}`);
      compared += 1;
    }
    groupCount += 1;
  }
  if (references.size) throw new Error(`historical-l2-sample: ${references.size} reference snapshots were not joined`);
  return Object.freeze({ groups: groupCount, comparedSnapshots: compared, engineRestarts: restarts });
}

if (require.main === module) {
  const [path, rawTickSize] = process.argv.slice(2);
  if (!path || !rawTickSize || !(Number(rawTickSize) > 0)) {
    console.error("usage: verify-historical-l2-sample.js <sample.json> <tick-size>");
    process.exitCode = 2;
  } else {
    const sample = JSON.parse(fs.readFileSync(path, "utf8"));
    console.log(JSON.stringify(verify(sample, { tickSize: Number(rawTickSize) })));
  }
}

module.exports = { verify };
